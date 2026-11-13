'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOnebotScope } = require('../src/onebot-scope');

const targets = [
  { key: 's:101', type: 'single' },
  { key: 'g:202', type: 'group' },
  { key: 's:303', type: 'single' },
];

test('绑定手表的空范围拒绝每个会话并返回空列表', () => {
  for (const keys of [[], null, undefined]) {
    const scope = createOnebotScope('watch-1', keys);
    for (const target of targets) assert.equal(scope.allows(target.key), false);
    assert.deepEqual(scope.filter(targets), []);
  }
});

test('绑定手表只允许已选单聊和群聊，不允许范围外会话', () => {
  const scope = createOnebotScope('watch-1', ['s:101', 'g:202']);
  assert.equal(scope.allows('s:101'), true);
  assert.equal(scope.allows('g:202'), true);
  assert.equal(scope.allows('s:303'), false);
  assert.equal(scope.allows('g:303'), false);
  assert.deepEqual(scope.filter(targets), targets.slice(0, 2));
});

test('空范围与其他手表的范围相互独立，且范围为创建时的快照', () => {
  const keys = ['s:101'];
  const first = createOnebotScope('watch-1', keys);
  const second = createOnebotScope('watch-2', []);
  keys.push('s:303');
  assert.equal(first.allows('s:101'), true);
  assert.equal(first.allows('s:303'), false);
  assert.equal(second.allows('s:101'), false);
  assert.deepEqual(second.filter(targets), []);
});

test('未绑定手表的全局实例保持不过滤的兼容行为', () => {
  for (const watchId of [null, undefined, '']) {
    const scope = createOnebotScope(watchId, []);
    assert.equal(scope.allows('s:303'), true);
    assert.deepEqual(scope.filter(targets), targets);
    assert.notEqual(scope.filter(targets), targets);
  }
});
