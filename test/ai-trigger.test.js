// 回归测试：AI 触发链路（关键词归一化 / 会话匹配 / 正文提取 / 模型参数）
//
// 优化/修复：anjianhe (https://github.com/anjianhe)
//
// 跑法：node --test test/
//
// 说明：文中的关键词（「你好」「24」等）都是**测试夹具**，用来模拟用户自己设置的
// 触发词；项目没有任何内置触发词，默认 keywords 是空数组。
//
// 这些用例全部对应线上真实故障：
//   1. 「关键词 + 内容」能看见但 AI 不回 —— 正文只在信封内层，parsed.text 是空串
//   2. 全角字符看着一样却匹配不上
//   3. 勾了单聊还是不放行 —— 触发用 imAccountId 比，归档用 dialogId 比，两套规则劈叉
//   4. deepseek-reasoner 带了 temperature 被网关 400，或只回思考不回正文
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const trig = require('../src/ai-trigger');
const ai = require('../src/ai');
const device = require('../src/device');

// ============ 文本归一化 ============
test('normText 把全角字符折成半角', () => {
  assert.strictEqual(trig.normText('１２３ 内容'), '123 内容');
  assert.strictEqual(trig.normText('ＡＢＣ'), 'abc');
});

test('normText 去掉零宽字符和各种怪异空白', () => {
  assert.strictEqual(trig.normText('1\u200b2 内容'), '12 内容');
  assert.strictEqual(trig.normText('\u00a012\u3000内容'), '12 内容');
  assert.strictEqual(trig.normText('  12   内容  '), '12 内容');
});

// ============ 关键词拆分 ============
test('splitKeywords 支持中英文逗号/空格/顿号分隔并去重', () => {
  assert.deepStrictEqual(trig.splitKeywords('你好，内容 你好、帮忙'), ['你好', '内容', '帮忙']);
  assert.deepStrictEqual(trig.splitKeywords(''), []);
  assert.deepStrictEqual(trig.splitKeywords(null), []);
  // 全角/半角同一关键词只留一份
  assert.deepStrictEqual(trig.splitKeywords(['ｈｅｌｌｏ', 'hello']), ['hello']);
});

// ============ 关键词匹配 ============
test('关键词前缀命中：以关键词开头的消息', () => {
  const r = trig.matchKeyword('你好 在吗', ['你好']);
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.keyword, '你好');
  assert.strictEqual(r.how, 'prefix');
});

test('全角文本也能命中半角关键词', () => {
  const r = trig.matchKeyword('ｈｅｌｌｏ 你好', ['hello']);
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.how, 'prefix');
});

test('夹了零宽字符的文本照样命中', () => {
  assert.strictEqual(trig.matchKeyword('\u200b你好 在吗', ['你好']).hit, true);
});

test('大小写不敏感', () => {
  assert.strictEqual(trig.matchKeyword('HELLO 你好', ['hello']).hit, true);
});

test('auto 模式：词边界内的数字也命中，但不匹配 1024 里的 24', () => {
  assert.strictEqual(trig.matchKeyword('今天 24 号', ['24']).hit, true);
  assert.strictEqual(trig.matchKeyword('1024', ['24']).hit, false);
  assert.strictEqual(trig.matchKeyword('abc24def', ['24']).hit, false);
});

test('prefix 模式只认开头', () => {
  assert.strictEqual(trig.matchKeyword('再说 你好', ['你好'], 'prefix').hit, false);
  assert.strictEqual(trig.matchKeyword('你好 在吗', ['你好'], 'prefix').hit, true);
});

test('contains 模式保留旧行为（含 1024）', () => {
  assert.strictEqual(trig.matchKeyword('1024', ['24'], 'contains').hit, true);
});

test('中文关键词直接包含即可', () => {
  assert.strictEqual(trig.matchKeyword('我想问个问题', ['问题']).hit, true);
});

test('空关键词/空文本不会误触发', () => {
  assert.strictEqual(trig.matchKeyword('随便说点什么', []).hit, false);
  assert.strictEqual(trig.matchKeyword('', ['你好']).hit, false);
  assert.strictEqual(trig.matchKeyword('随便说点什么', ['  ', '']).hit, false);
});

// ============ 正文提取（这次故障的核心） ============
test('aiTextOf：普通文本直接用 describe 的结果', () => {
  const parsed = { kind: 'text', text: '你好 在吗', inner: { text: '你好 在吗' } };
  assert.strictEqual(trig.aiTextOf(parsed, '你好 在吗'), '你好 在吗');
});

test('aiTextOf：转发文本剥掉 [转发] 前缀', () => {
  const parsed = { kind: 'relay_text', text: '', inner: { content: '你好 在吗' } };
  assert.strictEqual(trig.aiTextOf(parsed, '[转发] 你好 在吗'), '你好 在吗');
});

