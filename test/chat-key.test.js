// 回归测试：会话 ID 归一化与消息归属匹配
//
// 对应线上故障（2026-11-09）：用户收不到手表消息，日志反复出现
//   「收到手表消息但找不到对应会话(已丢弃): {"dialogId":1128491384,"imAccountId":255,...}」
//
// 根因：家庭群在服务端有两个 IM 会话 ID —— imDialogId（旧）和 upgradeImDialogId（新）。
// 原来只读旧的，且用严格相等匹配；旧值过期后（1128491383 → 1128491384，差 1）
// 群消息就一条都认不出来，全被丢弃。
//
// 跑法：node --test test/

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { chatIdsOf, matchChatKey } = require('../src/webui');

// 造一个和 loadChatTargets 产出一致的 targets
function build(fd, family, watchId) {
  const fam = family || {};
  const accounts = fam.accounts || [];
  const targets = [];
  if (watchId) {
    targets.push({
      key: 's:' + watchId,
      type: 'single',
      receiverId: watchId,
      peers: accounts,
    });
  }
  const ids = chatIdsOf(fd, fam);
  if (ids.length) {
    targets.push({
      key: 'g:' + ids[0],
      type: 'group',
      dialogId: ids[0],
      aliasIds: ids,
      peers: accounts,
    });
  }
  return targets;
}

// ---------- chatIdsOf ----------

test('chatIdsOf：两个字段相同时只留一个', () => {
  assert.deepStrictEqual(chatIdsOf({ imDialogId: 1611958009, upgradeImDialogId: 1611958009 }, {}), ['1611958009']);
});

test('chatIdsOf：upgrade 在前（发送要用新的那个）', () => {
  assert.deepStrictEqual(chatIdsOf({ imDialogId: 1128491383, upgradeImDialogId: 1128491384 }, {}),
    ['1128491384', '1128491383']);
});

test('chatIdsOf：只有 upgrade 时也能取到（旧值为空的账号）', () => {
  assert.deepStrictEqual(chatIdsOf({ upgradeImDialogId: 2365566902 }, {}), ['2365566902']);
});

test('chatIdsOf：退回 family 层取', () => {
  assert.deepStrictEqual(chatIdsOf({}, { imDialogId: 915162057 }), ['915162057']);
});

test('chatIdsOf：0 / null / 空串都当没有', () => {
  assert.deepStrictEqual(chatIdsOf({ imDialogId: 0, upgradeImDialogId: null }, { imDialogId: '' }), []);
});

// ---------- 群消息匹配 ----------

test('群消息：旧 ID 过期时，新 ID 也能认出来（本次故障的直接回归）', () => {
  // 服务端：旧 1128491383、新 1128491384
  const t = build({ imDialogId: 1128491383, upgradeImDialogId: 1128491384 });
  // 手表发来的消息带的是新 ID
  assert.strictEqual(matchChatKey(t, { dialogId: 1128491384, imAccountId: 255, msgType: 1 }), 'g:1128491384');
  // 老固件如果还发旧 ID，一样要认
  assert.strictEqual(matchChatKey(t, { dialogId: 1128491383, imAccountId: 255, msgType: 1 }), 'g:1128491384');
});

test('群消息：只有 upgrade 的账号也能匹配', () => {
  const t = build({ upgradeImDialogId: 2365566902 });
  assert.strictEqual(matchChatKey(t, { dialogId: 2365566902, imAccountId: 1, msgType: 1 }), 'g:2365566902');
});

test('群消息：字符串和数字混着来也认（服务端有时发字符串）', () => {
  const t = build({ imDialogId: '1128491383', upgradeImDialogId: 1128491384 });
  assert.strictEqual(matchChatKey(t, { dialogId: '1128491384', imAccountId: 0, msgType: 1 }), 'g:1128491384');
});

test('群消息：imAccountId=255 不会误判成单聊', () => {
  const t = build({ imDialogId: 1128491383, upgradeImDialogId: 1128491384 }, {}, 166586037);
  // 255 不是任何单聊的 receiverId，且 dialogId 命中群 → 必须归到群
  assert.strictEqual(matchChatKey(t, { dialogId: 1128491384, imAccountId: 255, msgType: 1 }), 'g:1128491384');
});

test('群消息：完全不认识的 dialogId 返回 null（该走告警，不能瞎认）', () => {
  const t = build({ imDialogId: 1128491383, upgradeImDialogId: 1128491384 }, {}, 166586037);
  assert.strictEqual(matchChatKey(t, { dialogId: 999999999, imAccountId: 255, msgType: 1 }), null);
});

// ---------- 单聊匹配 ----------

test('单聊消息：按 imAccountId 匹配', () => {
  const t = build({ imDialogId: 1128491383 }, {}, 166586037);
  assert.strictEqual(matchChatKey(t, { dialogId: 0, imAccountId: 166586037, msgType: 1 }), 's:166586037');
});

test('单聊消息：dialogId 恰好等于对方 id 时也能匹配（部分固件这么发）', () => {
  const t = build({}, {}, 166586037);
  assert.strictEqual(matchChatKey(t, { dialogId: 166586037, imAccountId: 0, msgType: 1 }), 's:166586037');
});

test('没登记任何会话时返回 null', () => {
  assert.strictEqual(matchChatKey([], { dialogId: 1128491384, imAccountId: 255 }), null);
  assert.strictEqual(matchChatKey(null, { dialogId: 1 }), null);
});

test('老结构（没有 aliasIds 的 target）仍然按 dialogId 匹配', () => {
  // 兼容：如果哪天别处构造了没有 aliasIds 的 target，也不能崩
  const t = [{ key: 'g:777', type: 'group', dialogId: 777 }];
  assert.strictEqual(matchChatKey(t, { dialogId: 777, imAccountId: 1 }), 'g:777');
});
