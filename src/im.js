// IM 客户端(纯 Node,无设备依赖)
// 协议说明:
//   TLS 长连接
//   帧: [0xA0][cmd][len varint][TLV body]; cmd<=0x1F 时头为单字节 0x20|cmd
//   握手: cmd22 PublicKeyRequest -> cmd23 返回 RSA 公钥(tag10), cmd33 EncryptSet{tag1 RID, tag10=1, tag11=RSA(key)}
//   启用加密后: 外层 cmd32, 载荷 tag10 = 内层帧 XOR 会话密钥(会话密钥为 32 字符串,循环复用)
//   cmd1 Regist -> cmd2 (tag10=registId)
//   cmd3 Login  -> cmd4
//   cmd5 Account(status=2 上线) -> cmd6 (tag10=自己的 imAccountId)
//   cmd40 单聊发消息 {tag10=receiverId, tag11=自己 imAccountId, tag12=registId, tag13=msgType, tag14=JSON, tag15=msgId, tag16=contentType}
//   cmd9  群聊发消息 {tag10=dialogId, tag11=群 imAccountId, tag12=registId, tag13=msgType, tag14=JSON, tag15=msgId, tag18=contentType}
//   cmd11 SyncInform -> cmd12 SyncRequest {tag11 imAccountId, tag12 registId, tag13 syncKey, tag14 pageSize, tag0 platformId}
//   cmd13 SyncResponse / cmd35 PushResponse 携带收到的消息
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const site = require('./site');
const log = require('./logger');

const IM_HOST = site.im.host;
const IM_PORT = site.im.port;
const APP_KEY = site.im.appKey;
const APP_VERSION_CODE = site.app.versionCode;
const APP_VERSION_NAME = site.app.versionName;
const PKG = site.app.packageName;

const CMD = {
  REGIST: 1, REGIST_RESP: 2,
  LOGIN: 3, LOGIN_RESP: 4,
  ACCOUNT: 5, ACCOUNT_RESP: 6,
  HEARTBEAT: 7, HEARTBEAT_RESP: 8,
  MESSAGE: 9, MESSAGE_RESP: 10,
  SYNC_INFORM: 11, SYNC: 12, SYNC_RESP: 13,
  SYNC_TRIGGER: 25, SYNC_TRIGGER_RESP: 26,
  ENCRYPT_WRAPPER: 32,
  ENCRYPT_SET: 33, ENCRYPT_SET_RESP: 34,
  PUSH: 35,
  SINGLE_MESSAGE: 40,
  PUBLIC_KEY: 22, PUBLIC_KEY_RESP: 23,
};

function varint(n) {
  const o = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n);
  return Buffer.from(o);
}
function readVarint(b, o) {
  let v = 0, s = 0, x;
  do { x = b[o++]; v |= (x & 0x7f) << s; s += 7; } while (x & 0x80 && o < b.length);
  return { val: v, next: o };
}
function numBytes(n) {
  const a = [];
  do { a.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
  return Buffer.from(a);
}
function tlv(tag, v) {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(typeof v === 'number' ? numBytes(v) : String(v), 'utf8');
  return Buffer.concat([varint(tag), varint(b.length), b]);
}
function parseTLV(b) {
  const out = [];
  let o = 0;
  while (o < b.length) {
    const t = readVarint(b, o); if (t.next > b.length) break; o = t.next;
    const l = readVarint(b, o); if (l.next > b.length) break; o = l.next;
    out.push({ tag: t.val, value: b.slice(o, o + l.val) });
    o += l.val;
  }
  return out;
}
function tlvMap(b) {
  const m = new Map();
  for (const t of parseTLV(b)) m.set(t.tag, t.value);
  return m;
}
function toInt(buf) {
  let v = 0n;
  for (const x of buf) v = (v << 8n) | BigInt(x);
  return Number(v);
}
function xor(buf, key) {
  const o = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) o[i] = buf[i] ^ key[i % key.length];
  return o;
}
function buildFrame(cmd, payload) {
  const head = cmd <= 0x1f ? Buffer.from([0x20 | cmd]) : Buffer.from([0xa0, cmd]);
  return Buffer.concat([head, varint(payload.length), payload]);
}
function normPem(raw) {
  const s = raw.toString('utf8');
  const m = s.match(/-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/);
  const b64 = (m ? m[1] : raw.toString('base64')).replace(/\s+/g, '');
  return '-----BEGIN PUBLIC KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END PUBLIC KEY-----';
}
function bjTime(ms) {
  return new Date((ms || Date.now()) + 8 * 3600e3).toISOString().replace('T', ' ').substring(0, 19);
}