test('aiTextOf：正文只在信封内层时也能取到（parsed.text 为空）', () => {
  const parsed = { kind: 'relay_text', text: '', inner: { content: '帮我看看作业' } };
  assert.strictEqual(trig.aiTextOf(parsed), '帮我看看作业');
});

test('aiTextOf：hint 类型走 inner.content', () => {
  const parsed = { kind: 'text_hint', text: '', inner: { content: '该喝水了' } };
  assert.strictEqual(trig.aiTextOf(parsed, '[提示] 该喝水了'), '该喝水了');
});

test('aiTextOf：媒体类消息不参与（图片/语音/位置）', () => {
  ['photo', 'voice', 'video', 'location', 'emoji', 'red_packet', 'status'].forEach((kind) => {
    assert.strictEqual(trig.aiTextOf({ kind, text: '[图片] https://x' }, '[图片] https://x'), '',
      kind + ' 不应该被当成可回复文本');
  });
});

test('aiTextOf：raw 去掉 [原始消息] 前缀', () => {
  assert.strictEqual(trig.aiTextOf({ kind: 'raw', text: '[原始消息] 你好' }, '[原始消息] 你好'), '你好');
});

// ============ 会话匹配 ============
const SESS_SINGLE = [{ key: 's:1001', type: 'single', name: '手表', receiverId: '1001' }];
const SESS_BOTH = SESS_SINGLE.concat([{ key: 'g:9009', type: 'group', name: '家庭群', dialogId: '9009' }]);

test('matchSession：chatKey 精确命中单聊', () => {
  const s = trig.matchSession(SESS_SINGLE, { chatKey: 's:1001', imAccountId: '1001' });
  assert.ok(s);
  assert.strictEqual(s.receiverId, '1001');
});

test('matchSession：chatKey 没命中时不会串到别的会话', () => {
  assert.strictEqual(trig.matchSession(SESS_SINGLE, { chatKey: 's:2002', imAccountId: '2002' }), null);
});

test('matchSession：旧配置把 key 存成 single:1001 也能匹配', () => {
  const legacy = [{ key: 'single:1001', type: 'single', name: '手表' }];
  const s = trig.matchSession(legacy, { chatKey: 's:1001' });
  assert.ok(s);
  assert.strictEqual(trig.sessionKeyOf(s), 's:1001');
});

test('matchSession：收不到 imAccountId、只有 dialogId=对方 时也能认出单聊（故障场景）', () => {
  // 服务端把 tag10 填成对方、tag11 是 0：旧代码 Number(0) !== Number('1001') 直接判死
  const s = trig.matchSession(SESS_SINGLE, { chatKey: '', imAccountId: 0, dialogId: '1001' });
  assert.ok(s, '应该靠 dialogId 兜底命中');
});

test('matchSession：数字和字符串形式的 id 都认', () => {
  const s = trig.matchSession(SESS_SINGLE, { chatKey: '', imAccountId: 1001 });
  assert.ok(s);
});

test('matchSession：超长数字 id 用 BigInt 精确比较，不会因浮点误差串号', () => {
  const big = '1234567890123456789';
  const sess = [{ key: 's:' + big, type: 'single', receiverId: big }];
  assert.ok(trig.matchSession(sess, { chatKey: '', imAccountId: ' 1234567890123456789 ' }));
  assert.strictEqual(trig.matchSession(sess, { chatKey: '', imAccountId: '1234567890123456790' }), null);
});

test('matchSession：单聊消息不会误匹配到群会话', () => {
  const s = trig.matchSession(SESS_BOTH, { chatKey: 'g:9009', imAccountId: '1001' });
  assert.ok(s);
  assert.strictEqual(s.type, 'group');
});

test('matchSession：群消息但群没勾选 → null', () => {
  assert.strictEqual(trig.matchSession(SESS_SINGLE, { chatKey: 'g:9009' }), null);
});

test('matchSession：自己发的消息（id 等于 selfId）不会被当对方', () => {
  const s = trig.matchSession(SESS_SINGLE, { chatKey: '', imAccountId: '1001', selfId: '1001' });
  assert.strictEqual(s, null);
});

test('matchSession：peers 里能对上也算命中', () => {
  const s = trig.matchSession(SESS_SINGLE, {
    chatKey: '', imAccountId: '0', dialogId: '0',
    peers: [{ imAccountId: '1001', name: '小宝' }],
  });
  assert.ok(s);
});

