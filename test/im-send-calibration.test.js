'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ImClient } = require('../src/im');

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[offset++];
    value += (byte & 0x7f) * (2 ** shift);
    if (!(byte & 0x80)) return { value, offset };
    shift += 7;
  }
  throw new Error('invalid varint');
}

function readTlvMap(buf) {
  const tags = new Map();
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    const length = readVarint(buf, tag.offset);
    const start = length.offset;
    const end = start + length.value;
    tags.set(tag.value, buf.subarray(start, end));
    offset = end;
  }
  return tags;
}

function toInt(buf) {
  let value = 0;
  for (const byte of buf) value = value * 256 + byte;
  return value;
}

function offlineClient() {
  const client = Object.create(ImClient.prototype);
  EventEmitter.call(client);
  client.imAccountId = 324766351;
  client.registId = 515070783;
  client.sent = null;
  client._request = async (_cmd, body) => {
    client.sent = body;
    return { tags: new Map([[2, Buffer.from([200])]]) };
  };
  return client;
}

test('单聊视频消息携带发送回执参数和数字接收者 ID', async () => {
  const client = offlineClient();
  const result = await client.sendSinglePayload('317872567', { msgNewType: 5 }, 1);
  const tags = readTlvMap(client.sent);

  assert.deepEqual([...tags.get(2)], [0]);
  assert.equal(toInt(tags.get(10)), 317872567);
  assert.equal(toInt(tags.get(11)), 324766351);
  assert.equal(toInt(tags.get(12)), 515070783);
  assert.equal(toInt(tags.get(13)), 1);
  assert.equal(result.ok, true);
});

test('群聊视频消息携带发送回执参数和数字会话 ID', async () => {
  const client = offlineClient();
  const result = await client.sendGroupPayload('1128491384', '255', { msgNewType: 5 }, 1);
  const tags = readTlvMap(client.sent);

  assert.deepEqual([...tags.get(2)], [0]);
  assert.equal(toInt(tags.get(10)), 1128491384);
  assert.equal(toInt(tags.get(11)), 255);
  assert.equal(toInt(tags.get(12)), 515070783);
  assert.equal(toInt(tags.get(13)), 1);
  assert.equal(result.ok, true);
});
