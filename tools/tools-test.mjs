// 模拟手机端的 tools 请求：node tools-test.mjs
// 验证：HUD 未命中 → DeepSeek 选工具 → tool_calls 透传回来
const { readFileSync } = await import('node:fs');
const token = readFileSync(new URL('../.state/bridge.token', import.meta.url), 'utf8').trim();
const res = await fetch('http://127.0.0.1:8790/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [
      { role: 'system', content: '你是眼镜语音助手' },
      { role: 'user', content: '导航去公司' },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'start_navigation',
        description: '开始导航到目的地（眼镜显示路线）',
        parameters: { type: 'object', properties: { destination: { type: 'string', description: '目的地' } }, required: ['destination'] },
      },
    }],
    stream: false,
  }),
});
const j = await res.json();
const m = j.choices?.[0]?.message;
console.log('finish_reason:', j.choices?.[0]?.finish_reason);
console.log('content:', m?.content || '(空)');
if (m?.tool_calls) console.log('tool_calls ✓ →', JSON.stringify(m.tool_calls));
else console.log('tool_calls: 无');
