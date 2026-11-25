// 飞书归档：把妙记 / 日程 / 待办 原样落到本机的不可变原始层。
//
// 原则
//   - 只增不改：每个条目按“内容哈希”落盘；内容没变就不写，变了就多一个版本，旧版本永不删除。
//   - 不加工：这里不做摘要、不做结构化、不建索引。原始层只负责“东西别丢”。
//   - 只读飞书：只用 lark-cli 的查询命令，不调用任何写操作。
//   - 原始 JSON 原样保存，以后想换 schema 不用重新拉。
//
// 目录
//   <root>/raw/feishu/<来源>/<条目id>/<内容哈希>.json     原始 JSON
//   <root>/raw/feishu/_manifest.jsonl                     每次拉取的流水（时间、来源、数量、哈希）
//
// 用法
//   node archive/feishu-archive.mjs [--root <目录>] [--days 7] [--dry-run]
//   默认 root 是仓库同级的数据目录，绝不在仓库里（仓库是公开的）。

import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const DRY = args.includes('--dry-run');
const REFETCH = args.includes('--refetch'); // 强制重拉所有妙记逐字稿（默认跳过已存过的）

// lark-cli 按时间搜索妙记的窗口上限是 30 天（接口限制，不是脚本的）。
const askedDays = Number(option('--days', 7)) || 7;
if (askedDays > 30) console.log(`[archive] 注意：--days ${askedDays} 超过 lark-cli 的搜索上限，按 30 天处理。`);
const days = Math.max(1, Math.min(30, askedDays));

// 默认数据目录：仓库目录之外。放在仓库里会有被 git 带走的风险（.gitignore 只是第二道防线）。
const repoRoot = resolve(here, '..');
const defaultRoot = resolve(repoRoot, '..', 'glasses-hud-data');
const root = resolve(option('--root', defaultRoot));

if (root === repoRoot || root.startsWith(repoRoot + '/') || root.startsWith(repoRoot + '\\')) {
  // 允许显式指定，但要说清楚风险；--force 才继续
  if (!args.includes('--force')) {
    console.error(`[archive] 数据目录在仓库内部（${root}）。仓库是公开的，请把数据放到仓库外，或加 --force 确认你明白风险。`);
    process.exit(2);
  }
  console.error('[archive] 警告：数据目录在仓库内部，依赖 .gitignore 防止入库。');
}

const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- lark-cli 封装 ----------
// 注意：命令字符串全部由本程序拼装，参数只含 ISO 日期和 [a-z0-9] 的 token，不接受任何用户输入。
function runLark(cmd, cwd) {
  return new Promise((resolve_) => {
    exec(`lark-cli ${cmd}`, { timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, cwd },
      (err, stdout, stderr) => {
        if (err || !stdout) return resolve_({ ok: false, err: err ? String(err.message).slice(0, 200) : 'empty', stderr: String(stderr || '').slice(0, 200) });
        try { resolve_({ ok: true, json: JSON.parse(stdout) }); }
        catch { resolve_({ ok: false, err: 'non_json', head: String(stdout).slice(0, 200) }); }
      });
  });
}

// ---------- 不可变落盘 ----------
const sha = (s) => createHash('sha256').update(s).digest('hex');
const stats = { added: 0, unchanged: 0, versions: 0, failed: 0 };

/** 写一个条目的一个版本。返回 'added' | 'unchanged' | 'version'。
 *  哈希只算“来自飞书的内容”。拉取时间等本地元数据放进同目录的 _meta.jsonl，
 *  不参与哈希——否则每次运行时间都不同，同一条目会被当成新版本反复存。 */
