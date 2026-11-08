// 端到端用例：真实 IM 信封 → parseMessage → describe → aiTextOf → 关键词判定
//
// 优化/修复：anjianhe (https://github.com/anjianhe)
//
// 这一层专门盯「聊天面板能看见、AI 却拿不到内容」：
// 只要 describe() 给出了可见文字，aiTextOf() 就必须能把它交给 AI 触发判定。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseMessage, describe } = require('../src/message');
const trig = require('../src/ai-trigger');
const biliBot = require('../src/bili-bot');

// 把一条原始消息跑完整条链路，返回 { kind, shown, text, hit }
function flow(envelope, msgType, keyword) {
  const raw = Buffer.from(JSON.stringify(envelope), 'utf8');
  const parsed = parseMessage(msgType == null ? 1 : msgType, raw);
  const shown = describe(parsed);
  const text = trig.aiTextOf(parsed, shown);
  const r = trig.matchKeyword(text, [keyword], 'auto');
  return { parsed, shown, text, hit: r.hit };
}

test('普通文本信封：面板文字和 AI 拿到的一致', () => {
  const r = flow({
    content: '你好 在吗', text: '你好 在吗', hintType: -1, isSensitive: false,
    msgNewContent: '', msgNewType: 0, showType: 0, textMsgType: 0,
  }, 1, '你好');
  assert.strictEqual(r.parsed.kind, 'text');
  assert.strictEqual(r.shown, '你好 在吗');
  assert.strictEqual(r.text, '你好 在吗');
  assert.strictEqual(r.hit, true);
});

test('转发文本信封(msgNewType=20)：正文在 msgNewContent 里也能拿到', () => {
  const r = flow({
    content: '', text: '', msgNewType: 20,
    msgNewContent: JSON.stringify({ content: '帮我看看这道题' }),
  }, 1, '帮我');
  assert.strictEqual(r.parsed.kind, 'relay_text');
  assert.ok(r.shown.indexOf('帮我看看这道题') >= 0);
  assert.strictEqual(r.text, '帮我看看这道题');
  assert.strictEqual(r.hit, true);
});

test('畸形信封：msgNewType=1 且正文只在 msgNewContent（parseMessage 不展开）', () => {
  // 这类消息旧代码里 parsed.text 是空串，AI 分支直接短路
  const r = flow({
    content: '', text: '', msgNewType: 1,
    msgNewContent: JSON.stringify({ content: '今天想早点回家' }),
  }, 1, '今天');
  assert.strictEqual(r.parsed.kind, 'text');
  assert.strictEqual(r.text, '今天想早点回家', 'aiTextOf 应该能从 msgNewContent 里救回来');
  assert.strictEqual(r.hit, true);
});

test('提示类消息(hint)不再交给 AI（避免把系统提示当用户发言）', () => {
  // msgType=4 会被判成 hint；这类多是系统提示，不该触发 AI
  const r = flow({ content: '注意安全', text: '注意安全' }, 4, '注意');
  assert.strictEqual(r.parsed.kind, 'hint');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.hit, false);
});

test('业务推送(JSON content)不会被当成用户消息喂给 AI', () => {
  const r = flow({ type: 27, content: '{"battery":24}' }, 1, '电量');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.hit, false);
});

test('图片消息不应该进 AI 判定', () => {
  const r = flow({
    content: '[图片]', text: '[图片]', msgNewType: 6,
    msgNewContent: JSON.stringify({ type: '1', source: { downloadUrl: 'https://x/y.jpg' } }),
  }, 6, '图片');
  assert.strictEqual(r.parsed.kind, 'photo');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.hit, false);
});

test('状态回执(type>=1000)不应该进 AI 判定', () => {
  const r = flow({ type: 1000, content: '已读', timestamp: 1 }, 1, '已读');
  assert.strictEqual(r.parsed.kind, 'status');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.hit, false);
});

// ============ B 站点播命令：和 AI 共用同一份正文 ============
test('B 站点播命令：普通文本信封能识别 /搜索', () => {
  const r = flow({ content: '/搜索 小猪佩奇', text: '/搜索 小猪佩奇' }, 1, '搜索');
  const cmd = biliBot.parseCommand(r.text);
  assert.ok(cmd);
  assert.strictEqual(cmd.kind, 'search');
  assert.strictEqual(cmd.arg, '小猪佩奇');
});

test('B 站点播命令：正文在信封内层（msgNewType=20）时也能识别', () => {
  // 旧代码只看 parsed.text，这里会是空串 → 命令解析不出来 → 点播没反应
  const r = flow({
    content: '', text: '', msgNewType: 20,
    msgNewContent: JSON.stringify({ content: '/搜索 小猪佩奇' }),
  }, 1, '搜索');
  assert.strictEqual(r.text, '/搜索 小猪佩奇');
  const cmd = biliBot.parseCommand(r.text);
  assert.ok(cmd, '内层正文应该也能被命令解析器识别');
  assert.strictEqual(cmd.kind, 'search');
});

test('B 站点播命令：裸词带参数也能识别（不带斜杠）', () => {
  const r = flow({
    content: '', text: '', msgNewType: 1,
    msgNewContent: JSON.stringify({ content: '搜索 小猪佩奇' }),
  }, 1, '搜索');
  const cmd = biliBot.parseCommand(r.text);
  assert.ok(cmd);
  assert.strictEqual(cmd.kind, 'search');
  assert.strictEqual(cmd.arg, '小猪佩奇');
});

test('B 站点播命令：普通聊天不会被误判成命令', () => {
  const r = flow({ content: '搜索结果好少啊', text: '搜索结果好少啊' }, 1, '搜索');
  assert.strictEqual(biliBot.parseCommand(r.text), null);
});
