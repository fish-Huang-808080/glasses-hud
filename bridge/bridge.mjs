// zcode-glasses bridge — exposes ZCode live session state over local HTTP.
// Pattern follows Turbo-IO codex-bridge: bearer token, no credentials logged,
// bounded payloads, no user content printed to console.
//
// Endpoints:
//   GET  /health                (no auth) liveness + db readability
//   GET  /v1/state              (bearer)  full session snapshot + event stream
//   POST /v1/chat/completions   (bearer)  OpenAI-compatible; answers from local
//                                        ZCode state (no external model called)
//
// Run: node bridge.mjs [--host 127.0.0.1] [--port 8790] [--db <path>] [--token-file <path>]

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ZCodeSource } from './zcode-source.mjs';
import { feishu, feishuWrites } from './feishu.mjs';
import { tinySearch, hasTinyfish } from './tinyfish.mjs';

// 语音写操作的中间态（两步确认：预览 → "确认"/"算了"），60 秒有效
let pendingWrite = null;
let lastTasks = []; // 最近一次"我的待办"展示的清单（供"完成第N个"定位）
let lastListOrder = []; // 最近一次"项目列表"的会话顺序（供"跟随第N个"定位，避免排序漂移）

// 自动跟随配置：.state/follow.json {"auto":true} —— 选中自有模型后首句直接进投屏
function loadAutoFollow() {
  try { return !!JSON.parse(readFileSync(resolve(here, '../.state/follow.json'), 'utf8')).auto; } catch { return false; }
}

// 跟随直播模式（认真工作模式）状态
let followActive = false;    // 当前是否有活跃直播流
let followStop = false;
let followState = null;      // { sessionId, title, seq, expiresAt } — 断连后保留 5 分钟供自动重连

