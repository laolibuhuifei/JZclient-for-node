// OpenAI 兼容的 Chat Completions 客户端(纯 Node, 使用内置 fetch)
// 支持: https://api.openai.com/v1 、https://xxx/v1 、完整 .../chat/completions 地址
//
// 优化/修复：anjianhe (https://github.com/anjianhe)
//   · 识别推理模型后不再发送 temperature（deepseek-reasoner 部分网关会 400）
//   · reasoning_content 与 content 分开处理，正文为空时给出可读错误
//   · 超时改为可配（默认 120 秒），reasoner 先想再答，60 秒常来不及
//
// 兼容性要点（都是线上踩出来的）:
//   · deepseek-reasoner / o1 这类推理模型不接受 temperature 等采样参数,
//     部分网关传了直接 400, 所以按模型名识别后不发送
//   · 推理模型的思考过程在 message.reasoning_content, 正文在 message.content。
//     正文为空时不能笼统报「返回内容为空」, 那会让用户以为是自己配置错
//   · 默认超时 120 秒: reasoner 先想再答, 原来写死的 60 秒经常来不及,
//     超时后表现为「AI 不回消息」, 日志里只有一句 AbortError
'use strict';

const DEFAULT_TIMEOUT = 120000;

function buildUrl(baseUrl) {
  const u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('未配置 AI 请求地址');
  if (/\/chat\/completions$/i.test(u)) return u;
  return u + '/chat/completions';
}

// 推理模型：先输出思考过程、且部分采样参数不支持
function isReasoningModel(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return false;
  return /reasoner|thinking|deepseek-r|qwq/.test(m) || /^o[134](?:-|$)/.test(m);
}

// ---------- 多模态 content ----------
//
// content 有两种形态：
//   · 字符串          —— 纯文本消息（老路径，绝大多数场景）
//   · parts 数组      —— 带图消息：[{type:'text'},{type:'image_url',image_url:{url}}]
//
// 旧实现上来就 String(content)，数组会变成 "[object Object]" 直接发给上游 ——
// 模型收到一堆乱码，还以为是自己的问题。识图功能必须先把这一层拆开。
//
// 只保留 text / image_url 两种 part：input_audio、file 这些各家支持度参差不齐，
// 传上去反而容易 400，不如就地丢掉。

function normalizeContent(c) {
  if (!Array.isArray(c)) return String(c == null ? '' : c);
  const parts = [];
  for (let i = 0; i < c.length; i++) {
    const p = c[i];
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text') {
      const t = String(p.text == null ? '' : p.text);
      if (t.trim()) parts.push({ type: 'text', text: t });
    } else if (p.type === 'image_url') {
      const u = p.image_url && p.image_url.url;
      if (typeof u === 'string' && u) parts.push({ type: 'image_url', image_url: { url: u } });
    }
  }
  return parts;
}

// 取 content 里的纯文字部分（日志、空值判断、历史归档都用它）
function contentText(c) {
  if (!Array.isArray(c)) return String(c == null ? '' : c).trim();
  return c.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').trim();
}

function hasImage(c) {
  return Array.isArray(c) && c.some((p) => p && p.type === 'image_url');
}

// 统一成 parts 数组（合并同角色消息时用）
function partsOf(c) {
  return Array.isArray(c) ? c.map((p) => Object.assign({}, p)) : [{ type: 'text', text: String(c == null ? '' : c) }];
}

// 把 b 的 parts 追加到 a 后面。相邻的 text 用换行接起来，图片保持原顺序
function mergeParts(a, b) {
  const out = a;
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    const last = out[out.length - 1];
    if (p.type === 'text' && last && last.type === 'text') last.text = (last.text + '\n' + p.text).trim();
    else out.push(p);
  }
  return out;
}