function putObject(source, id, obj) {
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown';
  const body = JSON.stringify(obj, null, 2) + '\n';
  const h = sha(body);
  const dir = join(root, 'raw', 'feishu', source, safeId);
  const file = join(dir, h + '.json');
  const isNew = !existsSync(file);
  const hadBefore = existsSync(dir) && existsSync(join(dir, '_meta.jsonl'));
  if (isNew) stats[hadBefore ? 'versions' : 'added']++; else stats.unchanged++;
  if (!DRY) {
    mkdirSync(dir, { recursive: true });
    if (isNew) writeFileSync(file, body, { flag: 'wx' }); // wx：已存在就报错，不会覆盖
    appendFileSync(join(dir, '_meta.jsonl'), JSON.stringify({ at: snapAtNow(), hash: h, change: isNew ? (hadBefore ? 'version' : 'added') : 'unchanged' }) + '\n');
  }
  return isNew ? (hadBefore ? 'version' : 'added') : 'unchanged';
}
// putObject 需要每次调用当时的真实时间，用取值函数而不是启动时固定的快照
const snapAtNow = () => new Date().toISOString();

/** 读一个条目最近一次存的内容；没存过返回 null。 */
function latestObject(source, id) {
  try {
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown';
    const dir = join(root, 'raw', 'feishu', source, safeId);
    // _meta.jsonl 的最后一行是最近一次：它的 hash 指向当时判定的最新版本
    const meta = readFileSync(join(dir, '_meta.jsonl'), 'utf8').trim().split('\n');
    let hash = null;
    for (let i = meta.length - 1; i >= 0; i--) {
      try { const m = JSON.parse(meta[i]); if (m.hash) { hash = m.hash; break; } } catch {}
    }
    if (!hash) return null;
    return JSON.parse(readFileSync(join(dir, hash + '.json'), 'utf8'));
  } catch { return null; }
}

/** 搜索接口给的元数据是否变了（标题、链接、描述）。只比这几项，不比顺序或空白。 */
function sameSearchMeta(a, b) {
  const pick = (x) => JSON.stringify({ t: x?.display_info, m: x?.meta_data, tok: x?.token });
  return !!a && !!b && pick(a) === pick(b);
}