const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const now = () => Date.now();
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(n);
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`; };
const fmtClock = (t) => new Date(t).toTimeString().slice(0, 5);

const dbPath = resolve(option('--db', `${homedir()}/.zcode/cli/db/db.sqlite`));
const host = option('--host', '127.0.0.1');
const port = Number(option('--port', '8790'));
const tokenFile = resolve(option('--token-file', `${here}/../.state/bridge.token`));

if (!existsSync(tokenFile)) {
  mkdirSync(dirname(tokenFile), { recursive: true });
  const t = randomBytes(24).toString('base64url');
  writeFileSync(tokenFile, t); try { chmodSync(tokenFile, 0o600); } catch {}
  console.log(`[bridge] generated token file: ${tokenFile} (fill its value into the phone as the model API key)`);
}
const token = readFileSync(tokenFile, 'utf8').trim();
const expected = Buffer.from('Bearer ' + token);

// 事件→飞书推送策略（终态通知：外出托管时"有结果了就喊"）。.state/notify.json 可覆盖。
function loadNotifyKinds() {
  const def = { needs_attention: true, turn_done: true, turn_ended: true, tool_failed: true };
  try {
    const j = JSON.parse(readFileSync(resolve(here, '../.state/notify.json'), 'utf8'));
    return { ...def, ...j };
  } catch { return def; }
}
const NOTIFY_KINDS = loadNotifyKinds();
const WEATHER_FILE = resolve(here, '../.state/weather.json');
let WeatherCache = (() => { try { const j = JSON.parse(readFileSync(WEATHER_FILE, 'utf8')); return { at: j.at || 0, text: j.text || '' }; } catch { return { at: 0, text: '' }; } })(); // 气温缓存（落盘，重启不丢）
const DS_FILE = resolve(here, '../.state/ds-balance.json');
let DsCache = (() => { try { const j = JSON.parse(readFileSync(DS_FILE, 'utf8')); return { at: j.at || 0, text: j.text || '' }; } catch { return { at: 0, text: '' }; } })();
async function getDsBalance() {
  if (DsCache.text && Date.now() - DsCache.at < 10 * 60_000) return DsCache.text;
  try {
    const cfgPath = resolve(homedir(), '.zcode/v2/provider_config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const rule = (cfg?.config?.providerConfigRules?.providerRules || []).find(x => x.providerId === 'deepseek');
    const key = rule?.config?.access?.apiKey;
    if (!key) return DsCache.text || '';
    const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal });
    clearTimeout(tm);
    if (res.ok) {
      const j = await res.json();
      const b = (j.balance_infos || []).find(x => x.currency === 'CNY') || (j.balance_infos || [])[0];
      if (b && b.total_balance != null) {
        const t = '¥' + Number(b.total_balance).toFixed(2);
        DsCache = { at: Date.now(), text: t };
        try { writeFileSync(DS_FILE, JSON.stringify(DsCache)); } catch {}
        return t;
      }
    }
  } catch {}
  return DsCache.text || '';
}

const source = new ZCodeSource({ dbPath, pollMs: 2000, now });
source.on('event', (e) => {
  console.log(`[event] ${e.kind} session=${e.shortId}`); // ids only, never content
  if (NOTIFY_KINDS[e.kind]) {
    const tag = { needs_attention: '等待确认', turn_done: '任务完成', turn_ended: '任务中止', tool_failed: '工具失败' }[e.kind] || e.kind;
    feishuWrites.notify(`【ZCode·${tag}】${e.title}。${e.content}`); // 模式B：飞书推送
  }
  // 事件行回显到眼镜监视屏（任何会话的"等你确认"都要冒出来）
  if (e.kind === 'needs_attention' && followState && followState.push) {
    followState.push(`! 等待确认：${String(e.content || e.title).slice(0, 16)}`);
  }
});

// ---------- 小码大脑：LLM 兜底（规则意图未命中时） ----------
// .state/llm.json 可覆写；apiKey 支持 "from-zcode:<providerId>" 运行时读取 ZCode 配置，不复制密钥。
function loadLlmConfig() {
  try {
    const own = resolve(here, '../.state/llm.json');
    if (existsSync(own)) {
      const j = JSON.parse(readFileSync(own, 'utf8'));
      if (j && j.enabled === false) return null;
      if (j && Array.isArray(j.providers) && j.providers.length) return j;
    }
  } catch {}
  try { // 自动探测 ZCode 的 provider 配置
    const p = resolve(homedir(), '.zcode/v2/provider_config.json');
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const rules = j?.config?.providerConfigRules?.providerRules || [];
    const providers = [];
    for (const r of rules) {
      const access = r?.config?.access || {};
      if (access.type !== 'api-key' || !access.apiKey) continue;
      const baseUrl = (r?.config?.api || {}).baseUrl || (r.providerId === 'deepseek' ? 'https://api.deepseek.com/v1' : null);
      const model = (r?.config?.modelOrder || [])[0];
      if (!baseUrl || !model) continue;
      providers.push({ id: r.providerId, baseUrl, model, apiKey: 'from-zcode:' + r.providerId, maxTokens: 500 });
    }
    return providers.length ? { enabled: true, autoDetected: true, timeoutMs: 15000, providers } : null;
  } catch { return null; }
}
const LLM = loadLlmConfig();

function zcodeKey(providerId) {
  try {
    const j = JSON.parse(readFileSync(resolve(homedir(), '.zcode/v2/provider_config.json'), 'utf8'));
    const r = (j?.config?.providerConfigRules?.providerRules || []).find(x => x.providerId === providerId);
    return r?.config?.access?.apiKey || '';
  } catch { return ''; }
}

function stateContext(snap) {
  return {
    now: fmtClock(now()),
    sessions: snap.sessions.slice(0, 6).map(s => ({
      title: s.title, status: s.status,
      runningFor: s.running && s.activeSince ? fmtDur(now() - s.activeSince) : null,
      tool: s.currentTool, todos: `${s.todos.done}/${s.todos.total}`,
      tokens24h: s.tokens24h,
      lastTurn: s.lastTurn ? { status: s.lastTurn.status, at: s.lastTurn.completedAt ? fmtClock(s.lastTurn.completedAt) : null, dur: fmtDur(s.lastTurn.durationMs || 0) } : null,
      pending: s.pendingInputs.length,
    })),
    recentEvents: snap.events.slice(-8).map(e => ({ at: fmtClock(e.createdAt), kind: e.kind, title: e.title, content: String(e.content || '').slice(0, 120) })),
  };
}

const SYSTEM_PROMPT = `你是运行在用户雷鸟 iO 智能眼镜上的编程助手 HUD（无需名字，唤醒词"小雷小雷"已由眼镜处理）。用户说"电脑"指代 ZCode（编程智能体系统），说"项目"指代 ZCode 里的会话。你替用户盯着电脑上的编程会话（数据来自 ZCode 本地数据库，每次调用时是最新的）。
回答规则：
- 极简中文，最多 8 行，每行不超过 20 个字，适合小屏幕阅读
- 不要 markdown、代码块、表情、客套话，直接给信息
- 只根据下面提供的状态数据回答；数据里没有的就说"我看不到这个"
- 用户问"哪个/谁/多少"时给具体的项目名和数字`;

// bridge 自有工具：模型选工具，bridge 执行（不依赖手机端注册）
const BRIDGE_TOOLS = [{
  type: 'function',
  function: {
    name: 'web_search',
    description: '搜索公开互联网最新资料（新闻/时事/技术文档/价格等）。ZCode 状态之外的问题优先用它。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        recency_minutes: { type: 'number', description: '新鲜度过滤（分钟），新闻类建议 1440' },
      },
      required: ['query'],
    },
  },
}];

async function callLlmOnce(prim, messages, tools, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(prim.baseUrl + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + prim.key },
      body: JSON.stringify({
        model: prim.model, max_tokens: 800, temperature: 0.2,
        thinking: { type: 'disabled' },
        messages,
        ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    return j?.choices?.[0]?.message || null;
  } catch { clearTimeout(timer); return null; }
}

async function callLlm(question, snap) {
  const prim = llmPrimary();
  if (!prim || !LLM) return null;
  const mkMessages = () => [
    { role: 'system', content: SYSTEM_PROMPT + (hasTinyfish() ? '\n你可用 web_search 工具查询外部最新信息；搜到的内容给用户时注明来源站点。' : '') },
    { role: 'user', content: '当前 ZCode 状态数据：\n' + JSON.stringify(stateContext(snap)) + '\n\n用户的问题：' + question },
  ];
  let msg = await callLlmOnce(prim, mkMessages(), hasTinyfish() ? BRIDGE_TOOLS : null);
  // 工具执行回路：DeepSeek 调 web_search → bridge 执行 → 结果回传 → 二轮作答
  if (msg?.tool_calls?.length && hasTinyfish()) {
    const msgs = [...mkMessages(), msg];
    for (const tc of msg.tool_calls.slice(0, 2)) {
      let result = '工具不可用';
      if (tc.function?.name === 'web_search') {
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          console.log(`[tf-search] ${String(args.query).slice(0, 50)}`);
          result = (await tinySearch(args.query, args.recency_minutes))?.join('\n') || '无搜索结果';
        } catch { result = '搜索参数错误'; }
      }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 4000) });
    }
    msg = await callLlmOnce(prim, msgs, null); // 二轮不再带工具，防循环
  }
  const text = (msg?.content && String(msg.content).trim()) || msg?.reasoning_content || '';
  if (text) return cleanForGlasses(String(text)).split('\n').map(x => x.trim()).filter(Boolean).slice(0, 10);
  return null;
}

// ---------- 工具透传：模型选工具，手机执行 ----------
// 手机在请求里携带本地能力的 tools 定义；HUD 未命中时原样转发 DeepSeek，
// 其返回的 tool_calls / 文本透传回手机（手机执行导航等原生功能）。
function llmPrimary() {
  const p = (LLM?.providers || [])[0];
  if (!p) return null;
  const key = String(p.apiKey || '').startsWith('from-zcode:') ? zcodeKey(p.apiKey.slice(11)) : p.apiKey;
  return key ? { baseUrl: String(p.baseUrl).replace(/\/$/, ''), model: p.model, key } : null;
}

// 长文提炼（妙记纪要 → 眼镜短行）：DeepSeek 压缩，失败返回 null
async function llmDigest(question, text) {
  const prim = llmPrimary();
  if (!prim || !text) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(prim.baseUrl + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + prim.key },
      body: JSON.stringify({
        model: prim.model, max_tokens: 800, temperature: 0.2,
        thinking: { type: 'disabled' }, // deepseek-flash 默认可能思考，正文会空
        messages: [
          { role: 'system', content: '把会议纪要提炼成不超过8行的中文要点，每行不超过20字，适合智能眼镜小屏阅读。不要markdown、不要客套。用户问了具体问题时优先回答该问题。' },
          { role: 'user', content: `用户问题：${question}\n\n会议AI纪要：\n${text.slice(0, 6000)}` },
        ],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) { console.log(`[digest] upstream ${res.status}: ${(await res.text()).slice(0, 200)}`); return null; }
    const j = await res.json();
    const msg = j?.choices?.[0]?.message || {};
    const t = msg.content && String(msg.content).trim() ? msg.content : (msg.reasoning_content || ''); // 兜底：思考型模型正文可能空
    if (t && String(t).trim()) return cleanForGlasses(String(t)).split('\n').map(x => x.trim()).filter(Boolean).slice(0, 8);
    console.log(`[digest] empty content: ${JSON.stringify(j).slice(0, 200)}`);
  } catch (e) { console.log(`[digest] err ${e.message}`); }
  return null;
}

// ---------- glasses-hud：意图引擎（glass-friendly：短行、无 markdown） ----------

let selectedSessionId = null; // 任务钻取的当前选中（单用户 HUD，进程级状态即可）
const CN_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

function digestState(snap) {
  const lines = [];
  if (!snap.sessions.length) return ['小码：ZCode 没有活跃会话', `检查时间 ${fmtClock(snap.generatedAt)}`];
  const totalTok = snap.sessions.reduce((a, s) => a + (s.tokens24h || 0), 0);
  for (const s of snap.sessions.slice(0, 4)) {
    const mark = s.status === '等待输入' ? '!' : s.running ? '>' : '·';
    lines.push(`${mark} ${s.title.slice(0, 18)} ${s.status}`);
    if (s.running && s.activeSince) {
      lines.push(`  ${fmtDur(now() - s.activeSince)}${s.currentTool ? ' · ' + String(s.currentTool).slice(0, 16) : ''}`);
    }
    if (s.status === '等待输入') lines.push('  需要你到电脑前确认');
    if (s.todos.total > 0) lines.push(`  todo ${s.todos.done}/${s.todos.total}`);
  }
  if (totalTok > 0) lines.push(`24h tokens ${fmtTok(totalTok)}`);
  lines.push('说"电脑的项目"选一个跟进');
  return lines.slice(0, 12);
}

function digestTodos(snap) {
  const s = snap.sessions.find(x => x.id === selectedSessionId && x.todos.total > 0) || snap.sessions.find(x => x.todos.total > 0) || snap.sessions[0];
  if (!s || !s.todos.top.length) return [`${s ? s.title.slice(0, 16) : 'ZCode'}：没有待办`];
  return [`${s.title.slice(0, 16)} 待办 ${s.todos.done}/${s.todos.total}`,
    ...s.todos.top.map((t, i) => `${i + 1}. ${t.content} [${t.status === 'in_progress' ? '进行中' : '待办'}]`)].slice(0, 10);
}

function digestEvents(snap) {
  const es = snap.events.slice(-6).reverse();
  if (!es.length) return ['最近一小时没有新事件'];
  return es.map(e => `${fmtClock(e.createdAt)} ${e.title}`);
}

function sessionCard(s) {
  const lines = [`【${s.title.slice(0, 14)}】${s.status}`];
  if (s.running && s.activeSince) lines.push(`已跑 ${fmtDur(now() - s.activeSince)}${s.currentTool ? ' · ' + s.currentTool : ''}`);
  else if (s.lastTurn?.completedAt) lines.push(`上次完成 ${fmtClock(s.lastTurn.completedAt)} · 耗时 ${fmtDur(s.lastTurn.durationMs || 0)}`);
  if (s.status === '等待输入') lines.push('! 在等你确认');
  if (s.todos.total > 0) lines.push(`todo ${s.todos.done}/${s.todos.total}`);
  lines.push(`24h tokens ${fmtTok(s.tokens24h || 0)}`);
  lines.push('说"最新回复"看它刚说了什么');
  return lines;
}

// 眼镜监视器用的"任务进度卡"：只看子任务拆分与完成度，不暴露对话/工具流水
// compact=true：3 行精简版（说话把卡顶掉后，重连即时补一张，最少占屏）
function buildProgressCard(source, sid, compact = false) {
  const snap = source.snapshot();
  const s = snap.sessions.find(x => x.id === sid);
  if (!s) return null;
  const todos = source.todosOf(sid, 8);
  const total = todos.length;
  const done = todos.filter(t => t.status === 'completed').length;
  const attn = s.status === '等待输入' ? '! ' : '';
  const head = `${attn}【${s.title.slice(0, 12)}】${s.status}${s.running && s.activeSince ? ' · ' + fmtDur(now() - s.activeSince) : ''} · ${fmtClock(now())}${total ? ` · 待办 ${done}/${total}` : ''}`;
  const lines = [head];
  if (compact) {
    if (total) {
      const cells = 10, filled = Math.max(0, Math.min(cells, Math.round(cells * done / total)));
      lines.push(`进度 ${'█'.repeat(filled)}${'░'.repeat(cells - filled)} ${done}/${total}`);
      const cur = todos.find(t => t.status === 'in_progress') || todos.find(t => t.status !== 'completed');
      if (cur) lines.push(`▶ ${cur.content}`);
    } else if (s.running) {
      lines.push(`进行中${s.currentTool ? ' · ' + s.currentTool : ''}`);
    }
    return { lines: lines.slice(0, 3), sig: null, compact: true };
  }
  if (total) {
    const cells = 10, filled = Math.max(0, Math.min(cells, Math.round(cells * done / total)));
    lines.push(`进度 ${'█'.repeat(filled)}${'░'.repeat(cells - filled)} ${done}/${total}`);
    for (const t of todos.slice(0, 6)) {
      const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '·';
      lines.push(`${mark} ${t.content}`);
    }
    if (total > 6) lines.push(`…另 ${total - 6} 项`);
    if (s.status === '等待输入') lines.push('! 等待你确认');
  } else if (s.running) {
    lines.push(`进行中${s.currentTool ? ' · ' + s.currentTool : ''}`);
  } else if (s.lastTurn?.completedAt) {
    lines.push(`上次完成 ${fmtClock(s.lastTurn.completedAt)} · ${fmtDur(s.lastTurn.durationMs || 0)}`);
  }
  // 回合结束：补一行"这次做完了什么"（答案首行，摘要级）
  if (s.lastTurn?.completedAt && now() - s.lastTurn.completedAt < 10 * 60_000) {
    const ans = cleanForGlasses(source.latestAssistantText(sid)).split('\n').find(x => x.trim());
    if (ans) lines.push(`✓ ${ans.slice(0, 26)}`);
  }
  const sig = [s.status, s.lastTurn?.id || '', todos.map(t => (t.status[0] || '') + t.content).join('|')].join('#');
  return { lines: lines.slice(0, 9), sig };
}

// 眼镜上别显示 markdown 噪音
const cleanForGlasses = (t) => t.replace(/```[\s\S]*?```/g, m => m.replace(/```/g, '')).replace(/[*#`>|]/g, '').replace(/\n{3,}/g, '\n\n').trim();
const tailText = (t, max = 230) => (t.length <= max ? t : '…' + t.slice(-max));

async function answerFor(messages, snap, source, reqTools) {
  let q = String(messages?.at(-1)?.content || '').trim();
  q = q.replace(/^小雷[，,。!！?\s]*/, '').replace(/^小码[，,。!！?\s]*/, '').replace(/小码/g, '').trim();
  q = q.replace(/[。！？.!?，,\s]+$/g, '').trim(); // ASR 常带句号，去掉再做指令匹配
  console.log(`[${new Date().toTimeString().slice(0, 8)}][q] ${q.slice(0, 60)}`); // 调试：App 发来的原文（本地日志）

  // HUD 模式显式开关（默认关闭）：主口令"跟随电脑"；兼容各种组合（打开/开启/电脑跟随…）
  const HUD_MODE = resolve(here, '../.state/hud-mode');
  const hudOn = () => { try { return readFileSync(HUD_MODE, 'utf8').trim() === 'on'; } catch { return false; } };
  const setHud = (on) => { try { writeFileSync(HUD_MODE, on ? 'on' : 'off'); } catch {} };
  const HUD_START = /^(打开|开启|启动|开始|进入)?\s*(电脑)?\s*(跟随|看板|监视)\s*(电脑|状态|模式)?$/;
  const HUD_STOP = /^(停止|关闭|退出|结束|取消)?\s*(电脑)?\s*(跟随|看板|监视)\s*(电脑|状态|模式)?$/;
  if (/^(打开提词器|提词器|启动看板)$/.test(q) || HUD_START.test(q)) {
    setHud(true); console.log('[hud] mode ON (voice)');
    return ['已跟随电脑', '进度看板将常驻镜片', '镜腿退出即可恢复其他功能'];
  }
  if (/^(关闭提词器|停止提词器|退出提词器)$/.test(q) || (HUD_STOP.test(q) && /跟随|看板|监视/.test(q))) {
    setHud(false); console.log('[hud] mode OFF (voice)');
    return ['已停止跟随电脑', '眼镜恢复正常功能'];
  }

  // 跟随直播（含断连自动重连）：App 层任何新语音都会掐断旧流——所以跟随中的
  // 任何输入不再是空响应，而是重连直播（水位续播）。
  // 停止 = "停/停吧/停下/停止跟随/退出跟随/别跟了"；"跟随X"=切换项目（不续播）。
  const STOP_RE = /^(停|停吧|停下|停一停|停止|停止跟随|退出|退出跟随|别跟了|结束)$/;
  const SWITCH_RE = /跟随|直播|投屏|认真工作/;
  if (followState && followState.expiresAt <= now()) followState = null; // 过期清理
  if (followState && !SWITCH_RE.test(q)) {
    if (STOP_RE.test(q) || /停止跟随|退出跟随|别跟了/.test(q)) {
      followStop = true;
      followState = null;
      return ['已停止跟随，交互恢复'];
    }
    return { __resumeFollow: true };
  }

  // 调试：检测文本页是否支持 \r 回车覆盖（决定能否做原地刷新的仪表盘）
  if (/^测试覆盖$|^覆盖测试$/.test(q)) return { __testRefresh: true };
  // 在吗 / 自我介绍
  if (!q || /^(在吗|在不在|你是谁|叫什么|你好|hi|hello|嗨)$/i.test(q)) {
    const running = snap.sessions.filter(s => s.running).length;
    return ['在线 ✓', `电脑上 ${snap.sessions.length} 个项目，${running} 个在跑`, '试试：电脑的项目 / 第1个 / 最新回复', '我的待办 / 明天日程'];
  }
  // 帮助 / 能干什么
  if (/^(帮助|你能干什么|能干啥|会什么|怎么用|指令|用法|help)$/i.test(q)) {
    return ['我能做的：', '电脑的项目 — 看所有会话', '第N个 — 进入某个项目', '最新回复 — 它刚说了什么', '今天/明天/本周日程', '我的待办（飞书）', '会话待办 / 事件 / token', '其他问题直接问，我用AI答'];
  }
  // ===== 跟随直播（认真工作模式）：把会话内容逐条推到眼镜 =====
  if (/停止跟随|退出跟随|别跟了/.test(q)) {
    if (!followActive) return ['当前没有在跟随'];
    followStop = true;
    return ['正在停止跟随…'];
  }
  if (/跟随|直播|投屏|认真工作/.test(q)) {
    let s = null;
    // 序号：第N个 / 第N / N号 / 跟随2；优先按最近一次"项目列表"的顺序（避免顺序漂移）
    const nm = q.match(/第\s*([0-9一二三四五六七八九十]+)\s*个?/) || q.match(/([0-9一二三四五六七八九十]+)\s*号/);
    const order = (lastListOrder.length ? lastListOrder : snap.sessions.map(x => x.id));
    if (/当前|这个|刚才/.test(q)) s = snap.sessions.find(x => x.id === selectedSessionId) || snap.sessions[0];
    else if (nm) {
      const n = CN_NUM[nm[1]] || parseInt(nm[1]);
      const id = order[n - 1];
      s = snap.sessions.find(x => x.id === id);
    }
    else if (nm) s = snap.sessions[(CN_NUM[nm[1]] || parseInt(nm[1])) - 1];
    else {
      // 关键词：去标点/语气词后模糊匹配（ASR 常带"。"和"项目/迭代"等词）
      const kw = q.replace(/跟随|直播|投屏|认真工作|模式|项目|会话|任务|那个|这个|[，。！？、\s]/g, '').trim();
      if (kw.length >= 2) {
        s = snap.sessions.find(x => x.title.replace(/\s/g, '').includes(kw))
          || snap.sessions.find(x => kw.includes(x.title.replace(/\s/g, '').slice(0, 6)))
          || snap.sessions.find(x => x.workspace.includes(kw));
      }
    }
    if (!s) s = snap.sessions[0];
    if (!s) return ['没有可跟随的项目'];
    selectedSessionId = s.id;
    return { __follow: s.id, title: s.title.slice(0, 16) };
  }
  // 任务列表（项目=会话；"在做哪个项目"也算）
  if (/项目列表|电脑.{0,6}项目|在做哪|哪个项目|哪些项目|有什么项目|什么项目|任务列表|会话列表|有哪些任务|列个项目|列个任务/.test(q)) {
    if (!snap.sessions.length) return ['电脑当前没有活跃项目'];
    lastListOrder = snap.sessions.slice(0, 6).map(s => s.id);
    return snap.sessions.slice(0, 6).map((s, i) =>
      `${i + 1}. ${s.title.slice(0, 16)} ${s.status === '运行中' ? '▶' : s.status === '等待输入' ? '!' : '·'}`);
  }
  // 选择任务：第N个 / N号 / 打开X / 进入X / 跟进X（"完成第N个待办"不在此列——否定后顾排除）
  let m = q.match(/(?<!完成|完结|办完|勾掉|删除|去掉)第\s*([0-9一二三四五六七八九十]+)\s*个/) || q.match(/^([0-9一二三四五六]+)\s*号/) || q.match(/^([0-9])$/);
  if (m) {
    const n = CN_NUM[m[1]] || parseInt(m[1]);
    const s = snap.sessions[n - 1];
    if (!s) return [`没有第 ${n} 个任务`, `共 ${snap.sessions.length} 个，说"任务列表"查看`];
    selectedSessionId = s.id;
    return sessionCard(s);
  }
  m = q.match(/(?:打开|进入|跟进|切换到?|看看)\s*(.+)/);
  if (m && snap.sessions.length) {
    const kw = m[1].replace(/的任务|任务|的会话|会话|的/g, '').trim();
    if (kw) {
      const s = snap.sessions.find(x => x.title.includes(kw) || x.workspace.includes(kw));
      if (s) { selectedSessionId = s.id; return sessionCard(s); }
    }
  }
  // 最新回复（当前选中或最活跃会话）
  if (/最新回复|最新回答|它在说什么|说到哪|最新输出|上下文|刚说了什么|详细/.test(q)) {
    let s = snap.sessions.find(x => x.id === selectedSessionId);
    if (!s) { s = snap.sessions[0]; if (s) selectedSessionId = s.id; }
    if (!s) return ['没有活跃会话'];
    const text = cleanForGlasses(source.latestAssistantText(s.id));
    const head = [`【${s.title.slice(0, 14)}】${s.status}`];
    if (!text) return [...head, '还没有回复文本'];
    return [...head, ...tailText(text).split('\n').filter(x => x.trim()).slice(-10)];
  }
  // ===== 飞书待办写操作（两步确认）=====
  const pendingValid = pendingWrite && pendingWrite.expiresAt > now();
  if (/^确认(一下)?$/.test(q) && pendingValid) {
    const op = pendingWrite; pendingWrite = null;
    if (op.kind === 'create') {
      const t = await feishuWrites.createTask(op.summary, op.dueOffset || 0);
      if (!t) return ['创建失败，稍后再试'];
      const g = t.guid || t.id;
      if (g) lastTasks.unshift({ guid: g, label: String(op.summary).slice(0, 20) });
      return [`已创建待办 ✓`, String(op.summary).slice(0, 20), op.dueOffset > 0 ? `期限：${op.dueOffset}天后` : '无期限'];
    }
    if (op.kind === 'complete') {
      const r = await feishuWrites.completeTask(op.guid);
      if (!r) return ['完结失败，稍后再试'];
      return ['已完结 ✓', op.label];
    }
  }
  if (/^确认(一下)?$/.test(q) && !pendingValid) return ['当前没有待确认的操作'];
  if (/^(算了|取消|不要了)$/.test(q)) {
    pendingWrite = null;
    return ['已取消，未做任何改动'];
  }
  // 创建：加个(飞书)待办/任务、记一下、备忘 XXX——"待办/任务"句式会被App本地待办界面
  // 拦截（它弹自己的确认UI顶掉模型回复），故主推"记一下"这个不冲突的触发词。
  let wm = q.match(/(?:加|记|添加|新建|创建)个?(?:飞书)?(?:待办|任务)(.*)/) || q.match(/^(?:记一下|备忘)[:：，,\s]?(.*)/);
  if (wm) {
    let text = (wm[1] || '').replace(/^[:：，,\s]+/, '').trim(); let dueOffset = 0;
    if (!text) return ['好的，要记什么？', '例如：记一下 明天买咖啡', '（将记入飞书待办）'];
    const dm = text.match(/^(明天|后天|大后天)(要|去|得)?/);
    if (dm) { dueOffset = dm[1] === '明天' ? 1 : dm[1] === '后天' ? 2 : 3; text = text.slice(dm[0].length).trim(); }
    if (text.length < 2) return ['待办内容太短，再说一次'];
    pendingWrite = { kind: 'create', summary: text, dueOffset, expiresAt: now() + 60_000 };
    return ['将创建飞书待办：', text.slice(0, 30), dueOffset > 0 ? `期限：${['', '明天', '后天', '大后天'][dueOffset]}` : '无期限', '说"确认"执行，"算了"取消'];
  }
  // 完结：完成第N个待办
  wm = q.match(/(?:完成|完结|办完|勾掉)(?:第)?([0-9一二三四五六七八九十]+)个?(?:待办|任务)?/);
  if (wm && /待办|任务/.test(q) || (wm && lastTasks.length)) {
    const n = CN_NUM[wm[1]] || parseInt(wm[1]);
    const t = lastTasks[n - 1];
    if (!t) return [`没有第 ${n} 条待办`, lastTasks.length ? `共 ${lastTasks.length} 条，先说"我的待办"看清单` : '先说"我的待办"看清单'];
    pendingWrite = { kind: 'complete', guid: t.guid, label: t.label, expiresAt: now() + 60_000 };
    return ['将完结待办：', `${n}. ${t.label}`, '说"确认"执行，"算了"取消'];
  }
  // 妙记/会议纪要检索（须在日历意图之前——两者都含"会议"，这里匹配更具体的纪要类问法）
  if (/妙记|纪要|会议记录|会议的结论|会的结论|会议说了|会议讲了|会说了|会讲了|开会.{0,3}内容/.test(q)) {
    const kw = q.replace(/妙记|纪要|会议记录|会议的结论|会的结论|会议说了|会议讲了|会说了|会讲了|开会.{0,3}内容|的|什么|结论|内容|昨天|今天|前几天|最近|最新|帮我|查|搜|一下|问问?/g, '').trim();
    const list = await feishu.searchMinutes(kw);
    if (!list) return ['妙记查询失败，稍后再试'];
    if (!list.length) {
      const recent = await feishu.searchMinutes('');
      if (recent && recent.length) return ['没搜到「' + kw.slice(0, 10) + '」', '最近的妙记：', ...recent.slice(0, 4).map((m, i) => `${i + 1}. ${m.title}`), '换个会议名关键词试试'];
      return ['没找到相关妙记', '试试带会议名关键词'];
    }
    if (!kw) return ['最近妙记 ' + list.length + ' 条', ...list.slice(0, 5).map((m, i) => `${i + 1}. ${m.title}`), '带会议名关键词可看结论'];
    const top = list[0];
    const summary = await feishu.minuteSummary(top.token);
    if (!summary) return [`【${top.title.slice(0, 14)}】`, '纪要原文获取失败，稍后再试'];
    const digest = await llmDigest(q, summary);
    if (digest) return [`【${top.title.slice(0, 14)}】`, ...digest];
    return [`【${top.title.slice(0, 14)}】`, 'AI提炼失败，稍后再试'];
  }
  // 飞书日历：今天/明天/本周 + 日程|安排|会议|日历
  if (/日程|安排|会议|日历|agenda/i.test(q)) {
    let evs, head = '今天日程';
    if (/明天/.test(q)) { evs = await feishu.agendaTomorrow(); head = '明天日程'; }
    else if (/本周|这周/.test(q)) { evs = await feishu.agendaWeek(); head = '本周日程'; }
    else evs = await feishu.agendaToday();
    if (!evs) return ['飞书查询失败，稍后再试'];
    if (!evs.length) return [`${head}：空闲 ✓`];
    return [`${head} · ${evs.length} 项`, ...evs.slice(0, 8).map(e => `${e.time} ${e.summary}`)].slice(0, 9);
  }
  // 飞书待办："待办"默认指个人（飞书）待办；ZCode 会话的叫"会话待办/todo"
  if (/我的待办|飞书待办|待办清单|^待办$/.test(q)) {
    const r = await feishu.tasks();
    if (!r) return ['飞书任务查询失败，稍后再试'];
    if (!r.mine.length) return ['飞书待办：全部完成 ✓'];
    lastTasks = r.mine.map(t => ({ guid: t.guid, label: t.summary }));
    const lines = [`飞书待办 · ${r.mine.length} 项`, ...r.mine.slice(0, 8).map((t, i) => `${i + 1}. ${t.due ? t.due + ' ' : ''}${t.summary}`)];
    if (r.conv > 0) lines.push(`（另${r.conv}条会话任务已略）`);
    return lines.slice(0, 10);
  }
  // 原有三类（ZCode 侧）
  if (/todo|会话待办|任务清单/.test(q)) return digestTodos(snap);
  if (/事件|通知|完成了什么/.test(q)) return digestEvents(snap);
  if (/token|费用|消耗|用量/.test(q)) {
    const total = snap.sessions.reduce((a, s) => a + (s.tokens24h || 0), 0);
    return [`24h tokens ${fmtTok(total)}`, ...snap.sessions.slice(0, 4).map(s => `${s.title.slice(0, 14)} ${fmtTok(s.tokens24h || 0)}`)];
  }
  // 自动跟随（外出主模式）：以上的具体指令都不命中时，任何话直接进投屏
  if (loadAutoFollow()) {
    const s = snap.sessions.find(x => x.id === selectedSessionId) || snap.sessions[0];
    if (!s) return ['电脑上没有活跃项目'];
    selectedSessionId = s.id;
    return { __follow: s.id, title: s.title.slice(0, 16), auto: true };
  }
  // “电脑”域兜底：提到电脑但未命中具体意图 → 状态总览（本地即时，省 LLM 一跳）
  if (/电脑/.test(q)) return digestState(snap);
  // 工具透传：手机带了本地功能 tools 且 HUD 未命中 → DeepSeek 决定（模型选工具，手机执行）
  if (Array.isArray(reqTools) && reqTools.length) return { __passthrough: true };
  // LLM 兜底：规则未命中 → 大模型（ZCode 状态作上下文）
  const llmAnswer = await callLlm(q, snap);
  if (llmAnswer) return llmAnswer;
  return digestState(snap);
}

// ---------- HTTP ----------

const server = createServer(async (req, res) => {
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  console.log(`[${new Date().toTimeString().slice(0, 8)}][http] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const snap = source.snapshot();
      return json(200, { ok: true, dbReadable: snap.dbReadable, liveSessions: snap.sessions.length, pollMs: 2000 });
    }
    // 本机 hooks 即时事件入口：仅 127.0.0.1，免 token（hooks 无法安全携带；回环限制即鉴权）
    if (req.method === 'POST' && req.url === '/v1/hook') {
      const ra = req.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) return json(403, { error: 'local_only' });
      let body = ''; for await (const c of req) { body += c; if (Buffer.byteLength(body) > 16384) return json(413, { error: 'body_too_large' }); }
      try { source.pushExternal(JSON.parse(body)); return json(200, { ok: true }); }
      catch { return json(400, { error: 'invalid_json' }); }
    }
    const actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return json(401, { error: 'unauthorized' });

    if (req.method === 'GET' && req.url === '/v1/state') return json(200, source.snapshot());

    // 眼镜提词器 HUD：双列拼接（每行≤34半角单位 ≈17汉字），右列放时间/进度
    if (req.method === 'GET' && req.url.startsWith('/v1/hud')) {
      let modeOn = false;
      try { modeOn = readFileSync(resolve(here, '../.state/hud-mode'), 'utf8').trim() === 'on'; } catch {}
      if (!modeOn) { res.writeHead(503); return res.end('hud off'); }
      let gb = -1, pb = -1;
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        gb = Number(u.searchParams.get('gb')); pb = Number(u.searchParams.get('pb'));
      } catch {}
      // 天气（IP 定位，10 分钟缓存）
      const getWeather = async () => {
        if (WeatherCache.text && Date.now() - WeatherCache.at < 10 * 60_000) return WeatherCache.text;
        try {
          const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 4000);
          const r = await fetch('https://wttr.in/?format=%t', { signal: ctrl.signal, headers: { 'User-Agent': 'curl/8.0' } });
          clearTimeout(tm);
          if (r.ok) {
            let s = (await r.text()).trim().replace(/^\+/, '');
            if (/^-?\d+°C$/.test(s)) {
              WeatherCache = { at: Date.now(), text: s };
              try { writeFileSync(WEATHER_FILE, JSON.stringify(WeatherCache)); } catch {}
              return s;
            }
          }
        } catch {}
        return WeatherCache.text || '';
      };
      const weather = await getWeather();
      if (gb !== -1) console.log(`[hud] gb=${gb} pb=${pb}`); // 诊断：手机上来的电量
      const dw = (s) => [...String(s)].reduce((a, ch) => a + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);
      const cut = (s, max) => { let out = '', w = 0; for (const ch of String(s)) { const c = dw(ch); if (w + c > max) break; out += ch; w += c; } return out; };
      // 压缩时长：<1分 显示秒；<1小时 显示分；否则 时+分（避免右列变长撑爆行）
      const durShort = (ms) => {
        const sec = Math.max(0, Math.round(ms / 1000));
        if (sec < 60) return `${sec}秒`;
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}分`;
        return `${Math.floor(min / 60)}时${min % 60}分`;
      };
      const twoCol = (left, right, max = 32) => {
        let r = cut(right, max - 4);
        let l = cut(left, max - dw(r) - 1);
        // 仍超宽：先缩右列，保证总宽不超
        while (dw(l) + 1 + dw(r) > max && dw(r) > 2) r = cut(r, dw(r) - 1);
        while (dw(l) + 1 + dw(r) > max && dw(l) > 2) l = cut(l, dw(l) - 1);
        const pad = Math.max(1, max - dw(l) - dw(r));
        return l + ' '.repeat(pad) + r;
      };
      const snap = source.snapshot();
      const s = snap.sessions.find(x => x.id === selectedSessionId) || snap.sessions[0];
      const lines = [];
      if (!s) {
        lines.push(twoCol('ZCode', fmtClock(now())), '没有活跃项目');
      } else {
        const todos = source.todosOf(s.id, 8);
        const done = todos.filter(t => t.status === 'completed').length;
        const cur = todos.find(t => t.status === 'in_progress') || todos.find(t => t.status !== 'completed');
        const d = new Date();
        const hour = d.getHours();
        const icon = hour >= 6 && hour < 18 ? '日' : '夜'; // 汉字（眼镜字体保证有字形）
        const dateTime = `${icon}${d.getMonth() + 1}/${d.getDate()} ${fmtClock(now())}`;
        // 第1行：日/夜+日期时间（左） | 气温（右）；宽度收到 32 防换行
        lines.push(twoCol(dateTime, weather || "", 33));
        // 第2行：DS 余额（左） | 飞书待办数（右，99+ 封顶）
        let ft = '';
        try { const r = await feishu.tasks(); if (r && Number.isFinite(r.total)) ft = r.total > 99 ? '99+' : String(r.total); } catch {}
        const ds = await getDsBalance();
        lines.push(twoCol(`DS 余额：${ds}`, ft ? `待办 ${ft}` : '', 33));
        // 第3行：项目名（左） | 状态+已跑时长（右）
        const runTxt = s.status === '等待输入' ? '!等确认'
          : (s.running && s.activeSince ? `>${durShort(now() - s.activeSince)}` : '.空闲');
        lines.push(twoCol(s.title.slice(0, 11), runTxt, 33));
        // 第4行：4 格进度条（左） | 百分比（右）
        if (todos.length) {
          const cells = 10, filled = Math.max(0, Math.min(cells, Math.round(cells * done / todos.length)));
          lines.push(`${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`); // 只保留进度条（百分比已去掉）
        }
        // 第5行：全局关注行（等确认 > 其他项目等确认 > 失败 > 最近完成）
        const othersWaiting = snap.sessions.filter(x => x.id !== s.id && x.status === '等待输入').length;
        const failEv = snap.events.filter(e => e.kind === 'tool_failed' && now() - e.createdAt < 10 * 60_000).slice(-1)[0];
        const doneEv = snap.events.filter(e => ['turn_done', 'turn_ended'].includes(e.kind) && now() - e.createdAt < 10 * 60_000).slice(-1)[0];
        let attention = '';
        if (s.status === '等待输入') attention = '! 当前项目等你确认';
        else if (othersWaiting > 0) attention = `! 另有${othersWaiting}项等你确认`;
        else if (failEv) attention = `✗ ${cut(String(failEv.title).replace('工具失败 ·', ''), 12)}`;
        else if (doneEv) attention = `✓ ${cut(String(doneEv.title), 14)}`;
        if (attention) lines.push(attention);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(lines.slice(0, 6).join('\n'));
    }

    // App 检测到用户用镜腿退出提词器 → 通知关闭 HUD 模式（恢复正常功能）
    if (req.method === 'POST' && req.url === '/v1/hud/off') {
      try { writeFileSync(resolve(here, '../.state/hud-mode'), 'off'); } catch {}
      console.log('[hud] mode OFF (glasses exit)');
      return json(200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = ''; for await (const c of req) { body += c; if (Buffer.byteLength(body) > 65536) return json(413, { error: 'body_too_large' }); }
      let parsed; try { parsed = JSON.parse(body); } catch { return json(400, { error: 'invalid_json' }); }
      if (Array.isArray(parsed.tools) && parsed.tools.length) {
        console.log(`[tools] ${parsed.tools.map(t => t?.function?.name || t?.name || '?').join(', ')}`); // 侦察：手机带来了哪些本地能力
      }
      let lines = await answerFor(parsed.messages, source.snapshot(), source, parsed.tools);
      const id = 'chatcmpl-' + randomBytes(6).toString('hex');
      const created = Math.floor(now() / 1000);
      const chunkOf = (delta) => ({ id, object: 'chat.completion.chunk', created, model: 'zcode-hud', choices: [{ index: 0, delta, finish_reason: null }] });
      // 工具透传模式：转发 DeepSeek（带手机给的 tools），tool_calls / 文本原样回传
      if (lines && !Array.isArray(lines) && lines.__passthrough) {
        const prim = llmPrimary();
        if (prim) {
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 30000);
            const up = await fetch(prim.baseUrl + '/chat/completions', {
              method: 'POST', signal: ctrl.signal,
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + prim.key },
              body: JSON.stringify({
                model: prim.model,
                messages: parsed.messages,
                ...(Array.isArray(parsed.tools) && parsed.tools.length ? { tools: parsed.tools, tool_choice: parsed.tool_choice ?? 'auto', parallel_tool_calls: false } : {}),
                stream: true, max_tokens: 800,
              }),
            });
            clearTimeout(timer);
            if (up.ok && up.body) {
              const reader = up.body.getReader();
              const dec = new TextDecoder();
              let buf = '';
              const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' };
              const pump = async (onEvent) => { // 逐个 SSE 事件回调（归一化 \r\n）
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
                  let i;
                  while ((i = buf.indexOf('\n\n')) >= 0) {
                    const raw = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
                    if (!raw.startsWith('data:')) continue;
                    onEvent(raw.slice(5).trim());
                  }
                }
              };
              if (parsed.stream) {
                res.writeHead(200, SSE_HEADERS);
                let ended = false;
                await pump((payload) => {
                  if (ended) return;
                  if (payload === '[DONE]') { try { res.write('data: [DONE]\n\n'); res.end(); } catch {} ended = true; return; }
                  try {
                    const j = JSON.parse(payload);
                    j.id = id; j.model = 'zcode-hud'; // 换马甲；choices/delta 结构原样（含 delta.tool_calls）
                    res.write(`data: ${JSON.stringify(j)}\n\n`);
                  } catch {}
                });
                if (!ended) { try { res.write('data: [DONE]\n\n'); res.end(); } catch {} }
                return;
              }
              // 非流式：聚合 content + tool_calls
              let content = ''; let finish = 'stop';
              const calls = new Map();
              await pump((payload) => {
                if (payload === '[DONE]') return;
                try {
                  const ch = JSON.parse(payload).choices?.[0];
                  if (!ch) return;
                  content += ch.delta?.content || '';
                  for (const tc of (ch.delta?.tool_calls || [])) {
                    const slot = calls.get(tc.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
                    if (tc.id) slot.id = tc.id;
                    if (tc.function?.name) slot.function.name += tc.function.name;
                    if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
                    calls.set(tc.index, slot);
                  }
                  if (ch.finish_reason === 'tool_calls') finish = 'tool_calls';
                } catch {}
              });
              const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(x => x[1]);
              return json(200, { id, object: 'chat.completion', created, model: 'zcode-hud',
                choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }] });
            }
          } catch {}
        }
        lines = digestState(source.snapshot()); // 上游不可用 → 退化本地总览
      }
      // 覆盖能力探测：A → \rB → \rC，看镜片是"三行各一"还是"只显示C"
      if (lines && !Array.isArray(lines) && lines.__testRefresh) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const w = (s) => { try { res.write(`data: ${JSON.stringify(chunkOf({ content: s }))}\n\n`); } catch {} };
        w('覆盖测试A\n'); await new Promise(r => setTimeout(r, 1500));
        w('\r覆盖测试B'); await new Promise(r => setTimeout(r, 1500));
        w('\r覆盖测试C\n'); await new Promise(r => setTimeout(r, 1000));
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'zcode-hud', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n'); res.end();
        return;
      }
      const followReq = lines && !Array.isArray(lines) && (lines.__follow || lines.__resumeFollow);
      if (followReq) {
        const resume = !!lines.__resumeFollow;
        const sid = lines.__follow || followState?.sessionId;
        const title = resume ? (followState?.title || '会话') : lines.title;
        if (!sid) return json(200, { id, object: 'chat.completion', created, model: 'zcode-hud', choices: [{ index: 0, message: { role: 'assistant', content: '没有可跟随的项目' }, finish_reason: 'stop' }] });
        if (!parsed.stream) { console.log(`[${new Date().toTimeString().slice(0, 8)}][follow] NON-STREAM request (App sent stream=false)`); return json(200, { id, object: 'chat.completion', created, model: 'zcode-hud', choices: [{ index: 0, message: { role: 'assistant', content: '跟随模式需流式请求（App 默认开启）' }, finish_reason: 'stop' }] }); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const send = (txt) => { try { res.write(`data: ${JSON.stringify(chunkOf({ content: String(txt) + '\n' }))}\n\n`); } catch {} };
        const ping = () => { try { res.write(`data: ${JSON.stringify(chunkOf({ content: '\u200b' }))}\n\n`); } catch {} }; // 零宽空格心跳：不可见、不换行、不清屏
        const MAX_FOLLOW_MS = 4 * 60 * 60_000; // 安全上限 4 小时（原 30 分钟太短）
        // 续播不显示任何标记；新开只给操作提示（进度卡随后由快照推送）
        if (!resume) {
          send('【监视】说"停"退出，"跟随第N个"切换');
          const list = source.snapshot().sessions.slice(0, 3).map((s, i) => `${i + 1}.${s.title.slice(0, 10)}`).join('  ');
          if (lines.auto && list) send(list);
        }
        followActive = true; followStop = false;
        console.log(`[${new Date().toTimeString().slice(0, 8)}][follow] ${resume ? 'resume' : 'start'} ${sid.slice(-6)} stream=${!!parsed.stream}`);
        // 事件行通道：外部事件（会议临期/等你确认）可实时贴一行到当前监视屏
        if (!followState) followState = { sessionId: sid, title, sig: '', lastAt: 0, lastCardAt: 0, missingSince: 0, todoState: {}, expiresAt: now() + 30 * 60_000 };
        followState.push = (txt) => { try { res.write(`data: ${JSON.stringify(chunkOf({ content: String(txt) + '\n' }))}\n\n`); lastSend = Date.now(); } catch {} };
        let lastSend = Date.now();
        const startedAt = Date.now();
        const finish = (why) => {
          clearInterval(timer);
          followActive = false;
          if (followState) followState.push = null;
          followState = null; // 正常终点（停止/超时/会话死）：清除直播会话
          console.log(`[${new Date().toTimeString().slice(0, 8)}][follow] end: ${why}`);
          try { send(why); res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'zcode-hud', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } catch {}
        };
        // 监视器模式：只在"任务进度有变化"时推一张进度卡，不推对话流水/工具调用
        // 断流重连（通常是用户说话/环境音把页面顶掉）：立刻补一张 3 行精简卡（5 秒内不重复）
        let forceCard = resume && Date.now() - (followState?.lastCardAt || 0) > 5_000;
        const timer = setInterval(() => {
          try {
            if (followStop) return finish('已停止跟随');
            if (Date.now() - startedAt > MAX_FOLLOW_MS) return finish('跟随已满4小时，自动退出');
            // 会话消失给 5 分钟宽限（presence 可能抖动；避免误判退出）
            if (!source.isSessionAlive(followState.sessionId)) {
              if (!followState.missingSince) followState.missingSince = Date.now();
              if (Date.now() - followState.missingSince > 5 * 60_000) return finish('会话已结束，跟随退出');
            } else followState.missingSince = 0;
            followState.expiresAt = now() + 30 * 60_000; // 活跃续期（断连后可续播30分钟）
            const card = buildProgressCard(source, followState.sessionId);
            if (!card) return;
            // 签名 = 状态+todo状态集+回合；变化才推（不周期性换行，避免滚屏）
            if (forceCard && card) {
              forceCard = false;
              followState.lastCardAt = Date.now();
              const mini = buildProgressCard(source, followState.sessionId, true);
              if (mini) for (const ln of mini.lines) send(ln);
              lastSend = Date.now();
              console.log(`[${new Date().toTimeString().slice(0, 8)}][follow] compact card on resume`);
            }
            if (card.sig !== followState.sig) {
              forceCard = false;
              followState.sig = card.sig;
              followState.lastAt = Date.now();
              followState.lastCardAt = Date.now();
              if (followState.shown) send('———'); // 快照分隔
              for (const ln of card.lines) send(ln);
              console.log(`[${new Date().toTimeString().slice(0, 8)}][follow] card pushed (${card.lines.length} lines)`);
              followState.shown = true;
              lastSend = Date.now();
            }
            // App 有30秒无可见内容即掐断的机制（实测：正好30s），零宽心跳不被认。
            // 每25秒推一行"行情条"保住页面：时间+进度+当前子任务（≤24字，慢速滚动，不空白）
            if (Date.now() - lastSend > 25_000) {
              const tt = source.todosOf(followState.sessionId, 8);
              const dd = tt.filter(x => x.status === 'completed').length;
              const cur = tt.find(x => x.status === 'in_progress') || tt.find(x => x.status !== 'completed');
              send(`⏱${fmtClock(now())} ${dd}/${tt.length}${cur ? ' ▶' + cur.content.slice(0, 10) : ''}`);
              console.log(`[${new Date().toTimeString().slice(0, 8)}][follow] tick sent`);
              lastSend = Date.now();
            }
          } catch {}
        }, 2000);
        // 被打断（App 发起新请求导致 close）：不清 followState —— 新请求会自动重连续播（5 分钟窗口）
        res.on('close', () => { clearInterval(timer); followActive = false; if (followState) followState.push = null; console.log(`[${new Date().toTimeString().slice(0, 8)}][follow] client closed after ${Math.round((Date.now() - startedAt) / 1000)}s (state kept)`); });
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        for (const line of lines) {
          res.write(`data: ${JSON.stringify(chunkOf(line ? { content: line + '\n' } : { content: '\n' }))}\n\n`);
          await new Promise(r => setTimeout(r, 120)); // gentle pacing so glasses render progressively
        }
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'zcode-hud', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n'); res.end();
      } else {
        return json(200, { id, object: 'chat.completion', created, model: 'zcode-hud',
          choices: [{ index: 0, message: { role: 'assistant', content: lines.join('\n') }, finish_reason: 'stop' }] });
      }
      return;
    }
    json(404, { error: 'not_found' });
  } catch (error) { console.log(`[${new Date().toTimeString().slice(0, 8)}][http] error: ${error?.message || error}`); json(500, { error: 'internal_error' }); }
});

