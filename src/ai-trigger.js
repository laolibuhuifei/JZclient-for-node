// AI 触发链路的纯逻辑：文本归一化 / 关键词匹配 / 会话匹配 / 可读文本提取。
//
// 优化/修复：anjianhe (https://github.com/anjianhe)
//
// 单独拆一个文件是为了能直接单测 —— 这里不碰网络、不碰 IM、也不读全局配置，
// 只回答三个问题：
//   1. 这条消息里有没有「值得交给 AI 的文本」
//   2. 这段文本命中关键词了吗（全角/零宽/大小写/前后空白都不该影响）
//   3. 这条消息属于哪个「启用 AI 的会话」
//
// 背景（线上真实故障）：关键词/自动回复都不触发，但聊天面板照常收消息。
// 根因是「会话匹配」和「聊天气泡归档」用了两套不同规则：
//   - 归档走 resolveChatKey()，对单聊同时比 receiverId ≈ imAccountId 和 receiverId ≈ dialogId
//   - 触发只比 receiverId ≈ imAccountId，而且用 Number() 转换
// 服务端下发的消息里 tag10/tag11 谁在前、谁为 0 会随固件/服务端版本变化，
// 于是「能看见消息但 AI 不吭声」。这里统一以 chatKey 为准，再保留多路兜底。
'use strict';

// 常见不可见字符：零宽空格/零宽连接符/词连接符/BOM
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/g;
// 各种「看着像空格」的字符：NBSP、全角空格、各种 Unicode 空白
const ODD_SPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

