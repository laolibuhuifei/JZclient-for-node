'use strict';
// 回归：去重表不能无限增长
//
// 线上可能出现的场景：一次补发几百条带图/语音的历史消息，或短时间内大量下行。
// 原来的清理只按「5 分钟前的条目」删，短时间内全都是新的，于是一条也删不掉，
// Map 会一直涨（长期运行的慢泄漏）。

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { ImClient } = require('../src/im');

function varint(n) {
  const bytes = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; bytes.push(b); } while (n);
  return Buffer.from(bytes);
}
function tlv(tag, value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([varint(tag), varint(b.length), b]);
}
function message(id, text) {
  return Buffer.concat([
    tlv(10, Buffer.from([7])), tlv(11, Buffer.from([8])),
    tlv(13, Buffer.from([1])), tlv(14, JSON.stringify({ text })), tlv(16, id),
  ]);
}

function offlineClient() {
  const client = Object.create(ImClient.prototype);
  EventEmitter.call(client);
  client._seen = new Map();
  client.pending = new Map();
  client.syncKey = 0;
  client.connected = false;
  client._pushAck = () => {};
  client._ackSoon = () => {};
  return client;
}

test('短时间内大量不同消息不会让去重表无限增长', () => {
  const client = offlineClient();
  let received = 0;
  client.on('message', () => { received++; });

  for (let i = 0; i < 1200; i++) client._dispatch(35, message('msg-' + i, '第' + i + '条'));

  assert.equal(received, 1200, '每条都应正常投递，不能被误判成重复');
  assert.ok(client._seen.size <= 500, '去重表应被压在 500 以内，实际 ' + client._seen.size);
});

test('超出上限后仍能识别刚刚出现过的重复消息', () => {
  const client = offlineClient();
  let received = 0;
  client.on('message', () => { received++; });

  for (let i = 0; i < 600; i++) client._dispatch(35, message('m-' + i, '内容' + i));
  const before = received;
  // 最新的一条再来一次，必须被去重
  client._dispatch(35, message('m-599', '内容599'));
  assert.equal(received, before, '重复消息不应再投递');
});

test('很老的消息在窗口外仍会重新投递（不误吞真消息）', () => {
  const client = offlineClient();
  let received = 0;
  client.on('message', () => { received++; });

  client._dispatch(35, message('old-1', '旧消息'));
  // 直接把它标记成 10 分钟前，模拟超出 TTL
  client._seen.set('m:old-1', Date.now() - 600000);
  client._dispatch(35, message('old-1', '旧消息'));
  assert.equal(received, 2, '窗口外不算重复');
});
