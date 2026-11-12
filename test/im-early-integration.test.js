'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ImClient } = require('../src/im');
const { bufferEarlyMessages } = require('../src/im-early-messages');

// 构造离线 TLV 载荷；直接交给真实的 _dispatch，不创建 socket。
function varint(n) {
  const bytes = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return Buffer.from(bytes);
}
function tlv(tag, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([varint(tag), varint(bytes.length), bytes]);
}
function message(id, text) {
  return Buffer.concat([
    tlv(10, Buffer.from([7])), tlv(11, Buffer.from([8])),
    tlv(13, Buffer.from([1])), tlv(14, JSON.stringify({ text })), tlv(16, id),
  ]);
}
function offlineClient() {
  // 不调用构造函数，不读取用户配置；仅初始化真实分发所需状态。
  const client = Object.create(ImClient.prototype);
  EventEmitter.call(client);
  client._seen = new Map();
  client.pending = new Map();
  client.syncKey = 0;
  client.connected = false;
  client._pushAck = () => {};
  client._ackSoon = () => {};
  client._open = async () => {};
  client._regist = async () => {};
  client._login = async () => {};
  client._online = async () => {};
  client._startHeartbeat = () => {};
  return client;
}

test('真实同步分发的握手消息按序缓冲，重复消息只触发一次', async () => {
  const client = offlineClient();
  const received = [];
  const seenEvents = [];
  client.on('message', (msg) => seenEvents.push(msg.msgId));
  const buffer = bufferEarlyMessages(client, (msg, buffered) => {
    received.push([msg.msgId, msg.body.text, msg.source, buffered]);
    // 排空期间同步到达的新消息不能插到此前缓冲消息的前面。
    if (msg.msgId === 'first') client._dispatch(35, message('third', '第三条'));
  });
  client._handshake = async () => {
    assert.equal(client.connected, false);
    client._dispatch(35, message('first', '第一条'));
    client._dispatch(13, message('second', '第二条'));
    client._dispatch(13, message('first', '第一条'));
    assert.deepEqual(seenEvents, ['first', 'second']);
    assert.deepEqual(received, []);
  };

  await client.connect();
  assert.equal(client.connected, true);
  buffer.activate();
  assert.deepEqual(received, [
    ['first', '第一条', 'push', true],
    ['second', '第二条', 'sync', true],
    ['third', '第三条', 'push', false],
  ]);
  client._dispatch(35, message('second', '第二条'));
  client._dispatch(13, message('fourth', '第四条'));
  assert.deepEqual(seenEvents, ['first', 'second', 'third', 'fourth']);
  assert.deepEqual(received[3], ['fourth', '第四条', 'sync', false]);
  assert.equal(received.length, 4);
  assert.equal(buffer.dispose(), 0);
});

test('connect 之前安装错误监听可处理握手阶段 error 事件', async () => {
  const client = offlineClient();
  const errors = [];
  const expected = new Error('离线模拟握手错误');
  client.on('error', (err) => errors.push(err));
  const buffer = bufferEarlyMessages(client, () => assert.fail('不应收到消息'));
  client._handshake = async () => {
    assert.equal(client.connected, false);
    client.emit('error', expected);
  };
  await client.connect();
  assert.deepEqual(errors, [expected]);
  assert.equal(buffer.dispose(), 0);
});
