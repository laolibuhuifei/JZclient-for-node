'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { batteryValue, selectBattery, selectOnline } = require('../src/watch-status-selection');

test('电量只接受有效百分比并保留零', () => {
  for (const v of [null, undefined, '', ' ', false, true, -1, 101, NaN, Infinity, '10%', '1e2', {}, []]) assert.equal(batteryValue(v), null);
  assert.equal(batteryValue(0), 0);
  assert.equal(batteryValue(' 0 '), 0);
  assert.equal(batteryValue('100'), 100);
  assert.equal(batteryValue(35.5), 35.5);
});

test('没有可比较采样时间时接口优先且不借用推送时间', () => {
  assert.deepEqual(selectBattery({ apiValue: 0, pushValue: 90, pushAt: 200, pushTimeKind: 'received' }),
    { battery: 0, batterySource: 'api', batteryAt: null, batteryTimeKind: null });
  assert.equal(selectBattery({ apiValue: 30, apiAt: 100, apiTimeKind: 'observed', pushValue: 90, pushAt: 200, pushTimeKind: 'received' }).battery, 30);
});

test('仅比较双方可信的设备采样时间', () => {
  const base = { apiValue: 30, apiAt: 100, apiTimeKind: 'observed', pushValue: 80, pushAt: 200, pushTimeKind: 'observed' };
  assert.deepEqual(selectBattery(base), { battery: 80, batterySource: 'push', batteryAt: 200, batteryTimeKind: 'observed' });
  assert.equal(selectBattery({ ...base, pushAt: 100 }).battery, 30);
  assert.equal(selectBattery({ ...base, pushAt: 50 }).battery, 30);
  assert.equal(selectBattery({ ...base, apiAt: null }).battery, 30);
});

test('接口无效时可展示推送但时间标记为接收时间', () => {
  assert.deepEqual(selectBattery({ apiValue: 101, pushValue: '0', pushAt: 200, pushTimeKind: 'received' }),
    { battery: 0, batterySource: 'push', batteryAt: 200, batteryTimeKind: 'received' });
  assert.deepEqual(selectBattery({}), { battery: null, batterySource: null, batteryAt: null, batteryTimeKind: null });
  assert.equal(selectBattery({ pushValue: 25, pushAt: 200 }).batteryAt, null);
});

test('在线状态为三态，冲突和非布尔值不臆断', () => {
  assert.equal(selectOnline(), null);
  assert.equal(selectOnline(false), false);
  assert.equal(selectOnline(undefined, true), true);
  assert.equal(selectOnline(true, false), null);
  assert.equal(selectOnline('false', 0), null);
  assert.equal(selectOnline(true, true), true);
});
