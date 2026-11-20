import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';

// Read-only watcher over ZCode's local SQLite store (~/.zcode/cli/db/db.sqlite).
// Derives a live session state model and diffs it into bounded glass-friendly events.
// Never writes to the database; logs only ids/counts, never session content.
//
// Write-lag reality (measured): turn_usage rows land only at turn completion,
// but tool_usage and message rows are written live — so "running" detection uses
// fresh tool_usage(status='running') or message activity, not turn_usage.

const ATTENTION_INPUT = (s) => !['promoted', 'cancelled'].includes(String(s || ''));
// 消息流类 input 不算"等你确认"：sendText=用户每轮发言的投递、backgroundNotification=后台注入；
// 它们在 promoted 前有短暂排队窗口，轮询撞见会误报。真确认会停留，故再加 15s 年龄门槛。
const INPUT_KIND_EXCLUDE = new Set(['sendText', 'backgroundNotification']);
const INPUT_SETTLE_MS = 15 * 1000;
const RUNNING_WINDOW_MS = 15 * 60 * 1000;  // a tool row older than this with status=running is stale
const MSG_ACTIVE_MS = 90 * 1000;           // latest message younger than this ⇒ model is streaming
const EVENT_TTL_MS = 60 * 60 * 1000;
const MAX_EVENTS = 128;
const EVENT_COOLDOWN_MS = 30 * 1000;       // same kind+session silenced for this long

const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
};

export class ZCodeSource extends EventEmitter {
  constructor({ dbPath, pollMs = 2000, now = () => Date.now() }) {
    super();
    this.dbPath = dbPath; this.pollMs = pollMs; this.now = now;
    this.db = null; this.timer = null;
    this.events = [];
    this.prev = new Map(); // sessionId -> { turnId, turnDone, lastUserMsgId, pendingInputs }
    this.lastSnapshot = { protocolVersion: 1, generatedAt: 0, dbReadable: false, sessions: [], events: [] };
  }

  start() { this.poll(); this.timer = setInterval(() => this.poll(), this.pollMs); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.db?.close(); this.db = null; }

  open() { if (!this.db) this.db = new DatabaseSync(this.dbPath, { readOnly: true }); return this.db; }

  poll() {
    let next;
    try { next = this.readState(); } catch { this.db?.close(); this.db = null; return; } // busy/locked: retry next tick
    this.diff(next);
    this.lastSnapshot = { ...next, events: [...this.events] };
    this.emit('snapshot', this.lastSnapshot);
  }

  readState() {
    const db = this.open();
    const all = (sql, ...a) => db.prepare(sql).all(...a);
    const get = (sql, ...a) => db.prepare(sql).get(...a);
    const t = this.now();
    const dayStart = t - 24 * 60 * 60 * 1000;

    const liveIds = [...new Set(all('SELECT session_id FROM session_runtime_presence').map(r => r.session_id))];
    if (liveIds.length === 0) return { protocolVersion: 1, generatedAt: t, dbReadable: true, sessions: [] };

    const sessions = [];
    for (const id of liveIds) {
      const s = get('SELECT id, title, directory FROM session WHERE id = ?', id);
      if (!s) continue;

      // live activity: tool rows and messages are written in real time
      const lastTool = get('SELECT tool_name, status, started_at FROM tool_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1', id);
      const lastMsgAt = get('SELECT time_created FROM message WHERE session_id = ? ORDER BY sequence DESC LIMIT 1', id)?.time_created ?? 0;
      // real user instructions land in session_input(status='promoted'); raw message rows mix in tool results
      const lastInput = get(`SELECT id, promoted_message_id, time_created FROM session_input WHERE session_id = ? AND status = 'promoted' ORDER BY time_created DESC LIMIT 1`, id);
      const toolActive = !!(lastTool && lastTool.status === 'running' && t - lastTool.started_at < RUNNING_WINDOW_MS);
      const msgActive = t - lastMsgAt < MSG_ACTIVE_MS;
      const running = toolActive || msgActive;

      const turn = get('SELECT * FROM turn_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1', id);
      const todos = all('SELECT content, status FROM todo WHERE session_id = ? ORDER BY position LIMIT 12', id);
      const inputs = all('SELECT kind, status, time_created FROM session_input WHERE session_id = ? ORDER BY time_created DESC LIMIT 20', id)
        .filter(r => ATTENTION_INPUT(r.status) && !INPUT_KIND_EXCLUDE.has(String(r.kind)) && r.time_created > t - RUNNING_WINDOW_MS && r.time_created < t - INPUT_SETTLE_MS);
      const usage = get('SELECT COUNT(*) n, COALESCE(SUM(computed_total_tokens),0) tokens FROM turn_usage WHERE session_id = ? AND started_at > ?', id, dayStart);

      sessions.push({
        id: s.id, shortId: s.id.replace(/^(sess|session)_/, '').slice(0, 6),
        title: String(s.title || basename(s.directory || '') || '未命名会话').slice(0, 60),
        workspace: basename(s.directory || ''),
        status: inputs.length > 0 ? '等待输入' : running ? '运行中' : '空闲',
        running, activeSince: running ? (toolActive ? lastTool.started_at : lastInput?.time_created ?? lastMsgAt) : null,
        currentTool: toolActive ? lastTool.tool_name : null,
        lastTurn: turn ? { id: turn.turn_id, status: turn.status, completedAt: turn.completed_at,
          durationMs: turn.duration_ms ?? null, toolCalls: turn.tool_call_count ?? 0 } : null,
        todos: { total: todos.length, done: todos.filter(x => x.status === 'completed').length,
          inProgress: todos.filter(x => x.status === 'in_progress').length,
          top: todos.filter(x => x.status !== 'completed').slice(0, 4).map(x => ({ content: String(x.content).slice(0, 40), status: x.status })) },
        pendingInputs: inputs.map(x => ({ kind: x.kind, timeCreated: x.time_created })),
        tokens24h: usage.tokens, turns24h: usage.n,
        lastInputId: lastInput?.id ?? null, lastInputMsgId: lastInput?.promoted_message_id ?? null,
        lastActivityAt: Math.max(lastMsgAt, lastTool?.started_at ?? 0),
      });
    }
    sessions.sort((a, b) => (b.running - a.running) || (b.lastActivityAt - a.lastActivityAt));
    return { protocolVersion: 1, generatedAt: t, dbReadable: true, sessions };
  }

