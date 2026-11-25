// 飞书数据源：经 lark-cli（用户身份）只读查询日历与任务，带 90s 缓存。
// 所有命令参数均由程序生成（ISO 日期），无用户输入注入面。
import { exec } from 'node:child_process';

// 过期后返回策略（lark-cli 每次要 fork 进程，约 1 秒；不能让 /v1/hud 的请求路径等它）：
//   fresh   —— TTL 内，直接返回
//   stale   —— 过期但未超过 STALE_MAX：立刻返回旧值，同时后台刷新（不阻塞请求）
//   absent  —— 太旧或从未成功：仍会等待一次（仅冷启动）
const TTL_MS = 90 * 1000;
const STALE_MAX_MS = 30 * 60 * 1000;
const cache = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> Promise，合并并发的同一请求

function runLark(args) {
  return new Promise((resolve) => {
    exec(`lark-cli ${args}`, { timeout: 20000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err || !stdout) {
        console.log(`[lark:fail] ${args.split(' ').slice(0, 3).join(' ')} | err=${err ? String(err.message).slice(0, 120) : 'empty'}`);
        return resolve(null);
      }
      try { const j = JSON.parse(stdout); resolve(j.ok ? (j.data ?? null) : null); }
      catch { console.log(`[lark:parse] ${args.split(' ').slice(0, 3).join(' ')} | head=${String(stdout).slice(0, 100)}`); resolve(null); }
    });
  });
}

function refresh(key, fetcher) {
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const value = await fetcher();
        if (value) cache.set(key, { at: Date.now(), value }); // 失败不更新时间戳，下次重试
        return value;
      } catch { return null; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
  }
  return p;
}

async function cached(key, fetcher) {
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (age < TTL_MS) return hit.value;
  if (hit && age < STALE_MAX_MS) {
    refresh(key, fetcher); // 后台刷新，不等待
    return hit.value;
  }
  return refresh(key, fetcher); // 冷启动：等这一次
}

/** 后台预取（不阻塞）：给定时器用，让热路径始终命中缓存。 */
function prefetch(key, fetcher) { return refresh(key, fetcher); }

const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hhmm = (iso) => { const m = String(iso || '').match(/T(\d{2}:\d{2})/); return m ? m[1] : ''; };
const md = (iso) => { const m = String(iso || '').match(/(\d{2})-(\d{2})T/); return m ? `${Number(m[1])}/${Number(m[2])}` : ''; };

// 日程事件字段容忍提取（Feishu v4: summary + start_time{datetime|date|timestamp}）
function normEvent(e) {
  const st = e.start_time || e.startTime || {};
  const startIso = st.datetime
    || (st.date ? `${st.date}T00:00:00+08:00` : '')
    || (st.timestamp ? new Date(st.timestamp * 1000).toISOString() : '');
  return { id: e.event_id || e.id || '', summary: String(e.summary || e.title || '（无标题）'), startIso, allDay: !!st.date };
}

async function agenda(startDay, endDay) {
  const data = await cached(`agenda:${startDay}:${endDay}`, () =>
    runLark(`calendar +agenda --start ${startDay}T00:00:00 --end ${endDay}T23:59:59`));
  if (!Array.isArray(data)) return null;
  return data.map(normEvent).filter(e => e.startIso).sort((a, b) => a.startIso.localeCompare(b.startIso));
}

async function myTasks() {
  // 只查未完成、翻全页；"来自会话"任务是飞书聊天自动生成的，不是用户亲手写的待办——剔除
  const data = await cached('tasks', () => runLark('task +get-my-tasks --complete=false --page-all'));
  const items = Array.isArray(data) ? data : (data?.items || data?.tasks || null);
  if (!items) return null;
  const open = items.filter(t => !t.completed);
  const conv = open.filter(t => String(t.summary).includes('来自会话')).length;
  const mineAll = open.filter(t => !String(t.summary).includes('来自会话'))
    .sort((a, b) => String(a.due_at || '9999').localeCompare(String(b.due_at || '9999')));
  const mine = mineAll.slice(0, 10)
    .map(t => ({ guid: t.guid, summary: String(t.summary || '（无标题）').replace(/\s+/g, ' ').slice(0, 24), due: t.due_at ? (md(t.due_at) + ' ' + hhmm(t.due_at)).trim() : '' }));
  return { mine, conv, total: open.length }; // total = 飞书“我负责的未完成”总数（含会话任务）
}

// ---- 写操作（语音两步确认后调用）----
// 白名单消毒：只留中文/字母/数字/常用标点，杜绝 shell 注入
const SAFE = (s) => String(s).replace(/[^\w\u4e00-\u9fff ，。：:、\-—…！？!?（）()\/.]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);

