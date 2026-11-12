'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { bufferEarlyMessages } = require('../src/im-early-messages');

test('连接前绑定、激活后按顺序交付早期及后续消息', () => {
  const client = new EventEmitter();
  const delivered = [];
  const buffer = bufferEarlyMessages(client, (m, buffered) => delivered.push([m, buffered]));
  client.emit('message', 1);
  client.emit('message', 2);
  assert.deepEqual(delivered, []);
  buffer.activate();
  client.emit('message', 3);
  buffer.activate();
  assert.deepEqual(delivered, [[1, true], [2, true], [3, false]]);
});

test('重入消息排在原有缓冲之后，处理异常不阻断后续消息', () => {
  const client = new EventEmitter();
  const delivered = [];
  const errors = [];
  const buffer = bufferEarlyMessages(client, (m) => {
    delivered.push(m);
    if (m === 1) { client.emit('message', 3); throw new Error('测试'); }
  }, { onError: (e) => errors.push(e.message) });
  client.emit('message', 1);
  client.emit('message', 2);
  buffer.activate();
  assert.deepEqual(delivered, [1, 2, 3]);
  assert.deepEqual(errors, ['测试']);
});

test('缓冲有界且溢出可观测，释放返回未处理数量', () => {
  const client = new EventEmitter();
  const overflow = [];
  const delivered = [];
  const buffer = bufferEarlyMessages(client, (m) => delivered.push(m), {
    limit: 1, onOverflow: (m) => overflow.push(m),
  });
  client.emit('message', 1);
  client.emit('message', 2);
  assert.deepEqual(overflow, [2]);
  assert.equal(buffer.dispose(), 1);
  assert.equal(buffer.dispose(), 0);
  buffer.activate();
  client.emit('message', 3);
  assert.deepEqual(delivered, []);
});
