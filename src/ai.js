// OpenAI 兼容的 Chat Completions 客户端(纯 Node,使用内置 fetch)
// 支持: https://api.openai.com/v1 、https://xxx/v1 、完整 .../chat/completions 地址

function buildUrl(baseUrl) {
  const u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('未配置 AI 请求地址');
  if (/\/chat\/completions$/i.test(u)) return u;
  return u + '/chat/completions';
}

async function chat(ai, messages, opts = {}) {
  const url = buildUrl(ai.baseUrl);
  const model = ai.model || 'gpt-4o-mini';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeout || 60000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (ai.apiKey || ''),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: ai.temperature != null ? ai.temperature : 0.7,
      }),
      signal: ac.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!resp.ok) {
      const msg = (json && json.error && (json.error.message || json.error.code)) || text.slice(0, 300);
      throw new Error(`AI 接口 ${resp.status}: ${msg}`);
    }
    const content = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : '';
    if (!content) throw new Error('AI 返回内容为空');
    return String(content).trim();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, buildUrl };
