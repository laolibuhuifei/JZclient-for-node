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
const fs = require('fs');
const crypto = require('crypto');
const log = require('./logger');
const device = require('./device');
const { describe, mediaUrl, EMOJI_PRESET } = require('./message');
const {
  resolveMediaSrc, cleanupMediaSrc, downloadToTmp, probeDuration, splitAudio, cleanupSplit,
} = require('./upload');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// OneBot 返回码
const RC = { OK: 0, BAD: 1400, AUTH: 1403, NOTFOUND: 1404, INTERNAL: 1500 };

// 本地表情图的数量。QQ 的 face id 是全局编号, 超出这个范围就没有对应图可发
const EMOJI_COUNT = ((EMOJI_PRESET && EMOJI_PRESET.emojis) || []).length;

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

// ===== 媒体段地址解析 =====
// QQ(NapCat / go-cqhttp) 一个媒体段会同时给 url / path / file 三个字段:
//   url  —— CDN 直链, 优先用
//   path —— 框架本机的缓存文件(通常就是解码后的真文件)
//   file —— 往往只是 "A1B2C3.image" 这种裸文件名, 直接当路径读会 ENOENT
// 所以按「能用就用」的顺序挑: 带协议的直接用, 本地路径要真的存在才算数。
function mediaSrcOf(data) {
  const cands = [data && data.url, data && data.path, data && data.file];
  for (const c of cands) {
    const s = String(c == null ? '' : c).trim();
    if (!s) continue;
    if (/^(https?|base64|data|file):/i.test(s)) return s;
    if (fs.existsSync(s)) return s;
  }
  // 一个都用不了: 把第一个非空值原样带下去, 让报错里能看到它长什么样
  for (const c of cands) {
    const s = String(c == null ? '' : c).trim();
    if (s) return s;
  }
  return '';
}