  diff(next) {
    const t = this.now();
    for (const s of next.sessions) {
      let p = this.prev.get(s.id);
      if (!p) { p = { turnId: s.lastTurn?.id ?? null, lastInputId: s.lastInputId, hadPending: false }; this.prev.set(s.id, p); }

      // new promoted session_input = a real user instruction (tool results don't land here)
      if (s.lastInputId && p.lastInputId !== s.lastInputId) {
        p.lastInputId = s.lastInputId;
        this.push('turn_started', s, '收到新指令', `${s.title}：${s.lastInputMsgId ? (this.userPromptText(s.id, s.lastInputMsgId) || '开始执行') : '开始执行'}`);
      }

      // turn_usage rows land on completion → emit done/failed once per turn id
      if (s.lastTurn && s.lastTurn.id !== p.turnId) {
        p.turnId = s.lastTurn.id;
        const st = String(s.lastTurn.status);
        const kind = st === 'completed' ? 'turn_done' : 'turn_ended';
        const stCn = { completed: '完成', interrupted: '被中止', cancelled: '被取消', failed: '失败' }[st] || st;
        this.push(kind, s,
          st === 'completed' ? `任务完成 · ${fmtDur(s.lastTurn.durationMs ?? 0)}` : `任务${stCn}`,
          st === 'completed' ? (this.finalAnswerText(s.id, s.lastTurn.id) || `${s.title}（${s.lastTurn.toolCalls} 次工具调用）`) : s.title);
      }

      // pending input appears
      const hasPending = s.pendingInputs.length > 0;
      if (hasPending && !p.hadPending) this.push('needs_attention', s, 'ZCode 等待你的输入', `${s.title}：${s.pendingInputs[0].kind || '输入请求'}待处理`);
      p.hadPending = hasPending;
    }
    this.events = this.events.filter(e => e.expiresAt > t);
  }

  textOfFirstPart(sessionId, messageId) {
    try {
      const rows = this.open().prepare('SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY sequence LIMIT 3').all(sessionId, messageId);
      for (const r of rows) { const d = JSON.parse(r.data); if (d.type === 'text' && d.text) return String(d.text).replace(/\s+/g, ' ').trim(); }
    } catch {}
    return '';
  }
  userPromptText(sessionId, messageId) { return this.textOfFirstPart(sessionId, messageId).slice(0, 120); }

  finalAnswerText(sessionId, turnId) {
    try {
      const turn = this.open().prepare('SELECT user_message_id FROM turn_usage WHERE session_id = ? AND turn_id = ?').get(sessionId, turnId);
      if (!turn?.user_message_id) return '';
      const parts = this.open().prepare(
        `SELECT p.data FROM part p JOIN message m ON p.message_id = m.id
         WHERE p.session_id = ? AND json_extract(m.data,'$.role') = 'assistant'
           AND m.sequence > (SELECT sequence FROM message WHERE id = ?)
         ORDER BY p.sequence DESC LIMIT 8`).all(sessionId, turn.user_message_id);
      for (const p of parts) { try { const d = JSON.parse(p.data); if (d.type === 'text' && d.text) return String(d.text).replace(/\s+/g, ' ').trim(); } catch {} }
    } catch {}
    return '';
  }