class ImClient extends EventEmitter {
  constructor(cfg, opts = {}) {
    super();
    this.cfg = cfg;
    this.host = opts.host || IM_HOST;
    this.port = opts.port || IM_PORT;
    this.sock = null;
    this.rbuf = Buffer.alloc(0);
    this.key = null;
    this.encrypted = false;
    this.rid = 100000;
    this.pending = new Map();
    this.registId = 0;
    this.imAccountId = Number(cfg.imAccountId) || 0;
    this.syncKey = Number(cfg.imSyncKey) || 0;
    this.imDeviceId = cfg.imDeviceId || crypto.randomUUID().replace(/-/g, '').toUpperCase();
    this.connected = false;
    this._heartbeat = null;
    this._seen = new Map();   // msgId -> 时间戳, 去重
  }

  nextRid() { this.rid = (this.rid + 1) & 0x7fffffff; return this.rid; }

  async connect() {
    log.debug('im', `连接 ${this.host}:${this.port}`);
    await this._open();
    log.debug('im', 'TLS 已建立, 开始协议握手');
    await this._handshake();
    await this._regist();
    await this._login();
    await this._online();
    this.connected = true;
    this._startHeartbeat();
    log.debug('im', `上线完成 imAccountId=${this.imAccountId} registId=${this.registId}`);
    return this;
  }

  _open() {
    return new Promise((resolve, reject) => {
      this.sock = tls.connect({
        host: this.host, port: this.port, servername: this.host, rejectUnauthorized: false,
      });
      const onErr = (e) => reject(e);
      this.sock.once('error', onErr);
      this.sock.once('secureConnect', () => {
        this.sock.removeListener('error', onErr);
        this.sock.on('error', (e) => this.emit('error', e));
        this.sock.on('close', () => { this.connected = false; this.emit('close'); });
        resolve();
      });
      this.sock.on('data', (d) => { this.rbuf = Buffer.concat([this.rbuf, d]); this._pump(); });
    });
  }

  _pump() {
    for (;;) {
      if (this.rbuf.length < 2) return;
      let cmd, lo;
      if (this.rbuf[0] === 0xa0) { cmd = this.rbuf[1]; lo = 2; } else { cmd = this.rbuf[0] & 0x1f; lo = 1; }
      const L = readVarint(this.rbuf, lo);
      const total = L.next + L.val;
      if (this.rbuf.length < total) return;
      const payload = this.rbuf.slice(L.next, total);
      this.rbuf = this.rbuf.slice(total);
      this._onFrame(cmd, payload);
    }
  }

  _onFrame(cmd, payload) {
    if (this.encrypted && cmd === CMD.ENCRYPT_WRAPPER) {
      const w = tlvMap(payload).get(10);
      if (!w) return;
      const inner = xor(w, this.key);
      let c2, lo2;
      if (inner[0] === 0xa0) { c2 = inner[1]; lo2 = 2; } else { c2 = inner[0] & 0x1f; lo2 = 1; }
      const L2 = readVarint(inner, lo2);
      this._dispatch(c2, inner.slice(L2.next, L2.next + L2.val));
      return;
    }
    this._dispatch(cmd, payload);
  }

  _dispatch(cmd, payload) {
    const map = tlvMap(payload);
    if (cmd === CMD.SYNC_RESP || cmd === CMD.PUSH) {
      this._emitMessage(cmd, map);
      if (map.has(15)) {
        const sk = toInt(map.get(15));
        if (sk > this.syncKey) this.syncKey = sk;
      }
    } else if (cmd === CMD.SYNC_INFORM) {
      this.sync().catch(() => {});
    }
    if (map.has(1)) {
      const rid = toInt(map.get(1));
      const p = this.pending.get(rid);
      if (p) {
        this.pending.delete(rid);
        clearTimeout(p.timer);
        p.resolve({ cmd, payload, tags: map });
        return;
      }
    }
    if (cmd === CMD.SYNC_RESP || cmd === CMD.PUSH || cmd === CMD.SYNC_INFORM) return;
    this.emit('frame', { cmd, tags: map, payload });
  }

  _emitMessage(cmd, map) {
    const msgRaw = map.get(14) || Buffer.alloc(0);
    const msgId = map.has(16) ? map.get(16).toString('utf8') : '';
    if (msgId) {
      const now = Date.now();
      const prev = this._seen.get(msgId);
      if (prev && now - prev < 300000) return;
      this._seen.set(msgId, now);
      if (this._seen.size > 500) {
        for (const [k, t] of this._seen) { if (now - t > 300000) this._seen.delete(k); }
      }
    }
    let body = null;
    try { body = JSON.parse(msgRaw.toString('utf8')); } catch (e) { /* 非 JSON */ }
    this.emit('message', {
      source: cmd === CMD.PUSH ? 'push' : 'sync',
      dialogId: map.has(10) ? toInt(map.get(10)) : 0,
      imAccountId: map.has(11) ? toInt(map.get(11)) : 0,
      registId: map.has(12) ? toInt(map.get(12)) : 0,
      msgType: map.has(13) ? toInt(map.get(13)) : 0,
      contentType: map.has(18) ? toInt(map.get(18)) : 0,
      msgId,
      createTime: map.has(17) ? toInt(map.get(17)) : 0,
      syncKey: map.has(15) ? toInt(map.get(15)) : 0,
      raw: msgRaw,
      body,
    });
  }