function logManifest(entry) {
  if (DRY) return;
  const dir = join(root, 'raw', 'feishu');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, '_manifest.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// ---------- 三类来源 ----------
async function archiveTasks(snapAt) {
  const r = await runLark('task +get-my-tasks --complete=false --page-all');
  const items = r.ok ? (r.json?.data?.items || r.json?.data || []) : null;
  if (!Array.isArray(items)) { stats.failed++; logManifest({ source: 'tasks', ok: false, err: r.err }); return { ok: false, n: 0 }; }
  let n = 0;
  for (const t of items) {
    if (!t?.guid) continue;
    putObject('tasks', t.guid, { _source: 'feishu.task', ...t });
    n++;
  }
  logManifest({ source: 'tasks', ok: true, n });
  return { ok: true, n };
}

async function archiveAgenda(snapAt, fromDay, toDay) {
  const r = await runLark(`calendar +agenda --start ${fromDay}T00:00:00 --end ${toDay}T23:59:59`);
  const items = r.ok ? (r.json?.data || []) : null;
  if (!Array.isArray(items)) { stats.failed++; logManifest({ source: 'agenda', ok: false, err: r.err }); return { ok: false, n: 0 }; }
  let n = 0;
  for (const e of items) {
    const id = e?.event_id; if (!id) continue;
    putObject('agenda', id, { _source: 'feishu.calendar', ...e });
    n++;
  }
  logManifest({ source: 'agenda', ok: true, n, from: fromDay, to: toDay });
  return { ok: true, n };
}

// 妙记：先搜出 token 列表，再逐条取逐字稿。
// minutes +detail 会把逐字稿写到 cwd 下的一个文件，并在返回 JSON 的
// data.minutes[0].artifacts.transcript_file 里给出相对路径。路径以它返回的为准，
// 不自己拼——换版本改了目录名也不会读错。
//
// 每条妙记要单独调一次 lark-cli，实测约 12 秒（它要把整份逐字稿取回来）。
// 妙记是历史记录，写完基本不变，所以已经存过逐字稿的条目默认跳过、不重拉
// （--refetch 可以强制全部重拉）。否则窗口越大越慢，而且是每 6 小时白跑一遍。
async function archiveMinutes(snapAt, fromDay, toDay) {
  const t0 = Date.now();
  const r = await runLark(`minutes +search --start ${fromDay} --end ${toDay} --page-size 30`);
  const items = r.ok ? (r.json?.data?.items || r.json?.data || []) : null;
  if (!Array.isArray(items)) { stats.failed++; logManifest({ source: 'minutes', ok: false, err: r.err }); return { ok: false, n: 0, withTranscript: 0, skipped: 0 }; }
  const tmp = minutesTmp; // 独立 cwd，逐字稿不会落到别的目录；跑完清掉，不留散落的副本
  let n = 0, withTranscript = 0, skipped = 0;
  const total = items.length;
  for (const [i, it] of items.entries()) {
    const token = String(it?.token || '').replace(/[^a-z0-9]/gi, '');
    if (!token) continue;
    // 已有带逐字稿的存档且搜索元数据没变 → 跳过
    const prev = latestObject('minutes', token);
    if (!REFETCH && prev && prev.transcript && sameSearchMeta(prev.search, it)) {
      skipped++; withTranscript++; n++;
      continue;
    }
    process.stdout.write(`[archive] minutes ${i + 1}/${total} 取逐字稿… (${Math.round((Date.now() - t0) / 1000)}s)\r`);
    const d = await runLark(`minutes +detail --minute-tokens ${token} --transcript`, tmp);
    let transcript = null;
    const rel = d.ok ? d.json?.data?.minutes?.[0]?.artifacts?.transcript_file : null;
    if (rel) {
      try {
        const abs = resolve(tmp, rel);
        if (abs.startsWith(resolve(tmp))) transcript = readFileSync(abs, 'utf8'); // 只读 tmp 内的文件
      } catch {}
    }
    if (transcript) withTranscript++;
    putObject('minutes', token, {
      _source: 'feishu.minutes',
      search: it,                 // 搜索接口给的元数据（标题、链接）
      detail: d.ok ? d.json?.data?.minutes?.[0] || null : null,
      transcript,                 // 逐字稿全文（带说话人+时间戳），取不到时为 null
    });
    n++;
  }
  if (total && !REFETCH) process.stdout.write('\n');
  logManifest({ source: 'minutes', ok: true, n, withTranscript, skipped, from: fromDay, to: toDay });
  return { ok: true, n, withTranscript, skipped };
}

// ---------- 主流程 ----------
const startedAt = Date.now();
const snapAt = new Date().toISOString();
const to = new Date();
const from = new Date(Date.now() - (days - 1) * 864e5);
const fromDay = dayStr(from), toDay = dayStr(to);

console.log(`[archive] ${DRY ? 'DRY-RUN ' : ''}root=${root}  range=${fromDay}..${toDay}`);
// lark-cli 是通过 cmd.exe 启动的：cwd 不存在会直接 spawn ENOENT。
// 逐字稿需要一个独立的临时 cwd，所以无论是否 dry-run 都要先把目录建出来。
const minutesTmp = join(root, '.tmp-minutes');
mkdirSync(minutesTmp, { recursive: true });
if (!DRY) mkdirSync(join(root, 'raw', 'feishu'), { recursive: true });

const cleanupTmp = () => { try { rmSync(minutesTmp, { recursive: true, force: true }); } catch {} };

const results = {};
results.tasks = await archiveTasks(snapAt);
results.agenda = await archiveAgenda(snapAt, fromDay, toDay);
results.minutes = await archiveMinutes(snapAt, fromDay, toDay);

for (const [k, v] of Object.entries(results)) {
  const extra = v.withTranscript != null ? ` transcript=${v.withTranscript}` : '';
  const skip = v.skipped ? ` skipped=${v.skipped}` : '';
  console.log(`[archive] ${k.padEnd(8)} ${v.ok ? 'ok ' : 'FAIL'} n=${v.n}${extra}${skip}`);
}
console.log(`[archive] 新增 ${stats.added}  未变 ${stats.unchanged}  新版本 ${stats.versions}  失败 ${stats.failed}  用时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
logManifest({ source: '_run', ok: stats.failed === 0, days, ...stats });
cleanupTmp();
process.exit(stats.failed ? 1 : 0);
