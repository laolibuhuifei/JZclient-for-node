'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allowMessageSideEffects: allow, MAX_AGE_MS, MAX_FUTURE_SKEW_MS } = require('../src/im-message-freshness');

const now = 1_700_000_000_000;

for (const source of ['sync', 'push']) {
  test(`${source} 毫秒时间戳在双侧边界内才允许副作用`, () => {
    for (const time of [now - MAX_AGE_MS, now, now + MAX_FUTURE_SKEW_MS]) {
      assert.equal(allow({ source, createTime: time }, now), true);
    }
    for (const time of [now - MAX_AGE_MS - 1, now + MAX_FUTURE_SKEW_MS + 1]) {
      assert.equal(allow({ source, createTime: time }, now), false);
    }
  });

  test(`${source} 秒时间戳按秒转换后判断边界`, () => {
    for (const seconds of [(now - MAX_AGE_MS) / 1000, now / 1000, (now + MAX_FUTURE_SKEW_MS) / 1000]) {
      assert.equal(allow({ source, createTime: seconds }, now), true);
    }
    for (const seconds of [(now - MAX_AGE_MS) / 1000 - 1, (now + MAX_FUTURE_SKEW_MS) / 1000 + 1]) {
      assert.equal(allow({ source, createTime: seconds }, now), false);
    }
    // 秒时间戳只有秒精度，不向上补偿，从而保守地处理跨界情况。
    assert.equal(allow({ source, createTime: (now - MAX_AGE_MS) / 1000 }, now + 1), false);
  });

  test(`${source} 拒绝无效或无法判定单位的时间`, () => {
    for (const value of [-1, 1, 999_999_999, 10_000_000_000, 999_999_999_999,
      10_000_000_000_000, 1.5, NaN, Infinity, '1700000000', '', {}, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(allow({ source, createTime: value }, now), false, String(value));
    }
  });
}

test('缺失时间只允许 push，上游缺失 tag17 表示为零', () => {
  for (const value of [undefined, null, 0]) {
    assert.equal(allow({ source: 'push', createTime: value }, now), true);
    assert.equal(allow({ source: 'sync', createTime: value }, now), false);
  }
  assert.equal(allow({ source: 'push' }, now), true);
  assert.equal(allow({ source: 'sync' }, now), false);
});

test('未知来源、无消息或无效当前时间均禁止', () => {
  for (const message of [null, undefined, {}, { source: 'other', createTime: now }]) {
    assert.equal(allow(message, now), false);
  }
  for (const invalidNow of [undefined, 0, -1, NaN, Infinity, '1700000000000']) {
    assert.equal(allow({ source: 'push' }, invalidNow), false);
  }
});
