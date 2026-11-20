// UTF-8 安全的意图测试：node test-voice.mjs "电脑在干嘛" [--stream]
// --stream 打印 SSE chunk（跟随模式持续输出，读满 FOLLOW_LINES 行自动断开）
const [,, q, flag] = process.argv;
const { readFileSync } = await import('node:fs');
const token = readFileSync(new URL('../.state/bridge.token', import.meta.url), 'utf8').trim();
const stream = flag === '--stream';
const res = await fetch('http://127.0.0.1:8790/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ stream, messages: [{ role: 'user', content: q }] }),
});
if (!stream) {
  const j = await res.json();
  console.log('◆ ' + q + '\n' + j.choices[0].message.content + '\n');
  process.exit(0);
}
console.log('◆ ' + q + '（流式）');
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '', shown = 0;
const limit = Number(process.env.FOLLOW_LINES || 40);
while (shown < limit) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  for (const m of buf.matchAll(/data: (\{[^\n]*\})/g)) {
    try {
      const j = JSON.parse(m[1]);
      const c = j.choices?.[0]?.delta?.content;
      if (c && c.trim()) {
        console.log('  | ' + c.replace(/\n/g, ''));
        shown++;
        if (j.choices[0].finish_reason === 'stop') { reader.cancel(); process.exit(0); }
      }
    } catch {}
  }
  buf = buf.slice(Math.max(0, buf.lastIndexOf('\n\n') + 2)); // 清掉已处理的完整消息
}
reader.cancel();
