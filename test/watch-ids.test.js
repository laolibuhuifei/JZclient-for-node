'use strict';
// 回归：卡片里的手表列表必须包含「配置里配过的表」
//
// 线上现象（2026-11-13）：用户给第 3 块表启用了 B 站点播，点保存后卡片显示回「未启用」。
// 实际配置里 enabled=true 早就写进去了 —— 是列表只按 watchNames 生成，那块表不在里面，
// 卡片就退化成默认值（enabled:false）。

const test = require('node:test');
const assert = require('node:assert');
const { mergeWatchIds } = require('../src/watch-ids');

test('名字列表和配置取并集，顺序先接口后配置', () => {
  const names = [{ watchId: 'a' }, { watchId: 'b' }];
  assert.deepEqual(mergeWatchIds(names, { c: {} }), ['a', 'b', 'c']);
});

test('配置里有、接口没返回的表也要列出来（本次故障）', () => {
  const names = [{ watchId: 'a' }, { watchId: 'b' }];
  const configured = { a: { enabled: true }, b: {}, third: { enabled: true } };
  const ids = mergeWatchIds(names, configured);
  assert.ok(ids.includes('third'), '配置过的表不能从列表里消失');
  assert.deepEqual(ids, ['a', 'b', 'third']);
});

test('接口一个都没给时仍然按配置列出', () => {
  assert.deepEqual(mergeWatchIds([], { x: {}, y: {} }), ['x', 'y']);
  assert.deepEqual(mergeWatchIds(null, { x: {} }), ['x']);
  assert.deepEqual(mergeWatchIds(undefined, null), []);
});

test('重复项去重，空值忽略', () => {
  const names = [{ watchId: 'a' }, { watchId: 'a' }, { watchId: '' }, {}, null];
  assert.deepEqual(mergeWatchIds(names, { a: {}, '': {}, b: {} }), ['a', 'b']);
});

test('数字型 watchId 归一化成字符串，不会和配置键重复', () => {
  assert.deepEqual(mergeWatchIds([{ watchId: 123 }], { 123: {} }), ['123']);
});