// 请求体里的消息必须干净:
//   · content 为空的 assistant 消息会让部分网关 400, 直接丢掉
//   · 既没文字也没图片的 user 消息同样丢掉
//   · system 提到最前面
//   · 相邻同角色消息合并 —— reasoner 对「严格交替」比较挑, 连发两条 user 会被拒
function normalizeMessages(messages) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: normalizeContent(m.content) }))
    .filter((m) => (m.role === 'assistant'
      ? !!contentText(m.content)
      : (!!contentText(m.content) || hasImage(m.content))));
  const sys = list.filter((m) => m.role === 'system');
  const rest = list.filter((m) => m.role !== 'system');
  const merged = [];
  sys.concat(rest).forEach((m) => {
    const prev = merged[merged.length - 1];
    if (!prev || prev.role !== m.role) {
      merged.push({ role: m.role, content: m.content });
      return;
    }
    // 两边都是纯文本就还是纯文本（别把老路径的数据结构改掉），
    // 只要有一边带图就统一成 parts 数组
    if (typeof prev.content === 'string' && typeof m.content === 'string') {
      prev.content = (prev.content + '\n' + m.content).trim();
    } else {
      prev.content = mergeParts(partsOf(prev.content), partsOf(m.content));
    }
  });
  return merged;
}

// 组装请求体（单独抽出来便于单测：不同模型该带/不该带哪些参数）
function buildBody(ai, messages, opts) {
  const o = opts || {};
  const model = String(ai.model || 'gpt-4o-mini').trim();
  const body = { model, messages: normalizeMessages(messages), stream: false };
  if (!body.messages.length) throw new Error('没有要发送的消息');
  // 推理模型只发 model/messages，采样参数一律不发
  if (!isReasoningModel(model)) {
    if (ai.temperature != null && ai.temperature !== '') {
      const t = Number(ai.temperature);
      if (Number.isFinite(t)) body.temperature = Math.min(2, Math.max(0, t));
    }
  }
  const maxTokens = Number(o.maxTokens || ai.maxTokens || 0);
  if (maxTokens > 0) body.max_tokens = Math.round(maxTokens);
  return body;
}

// 返回 { content, reasoning, finishReason, model, ms, usage }
async function chatFull(ai, messages, opts = {}) {
  const url = buildUrl(ai.baseUrl);
  const body = buildBody(ai, messages, opts);
  const timeout = Number(opts.timeout || ai.timeoutMs) > 0
    ? Number(opts.timeout || ai.timeoutMs) : DEFAULT_TIMEOUT;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (ai.apiKey || ''),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON：多半是网关的 HTML 错误页 */ }
    if (!resp.ok) {
      const detail = (json && ((json.error && (json.error.message || json.error.code)) || json.message))
        || text.slice(0, 300);
      throw new Error(`接口 ${resp.status}: ${detail}`);
    }
    if (!json) throw new Error('上游返回的不是 JSON: ' + text.slice(0, 200));
    const choice = (json.choices && json.choices[0]) || null;
    const msg = (choice && choice.message) || {};
    // 有的网关会按多模态格式回 content 数组，取里面的 text 部分
    const content = contentText(msg.content);
    const reasoning = String(msg.reasoning_content || msg.reasoning || '').trim();
    if (!content) {
      // 推理模型常见：思考完了但 max_tokens 被吃光，正文是空串
      if (reasoning) {
        throw new Error('模型只返回了思考过程（reasoning_content ' + reasoning.length
          + ' 字），没有正文。请调大 max_tokens，或换用对话模型（如 deepseek-flash）');
      }
      throw new Error('返回内容为空'
        + (choice && choice.finish_reason ? '（finish_reason=' + choice.finish_reason + '）' : '（上游没有 message.content）'));
    }
    return {
      content,
      reasoning,
      finishReason: choice && choice.finish_reason ? String(choice.finish_reason) : '',
      model: String(json.model || body.model),
      ms: Date.now() - t0,
      usage: json.usage || null,
    };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeout / 1000)} 秒）。推理模型可以把超时调大，或换用更快的模型`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 老接口：返回纯文本，调用方（queueAiReply）不用改
async function chat(ai, messages, opts = {}) {
  const r = await chatFull(ai, messages, opts);
  return r.content;
}

module.exports = {
  chat, chatFull, buildUrl, buildBody, isReasoningModel, normalizeMessages, DEFAULT_TIMEOUT,
  // 多模态相关：识图功能在 webui 里要拼 content，测试也要能单独验
  normalizeContent, contentText, hasImage,
};
