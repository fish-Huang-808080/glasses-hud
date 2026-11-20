// TinyFish 搜索执行器：bridge 自有 web_search 工具的后端。
// key 存 .state/tinyfish-key（gitignore）；Search 端点免费 5次/分钟。
import { readFileSync } from 'node:fs';

const KEY = (() => {
  try { return readFileSync(new URL('../.state/tinyfish-key', import.meta.url), 'utf8').trim(); } catch { return ''; }
})();

export const hasTinyfish = () => !!KEY;

export async function tinySearch(query, recencyMinutes) {
  if (!KEY) return null;
  const u = new URL('https://api.search.tinyfish.ai');
  u.searchParams.set('query', String(query).slice(0, 200));
  u.searchParams.set('language', 'zh-CN');
  if (recencyMinutes) u.searchParams.set('recency_minutes', String(Math.min(Number(recencyMinutes) || 1440, 43200)));
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(u, { headers: { 'X-API-Key': KEY }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return (j.results || []).slice(0, 5).map(r => `${r.title}：${String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 110)}`);
  } catch { return null; }
}
