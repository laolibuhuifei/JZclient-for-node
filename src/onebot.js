// OneBot v11 协议桥接(参考 NapCat): 把微聊的私聊/家庭群映射成标准事件与动作
// 零依赖 —— WebSocket(RFC6455) 服务端自己实现, 只用到 http/crypto
//
// 支持的传输:
//   HTTP 服务器   POST /  {action, params, echo}  → {status, retcode, data, echo}
//   WebSocket 服务器(正向)  ws://host:port/?access_token=xxx
//                 下行事件 JSON, 上行动作 JSON(带 echo)
//
// 令牌: HTTP 用 Authorization: Bearer <token> 或 ?access_token=<token>;
//       WS 必须用 ?access_token=<token>(浏览器握手指令带不了自定义头)。
const http = require('http');
const crypto = require('crypto');
const log = require('./logger');
const device = require('./device');
const { describe, mediaUrl, EMOJI_PRESET } = require('./message');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// OneBot 返回码
const RC = { OK: 0, BAD: 1400, AUTH: 1403, NOTFOUND: 1404, INTERNAL: 1500 };

function genToken() {
  return 'jz_' + crypto.randomBytes(16).toString('hex');
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ============ WebSocket 帧编解码(RFC6455) ============

function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

// 帧编码。mask=true 用于客户端发往服务端(RFC6455 要求客户端帧必须掩码)
function wsEncode(opcode, payload, mask) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  const maskBit = mask ? 0x80 : 0;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = maskBit | len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = maskBit | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = maskBit | 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x80 | opcode; // FIN + opcode
  if (!mask) return Buffer.concat([head, body]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = body[i] ^ key[i & 3];
  return Buffer.concat([head, key, masked]);
}

// 从缓冲区里切出一帧, 返回 { frame, used } 或 null(数据不够)
function wsDecode(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;

  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const hi = buf.readUInt32BE(off);
    const lo = buf.readUInt32BE(off + 4);
    len = hi * 4294967296 + lo;
    off += 8;
  }

  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.slice(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;

  let payload = Buffer.from(buf.slice(off, off + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { frame: { fin, opcode, payload }, used: off + len };
}

// ============ OneBot 服务 ============

async function startOneBot({ cfg, ctx }) {
  const conf = Object.assign(
    { enabled: false, heartbeat: 30 },
    cfg.onebot || {},
    {
      http: Object.assign({ enabled: true, host: '0.0.0.0', port: 5700, token: '' }, (cfg.onebot || {}).http || {}),
      ws: Object.assign({ enabled: true, host: '0.0.0.0', port: 5701, token: '' }, (cfg.onebot || {}).ws || {}),
      wsClient: Object.assign({ enabled: false, url: '', token: '', reconnect: 5 }, (cfg.onebot || {}).wsClient || {}),
    }
  );

  // 令牌为空时生成并写回配置, 避免"裸奔"的服务
  let dirty = false;
  if (!conf.http.token) { conf.http.token = genToken(); dirty = true; }
  if (!conf.ws.token) { conf.ws.token = genToken(); dirty = true; }
  if (dirty) {
    cfg.onebot = conf;
    try { device.save(cfg); } catch (e) { log.warn('onebot', '令牌保存失败(每次启动会变): ' + e.message); }
  }

  const sockets = new Set();   // 已连上的 WS 客户端
  const msgStore = new Map();  // message_id -> 元信息(供 get_msg)
  let msgSeq = 0;
  let heartbeatTimer = null;
  let httpServer = null;
  let wsServer = null;

  function nextMsgId() {
    msgSeq = msgSeq % 2000000000 + 1;
    return msgSeq;
  }

  function selfId() {
    try { return toInt(ctx.selfId && ctx.selfId()); } catch (e) { return 0; }
  }

  function isOnline() {
    try { return !!(ctx.online && ctx.online()); } catch (e) { return false; }
  }

  // ===== 令牌校验 =====
  function tokenOk(req, url, token) {
    if (!token) return true; // 未配置令牌则不校验(不推荐)
    const q = url.searchParams.get('access_token');
    if (q && safeEqual(q, token)) return true;
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m && safeEqual(m[1].trim(), token)) return true;
    const t = String(req.headers['x-onebot-token'] || '');
    if (t && safeEqual(t, token)) return true;
    return false;
  }

  // ===== 动作实现 =====
  async function findTarget(kind, id) {
    const list = (await ctx.targets()) || [];
    if (kind === 'private') {
      return list.find((t) => t.type === 'single' && String(t.receiverId) === String(id)) || null;
    }
    return list.find((t) => t.type === 'group' && String(t.dialogId) === String(id)) || null;
  }

  function normSegments(msg) {
    if (Array.isArray(msg)) return msg;
    if (msg && typeof msg === 'object' && msg.type) return [msg];
    // 字符串: 支持 CQ 码里的 [CQ:image,file=...] 简单形式, 其余当纯文本
    const s = String(msg == null ? '' : msg);
    const out = [];
    const re = /\[CQ:(image|face|at),([^\]]*)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ type: 'text', data: { text: s.slice(last, m.index) } });
      const attrs = {};
      m[2].split(',').forEach((kv) => {
        const i = kv.indexOf('=');
        if (i > 0) attrs[kv.slice(0, i)] = kv.slice(i + 1);
      });
      out.push({ type: m[1], data: attrs });
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push({ type: 'text', data: { text: s.slice(last) } });
    return out;
  }

  // 把 OneBot 消息段翻译成微聊的多次发送
  async function sendSegments(target, segments) {
    let ids = [];
    let buf = '';

    const flush = async () => {
      const text = buf.trim();
      buf = '';
      if (!text) return;
      await ctx.send(target.key, { kind: 'text', text });
      const id = nextMsgId();
      msgStore.set(id, { targetKey: target.key, type: target.type, text, time: nowSec() });
      ids.push(id);
    };

    for (const seg of segments) {
      const type = seg && seg.type;
      const data = (seg && seg.data) || {};
      if (type === 'text') { buf += String(data.text || ''); continue; }
      if (type === 'at') { buf += '@' + String(data.qq || data.name || ''); continue; }
      if (type === 'reply') continue; // 引用回复: 微聊没有对应能力, 直接忽略
      if (type === 'face') {
        await flush();
        const idx = toInt(data.id) || 1;
        await ctx.send(target.key, { kind: 'emoji', index: idx });
        const id = nextMsgId();
        msgStore.set(id, { targetKey: target.key, type: target.type, text: '[表情]', time: nowSec() });
        ids.push(id);
        continue;
      }
      if (type === 'image') {
        await flush();
        const src = String(data.url || data.file || '');
        if (!/^https?:\/\//i.test(src)) throw new Error('图片段只支持 http(s) 地址或 url 字段');
        await ctx.send(target.key, { kind: 'image', src });
        const id = nextMsgId();
        msgStore.set(id, { targetKey: target.key, type: target.type, text: '[图片]', time: nowSec() });
        ids.push(id);
        continue;
      }
      if (type === 'record') {
        await flush();
        const src = String(data.url || data.file || '');
        if (!/^https?:\/\//i.test(src)) throw new Error('语音段只支持 http(s) 地址或 url 字段');
        await ctx.send(target.key, { kind: 'voice', src });
        const id = nextMsgId();
        msgStore.set(id, { targetKey: target.key, type: target.type, text: '[语音]', time: nowSec() });
        ids.push(id);
        continue;
      }
      throw new Error('暂不支持的消息段类型: ' + type);
    }
    await flush();
    if (!ids.length) throw new Error('消息内容为空');
    return ids[ids.length - 1];
  }

  const actions = {
    // ===== 基础信息 =====
    get_login_info: async () => ({
      user_id: selfId(),
      nickname: (ctx.nickname && ctx.nickname()) || 'JZClientForNode',
    }),

    get_status: async () => ({
      online: isOnline(),
      good: isOnline(),
      stat: { packet_received: 0, packet_sent: 0, message_received: 0, message_sent: 0 },
    }),

    get_version_info: async () => ({
      app_name: 'JZClientForNode',
      app_version: '0.1.0',
      protocol_version: 'v11',
      app_full_name: 'JZClientForNode OneBot v11',
    }),

    // ===== 好友 / 群(映射自微聊会话) =====
    get_friend_list: async () => {
      const list = (await ctx.targets()) || [];
      return list.filter((t) => t.type === 'single').map((t) => ({
        user_id: toInt(t.receiverId),
        nickname: t.name || '手表',
        remark: t.name || '',
      }));
    },

    get_group_list: async () => {
      const list = (await ctx.targets()) || [];
      return list.filter((t) => t.type === 'group').map((t) => ({
        group_id: toInt(t.dialogId),
        group_name: t.name || '家庭群',
        member_count: (t.peers || []).length,
        max_member_count: (t.peers || []).length,
      }));
    },

    get_group_info: async (p) => {
      const t = await findTarget('group', p.group_id);
      if (!t) throw new Error('群不存在');
      return {
        group_id: toInt(t.dialogId),
        group_name: t.name || '家庭群',
        member_count: (t.peers || []).length,
        max_member_count: (t.peers || []).length,
      };
    },

    get_group_member_list: async (p) => {
      const t = await findTarget('group', p.group_id);
      if (!t) throw new Error('群不存在');
      return (t.peers || []).map((a) => ({
        group_id: toInt(t.dialogId),
        user_id: toInt(a.imAccountId),
        nickname: a.name || '',
        card: a.name || '',
        role: a.accountType === 1 ? 'member' : 'owner',
      }));
    },

    get_stranger_info: async (p) => {
      const t = await findTarget('private', p.user_id);
      return {
        user_id: toInt(p.user_id),
        nickname: (t && t.name) || String(p.user_id),
        sex: 'unknown',
        age: 0,
      };
    },

    // ===== 发送 =====
    send_private_msg: async (p) => {
      const t = await findTarget('private', p.user_id);
      if (!t) throw new Error('没有这个私聊会话(手表未绑定或 ID 不对)');
      const id = await sendSegments(t, normSegments(p.message));
      return { message_id: id };
    },

    send_group_msg: async (p) => {
      const t = await findTarget('group', p.group_id);
      if (!t) throw new Error('没有这个群会话(家庭群 ID 不对)');
      const id = await sendSegments(t, normSegments(p.message));
      return { message_id: id };
    },

    send_msg: async (p) => {
      if (p.message_type === 'group' || (p.group_id != null && p.user_id == null)) {
        return actions.send_group_msg(p);
      }
      if (p.user_id != null) return actions.send_private_msg(p);
      if (p.group_id != null) return actions.send_group_msg(p);
      throw new Error('send_msg 需要 user_id 或 group_id');
    },

    // ===== 消息查询 =====
    get_msg: async (p) => {
      const rec = msgStore.get(toInt(p.message_id));
      if (!rec) throw new Error('消息不存在或已过期');
      return {
        message_id: toInt(p.message_id),
        message_type: rec.type === 'group' ? 'group' : 'private',
        sender: { user_id: selfId(), nickname: 'JZClientForNode' },
        time: rec.time,
        message: [{ type: 'text', data: { text: rec.text } }],
        raw_message: rec.text,
      };
    },

    // ===== 能力声明 =====
    can_send_image: async () => ({ yes: true }),
    can_send_record: async () => ({ yes: true }),

    // AstrBot 等框架会调, 直接回成功避免报错
    '.handle_quick_operation': async () => ({}),
    set_restart: async () => { throw new Error('不支持重启'); },
    clean_cache: async () => ({}),
  };

  async function dispatch(action, params) {
    const fn = actions[action];
    if (!fn) {
      const e = new Error('不支持的 action: ' + action);
      e.retcode = RC.NOTFOUND;
      throw e;
    }
    return fn(params || {});
  }

  async function runAction(action, params) {
    try {
      const data = await dispatch(action, params);
      return { status: 'ok', retcode: RC.OK, data };
    } catch (e) {
      const rc = e && e.retcode ? e.retcode : RC.BAD;
      return { status: 'failed', retcode: rc, data: null, message: String((e && e.message) || e), wording: String((e && e.message) || e) };
    }
  }

  // ===== 事件下发 =====
  function broadcast(obj) {
    if (!sockets.size) return;
    const text = JSON.stringify(obj);
    sockets.forEach((c) => {
      try { c.socket.write(wsEncode(0x1, text, c.masked)); } catch (e) { /* ignore */ }
    });
  }

  function lifecycle(subType) {
    broadcast({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: subType,
      self_id: selfId(),
      time: nowSec(),
    });
  }

  function heartbeat() {
    const online = isOnline();
    broadcast({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      self_id: selfId(),
      time: nowSec(),
      interval: Math.max(1, Number(conf.heartbeat) || 30) * 1000,
      status: { online, good: online },
    });
  }

  // 把 watch 的 emoji code/desc 映射成 OneBot face id(表情序号)
  function faceIdOf(parsed) {
    const i = parsed.inner || {};
    const code = i.code || i.name || '';
    const desc = i.desc || '';
    const list = (EMOJI_PRESET && EMOJI_PRESET.emojis) || [];
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      if ((code && e.code === code) || (desc && e.desc === desc)) return k + 1;
    }
    return 0;
  }

  // parsed(message.js) -> OneBot 消息段
  function toSegments(parsed, fallbackText) {
    const segs = [];
    const kind = parsed && parsed.kind;
    const i = (parsed && parsed.inner) || {};

    if (kind === 'text') {
      if (parsed.text) segs.push({ type: 'text', data: { text: parsed.text } });
      return segs;
    }
    if (kind === 'emoji') {
      const id = faceIdOf(parsed);
      if (id) segs.push({ type: 'face', data: { id: String(id) } });
      else segs.push({ type: 'text', data: { text: fallbackText || '[表情]' } });
      return segs;
    }
    if (kind === 'photo') {
      const url = mediaUrl(parsed) || '';
      if (url) segs.push({ type: 'image', data: { file: url, url, summary: '[图片]' } });
      else segs.push({ type: 'text', data: { text: fallbackText || '[图片]' } });
      return segs;
    }
    if (kind === 'voice' || kind === 'voice_file') {
      const url = mediaUrl(parsed) || '';
      segs.push({ type: 'record', data: { file: url, url, magic: false } });
      if (!url) segs.push({ type: 'text', data: { text: fallbackText || '[语音]' } });
      return segs;
    }
    if (kind === 'video' || kind === 'relay_video') {
      const url = mediaUrl(parsed) || '';
      if (url) segs.push({ type: 'video', data: { file: url, url } });
      else segs.push({ type: 'text', data: { text: fallbackText || '[视频]' } });
      return segs;
    }
    if (kind === 'location') {
      const lat = Number(i.goalLatitude);
      const lng = Number(i.goalLongitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        segs.push({ type: 'location', data: { lat: String(lat), lon: String(lng), title: i.goalPoi || '' } });
        return segs;
      }
    }
    segs.push({ type: 'text', data: { text: fallbackText || describe(parsed) || '' } });
    return segs;
  }

  // 由 webui 在收到 IM 聊天消息时调用
  function pushMessage({ type, userId, groupId, senderName, parsed, text, time }) {
    if (!sockets.size) return;
    const segments = toSegments(parsed, text);
    if (!segments.length) return;
    const id = nextMsgId();
    msgStore.set(id, { targetKey: type === 'group' ? 'g:' + groupId : 's:' + userId, type, text: text || '', time: nowSec() });
    if (msgStore.size > 500) {
      const first = msgStore.keys().next();
      if (!first.done) msgStore.delete(first.value);
    }

    const evt = {
      post_type: 'message',
      message_type: type === 'group' ? 'group' : 'private',
      sub_type: type === 'group' ? 'normal' : 'friend',
      message_id: id,
      user_id: toInt(userId),
      message: segments,
      raw_message: text || describe(parsed) || '',
      font: 0,
      sender: { user_id: toInt(userId), nickname: senderName || String(userId), role: 'member' },
      self_id: selfId(),
      time: time ? Math.floor(Number(time) / 1000) : nowSec(),
    };
    if (type === 'group') evt.group_id = toInt(groupId);
    broadcast(evt);
  }

  // 处理某个 WS 连接收到的数据: 切帧 → 分发动作 → 回包
  // client = { socket, buf, frag, fragOp, masked, ip, onDrop }
  // masked=true 表示这条连接是我们主动发起的(反向 WS), 发出的帧必须掩码
  function pumpFrames(client, chunk) {
    const socket = client.socket;
    const send = (obj) => {
      try { socket.write(wsEncode(0x1, JSON.stringify(obj), client.masked)); } catch (e) { /* ignore */ }
    };

    client.buf = Buffer.concat([client.buf, chunk]);
    // 一帧可能被拆成多个 TCP 包, 也可能一个包里有多帧
    for (;;) {
      const r = wsDecode(client.buf);
      if (!r) break;
      client.buf = client.buf.slice(r.used);
      const f = r.frame;

      if (f.opcode === 0x8) { // close
        try { socket.write(wsEncode(0x8, f.payload.slice(0, 2), client.masked)); } catch (e) { /* ignore */ }
        if (client.onDrop) client.onDrop();
        try { socket.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      if (f.opcode === 0x9) { // ping
        try { socket.write(wsEncode(0xA, f.payload, client.masked)); } catch (e) { /* ignore */ }
        continue;
      }
      if (f.opcode === 0xA) continue; // pong

      let payload = f.payload;
      if (f.opcode === 0x0) { // continuation
        if (!client.frag) continue;
        client.frag = Buffer.concat([client.frag, payload]);
        if (!f.fin) continue;
        payload = client.frag;
        const op = client.fragOp;
        client.frag = null;
        client.fragOp = 0;
        if (op !== 0x1) continue;
      } else if (f.opcode === 0x1 || f.opcode === 0x2) {
        if (!f.fin) {
          client.frag = payload;
          client.fragOp = f.opcode;
          continue;
        }
        if (f.opcode !== 0x1) continue; // 二进制帧忽略
      } else {
        continue;
      }

      let req;
      try { req = JSON.parse(payload.toString('utf8')); } catch (e) {
        send({ status: 'failed', retcode: RC.BAD, data: null, echo: null, message: 'JSON 解析失败' });
        continue;
      }
      const action = req.action;
      const echo = req.echo;
      if (!action) {
        send({ status: 'failed', retcode: RC.BAD, data: null, echo: echo === undefined ? null : echo, message: '缺少 action' });
        continue;
      }
      runAction(action, req.params || {}).then((out) => {
        send(Object.assign(out, { echo: echo === undefined ? null : echo }));
      }).catch(() => { /* runAction 内部已兜底 */ });
    }
  }

  // 启动监听并等到有结果(成功或失败), 避免端口被占用时还打印可用地址
  function listenOn(srv, port, host, label) {
    return new Promise((resolve) => {
      let settled = false;
      srv.on('error', (e) => {
        if (!settled) {
          settled = true;
          log.error('onebot', `${label} 启动失败 :${port} ${e && e.message ? e.message : e}`);
          resolve(false);
        } else {
          log.warn('onebot', `${label} 运行错误: ${e && e.message ? e.message : e}`);
        }
      });
      srv.listen(port, host, () => {
        if (settled) return;
        settled = true;
        resolve(true);
      });
    });
  }

  // ===== HTTP 服务器(OneBot HTTP API) =====
  async function startHttp() {
    if (!conf.http.enabled) return false;
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const sendJson = (status, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      };

      if (!tokenOk(req, url, conf.http.token)) {
        log.warn('onebot', `HTTP 令牌无效 ip=${(req.socket && req.socket.remoteAddress) || '-'}`);
        return sendJson(401, { status: 'failed', retcode: RC.AUTH, data: null, message: '令牌无效' });
      }

      const done = async (action, params, echo) => {
        const out = await runAction(action, params);
        sendJson(200, Object.assign(out, { echo: echo === undefined ? null : echo }));
      };

      // GET /?action=xxx&... 或 POST / {action, params, echo}
      if (req.method === 'GET') {
        const action = url.searchParams.get('action');
        if (!action) {
          return sendJson(200, { status: 'ok', retcode: RC.OK, data: { app: 'JZClientForNode OneBot v11', ws: conf.ws.enabled ? `ws://0.0.0.0:${conf.ws.port}` : null } });
        }
        const params = {};
        url.searchParams.forEach((v, k) => { if (k !== 'action' && k !== 'access_token') params[k] = v; });
        return done(action, params, url.searchParams.get('echo'));
      }

      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
          size += c.length;
          if (size > 4 * 1024 * 1024) { try { req.destroy(); } catch (e) { /* ignore */ } return; }
          chunks.push(c);
        });
        req.on('end', () => {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { body = {}; }
          const action = body.action || url.searchParams.get('action');
          if (!action) return sendJson(400, { status: 'failed', retcode: RC.BAD, data: null, message: '缺少 action' });
          done(action, body.params || {}, body.echo);
        });
        return;
      }

      sendJson(405, { status: 'failed', retcode: RC.BAD, data: null, message: '只支持 GET/POST' });
    });

    httpServer = srv;
    const ok = await listenOn(srv, conf.http.port, conf.http.host, 'HTTP API');
    if (ok) log.info('onebot', `HTTP API  http://${conf.http.host}:${conf.http.port}  令牌 ${conf.http.token}`);
    return ok;
  }

  // ===== WebSocket 服务器(正向 WS) =====
  async function startWs() {
    if (!conf.ws.enabled) return false;
    const srv = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('This endpoint speaks WebSocket only. Connect with ws://');
    });

    srv.on('upgrade', (req, socket) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (!tokenOk(req, url, conf.ws.token)) {
        log.warn('onebot', `WS 令牌无效 ip=${(socket.remoteAddress) || '-'}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
      );
      socket.setNoDelay(true);

      const client = { socket, buf: Buffer.alloc(0), frag: null, fragOp: 0, masked: false, ip: socket.remoteAddress || '-' };
      sockets.add(client);
      log.info('onebot', `WS 客户端接入 ip=${client.ip} 当前 ${sockets.size} 个`);

      // 接入即发 lifecycle(connect), 符合 OneBot v11
      try {
        socket.write(wsEncode(0x1, JSON.stringify({
          post_type: 'meta_event',
          meta_event_type: 'lifecycle',
          sub_type: 'connect',
          self_id: selfId(),
          time: nowSec(),
        })));
      } catch (e) { /* ignore */ }

      const drop = () => {
        if (sockets.delete(client)) log.info('onebot', `WS 客户端断开 ip=${client.ip} 剩余 ${sockets.size} 个`);
      };
      client.onDrop = drop;

      socket.on('data', (chunk) => pumpFrames(client, chunk));
      socket.on('close', drop);
      socket.on('error', () => { drop(); try { socket.destroy(); } catch (e) { /* ignore */ } });
    });

    wsServer = srv;
    const ok = await listenOn(srv, conf.ws.port, conf.ws.host, 'WS 服务');
    if (ok) log.info('onebot', `WS 服务  ws://${conf.ws.host}:${conf.ws.port}  令牌 ${conf.ws.token}`);
    return ok;
  }

  // ===== 反向 WS 客户端: 由我们主动连到 AstrBot / NoneBot =====
  let revTimer = null;
  let revSock = null;
  let revState = 'idle'; // idle | connecting | connected
  let revClosed = false;

  function revConf() {
    return Object.assign({ enabled: false, url: '', token: '', reconnect: 5 }, conf.wsClient || {});
  }

  function revSchedule() {
    if (revClosed) return;
    const c = revConf();
    if (!c.enabled || !c.url) return;
    const ms = Math.max(1, Number(c.reconnect) || 5) * 1000;
    if (revTimer) clearTimeout(revTimer);
    revTimer = setTimeout(revConnect, ms);
    if (revTimer.unref) revTimer.unref();
  }

  function revConnect() {
    if (revClosed) return;
    const c = revConf();
    if (!c.enabled || !c.url) return;

    let u;
    try { u = new URL(c.url); } catch (e) {
      log.error('onebot', '反向 WS 地址不合法: ' + c.url);
      return;
    }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      log.error('onebot', '反向 WS 只支持 ws:// 或 wss://: ' + c.url);
      return;
    }

    revState = 'connecting';
    const key = crypto.randomBytes(16).toString('base64');
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      // aiocqhttp(AstrBot/NoneBot 用的库) 会直接读这两个头, 缺了会 500:
      // X-Client-Role 决定这条连接同时收发(Universal) 还是只收事件/只发动作
      // X-Self-ID 是账号标识, 事件里的 self_id 要与它一致, 否则回消息找不到连接
      'X-Self-ID': String(selfId()),
      'X-Client-Role': 'Universal',
    };
    if (c.token) headers.Authorization = 'Bearer ' + c.token;

    let p = u.pathname || '/';
    const qs = [];
    if (u.search) qs.push(u.search.replace(/^\?/, ''));
    if (c.token) qs.push('access_token=' + encodeURIComponent(c.token));
    if (qs.length) p += '?' + qs.join('&');

    const mod = u.protocol === 'wss:' ? require('https') : require('http');
    const req = mod.request({
      host: u.hostname,
      port: u.port || (u.protocol === 'wss:' ? 443 : 80),
      path: p,
      headers,
    });

    req.on('upgrade', (res, socket) => {
      if (String(res.headers['sec-websocket-accept'] || '') !== wsAccept(key)) {
        log.error('onebot', '反向 WS 握手校验失败(对方不是标准 WebSocket 服务)');
        try { socket.destroy(); } catch (e) { /* ignore */ }
        revState = 'idle';
        revSchedule();
        return;
      }
      revSock = socket;
      revState = 'connected';
      socket.setNoDelay(true);

      const client = { socket, buf: Buffer.alloc(0), frag: null, fragOp: 0, masked: true, ip: u.host, reverse: true };
      sockets.add(client);
      log.info('onebot', `反向 WS 已连接 ${c.url}`);

      try {
        socket.write(wsEncode(0x1, JSON.stringify({
          post_type: 'meta_event',
          meta_event_type: 'lifecycle',
          sub_type: 'connect',
          self_id: selfId(),
          time: nowSec(),
        }), true));
      } catch (e) { /* ignore */ }

      let dropped = false;
      const drop = () => {
        if (dropped) return;
        dropped = true;
        sockets.delete(client);
        revSock = null;
        if (revState === 'connected') {
          log.warn('onebot', `反向 WS 断开，${Math.max(1, Number(c.reconnect) || 5)} 秒后重连`);
        }
        revState = 'idle';
        revSchedule();
      };
      client.onDrop = drop;

      socket.on('data', (chunk) => pumpFrames(client, chunk));
      socket.on('close', drop);
      socket.on('error', () => { try { socket.destroy(); } catch (e) { /* ignore */ } });
    });

    req.on('response', (res) => {
      log.error('onebot', `反向 WS 连接被拒绝 HTTP ${res.statusCode}`);
      res.resume();
      revState = 'idle';
      revSchedule();
    });

    req.on('error', (e) => {
      revState = 'idle';
      log.warn('onebot', `反向 WS 连接失败: ${e && e.message ? e.message : e}（稍后重试）`);
      revSchedule();
    });

    req.end();
  }

  const httpOk = await startHttp();
  const wsOk = await startWs();
  if (revConf().enabled && revConf().url) revConnect();

  const hb = Number(conf.heartbeat) || 0;
  if (hb > 0) {
    heartbeatTimer = setInterval(heartbeat, hb * 1000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  return {
    http: { enabled: !!conf.http.enabled, running: httpOk, host: conf.http.host, port: conf.http.port, token: conf.http.token },
    ws: { enabled: !!conf.ws.enabled, running: wsOk, host: conf.ws.host, port: conf.ws.port, token: conf.ws.token },
    // 反向 WS 状态用 getter 实时求值: 握手是异步的, 若写成静态快照会永远停在 connecting
    wsClient: {
      get enabled() { return !!revConf().enabled; },
      get url() { return revConf().url || ''; },
      get token() { return revConf().token || ''; },
      get connected() { return revState === 'connected'; },
      get state() { return revState; },
    },
    clients: () => sockets.size,
    pushMessage,
    broadcast,
    close: () => new Promise((resolve) => {
      revClosed = true;
      if (revTimer) { clearTimeout(revTimer); revTimer = null; }
      try { if (revSock) revSock.destroy(); } catch (e) { /* ignore */ }
      revSock = null;
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      try { lifecycle('disable'); } catch (e) { /* ignore */ }
      sockets.forEach((c) => { try { c.socket.destroy(); } catch (e) { /* ignore */ } });
      sockets.clear();
      let n = 0;
      const done = () => { n += 1; if (n >= 2) resolve(); };
      const closeOne = (s) => {
        if (!s) { done(); return; }
        try { s.close(done); } catch (e) { done(); }
        // close() 在没有连接时不会回调, 兜底
        setTimeout(done, 300);
      };
      closeOne(httpServer);
      closeOne(wsServer);
      setTimeout(resolve, 500);
    }),
  };
}

module.exports = { startOneBot, genToken };