// ============ 模型参数（deepseek 系列） ============
test('buildUrl 兼容 /v1 与完整地址', () => {
  assert.strictEqual(ai.buildUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(ai.buildUrl('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(ai.buildUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.throws(() => ai.buildUrl(''));
});

test('isReasoningModel 识别 deepseek-reasoner，不误伤 deepseek-flash', () => {
  assert.strictEqual(ai.isReasoningModel('deepseek-reasoner'), true);
  assert.strictEqual(ai.isReasoningModel('deepseek-r1'), true);
  assert.strictEqual(ai.isReasoningModel('o1-mini'), true);
  assert.strictEqual(ai.isReasoningModel('deepseek-flash'), false);
  assert.strictEqual(ai.isReasoningModel('deepseek-chat'), false);
  assert.strictEqual(ai.isReasoningModel('gpt-4o-mini'), false);
});

test('buildBody：deepseek-flash 正常带 temperature', () => {
  const body = ai.buildBody(
    { model: 'deepseek-flash', temperature: 0.7 },
    [{ role: 'user', content: '你好' }]
  );
  assert.strictEqual(body.model, 'deepseek-flash');
  assert.strictEqual(body.temperature, 0.7);
  assert.strictEqual(body.stream, false);
});

test('buildBody：deepseek-reasoner 不带 temperature（否则部分网关 400）', () => {
  const body = ai.buildBody(
    { model: 'deepseek-reasoner', temperature: 0.7 },
    [{ role: 'user', content: '你好' }]
  );
  assert.strictEqual(body.model, 'deepseek-reasoner');
  assert.strictEqual('temperature' in body, false);
});

test('buildBody：temperature 越界会被夹到 [0,2]', () => {
  assert.strictEqual(ai.buildBody({ model: 'deepseek-flash', temperature: 9 }, [{ role: 'user', content: 'a' }]).temperature, 2);
  assert.strictEqual(ai.buildBody({ model: 'deepseek-flash', temperature: -3 }, [{ role: 'user', content: 'a' }]).temperature, 0);
});

test('buildBody：maxTokens>0 才带 max_tokens', () => {
  assert.strictEqual('max_tokens' in ai.buildBody({ model: 'deepseek-flash' }, [{ role: 'user', content: 'a' }]), false);
  assert.strictEqual(ai.buildBody({ model: 'deepseek-flash', maxTokens: 800 }, [{ role: 'user', content: 'a' }]).max_tokens, 800);
});

test('normalizeMessages：连续同角色合并、空 assistant 丢弃、system 提前', () => {
  const out = ai.normalizeMessages([
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: '第二条' },
    { role: 'system', content: '你是助手' },
  ]);
  assert.deepStrictEqual(out, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '第一条\n第二条' },
  ]);
});

// ============ 配置归一化 ============
test('toImId：数字字符串必须还原成 number（tlv 对 string 走 UTF-8，协议不认）', () => {
  assert.strictEqual(trig.toImId(123), 123);
  assert.strictEqual(trig.toImId('123'), 123);
  assert.strictEqual(trig.toImId(' 123 '), 123);
  assert.strictEqual(trig.toImId(''), '');
  assert.strictEqual(trig.toImId(null), '');
  assert.strictEqual(trig.toImId('s:123'), 's:123');
  // 超出安全整数就保留字符串，宁可报错也不悄悄改号
  assert.strictEqual(trig.toImId('12345678901234567890'), '12345678901234567890');
});

test('normalizeAi：老配置缺字段时补默认值，keywords 默认为空', () => {
  const a = device.normalizeAi({ baseUrl: 'https://api.deepseek.com/v1/' });
  assert.strictEqual(a.baseUrl, 'https://api.deepseek.com/v1');
  assert.strictEqual(a.trigger, 'auto');
  assert.strictEqual(a.keywordsMode, 'auto');
  assert.strictEqual(a.autoStart, true);
  assert.strictEqual(a.timeoutMs, 120000);
  assert.deepStrictEqual(a.keywords, []);
  assert.deepStrictEqual(a.sessions, []);
});

test('normalizeAi：脏数据收敛', () => {
  const a = device.normalizeAi({
    keywords: '不是数组',
    temperature: 99,
    trigger: '乱写',
    keywordsMode: '乱写',
    sessions: [
      { type: 'single', receiverId: 1001, name: '手表' },
      { type: 'group', dialogId: 9009 },
      { type: 'bogus' },
      null,
    ],
  });
  // keywords 是字符串时按分隔符拆开保留，不能丢成空数组。
  // 老配置（手改过 config.json / 早期版本）里真有字符串形式，
  // 丢掉等于「升级后关键词全没了」，和「AI 怎么都不触发」是同一副面孔。
  assert.deepStrictEqual(a.keywords, ['不是数组']);
  assert.strictEqual(a.temperature, 2);
  assert.strictEqual(a.trigger, 'auto');
  assert.strictEqual(a.keywordsMode, 'auto');
  assert.strictEqual(a.sessions.length, 2);
  // 保持数字类型：转成字符串会让 im.js 的 tlv() 用 UTF-8 编码 id，消息发不出去
  assert.strictEqual(a.sessions[0].receiverId, 1001);
  assert.strictEqual(a.sessions[1].dialogId, 9009);
});

test('normalizeAi：autoStart=false 保持关闭', () => {
  assert.strictEqual(device.normalizeAi({ autoStart: false }).autoStart, false);
});
