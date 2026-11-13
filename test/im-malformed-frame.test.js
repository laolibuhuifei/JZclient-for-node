'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ImClient } = require('../src/im');

function clientWith(bytes) {
  const client = new ImClient({});
  client.rbuf = Buffer.from(bytes);
  client.died = 0;
  client._die = () => { client.died++; };
  return client;
}

test('溢出帧长度断开而不是负长度循环', () => {
  const client = clientWith([0x21, 0xff, 0xff, 0xff, 0xff, 0x08]);
  client._pump();
  assert.equal(client.died, 1);
  assert.equal(client.rbuf.length, 0);
});

test('过长 varint 断开连接', () => {
  const client = clientWith([0x21, 0x80, 0x80, 0x80, 0x80, 0x80]);
  client._pump();
  assert.equal(client.died, 1);
});

test('跨包的长度 varint 等待后续字节', () => {
  const client = clientWith([0x21, 0x80]);
  const received = [];
  client._onFrame = (cmd, data) => received.push([cmd, data.length]);
  client._pump();
  assert.equal(client.rbuf.length, 2);
  client.rbuf = Buffer.concat([client.rbuf, Buffer.from([0x01]), Buffer.alloc(128)]);
  client._pump();
  assert.deepEqual(received, [[1, 128]]);
  assert.equal(client.died, 0);
});

test('截断 TLV 的值不当作完整字段', () => {
  const client = clientWith([0xa0, 35, 3, 14, 5, 123]);
  let message;
  client.on('message', m => { message = m; });
  client._pushAck = () => {};
  client._ackSoon = () => {};
  client._pump();
  assert.equal(message.raw.length, 0);
});