// 归一化一条文本，用于「比较」而不是「展示」：
//   - NFKC：全角数字/字母/标点折成半角（全角「Ａ」→「A」）
//   - 去掉零宽字符（手表固件和输入法偶尔会塞进去）
//   - 各种怪异空白统一成一个半角空格
//   - 小写化，英文关键词大小写不敏感
function normText(input) {
  return String(input == null ? '' : input)
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(ODD_SPACE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// 关键词输入 → 干净的数组。
// 分隔符：中英文逗号、顿号、分号、竖线、斜杠、换行、制表、空格（沿用旧行为）
// 顺手做去重（归一化之后），避免同一条关键词以全角/半角两种写法各存一份
function splitKeywords(input) {
  const raw = Array.isArray(input) ? input.map((x) => String(x == null ? '' : x)).join(',') : String(input == null ? '' : input);
  const out = [];
  const seen = new Set();
  raw.split(/[,，、;；|/\n\r\t\s]+/).forEach((part) => {
    const k = normText(part);
    if (!k || k.length > 64) return;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(k);
  });
  return out;
}

// 纯 ASCII 的关键词才需要「词边界」判断：
// 中文没有词边界概念，而英文/数字不加边界会误命中（关键词「24」命中「1024」）。
function isAsciiWord(s) {
  return /^[\x20-\x7e]+$/.test(s);
}

// 词边界包含：关键词必须在「行首」或「非字母数字字符之后」出现
function boundaryContains(text, kw) {
  if (!isAsciiWord(kw)) return text.indexOf(kw) >= 0;
  let i = text.indexOf(kw);
  while (i >= 0) {
    const before = i === 0 ? '' : text.charAt(i - 1);
    if (!before || !/[a-z0-9]/.test(before)) return true;
    i = text.indexOf(kw, i + 1);
  }
  return false;
}

// id 相等判定（字符串化之后比）。
// 不直接用 Number：IM 账号 ID 是 19~20 位时 Number 会丢精度（9007199254740991 以上），
// 两个本该相等的 id 会变成两个不同的浮点数，匹配就此失效 —— 这也是「部分环境怎么都不触发」的来源之一。
// 纯数字且都很长时用 BigInt 比，其余按字符串比。
function idEq(a, b) {
  const x = String(a == null ? '' : a).trim();
  const y = String(b == null ? '' : b).trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
    try { return BigInt(x) === BigInt(y); } catch (e) { return false; }
  }
  return false;
}

// 关键词匹配。返回 { hit, keyword, how, text }
//   mode = 'prefix'   ：必须以关键词开头（用户要的「前缀触发」）
//   mode = 'contains' ：包含即可（旧版本行为）
//   mode = 'auto'     ：前缀优先，其次词边界包含 —— 两种语义都兜住，默认值
function matchKeyword(text, keywords, mode) {
  const m = (mode === 'prefix' || mode === 'contains') ? mode : 'auto';
  const t = normText(text);
  const list = Array.isArray(keywords) ? keywords : splitKeywords(keywords);
  if (!t || !list.length) return { hit: false, keyword: null, how: '', text: t };

  for (let i = 0; i < list.length; i++) {
    const k = normText(list[i]);
    if (!k) continue;
    if (t === k) return { hit: true, keyword: k, how: 'exact', text: t };
    if (m !== 'contains' && t.indexOf(k) === 0) return { hit: true, keyword: k, how: 'prefix', text: t };
    if (m === 'contains' && t.indexOf(k) >= 0) return { hit: true, keyword: k, how: 'contains', text: t };
    if (m === 'auto' && boundaryContains(t, k)) return { hit: true, keyword: k, how: 'contains', text: t };
  }
  return { hit: false, keyword: null, how: '', text: t };
}

// 这些 kind 都带「能读出来的文本」，可以交给 AI。
// 只放文本类：语音/图片/视频/位置等不参与，避免把「[图片] https://...」喂给模型。
const AI_TEXT_KINDS = ['text', 'relay_text', 'hint', 'text_hint', 'kaomoji', 'unknown', 'raw'];

// describe() 给「人类看」的展示文本加的装饰前缀，喂给 AI 前要剥掉
const DISPLAY_PREFIX = /^\[(?:转发|转发文本|提示|颜文字|文字提示|原始消息|消息\s*[-\d]*)\]\s*/;

// 从解析结果里取「要发给 AI 的正文」。
//
// 这是线上「AI 不回复」的第二个根因：
//   parseMessage() 只从信封顶层取 text（body.text || body.content），
//   而部分固件/服务端把正文放在 msgNewContent 里 —— describe() 会去 inner.content 找，
//   所以聊天面板照常显示，可 parsed.text 是空串，AI 分支 `parsed.kind === 'text' && parsed.text`
//   直接短路，永远进不去。用户的感受就是「代码没拿到要发给 AI 的内容」。
//
// 所以这里不再只看 parsed.text，而是：
//   1) 先看 describe 出来的展示文本（和聊天面板完全同源），剥掉装饰前缀
//   2) 再按字段逐个兜底（顶层 text/content → inner 里的常见正文字段）
// 传入第二个参数 described 时优先用它，保证「面板能看到的文字，AI 也一定能看到」。
function aiTextOf(parsed, described) {
  if (!parsed || typeof parsed !== 'object') return '';
  const kind = String(parsed.kind || '');
  if (AI_TEXT_KINDS.indexOf(kind) < 0) return '';
  const inner = parsed.inner || parsed.body || {};

  const clean = (v) => String(v == null ? '' : v).replace(DISPLAY_PREFIX, '').trim();
  const pick = (v) => String(v == null ? '' : v).trim();

  // 1) 展示文本优先：它就是用户在聊天面板里看到的那串
  const shown = clean(described);
  if (shown) return shown;

  // 2) 字段兜底：不同信封里正文字段名不一样，按常见顺序试
  const candidates = [
    parsed.text,
    inner.content,
    inner.text,
    inner.msg,
    inner.desc,
    inner.contentText,
    inner.message,
  ];
  for (let i = 0; i < candidates.length; i++) {
    const v = pick(candidates[i]);
    if (v) return clean(v);
  }
  // 3) 信封里还留着 msgNewContent 字符串时再搏一次：
  //    部分固件把正文塞在里面而 msgNewType 是 0/1，parseMessage 不会展开，
  //    结果就是 kind=text 但 text 是空串 —— 面板显示空白，AI 也无从下手。
  if (inner.msgNewContent) {
    try {
      const nested = typeof inner.msgNewContent === 'string'
        ? JSON.parse(inner.msgNewContent) : inner.msgNewContent;
      if (nested && typeof nested === 'object') {
        const v = pick(nested.content) || pick(nested.text) || pick(nested.msg) || pick(nested.desc);
        if (v) return clean(v);
      }
    } catch (e) { /* 不是 JSON，忽略 */ }
  }
  // 4) 实在没有就退回 parsed.text 原文（可能是 raw 的截断文本）
  return clean(parsed.text);
}

// 会话 → 聊天 key。和 webui 里 chatTargets 的 key 保持同一套写法：
//   单聊 s:<手表 imAccountId>、家庭群 g:<dialogId>
function sessionKeyOf(sess) {
  if (!sess || typeof sess !== 'object') return '';
  if (sess.type === 'group' && sess.dialogId != null && sess.dialogId !== '') return 'g:' + String(sess.dialogId);
  if (sess.type === 'single' && sess.receiverId != null && sess.receiverId !== '') return 's:' + String(sess.receiverId);
  // 老版本的配置把 key 存成 'single:123' / 'group:456'，统一成聊天会话的写法
  const k = String(sess.key || '');
  if (k.indexOf('single:') === 0) return 's:' + k.slice(7);
  if (k.indexOf('group:') === 0) return 'g:' + k.slice(6);
  return k;
}

// 从一条 IM 消息里挑出「可能是对方」的 id 候选（字符串化，避免 Number 精度/类型差异）
function peerIdCandidates(ctx) {
  const out = [];
  const push = (v) => {
    if (v == null) return;
    const s = String(v).trim();
    if (!s || s === '0' || s === 'undefined' || s === 'null') return;
    if (out.indexOf(s) < 0) out.push(s);
  };
  push(ctx.imAccountId);
  push(ctx.dialogId);
  (Array.isArray(ctx.peers) ? ctx.peers : []).forEach((p) => push(p && p.imAccountId));
  const self = ctx.selfId == null ? '' : String(ctx.selfId).trim();
  return self ? out.filter((x) => !idEq(x, self)) : out;
}

// 这条消息是否属于「启用 AI 的会话」，是就返回那个 session 配置。
// 判定顺序：
//   1. chatKey 精确匹配 —— 和聊天面板归档完全同源，最可靠
//   2. chatKey 有效但没命中 → 明确不在启用范围，直接 null（避免自动回复串到没勾的会话）
//   3. chatKey 缺失（会话列表还没就绪）→ 用 id 候选做兜底，能对上一个就认
function matchSession(sessions, ctx) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) return null;
  const c = ctx || {};
  const chatKey = String(c.chatKey || '').trim();

  if (chatKey) {
    const hit = list.find((s) => idEq(sessionKeyOf(s), chatKey) || idEq(s && s.key || '', chatKey));
    return hit || null;
  }

  const ids = peerIdCandidates(c);
  if (!ids.length) return null;

  // 只有明确带 dialogId 且没被当成单聊候选时，才去匹配群会话
  const dialogId = c.dialogId == null ? '' : String(c.dialogId).trim();
  if (dialogId && dialogId !== '0') {
    const group = list.find((s) => s && s.type === 'group' && idEq(s.dialogId, dialogId));
    if (group) return group;
  }
  const single = list.find((s) => s && s.type === 'single'
    && s.receiverId != null && ids.some((id) => idEq(s.receiverId, id)));
  return single || null;
}

// IM 协议里的 accountId / dialogId 是**整数**：im.js 的 tlv() 对 number 走 numBytes
// （大端整数），对 string 走 UTF-8。如果发送前把 id 变成了字符串，服务端就认不出接收方，
// 表现是「AI 生成了回复但一直发送失败」。所以发消息前必须还原成 number。
// 超出 JS 安全整数（2^53-1）的 id 保留字符串，宁可让上层报错也不悄悄改号。
function toImId(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s)) return s;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : s;
}

module.exports = {
  normText,
  splitKeywords,
  matchKeyword,
  aiTextOf,
  sessionKeyOf,
  matchSession,
  toImId,
  AI_TEXT_KINDS,
};