let myOpenId = null; // 缓存自己的 open_id：不带 assignee 的任务不会出现在"我的待办"
async function resolveMyOpenId() {
  if (myOpenId) return myOpenId;
  await new Promise((resolve) => {
    exec('lark-cli task +create --dry-run', { timeout: 10000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      try { myOpenId = JSON.parse(stdout || '{}').data?.context?.user_open_id || null; } catch { myOpenId = null; }
      resolve();
    });
  });
  return myOpenId;
}

export const feishuWrites = {
  // 模式B：托管通知——ZCode 等确认时经 bot 通道发飞书消息（手机弹推送，无需 VPN）
  async notify(text) {
    const uid = await resolveMyOpenId();
    if (!uid) return false;
    const s = SAFE(text);
    if (!s) return false;
    return !!(await runLark(`im +messages-send --as bot --user-id ${uid} --text "${s}"`));
  },
  async createTask(summary, dueOffsetDays = 0) {
    const s = SAFE(summary);
    if (!s) return null;
    const uid = await resolveMyOpenId();
    const due = dueOffsetDays > 0 ? ` --due +${dueOffsetDays}d` : '';
    const assignee = uid ? ` --assignee ${uid}` : '';
    const r = await runLark(`task +create --summary "${s}"${due}${assignee}`);
    if (r) cache.delete('tasks');
    return r ? (r.task || r) : null;
  },
  async completeTask(guid) {
    const g = String(guid || '').replace(/[^a-f0-9-]/gi, '');
    if (!g) return null;
    const r = await runLark(`task +complete --task-id ${g}`);
    if (r) cache.delete('tasks'); // 写成功后让下次查询拿到新清单
    return r;
  },
};

// 返回可直接上镜的 {time, summary}；日/周视图的时间格式不同
async function agendaView(startDay, endDay, withDate) {
  const evs = await agenda(startDay, endDay);
  if (!evs) return null;
  return evs.map(e => ({
    id: e.id,
    time: e.allDay ? '全天' : (withDate ? md(e.startIso) + ' ' : '') + hhmm(e.startIso),
    summary: e.summary.slice(0, 20),
    startIso: e.startIso, allDay: e.allDay,
  }));
}

export const feishu = {
  async agendaToday() { const d = new Date(); return agendaView(dayStr(d), dayStr(d), false); },
  async agendaTomorrow() { const d = new Date(Date.now() + 864e5); return agendaView(dayStr(d), dayStr(d), false); },
  async agendaWeek() { const d = new Date(); const e = new Date(Date.now() + 6 * 864e5); return agendaView(dayStr(d), dayStr(e), true); },
  async tasks() { return myTasks(); },
  // 看板要用的三份数据，后台定时刷新；/v1/hud 请求路径上因此不再等 lark-cli
  prefetchBoard() {
    const d = new Date();
    return Promise.all([
      prefetch('tasks', () => runLark('task +get-my-tasks --complete=false --page-all')),
      prefetch(`agenda:${dayStr(d)}:${dayStr(d)}`, () => runLark(`calendar +agenda --start ${dayStr(d)}T00:00:00 --end ${dayStr(d)}T23:59:59`)),
    ]);
  },
  // 妙记检索：关键词（空=近30天）→ [{title, token}]
  async searchMinutes(kw) {
    const d = new Date(); const since = new Date(Date.now() - 30 * 864e5);
    const cmd = kw
      ? `minutes +search --query "${SAFE(kw)}" --page-size 5`
      : `minutes +search --start ${dayStr(since)} --end ${dayStr(d)} --page-size 5`;
    const data = await cached('minutes:' + (kw || 'recent'), () => runLark(cmd));
    const items = Array.isArray(data) ? data : (data?.items || []);
    console.log(`[minutes] kw=${kw || '(recent)'} dataType=${Array.isArray(data) ? 'array(' + data.length + ')' : data ? typeof data + ':' + Object.keys(data).join('|') : 'null'} items=${items.length}`);
    return items.map(it => ({
      title: String(it.display_info || '').split('\n')[0].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim().slice(0, 32),
      token: it.token,
    })).filter(x => x.token);
  },
  // 取妙记的 AI 摘要原文（长文，由调用方提炼）
  async minuteSummary(token) {
    const t = String(token || '').replace(/[^a-z0-9]/gi, '');
    if (!t) return '';
    const data = await runLark(`minutes +detail --minute-tokens ${t} --summary`);
    return String(data?.minutes?.[0]?.artifacts?.summary || '');
  },
};
