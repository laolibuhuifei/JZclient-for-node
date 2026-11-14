'use strict';
// 回归：会话列表重复 / 少一块表
//
// 线上现象（2026-11-13）：聊天列表里「家庭群」和同名单聊各出现两遍，
// 同时用户绑了四块表却只看到三块。
//
// 原实现逐条生成会话且只取首个手表账号；具体线上返回数据仍需验证。

const test = require('node:test');
const assert = require('node:assert');
const { buildChatTargets } = require('../src/chat-targets');
const { matchChatKey } = require('../src/webui');

const parent = (id) => ({ accountType: 0, imAccountId: id, name: '家长' + id });
const watch = (id, name) => ({ accountType: 1, imAccountId: id, name, model: 'Z7' });

function fd(ids, accounts) {
  return {
    imDialogId: ids.old,
    upgradeImDialogId: ids.up,
    familyList: [{ accounts }],
  };
}

test('同一家庭出现两条记录时只留一条，不重复显示', () => {
  const accounts = [watch(1001, '冉冉'), parent(9001)];
  const targets = buildChatTargets([
    fd({ old: 555, up: 666 }, accounts),
    fd({ old: 555, up: 666 }, accounts),   // 服务端重复下发
  ]);
  assert.equal(targets.filter((t) => t.type === 'single').length, 1);
  assert.equal(targets.filter((t) => t.type === 'group').length, 1);
  assert.equal(targets.length, 2);
  assert.equal(targets.find((t) => t.type === 'group').key, 'g:666');
});

test('一个家庭绑多块表时每块表都要有自己的单聊', () => {
  const accounts = [watch(1001, '冉冉'), watch(1002, '罗比特'), parent(9001)];
  const targets = buildChatTargets([fd({ old: 555 }, accounts)]);
  const singles = targets.filter((t) => t.type === 'single');
  assert.deepEqual(singles.map((t) => t.key).sort(), ['s:1001', 's:1002']);
  assert.equal(targets.filter((t) => t.type === 'group').length, 1);
});

test('成员相同但群 ID 不同，不推断是同一群', () => {
  const accounts = [watch(1001, '冉冉'), parent(9001)];
  const targets = buildChatTargets([
    fd({ old: 555 }, accounts),
    fd({ up: 666 }, accounts),
  ]);
  assert.deepEqual(targets.filter(t => t.type === 'group').map(t => t.key).sort(), ['g:555', 'g:666']);
});

test('两个不同的家庭不会被误合并', () => {
  const a = [watch(1001, '冉冉'), parent(9001)];
  const b = [watch(2001, '未命名'), parent(9002)];
  const targets = buildChatTargets([
    fd({ old: 555, up: 556 }, a),
    fd({ old: 777, up: 778 }, b),
  ]);
  assert.equal(targets.filter((t) => t.type === 'group').length, 2);
  assert.equal(targets.filter((t) => t.type === 'single').length, 2);
});

test('同一条记录明确关联的新旧群 ID 都还能归档', () => {
  const accounts = [watch(1001, '冉冉'), parent(9001)];
  const targets = buildChatTargets([
    fd({ old: 555, up: 666 }, accounts),
  ]);
  assert.equal(matchChatKey(targets, { dialogId: 666 }), 'g:666');
  assert.equal(matchChatKey(targets, { dialogId: 555 }), 'g:666', '旧 ID 也要认');
  assert.equal(matchChatKey(targets, { dialogId: 0, imAccountId: 1001 }), 's:1001');
});

test('群 ID 别名有歧义时拒绝猜测消息归属', () => {
  const accounts = [watch(1001, '手表')];
  const targets = buildChatTargets([
    fd({ up: 666, old: 555 }, accounts),
    fd({ up: 777, old: 555 }, accounts),
  ]);
  assert.equal(matchChatKey(targets, { dialogId: 555 }), null);
  assert.equal(matchChatKey(targets, { dialogId: 666 }), 'g:666');
  assert.equal(matchChatKey(targets, { dialogId: 777 }), 'g:777');
});

test('没有成员表时按群 ID 区分，不会把两个空成员家庭并成一个', () => {
  const targets = buildChatTargets([
    fd({ old: 555 }, []),
    fd({ old: 777 }, []),
  ]);
  assert.equal(targets.filter((t) => t.type === 'group').length, 2);
  assert.equal(targets.filter((t) => t.type === 'single').length, 0);
});

test('多余字段不外泄：targets 里不带合并用的中间状态', () => {
  const accounts = [watch(1001, '冉冉')];
  const targets = buildChatTargets([fd({ old: 555, up: 666 }, accounts)]);
  for (const t of targets) {
    assert.equal('up' in t, false);
    assert.equal('old' in t, false);
  }
});

// 2026-11-14 用户反馈「绑了手表但聊天里没有它的会话」。
// 排查到两个点：绑表后服务端缓存没失效（webui 侧已修），以及这里只读 familyList[0]。
// familyList 是数组，只取第一组的话，服务端一旦把成员拆成多组推送，后面几组的表就整块消失。
test('familyList 有多组时，每一组的表都要出现在会话列表里', () => {
  const targets = buildChatTargets([{
    imDialogId: 555,
    upgradeImDialogId: 666,
    familyList: [
      { accounts: [watch(1001, '冉冉'), parent(9001)] },
      { accounts: [watch(1002, '罗比特'), parent(9002)] },
    ],
  }]);
  const singles = targets.filter((t) => t.type === 'single').map((t) => t.key).sort();
  assert.deepEqual(singles, ['s:1001', 's:1002']);
  // 群只建一个（群 ID 来自顶层，不按 familyList 拆）
  assert.equal(targets.filter((t) => t.type === 'group').length, 1);
  // 群成员名要把两组的家长都带上，否则用户看不到另一组是谁
  assert.ok(targets.find((t) => t.type === 'group').sub.includes('家长9002'));
});

test('同一块表在多个 familyList 分组里重复出现时不会变成两个单聊', () => {
  const w = watch(1001, '冉冉');
  const targets = buildChatTargets([{
    imDialogId: 555,
    familyList: [
      { accounts: [w, parent(9001)] },
      { accounts: [w, parent(9002)] },
    ],
  }]);
  assert.equal(targets.filter((t) => t.type === 'single').length, 1);
});

test('familyList 缺失 / 是空数组 / 元素没有 accounts 都不崩', () => {
  const cases = [
    { imDialogId: 555 },
    { imDialogId: 555, familyList: [] },
    { imDialogId: 555, familyList: [{}] },
    { imDialogId: 555, familyList: [null] },
  ];
  for (const c of cases) {
    const targets = buildChatTargets([c]);
    assert.equal(targets.filter((t) => t.type === 'group').length, 1, JSON.stringify(c));
    assert.equal(targets.filter((t) => t.type === 'single').length, 0, JSON.stringify(c));
  }
});

test('familyList 不是数组时当作没有成员，但群照样建', () => {
  const targets = buildChatTargets([{ imDialogId: 555, familyList: 'oops' }]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].type, 'group');
});