  latestAssistantText(sessionId) {
    try {
      const row = this.open().prepare(
        `SELECT p.data FROM part p JOIN message m ON p.message_id = m.id
         WHERE p.session_id = ? AND json_extract(m.data,'$.role')='assistant' AND json_extract(p.data,'$.type')='text'
         ORDER BY p.sequence DESC LIMIT 1`).get(sessionId);
      if (!row) return '';
      return String(JSON.parse(row.data).text || '').trim();
    } catch { return ''; }
  }

  // 跟随直播：取会话中 time_created > since 的新增 part（用户消息/AI文本/工具调用）
  // 注：part.sequence 是消息内序号(0-N循环)、id 是 UUID——都不能做水位，必须用 time_created
  streamUpdates(sessionId, sinceTs) {
    try {
      const rows = this.open().prepare(
        `SELECT p.data AS pdata, p.time_created AS ts, json_extract(m.data,'$.role') AS role
         FROM part p JOIN message m ON p.message_id = m.id
         WHERE p.session_id = ? AND p.time_created > ? ORDER BY p.time_created LIMIT 30`).all(sessionId, sinceTs);
      const out = [];
      for (const r of rows) {
        let d; try { d = JSON.parse(r.pdata); } catch { continue; }
        if (d.type === 'text' && d.text) {
          const t = String(d.text);
          if (/^<total_tokens|^<system-reminder|tokens left<\/total_tokens/.test(t.trim())) continue; // 系统内部标记不上镜
          out.push({ ts: r.ts, role: r.role, kind: 'text', text: t });
        }
        else if (d.type === 'tool' && d.tool) out.push({ ts: r.ts, role: r.role, kind: 'tool', text: String(d.tool) });
      }
      return out;
    } catch { return []; }
  }

  currentMaxSeq(sessionId) {
    try { return this.open().prepare('SELECT COALESCE(MAX(time_created),0) AS m FROM part WHERE session_id = ?').get(sessionId).m; }
    catch { return 0; }
  }

  isSessionAlive(sessionId) {
    try { return !!this.open().prepare('SELECT 1 FROM session_runtime_presence WHERE session_id = ?').get(sessionId); }
    catch { return false; }
  }

  // 完整 todo 清单（按 position；用于眼镜进度板）
  todosOf(sessionId, limit = 8) {
    try {
      return this.open().prepare('SELECT content, status FROM todo WHERE session_id = ? ORDER BY position LIMIT ?').all(sessionId, limit)
        .map(t => ({ content: String(t.content).replace(/\s+/g, ' ').slice(0, 22), status: String(t.status) }));
    } catch { return []; }
  }

  push(kind, session, title, content) {
    const t = this.now();
    const last = this.events[this.events.length - 1];
    if (last && last.kind === kind && last.sessionId === session.id && t - last.createdAt < EVENT_COOLDOWN_MS) return;
    this.events.push({ id: randomUUID(), kind, sessionId: session.id, shortId: session.shortId,
      title: title.slice(0, 80), content: String(content || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 350),
      createdAt: t, expiresAt: t + EVENT_TTL_MS });
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    this.lastSnapshot = { ...this.lastSnapshot, events: [...this.events] }; // hook 事件立即对 /v1/state 可见
    this.emit('event', this.events[this.events.length - 1]);
  }

  // 供 hooks 即时推送调用：毫秒级事件，与轮询差分共用冷却去重
  pushExternal({ event, sessionId, tool, prompt, preview }) {
    const snap = this.snapshot();
    const s = snap.sessions.find(x => x.id === sessionId)
      || { id: sessionId || 'unknown', shortId: String(sessionId || 'unk').slice(-6), title: '会话' };
    if (event === 'Stop') {
      this.push('turn_done', s, '任务完成 · 即时', preview || s.title);
    } else if (event === 'PermissionRequest') {
      this.push('needs_attention', s, 'ZCode 等待你的批准（即时）', `${s.title}${tool ? '：' + tool : ''}`);
    } else if (event === 'UserPromptSubmit') {
      this.push('turn_started', s, '收到新指令（即时）', `${s.title}：${prompt || '开始执行'}`);
    } else if (event === 'PostToolUseFailure') {
      this.push('tool_failed', s, `工具失败 · ${tool || ''}`.trim(), s.title);
    }
  }

  snapshot() { return this.lastSnapshot; }
}
