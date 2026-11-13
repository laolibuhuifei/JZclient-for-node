'use strict';
// 回归：会话列表重复 / 少一块表
//
// 线上现象（2026-11-13）：聊天列表里「家庭群」和同名单聊各出现两遍，
// 同时用户绑了四块表却只看到三块。
//
// 根因：loadChatTargets 逐条 push familyDialogs，既不去重，
// 又用 accounts.find(accountType === 1) 只取家庭里的第一块表。

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

test('两条记录一条只有旧 ID、一条只有 upgrade 时合并，发送用 upgrade', () => {
  const accounts = [watch(1001, '冉冉'), parent(9001)];
  const targets = buildChatTargets([
    fd({ old: 555 }, accounts),
    fd({ up: 666 }, accounts),
  ]);
  assert.equal(targets.length, 2);
  const group = targets.find((t) => t.type === 'group');
  assert.equal(group.key, 'g:666', '主 ID 要用 upgrade');
  assert.equal(group.dialogId, '666');
  assert.deepEqual(group.aliasIds, ['666', '555'], '新旧 ID 都要能匹配');
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

test('合并后新旧群 ID 的消息都还能归档', () => {
  const accounts = [watch(1001, '冉冉'), parent(9001)];
  const targets = buildChatTargets([
    fd({ old: 555 }, accounts),
    fd({ up: 666 }, accounts),
  ]);
  assert.equal(matchChatKey(targets, { dialogId: 666 }), 'g:666');
  assert.equal(matchChatKey(targets, { dialogId: 555 }), 'g:666', '旧 ID 也要认');
  assert.equal(matchChatKey(targets, { dialogId: 0, imAccountId: 1001 }), 's:1001');
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