  _send(cmd, payload) {
    if (!this.sock) throw new Error('IM 未连接');
    let out;
    if (this.encrypted && cmd !== CMD.ENCRYPT_SET && cmd !== CMD.PUBLIC_KEY) {
      out = buildFrame(CMD.ENCRYPT_WRAPPER, tlv(10, xor(buildFrame(cmd, payload), this.key)));
    } else {
      out = buildFrame(cmd, payload);
    }
    this.sock.write(out);
  }

  _request(cmd, payload, rid, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`IM 等待命令 ${cmd} 响应超时`));
      }, timeout);
      this.pending.set(rid, { resolve, reject, timer });
      try { this._send(cmd, payload); } catch (e) { clearTimeout(timer); this.pending.delete(rid); reject(e); }
    });
  }

  async _handshake() {
    const rid = this.nextRid();
    const resp = await this._request(CMD.PUBLIC_KEY, tlv(1, rid), rid);
    const pemRaw = resp.tags.get(10);
    if (!pemRaw) throw new Error('IM 未获取到 RSA 公钥');
    const pem = normPem(pemRaw);

    this.key = Buffer.from(crypto.randomUUID().replace(/-/g, ''), 'ascii');
    const enc = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, this.key);
    const rid2 = this.nextRid();
    const r2 = await this._request(CMD.ENCRYPT_SET, Buffer.concat([tlv(1, rid2), tlv(10, 1), tlv(11, enc)]), rid2);
    if (r2.tags.has(2) && toInt(r2.tags.get(2)) !== 200) throw new Error('IM 加密协商失败');
    this.encrypted = true;
    log.debug('im', '加密协商完成');
  }

  async _regist() {
    const rid = this.nextRid();
    const body = Buffer.concat([
      tlv(1, rid),
      tlv(25, this.cfg.token || ''),
      tlv(11, APP_KEY),
      tlv(22, 'sdk_gphone64_arm64-userdebug 15 AE3A.240806.043 12960925 dev-keys'),
      tlv(24, this.cfg.mobileId || ''),
      tlv(13, this.imDeviceId),
      tlv(26, APP_VERSION_CODE),
      tlv(20, 'sdk_gphone64_arm64'),
      tlv(12, PKG),
      tlv(10, 1),
      tlv(23, '1080*2400'),
      tlv(14, 35),
      tlv(15, 'sdk_gphone64_arm64 15'),
      tlv(16, '15'),
    ]);
    const resp = await this._request(CMD.REGIST, body, rid);
    const code = resp.tags.has(2) ? toInt(resp.tags.get(2)) : 0;
    if (code !== 200) {
      const desc = resp.tags.has(3) ? resp.tags.get(3).toString('utf8') : '未知错误';
      throw new Error(`IM 注册失败(${code}): ${desc}`);
    }
    this.registId = toInt(resp.tags.get(10) || Buffer.alloc(0));
    log.debug('im', `注册成功 registId=${this.registId}`);
  }

  _baseParam() {
    return JSON.stringify({
      accountId: this.cfg.mobileId,
      appId: '0',
      deviceId: this.cfg.bizDeviceId,
      imFlag: '1',
      mac: this.cfg.bizMac,
      machineId: this.cfg.bizMachineId,
      program: 'android',
      registId: this.registId,
      timestamp: bjTime(),
      token: this.cfg.token,
      stability: 0,
    });
  }

  async _login() {
    const rid = this.nextRid();
    const body = Buffer.concat([
      tlv(1, rid),
      tlv(24, this._baseParam()),
      tlv(26, this.imDeviceId),
      tlv(18, APP_VERSION_NAME),
      tlv(20, 1),
      tlv(10, this.registId),
      tlv(11, 'null'),
      tlv(12, APP_VERSION_CODE),
      tlv(21, Buffer.from(Date.now().toString(16).padStart(16, '0'), 'hex')),
    ]);
    const resp = await this._request(CMD.LOGIN, body, rid);
    const code = resp.tags.has(2) ? toInt(resp.tags.get(2)) : 0;
    if (code !== 200) {
      const desc = resp.tags.has(3) ? resp.tags.get(3).toString('utf8') : '未知错误';
      throw new Error(`IM 登录失败(${code}): ${desc}`);
    }
    log.debug('im', '登录成功');
  }

  async _online() {
    const rid = this.nextRid();
    const body = Buffer.concat([
      tlv(1, rid),
      tlv(15, APP_KEY),
      tlv(12, this.cfg.mobileId || ''),
      tlv(13, this.cfg.token || ''),
      tlv(11, 1),
      tlv(10, this.registId),
      tlv(14, 2),
    ]);
    const resp = await this._request(CMD.ACCOUNT, body, rid);
    if (resp.tags.has(10)) this.imAccountId = toInt(resp.tags.get(10));
    return this.imAccountId;
  }

  _startHeartbeat() {
    this.stopHeartbeat();
    this._heartbeat = setInterval(() => {
      try { const rid = this.nextRid(); this._request(CMD.HEARTBEAT, tlv(1, rid), rid, 8000).catch(() => {}); } catch (e) { /* ignore */ }
    }, 30000);
    this._heartbeat.unref && this._heartbeat.unref();
  }

  stopHeartbeat() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
  }

  // 同步离线消息(服务端会按 cmd13 逐条推送)
  async sync() {
    const rid = this.nextRid();
    const body = Buffer.concat([
      tlv(1, rid),
      tlv(11, this.imAccountId),
      tlv(12, this.registId),
      tlv(13, this.syncKey || 1),
      tlv(14, 15),
      tlv(0, 1),
    ]);
    try { return await this._request(CMD.SYNC, body, rid, 8000); } catch (e) { return null; }
  }

  _textBody(text) {
    return {
      content: text, hintType: -1, isSensitive: false, msgNewContent: '',
      msgNewType: 0, showType: 0, text, textMsgType: 0,
    };
  }

  // 单聊发送任意消息 JSON(消息类型由 JSON 信封决定; 语音直发时 msgType=2)
  async sendSinglePayload(receiverId, obj, msgType = 1) {
    const t0 = Date.now();
    const rid = this.nextRid();
    const body = Buffer.concat([
      tlv(1, rid),
      tlv(16, 3),
      tlv(14, Buffer.from(JSON.stringify(obj), 'utf8')),
      tlv(15, crypto.randomUUID().replace(/-/g, '')),
      tlv(13, msgType),
      tlv(11, this.imAccountId),
      tlv(10, receiverId),
      tlv(12, this.registId),
    ]);
    const resp = await this._request(CMD.SINGLE_MESSAGE, body, rid, 10000);
    const code = resp.tags.has(2) ? toInt(resp.tags.get(2)) : 0;
    const desc = resp.tags.has(3) ? resp.tags.get(3).toString('utf8') : '';
    log.debug('im', `单聊发送 → ${receiverId} msgType=${msgType} ${code === 200 ? 'OK' : code} ${Date.now() - t0}ms${desc ? ' ' + desc : ''}`);
    return { ok: code === 200, code, desc };
  }

  // 群聊发送任意消息 JSON
  async sendGroupPayload(dialogId, imAccountId, obj, msgType = 1) {
    const t0 = Date.now();
    const rid = this.nextRid();
    const body = Buffer.concat([
      tlv(1, rid),
      tlv(18, 4),
      tlv(14, Buffer.from(JSON.stringify(obj), 'utf8')),
      tlv(15, crypto.randomUUID().replace(/-/g, '')),
      tlv(13, msgType),
      tlv(11, imAccountId),
      tlv(10, dialogId),
      tlv(12, this.registId),
    ]);
    const resp = await this._request(CMD.MESSAGE, body, rid, 10000);
    const code = resp.tags.has(2) ? toInt(resp.tags.get(2)) : 0;
    const desc = resp.tags.has(3) ? resp.tags.get(3).toString('utf8') : '';
    log.debug('im', `群聊发送 → dialog ${dialogId} msgType=${msgType} ${code === 200 ? 'OK' : code} ${Date.now() - t0}ms${desc ? ' ' + desc : ''}`);
    return { ok: code === 200, code, desc };
  }

  // 单聊发文本(receiverId 即对方 imAccountId)
  sendText(receiverId, text) {
    return this.sendSinglePayload(receiverId, this._textBody(text));
  }

  // 群聊发文本(dialogId / imAccountId 来自会话列表)
  sendGroupText(dialogId, imAccountId, text) {
    return this.sendGroupPayload(dialogId, imAccountId, this._textBody(text));
  }

  // 单聊发语音(receiverId, VoiceDescEntity JSON)
  sendSingleVoice(receiverId, voice) {
    return this.sendSinglePayload(receiverId, voice, 2);
  }

  // 群聊发语音
  sendGroupVoice(dialogId, imAccountId, voice) {
    return this.sendGroupPayload(dialogId, imAccountId, voice, 2);
  }

  close() {
    this.stopHeartbeat();
    if (this.sock) { try { this.sock.destroy(); } catch (e) { /* ignore */ } }
    this.sock = null;
    this.connected = false;
  }
}

module.exports = { ImClient, IM_HOST, IM_PORT, APP_KEY };