// conf:  可选, 直接指定一份 OneBot 配置(按手表分开的实例用它, 不读 cfg.onebot)
// onSave:可选, 令牌自动生成后的落盘回调。不传则写回 cfg.onebot(全局实例的老行为)
async function startOneBot({ cfg, ctx, conf: rawConf, onSave }) {
  const base = rawConf || cfg.onebot || {};
  const conf = Object.assign(
    // qqCompat: QQ 兼容层开关(默认开)。开了之后, 微聊物理上做不到的动作(撤回/禁言/戳一戳等)
    // 一律静默成功, 让按 QQ(NapCat / go-cqhttp)写的插件不会因为一个 1404 整条链路崩掉
    { enabled: false, heartbeat: 30, qqCompat: true },
    base,
    {
      // port 传 0/空 时回落到默认端口(按手表的实例会先算好端口再传进来)
      http: Object.assign({ enabled: true, host: '0.0.0.0', port: 5700, token: '' }, base.http || {}, {
        port: (base.http && base.http.port) || 5700,
      }),
      ws: Object.assign({ enabled: true, host: '0.0.0.0', port: 5701, token: '' }, base.ws || {}, {
        port: (base.ws && base.ws.port) || 5701,
      }),
      wsClient: Object.assign({ enabled: false, url: '', token: '', reconnect: 5 }, base.wsClient || {}),
    }
  );

  // 令牌为空时生成并写回配置, 避免"裸奔"的服务。
  // ⚠️ 不能直接 device.save(cfg): 调用方传进来的 cfg 可能只是片段(测试脚本、CLI 局部调用),
  // 那样会把磁盘上完整的登录票据 / 设备指纹 / 手表状态整份覆盖掉。所以先读完整配置再只改 onebot 这一段。
  let dirty = false;
  if (!conf.http.token) { conf.http.token = genToken(); dirty = true; }
  if (!conf.ws.token) { conf.ws.token = genToken(); dirty = true; }
  if (dirty) {
    if (typeof onSave === 'function') {
      try { onSave(conf); } catch (e) { log.warn('onebot', '令牌保存失败(每次启动会变): ' + e.message); }
    } else {
      cfg.onebot = conf;
      try {
        const full = device.load();
        full.onebot = conf;
        device.save(full);
      } catch (e) {
        log.warn('onebot', '令牌保存失败(每次启动会变): ' + e.message);
      }
    }
  }

  const sockets = new Set();   // 已连上的 WS 客户端
  // message_id -> 消息记录。get_msg / *_msg_history / get_recent_contact 都靠它
  // 记录里带真实消息段, 不只是文本, 这样插件拿回去能还原图片/语音
  const msgStore = new Map();
  const histMap = new Map();    // targetKey -> [记录], 每个会话最多 HIST_MAX 条
  const forwardStore = new Map(); // forward_id -> nodes, 合并转发的原文
  const HIST_MAX = 200;
  const MSG_MAX = 800;
  const stats = { message_received: 0, message_sent: 0 }; // get_status 用
  let msgSeq = 0;
  let heartbeatTimer = null;
  let httpServer = null;
  let wsServer = null;

  function nextMsgId() {
    msgSeq = msgSeq % 2000000000 + 1;
    return msgSeq;
  }

  // 记账: 同时写 msgStore(全局, 供 get_msg) 和 per-target 历史(供 *_msg_history)
  function remember(rec) {
    msgStore.set(rec.message_id, rec);
    while (msgStore.size > MSG_MAX) {
      const k = msgStore.keys().next();
      if (k.done) break;
      msgStore.delete(k.value);
    }
    const arr = histMap.get(rec.targetKey) || [];
    arr.push(rec);
    if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
    histMap.set(rec.targetKey, arr);
  }

  function historyOf(key, count) {
    const arr = histMap.get(key) || [];
    const n = Math.max(1, Math.min(HIST_MAX, toInt(count) || 20));
    return arr.slice(Math.max(0, arr.length - n));
  }

  // 一条记录 -> OneBot 消息事件。sender 按 QQ 的字段补齐(card/sex/age/role ...),
  // 少了这些字段很多 QQ 插件会在取昵称时直接 KeyError
  function msgEventOf(rec) {
    const evt = {
      post_type: 'message',
      message_type: rec.type === 'group' ? 'group' : 'private',
      sub_type: rec.type === 'group' ? 'normal' : 'friend',
      message_id: rec.message_id,
      message_seq: rec.message_id,
      user_id: toInt(rec.userId),
      message: rec.segments,
      raw_message: rec.text || '',
      font: 0,
      sender: {
        user_id: toInt(rec.userId),
        nickname: rec.senderName || String(rec.userId || ''),
        card: rec.type === 'group' ? (rec.senderName || '') : '',
        sex: 'unknown',
        age: 0,
        area: '',
        level: '',
        title: '',
        role: rec.role || 'member',
      },
      anonymous: null,
      self_id: selfId(),
      time: rec.time,
    };
    if (rec.type === 'group') evt.group_id = toInt(rec.groupId);
    return evt;
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

  // CQ 码里的字符转义(QQ 标准)。顺序不能变: &amp; 必须最后还原
  function cqUnescape(s) {
    return String(s)
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&#44;/g, ',')
      .replace(/&amp;/g, '&');
  }

  function normSegments(msg, autoEscape) {
    if (Array.isArray(msg)) return msg;
    if (msg && typeof msg === 'object' && msg.type) return [msg];
    const s = String(msg == null ? '' : msg);
    if (!s) return [];
    // auto_escape=true 表示整串都是纯文本, 不要解析 CQ 码
    if (autoEscape) return [{ type: 'text', data: { text: s } }];

    // 字符串形式: 解析 CQ 码。QQ 插件发字符串消息时几乎都会带 [CQ:reply]/[CQ:at] 这类段,
    // 以前只认 4 种, 剩下的会原样发给手表 —— 现在一律先解析再交给 sendSegments 决定去留
    const out = [];
    const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ type: 'text', data: { text: cqUnescape(s.slice(last, m.index)) } });
      const attrs = {};
      String(m[2] || '').replace(/^,/, '').split(',').forEach((kv) => {
        const i = kv.indexOf('=');
        if (i > 0) attrs[kv.slice(0, i)] = cqUnescape(kv.slice(i + 1));
      });
      out.push({ type: m[1].toLowerCase(), data: attrs });
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push({ type: 'text', data: { text: cqUnescape(s.slice(last)) } });
    return out;
  }

  // at 段的显示名: 优先用 name, 其次按 qq 去会话成员里找, qq=all 时按 QQ 的说法叫全体成员
  function atName(data, peers) {
    const qq = String(data.qq == null ? '' : data.qq);
    if (qq === 'all') return '全体成员';
    if (data.name) return String(data.name);
    const p = (peers || []).find((a) => String(a.imAccountId) === qq);
    return (p && p.name) || qq;
  }

  // 合并转发里的一个 node -> 一行文本
  function nodeText(d) {
    const c = d.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.map((s) => {
      if (!s || !s.type) return '';
      const dd = s.data || {};
      if (s.type === 'text') return String(dd.text || '');
      if (s.type === 'image') return '[图片]';
      if (s.type === 'face') return '[表情]';
      if (s.type === 'record') return '[语音]';
      if (s.type === 'video') return '[视频]';
      if (s.type === 'at') return '@' + atName(dd);
      return '';
    }).join('');
  }

  // 把 messages 数组(可能是 node / 引用已有转发 / 老式 {name,uin,content})摊平成文本行
  function flattenNodes(messages) {
    const out = [];
    const walk = (arr, depth) => {
      if (!Array.isArray(arr)) return;
      arr.forEach((n) => {
        if (!n) return;
        const d = n.data || n;
        // {type:'node', data:{id}} 是引用一条已存在的转发
        if (d.id && d.content === undefined) {
          const cached = forwardStore.get(String(d.id));
          if (cached) walk(cached, depth + 1);
          return;
        }
        const name = d.name || d.nickname || d.uin || d.user_id || '';
        const txt = nodeText(d);
        if (!name && !txt) return;
        out.push('　'.repeat(depth) + (name ? name + '：' : '') + txt);
      });
    };
    walk(messages, 0);
    return out;
  }

  // 发出去的消息统一记账, 顺手写历史
  async function emit(target, body, label, segments) {
    await ctx.send(target.key, body);
    stats.message_sent += 1;
    const id = nextMsgId();
    remember({
      message_id: id,
      targetKey: target.key,
      type: target.type,
      groupId: target.type === 'group' ? target.dialogId : null,
      userId: selfId(),
      senderName: (ctx.nickname && ctx.nickname()) || 'JZClientForNode',
      role: 'member',
      segments: segments || [{ type: 'text', data: { text: label } }],
      text: label,
      time: nowSec(),
      self: true,
    });
    return id;
  }

  // 合并转发: 微聊没有卡片式转发, 降级成「昵称：内容」的多行文本一次发出
  async function sendForward(target, messages) {
    const lines = flattenNodes(messages);
    if (!lines.length) throw new Error('转发内容为空');
    // 手表端对超长文本会截断, 按 1500 字切块分条发
    const chunks = [];
    let buf = '';
    lines.forEach((l) => {
      if (buf && buf.length + l.length + 1 > 1500) { chunks.push(buf); buf = ''; }
      buf += (buf ? '\n' : '') + l;
    });
    if (buf) chunks.push(buf);

    let last = 0;
    for (const c of chunks) last = await emit(target, { kind: 'text', text: c }, c);

    const fid = 'fwd_' + crypto.randomBytes(6).toString('hex');
    forwardStore.set(fid, messages);
    while (forwardStore.size > 50) {
      const k = forwardStore.keys().next();
      if (k.done) break;
      forwardStore.delete(k.value);
    }
    return { message_id: last, forward_id: fid };
  }

  // 把 OneBot 消息段翻译成微聊的多次发送
  async function sendSegments(target, segments) {
    const ids = [];
    let buf = '';
    let needSpace = false; // at 段刚补过尾空格, 下一段若自己也以空白开头就吃掉重复的那个

    const flush = async () => {
      const text = buf.trim();
      buf = '';
      needSpace = false;
      if (!text) return;
      ids.push(await emit(target, { kind: 'text', text }, text));
    };

    // 媒体段统一入口。OneBot 规范只说 http(s), 但 NapCat / go-cqhttp / AstrBot
    // 实际还会发 base64:// 和 file:///abs/path —— 全交给 resolveMediaSrc 解开,
    // 解成临时文件的话发完立刻删掉(图片 1MB+ 堆在 /tmp 里迟早出问题)。
    const sendMedia = async (data, kind, label, extra) => {
      const raw = mediaSrcOf(data);
      const hint = kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'voice';
      const m = resolveMediaSrc(raw, hint);
      if (m.tmp) log.debug('onebot', `媒体段 ${kind} 已解码到临时文件 ${m.src.split(/[\\/]/).pop()}`);
      try {
        ids.push(await emit(target, Object.assign({ kind, src: m.src }, extra || {}), label));
      } finally {
        cleanupMediaSrc(m);
      }
    };

    // 语音: 微聊单条上限 60 秒, 超了发不出去。超过 VOICE_MAX_SEC 就自动切段连发,
    // 一首 4 分钟的歌会变成 5 条语音, 手表端按顺序听就是完整的。
    const VOICE_MAX_SEC = 58;   // 留 2 秒余量, 避免刚好 60 被拒
    const VOICE_MAX_SEG = 20;   // 再长就别发了(>19 分钟), 直接报错比刷屏好
    const sendVoice = async (data) => {
      const m = resolveMediaSrc(mediaSrcOf(data), 'voice');
      let file = m.src;
      let downloaded = '';
      try {
        // ffmpeg 只吃文件, http 的语音也得先落盘才能探测时长 / 切段
        if (!m.tmp && /^https?:\/\//i.test(file)) {
          downloaded = await downloadToTmp(file, 'voice');
          file = downloaded;
        }
        const dur = probeDuration(file);
        if (!dur || dur <= VOICE_MAX_SEC) {
          ids.push(await emit(target, { kind: 'voice', src: file }, '[语音]'));
          return;
        }
        const seg = splitAudio(file, VOICE_MAX_SEC);
        try {
          if (!seg.files.length) throw new Error('音频切分失败(需要 ffmpeg)');
          if (seg.files.length > VOICE_MAX_SEG) {
            throw new Error(`语音 ${Math.round(dur)} 秒, 切分后 ${seg.files.length} 段超过上限 ${VOICE_MAX_SEG} 段, 换短一点的音频`);
          }
          log.info('onebot', `语音 ${Math.round(dur)} 秒超过 ${VOICE_MAX_SEC} 秒上限, 切成 ${seg.files.length} 段发送`);
          for (let i = 0; i < seg.files.length; i++) {
            // 连着发太快平台会吞掉后面的, 留一点间隔
            if (i) await new Promise((r) => setTimeout(r, 350));
            ids.push(await emit(target, { kind: 'voice', src: seg.files[i] }, `[语音 ${i + 1}/${seg.files.length}]`));
          }
        } finally {
          cleanupSplit(seg);
        }
      } finally {
        if (downloaded) { try { fs.unlinkSync(downloaded); } catch (e) { /* ignore */ } }
        cleanupMediaSrc(m);
      }
    };

    // QQ 的合并转发有两种写法: 调 send_forward_msg(走 sendForward), 或者直接把
    // node 段塞进 message 数组发。后者以前会被当成未知段丢掉, 现在整条都交给转发逻辑。
    if (segments.length && segments.every((s) => s && String(s.type || '').toLowerCase() === 'node')) {
      return (await sendForward(target, segments)).message_id;
    }

    for (const seg of segments) {
      const type = String((seg && seg.type) || '').toLowerCase();
      const data = (seg && seg.data) || {};

      if (type === 'text') {
        let t = String(data.text || '');
        if (needSpace && /^\s/.test(t)) t = t.replace(/^\s+/, '');
        needSpace = false;
        buf += t;
        continue;
      }
      // 微聊不能 @ 人, 降级成 @昵称 文本
      if (type === 'at') { buf += '@' + atName(data, target.peers) + ' '; needSpace = true; continue; }
      if (type === 'reply') continue; // 引用回复: 微聊没有对应能力, 直接忽略
      if (type === 'face') {
        const idx = toInt(data.id) || 0;
        // QQ 的表情号是 0~300+, 本地只有 EMOJI_COUNT 个对应图。
        // 超出范围就降级成文本 —— 直接丢给下游会因为「表情不存在」把整条消息打成 1400,
        // 这是按 QQ 写的插件最容易踩的一个坑(随便发个 doge 就整条失败)。
        if (idx >= 1 && idx <= EMOJI_COUNT) {
          await flush();
          ids.push(await emit(target, { kind: 'emoji', index: idx }, '[表情]'));
        } else {
          buf += '[表情]';
        }
        continue;
      }
      // QQ 商城表情(mface) / 小表情(bface): 本质是一张图, 带 url 就按图片发
      if (type === 'mface' || type === 'bface') {
        await flush();
        const u = String(data.url || '');
        if (/^https?:\/\//i.test(u)) await sendMedia({ url: u }, 'image', '[表情]');
        else buf += '[表情]';
        continue;
      }
      if (type === 'image') {
        await flush();
        await sendMedia(data, 'image', '[图片]');
        continue;
      }
      if (type === 'record' || type === 'voice') {
        await flush();
        await sendVoice(data);
        continue;
      }
      if (type === 'video') {
        await flush();
        // duration 是秒, 部分框架会带; 不带就让 upload 那边自己探测
        await sendMedia(data, 'video', '[视频]', { duration: Number(data.duration) || 0 });
        continue;
      }
      // 文件段: 微聊没有文件传输。但插件经常用它兜底 —— 比如音乐插件语音发不出去时
      // 会 fallback 成 file 段, 内容其实还是音频。按扩展名当对应消息发, 实在不认识才降级成文本。
      if (type === 'file') {
        await flush();
        const name = String(data.name || data.file || data.url || '');
        const ext = (name.toLowerCase().match(/\.(amr|mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4|mov|m4v|3gp|mkv|avi|jpe?g|png|gif|webp)(?:[?#]|$)/) || [])[1] || '';
        if (/^(amr|mp3|m4a|aac|wav|ogg|oga|opus|flac)$/.test(ext)) { await sendVoice(data); continue; }
        if (/^(mp4|mov|m4v|3gp|mkv|avi|webm)$/.test(ext)) { await sendMedia(data, 'video', '[视频]', { duration: Number(data.duration) || 0 }); continue; }
        if (/^(jpe?g|png|gif|webp)$/.test(ext)) { await sendMedia(data, 'image', '[图片]'); continue; }
        buf += (buf ? ' ' : '') + '[文件] ' + name;
        continue;
      }
      if (type === 'location') {
        await flush();
        const lat = Number(data.lat);
        const lng = Number(data.lon != null ? data.lon : data.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('位置段的经纬度不正确');
        ids.push(await emit(target, { kind: 'location', latitude: lat, longitude: lng, poi: String(data.title || '') }, '[位置]'));
        continue;
      }
      // 链接分享: 拼成「标题 + 地址」当文本发, 微聊的 link 气泡要业务类型, 这里不猜
      if (type === 'share') {
        const u = String(data.url || '');
        if (/^https?:\/\//i.test(u)) buf += (buf ? ' ' : '') + (data.title ? data.title + ' ' : '') + u;
        continue;
      }
      // 合并转发段: 引用之前缓存过的 nodes, 展开成文本
      if (type === 'forward') {
        await flush();
        const nodes = forwardStore.get(String(data.id || ''));
        if (!nodes) throw new Error('转发内容不存在或已过期');
        ids.push((await sendForward(target, nodes)).message_id);
        continue;
      }
      // QQ 卡片消息(小程序 / 分享卡片): 微聊还原不了, 只捞一个标题当文本
      if (type === 'json' || type === 'xml' || type === 'ark' || type === 'light_app') {
        const m = /"(?:prompt|title|desc)"\s*:\s*"([^"]{1,80})"/.exec(String(data.data || data.content || ''));
        if (m) buf += (buf ? ' ' : '') + m[1];
        continue;
      }
      // 戳一戳 / 抖动 / 骰子 / 猜拳: 转成一句提示, 至少让手表知道发生过
      if (type === 'poke' || type === 'shake' || type === 'dice' || type === 'rps') {
        const label = { poke: '[戳一戳]', shake: '[窗口抖动]', dice: '[骰子]', rps: '[猜拳]' }[type];
        buf += (buf ? ' ' : '') + label;
        continue;
      }
      // 混在文本里的单个 node 段(上面整条都是 node 的情况已经拦掉了): 摊成一行
      if (type === 'node') {
        const line = flattenNodes([seg])[0];
        if (line) buf += (buf ? ' ' : '') + line;
        continue;
      }
      // 其余段: 兼容模式下静默丢弃(别为了一个不认识的段把整条消息打回去), 严格模式报错
      if (conf.qqCompat !== false) {
        log.debug('onebot', '忽略不支持的消息段: ' + type);
        continue;
      }
      throw new Error('暂不支持的消息段类型: ' + type);
    }
    await flush();
    if (!ids.length) throw new Error('消息内容为空');
    return ids[ids.length - 1];
  }

  // ===== QQ 兼容层 =====
  // 微聊(手表)和 QQ 的能力差得很远, 而按 QQ(NapCat / go-cqhttp)写的 AstrBot 插件会调一堆
  // QQ 专有动作。只要有一个动作回 1404, 很多插件整条链路就崩了。所以分三档:
  //   1) 真做     —— 用微聊能力实现(信息查询 / 发送 / 历史 / 合并转发降级)
  //   2) 空实现   —— 物理上做不到, 返回结构合理的空值或 {}, 让插件继续往下跑
  //   3) 明确拒绝 —— 危险操作(踢人 / 退群 / 删好友)直接报错, 绝不静默
  // 每一档的具体清单写在 README 的「QQ 兼容性」一节, 增删动作要同步。

  // 空实现: 调用即成功, 什么也不会发生
  const NOOP_ACTIONS = [
    'delete_msg',                        // 微聊没有撤回接口(收到别人的撤回只是通知)
    'set_group_ban', 'set_group_whole_ban', 'set_group_anonymous_ban',
    'set_group_card', 'set_group_name', 'set_group_special_title', 'set_group_remark',
    'set_group_anonymous',
    'send_like', 'send_poke', 'set_msg_emoji_like', 'set_input_status',
    'mark_msg_as_read', 'mark_group_msg_as_read', 'mark_private_msg_as_read', 'mark_all_as_read',
    'send_group_notice', '_send_group_notice', 'send_group_sign',
    'set_online_status', 'set_diy_online_status',
    'set_qq_profile', 'set_qq_avatar',
    'set_friend_add_request', 'set_group_add_request',
  ];

  // 固定空值: 查询类, 结构对得上 QQ, 内容为空
  const EMPTY_ACTIONS = {
    get_group_honor_info: (p) => ({
      group_id: toInt(p.group_id), current_talkative: null,
      talkative_list: [], performer_list: [], legend_list: [], strong_newbie_list: [], emotion_list: [],
    }),
    get_group_shut_list: () => [],
    get_group_at_all_remain: () => ({ can_at_all: false, remain_at_all_count_for_group: 0, remain_at_all_count_for_uin: 0 }),
    get_group_system_msg: () => ({ invited_requests: [], join_requests: [] }),
    get_group_file_system_info: () => ({ file_count: 0, limit_count: 0 }),
    get_group_root_files: () => ({ files: [], folders: [] }),
    get_group_files_by_folder: () => ({ files: [], folders: [] }),
    get_essence_msg_list: () => [],
    get_group_notice: () => [],
    _get_group_notice: () => [],
    get_group_ignore_add_request: () => [],
    get_doubt_friends_add_request: () => [],
    get_unidirectional_friend_list: () => [],
    get_online_clients: () => ({ clients: [] }),
    get_cookies: () => ({ cookies: '' }),
    get_csrf_token: () => ({ token: 0 }),
    get_credentials: () => ({ cookies: '', csrf_token: 0 }),
    get_clientkey: () => '',
    get_robot_uin_range: () => [],
    get_model_show: () => ({ variants: [] }),
    _get_model_show: () => ({ variants: [] }),
    get_profile_like: () => ({ uid: '', time: 0, favorite_count: 0, vote_count: 0, favorite_user_count: 0, vote_user_count: 0 }),
    fetch_custom_face: () => [],
    get_group_info_ex: () => ({}),
    get_group_detail_info: () => ({}),
    get_mini_app_ark: () => ({}),
    get_ai_characters: () => [],
    get_group_album_media_list: () => ({ media_list: [] }),
    '.get_word_slices': () => ({ slices: [] }),
  };

  // 明确拒绝: 要么物理上做不到, 要么会动到绑定关系, 静默成功会害人
  const DENY_ACTIONS = {
    ocr_image: '微聊没有图片文字识别能力',
    send_packet: '不支持发送原始数据包',
    get_ai_record: '微聊没有 AI 语音合成能力',
    send_group_ai_record: '微聊没有 AI 语音合成能力',
    set_group_leave: '退出家庭群会破坏手表绑定, 已禁用',
    set_group_kick: '踢人会破坏手表绑定, 已禁用',
    delete_friend: '删除好友会破坏手表绑定, 已禁用',
  };

  const actions = {
    // ===== 基础信息 =====
    get_login_info: async () => ({
      user_id: selfId(),
      nickname: (ctx.nickname && ctx.nickname()) || 'JZClientForNode',
    }),

    get_status: async () => {
      const online = isOnline();
      return {
        online,
        good: online,
        app_initialized: true,
        app_enabled: true,
        plugins_good: true,
        stat: {
          packet_received: 0, packet_sent: 0, packet_lost: 0,
          message_received: stats.message_received, message_sent: stats.message_sent,
        },
      };
    },

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
        group_create_time: 0,
        group_level: 0,
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
        group_create_time: 0,
        group_level: 0,
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
        sex: 'unknown',
        age: 0,
        area: '',
        join_time: 0,
        last_sent_time: 0,
        level: '1',
        role: a.accountType === 1 ? 'member' : 'owner',
        unfriendly: false,
        title: '',
        title_expire_time: 0,
        card_changeable: false,
      }));
    },

    get_group_member_info: async (p) => {
      const t = await findTarget('group', p.group_id);
      if (!t) throw new Error('群不存在');
      const a = (t.peers || []).find((x) => String(x.imAccountId) === String(p.user_id));
      if (!a) throw new Error('该成员不在这个群里');
      return {
        group_id: toInt(t.dialogId),
        user_id: toInt(a.imAccountId),
        nickname: a.name || '',
        card: a.name || '',
        sex: 'unknown',
        age: 0,
        area: '',
        join_time: 0,
        last_sent_time: 0,
        level: '1',
        role: a.accountType === 1 ? 'member' : 'owner',
        unfriendly: false,
        title: '',
        title_expire_time: 0,
        card_changeable: false,
      };
    },

    get_stranger_info: async (p) => {
      const t = await findTarget('private', p.user_id);
      return {
        user_id: toInt(p.user_id),
        nickname: (t && t.name) || String(p.user_id),
        sex: 'unknown',
        age: 0,
        qid: '',
        level: 0,
        login_days: 0,
      };
    },

    // ===== 发送 =====
    send_private_msg: async (p) => {
      const t = await findTarget('private', p.user_id);
      if (!t) throw new Error('没有这个私聊会话(手表未绑定或 ID 不对)');
      const id = await sendSegments(t, normSegments(p.message, p.auto_escape));
      return { message_id: id };
    },

    send_group_msg: async (p) => {
      const t = await findTarget('group', p.group_id);
      if (!t) throw new Error('没有这个群会话(家庭群 ID 不对)');
      const id = await sendSegments(t, normSegments(p.message, p.auto_escape));
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

    // ===== 合并转发(降级成多行文本) =====
    send_group_forward_msg: async (p) => {
      const t = await findTarget('group', p.group_id);
      if (!t) throw new Error('没有这个群会话(家庭群 ID 不对)');
      return sendForward(t, p.messages);
    },

    send_private_forward_msg: async (p) => {
      const t = await findTarget('private', p.user_id);
      if (!t) throw new Error('没有这个私聊会话(手表未绑定或 ID 不对)');
      return sendForward(t, p.messages);
    },

    send_forward_msg: async (p) => {
      if (p.group_id != null) return actions.send_group_forward_msg(p);
      if (p.user_id != null) return actions.send_private_forward_msg(p);
      throw new Error('send_forward_msg 需要 user_id 或 group_id');
    },

    get_forward_msg: async (p) => {
      const nodes = forwardStore.get(String(p.id || p.message_id || ''));
      if (!nodes) throw new Error('转发内容不存在或已过期');
      return { messages: nodes };
    },

    // ===== 消息查询 =====
    get_msg: async (p) => {
      const rec = msgStore.get(toInt(p.message_id));
      if (!rec) throw new Error('消息不存在或已过期');
      return msgEventOf(rec);
    },

    get_group_msg_history: async (p) => {
      const t = await findTarget('group', p.group_id);
      if (!t) throw new Error('群不存在');
      return { messages: historyOf(t.key, p.count).map((r) => msgEventOf(r)) };
    },

    get_friend_msg_history: async (p) => {
      const t = await findTarget('private', p.user_id);
      if (!t) throw new Error('没有这个私聊会话');
      return { messages: historyOf(t.key, p.count).map((r) => msgEventOf(r)) };
    },

    get_recent_contact: async (p) => {
      const list = (await ctx.targets()) || [];
      const n = Math.max(1, Math.min(50, toInt(p.count) || 10));
      const out = [];
      list.forEach((t) => {
        const arr = histMap.get(t.key) || [];
        const last = arr[arr.length - 1];
        if (!last) return;
        out.push({
          lastest_msg: msgEventOf(last),
          peer_id: toInt(t.type === 'group' ? t.dialogId : t.receiverId),
          peer_name: t.name || '',
          peer_remark: t.name || '',
          remark: t.name || '',
          msg_time: last.time,
          msg_seq: last.message_id,
          chat_type: t.type === 'group' ? 2 : 1,
          sender_id: toInt(last.userId),
        });
      });
      return out.slice(0, n);
    },

    // 拿媒体文件的地址。插件通常用它去下载, 所以把 url 原样回给它们
    get_image: async (p) => ({ file: String(p.file || ''), url: String(p.url || p.file || '') }),
    get_record: async (p) => ({ file: String(p.file || ''), url: String(p.url || p.file || '') }),
    get_file: async (p) => ({ file: String(p.file || ''), url: String(p.url || p.file || ''), file_size: '0' }),

    // ===== 能力声明 =====
    can_send_image: async () => ({ yes: true }),
    can_send_record: async () => ({ yes: true }),

    // AstrBot 等框架会调, 直接回成功避免报错
    '.handle_quick_operation': async () => ({}),
    set_restart: async () => { throw new Error('不支持重启'); },
    clean_cache: async () => ({}),
  };

  // 把三档兼容动作挂上去。放最后是为了让上面的真实实现永远优先(顺序即优先级)
  // 注意: 关掉 qqCompat 时只有「静默成功」这一档会被拆掉 —— 那是唯一会骗插件的地方;
  //       「返回空值」是诚实的(确实没有禁言列表), 严格模式也保留, 否则一堆只读插件直接跑不起来
  NOOP_ACTIONS.forEach((name) => {
    if (actions[name]) return;
    actions[name] = async () => {
      if (conf.qqCompat === false) {
        const e = new Error('不支持的 action: ' + name + '(微聊没有对应能力, QQ 兼容模式已关闭)');
        e.retcode = RC.NOTFOUND;
        throw e;
      }
      log.debug('onebot', `QQ 兼容: ${name} 在微聊没有对应能力, 已忽略`);
      return {};
    };
  });
  Object.keys(EMPTY_ACTIONS).forEach((name) => {
    if (!actions[name]) actions[name] = EMPTY_ACTIONS[name];
  });
  Object.keys(DENY_ACTIONS).forEach((name) => {
    if (actions[name]) return;
    actions[name] = async () => {
      const e = new Error(DENY_ACTIONS[name]);
      e.retcode = RC.BAD;
      throw e;
    };
  });

  async function dispatch(action, params) {
    const fn = actions[action];
    if (!fn) {
      // 打出来方便用户反馈"某个插件用不了"时直接对上是哪个动作没实现
      log.debug('onebot', '未实现的 action: ' + action);
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
    const at = time ? Math.floor(Number(time) / 1000) : nowSec();

    // 撤回: 微聊有明确的撤回消息体, 转成 QQ 的 recall 通知事件。
    // 手表侧不知道被撤回的是哪条, message_id 只能给 0
    if (parsed && parsed.kind === 'withdraw') {
      if (!sockets.size) return;
      const evt = {
        post_type: 'notice',
        notice_type: type === 'group' ? 'group_recall' : 'friend_recall',
        sub_type: 'withdraw',
        self_id: selfId(),
        time: at,
        user_id: toInt(userId),
        operator_id: toInt(userId),
        message_id: 0,
      };
      if (type === 'group') evt.group_id = toInt(groupId);
      broadcast(evt);
      return;
    }

    const segments = toSegments(parsed, text);
    if (!segments.length) return;

    // 先记账再广播: 没有客户端连着的时候也要留历史, 否则 get_group_msg_history 永远是空的
    const rec = {
      message_id: nextMsgId(),
      targetKey: type === 'group' ? 'g:' + groupId : 's:' + userId,
      type,
      groupId: type === 'group' ? groupId : null,
      userId: toInt(userId),
      senderName: senderName || String(userId || ''),
      role: 'member',
      segments,
      text: text || describe(parsed) || '',
      time: at,
      self: false,
    };
    remember(rec);
    stats.message_received += 1;
    if (!sockets.size) return;
    broadcast(msgEventOf(rec));
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
        // base64:// 的语音/视频很容易上几 MB(一首 4 分钟的 mp3 转 base64 就有 5MB+)。
        // 以前这里 4MB 就 req.destroy(), 客户端只看到连接被重置、根本不知道原因;
        // 现在放宽到 32MB, 超了也照样读完再回一个明确的 1400。
        const MAX_BODY = 32 * 1024 * 1024;
        const chunks = [];
        let size = 0;
        let tooBig = false;
        req.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) { tooBig = true; chunks.length = 0; return; }
          if (!tooBig) chunks.push(c);
        });
        req.on('end', () => {
          if (tooBig) {
            return sendJson(400, {
              status: 'failed', retcode: RC.BAD, data: null,
              message: `请求体超过 ${MAX_BODY / 1048576}MB 上限（多半是 base64:// 的媒体太大），改用 http(s) 地址或降低码率`,
            });
          }
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
    // 归一化后的配置(含自动生成的令牌), 调用方据此回写 cfg 与展示
    conf,
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