server.listen(port, host, () => {
  source.start();
  console.log(`[bridge] zcode-glasses listening on http://${host}:${port} (db: ${dbPath})`);
  console.log('[bridge] endpoints: GET /health, GET /v1/state, POST /v1/chat/completions');

  // 会前提醒：每 5 分钟检查今日日程。T-30 推眼镜事件行（一次）；T-9~20 推飞书（一次）
  const reminded = new Set();
  const reminded30 = new Set();
  const remindTick = async () => {
    try {
      const evs = await feishu.agendaToday();
      if (!Array.isArray(evs)) return;
      const nowMs = now();
      for (const e of evs) {
        if (e.allDay || !e.id) continue;
        const mins = (new Date(e.startIso).getTime() - nowMs) / 60000;
        // 眼镜事件行：T-30 分钟（25~35 窗口，只一次）
        if (mins > 25 && mins <= 35 && !reminded30.has(e.id)) {
          reminded30.add(e.id);
          const line = `⚡ ${e.time} ${e.summary.slice(0, 12)} · ${Math.round(mins)}分后`;
          if (followState && followState.push) followState.push(line);
          console.log(`[remind30] ${line}`);
        }
        if (mins > 9 && mins <= 20 && !reminded.has(e.id)) {
          reminded.add(e.id);
          console.log(`[remind] ${e.time} ${e.summary}`);
          feishuWrites.notify(`【会前提醒】${Math.round(mins)}分钟后：${e.summary}（${e.time}）`);
        }
      }
    } catch {}
  };
  setTimeout(remindTick, 15000); // 启动后先查一轮
  setInterval(remindTick, 5 * 60 * 1000);
});
const stop = () => { source.stop(); server.close(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
