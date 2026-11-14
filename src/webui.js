// 本地 Web UI: 纯 Node http 服务, 默认 0.0.0.0 监听(局域网可访问), 所有接口需访问令牌
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ApiClient, MODULES } = require('./api');
const device = require('./device');
const sso = require('./sso');
const { ImClient } = require('./im');
const { bufferEarlyMessages } = require('./im-early-messages');
const { allowMessageSideEffects } = require('./im-message-freshness');
const { buildChatTargets, chatIdsOf } = require('./chat-targets');
const { selectBattery, selectOnline } = require('./watch-status-selection');
const { chat: aiChat } = require('./ai');
const aiTrigger = require('./ai-trigger');
const vision = require('./vision');
const { parseMessage, describe, mediaUrl, buildText, buildEmoji, buildLocation, buildLink, buildPhoto, buildVideo, buildVoice, buildKaomoji, EMOJI_PRESET, LINK_APP_NAME } = require('./message');
const { loadImageSource, uploadImage, uploadVoice, uploadVideo, directVideo, probeDuration, splitAudio, splitVideo, cleanupSplit, downloadToTmp } = require('./upload');
const { fetchFavicon } = require('./favicon');
const linkLib = require('./link-presets');
const { startOneBot } = require('./onebot');
const { createOnebotScope } = require('./onebot-scope');
const { mergeWatchIds } = require('./watch-ids');
const bili = require('./bilibili');
const biliBot = require('./bili-bot');
const biliComment = require('./bili-comment');
const biliSearch = require('./bili-search');
const { PluginManager, normalizeManifest, PLUGIN_MODE, MANAGED_HINT } = require('./plugin');
const log = require('./logger');
const SITE = require('./site.config');

const HTML_FILE = path.join(__dirname, 'webui.html');
let htmlCache = null;
let htmlGzip = null;
let htmlEtag = '';

function pageHtml() {
  if (!htmlCache) {
    htmlCache = fs.readFileSync(HTML_FILE, 'utf8');
    // ETag 用「大小 + mtime」拼，不重算内容哈希：换文件自然失效，算一次也几乎不花时间
    try {
      const st = fs.statSync(HTML_FILE);
      htmlEtag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    } catch (e) { htmlEtag = ''; }
    // 顺手压一份放内存。HTML 是死文件，压一次管到进程重启，实测 20ms 上下，
    // 换来的是一次 345KB → 84KB（4.1 倍）。别改成每次请求现压，那才是真的浪费 CPU。
    try {
      htmlGzip = zlib.gzipSync(Buffer.from(htmlCache, 'utf8'), { level: 6 });
    } catch (e) {
      htmlGzip = null;
      log.warn('webui', '首页 gzip 失败，退回明文发送：' + (e && e.message ? e.message : e));
    }
  }
  return htmlCache;
}

// 只认 gzip：deflate 和 br 得多缓存一份压缩结果，而首页以中文 + CSS/JS 为主，
// 三者压缩率都在 4 倍上下，为那一点点差额多养一份内存不划算。
function acceptsGzip(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  // 认 "gzip" 和 "*"；q=0 表示客户端明确拒绝，别硬塞
  const m = ae.match(/(?:^|,)\s*(?:gzip|\*)\s*(?:;\s*q=([\d.]+))?/i);
  if (!m) return false;
  return m[1] === undefined || parseFloat(m[1]) > 0;
}

// 页面 HTML 有 300 多 KB（CSS/JS 全内嵌），走内网穿透时每次重传要一秒左右。
// 但它其实是**静态文件** —— 里面的数据都是前端起来后异步拉的 —— 所以给了两层优化：
//   1. ETag + no-cache：浏览器第二次访问只发 If-None-Match，命中回 304（几十字节），整包都不传
//   2. gzip：绕不过去的「首次访问」和「换设备/清缓存」压到 84KB，隧道上从 2 秒掉到 0.7 秒
// 注意别改成 no-store：那样每次都要重下 300KB，隧道上就是实打实的两秒。
function sendHtml(req, res) {
  const text = pageHtml();
  if (htmlEtag && req.headers['if-none-match'] === htmlEtag) {
    res.writeHead(304, { ETag: htmlEtag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
    return res.end();
  }
  const plain = Buffer.from(text, 'utf8');
  const gz = acceptsGzip(req) ? htmlGzip : null;
  const out = gz || plain;
  // 记的是真实上线的字节数（压缩后），debug 日志里才对得上隧道的实际流量
  res._bytes = out.length;
  const head = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': out.length,
    'Cache-Control': 'no-cache',
    // 同一份 HTML 有两种表示，不写 Vary 会让中间缓存把 gzip 版本发给不支持的客户端
    'Vary': 'Accept-Encoding',
  };
  if (gz) head['Content-Encoding'] = 'gzip';
  if (htmlEtag) head.ETag = htmlEtag;
  res.writeHead(200, head);
  res.end(out);
}

function send(res, status, type, body) {
  res._bytes = Buffer.byteLength(body || '');
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function ok(res, data) {
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, data }));
}

function fail(res, e) {
  res._failed = true;
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { resolve({}); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { resolve({}); }
    });
  });
}

// 读取原始二进制 body(用于浏览器直接上传相册文件)
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 100 * 1024 * 1024)) {
        reject(new Error('文件超过 100MB'));
        try { req.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function unwrap(r) {
  const j = r && r.json;
  if (!j) return { code: '000000', desc: '无响应', data: null };
  return { code: j.code, desc: j.desc, data: j.data };
}

function ensure(r) {
  const u = unwrap(r);
  if (u.code !== '000001') throw new Error(`[${u.code}] ${u.desc || '请求失败'}`);
  return u.data;
}

async function safe(fn) {
  try { return ensure(await fn()); } catch (e) { return null; }
}

function isWatchCodeResponse(j) {
  const code = String((j && j.code) || '');
  // 服务端绑表接口用 0 开头的一套码: 010014 需要验证 010015 错误 010016 失效 010017 次数上限
  if (['010014', '010015', '010016', '010017', '010018'].includes(code)) return true;
  const n = Number(code);
  if ([1138, 1139, 1140, 1141, 1142].includes(n)) return true;
  return /验证码|校验码/i.test((j && j.desc) || '');
}

// 时间统一成服务端要求的 HH:mm:ss
function clock(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.length === 5 ? `${s}:00` : s;
}

// 上课禁用的 timePeriod 是 [{startTime,endTime}] 的 JSON 字符串
function parsePeriods(start, end) {
  const a = clock(start);
  const b = clock(end);
  if (!a || !b) return [];
  return [{ startTime: a, endTime: b }];
}

// ===== 表情图片 =====
// 官方表情 CDN(site.assets.emojiBaseUrl) 已失效, 请求返回 404;
// 图片本体在客户端安装包的 assets/emoji_new.zip 里, 其中 small/ 为 114x114 PNG 预览图。
// 已按 code 导出到 src/assets/emoji/<code>.png, 由 /assets/emoji/ 静态路由提供。
const EMOJI_DIR = path.join(__dirname, 'assets', 'emoji');
const emojiFileCache = new Map(); // code -> 文件是否存在

function emojiAsset(code) {
  const c = String(code || '').trim();
  if (!c || !/^[A-Za-z0-9_]+$/.test(c)) return '';
  let hit = emojiFileCache.get(c);
  if (hit === undefined) {
    hit = fs.existsSync(path.join(EMOJI_DIR, c + '.png'));
    emojiFileCache.set(c, hit);
  }
  return hit ? '/assets/emoji/' + c + '.png' : '';
}

// 消息展示用的图片地址: 表情优先用本地资源(服务端下发的 url 只是 CDN 前缀, 已失效),
// 其余类型沿用 message.mediaUrl 的提取规则
function messageUrl(parsed) {
  if (parsed && parsed.kind === 'emoji') {
    const code = (parsed.inner && parsed.inner.code) || (parsed.body && parsed.body.code) || '';
    const local = emojiAsset(code);
    if (local) return local;
  }
  return mediaUrl(parsed);
}

// ===== 链接卡片的封面 / 来源图标 =====
// 链接消息(RelayH5Message)能带三样装饰: 封面 source、来源小图标 icon、来源文字 appName。
// 全都可留空 —— 封面留空就抓网页图标, 图标留空就用项目自带的图标。
// 来源图标在手表上只是个圆角小图, 所以默认用 64x64 的 icon-link.png:
// 它要 base64 塞进每条消息的 msgNewContent 里, 用 180x180 那张会白多背 26KB。
const LINK_ICON_FILES = ['icon-link.png', 'icon-180.png', 'icon.png'];
const LINK_COVER_MAX = 4 * 1024 * 1024;   // 封面原图上限(前端已压到 2MB 以内, 这里兜底)
const LINK_ICON_MAX = 256 * 1024;         // 来源图标是卡片角落的小图, 别塞大图
let linkIconCache;                        // undefined=未读, null=读不到

// 项目自带的默认来源图标
function defaultLinkIcon() {
  if (linkIconCache !== undefined) return linkIconCache;
  for (const name of LINK_ICON_FILES) {
    try {
      linkIconCache = fs.readFileSync(path.join(__dirname, 'assets', name));
      return linkIconCache;
    } catch (e) { /* 换下一个 */ }
  }
  log.warn('chat', '默认链接图标读取失败, 这条消息不带来源图标');
  linkIconCache = null;
  return linkIconCache;
}

// 前端传上来的图片: 支持 data URL(网页选图) / http(s) / 本地路径
function tooBig(limit) {
  return limit >= 1024 * 1024
    ? '图片超过 ' + Math.round(limit / 1024 / 1024) + 'MB'
    : '图片超过 ' + Math.round(limit / 1024) + 'KB';
}

async function loadLinkImage(src, limit) {
  const s = String(src || '').trim();
  if (!s) return null;
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(s);
  if (m) {
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'binary');
    if (!buf.length) throw new Error('图片内容为空');
    if (buf.length > limit) throw new Error(tooBig(limit));
    return { buf, filename: 'image' + (String(m[1]).indexOf('png') >= 0 ? '.png' : '.jpg') };
  }
  const loaded = await loadImageSource(s);
  if (loaded.buf.length > limit) throw new Error(tooBig(limit));
  return loaded;
}

// ===== 会话 ID 的归一化与匹配（纯函数，不碰网络，可以直接单测） =====
//
// 家庭群的 ID 归一化和会话列表构建在 chat-targets.js（纯函数，可单测）：
// 那里同时解决了「同一个家庭出现两条记录」和「一个家庭绑多块表只显示一块」。
// 2026-11-09 那批用户「收不到手表消息」就是旧 ID 过期后严格相等匹配不上，
// 所以匹配时任一 aliasIds 命中就算，发送用第一个（优先 upgrade）。

// 把一条 IM 消息映射到会话 key（'s:xxx' / 'g:xxx'），认不出来返回 null
function matchChatKey(targets, m) {
  if (!targets || !targets.length || !m) return null;
  const did = String(m.dialogId == null ? '' : m.dialogId);

  if (did && did !== '0') {
    const groups = targets.filter((t) => t.type === 'group'
      && (t.aliasIds && t.aliasIds.length ? t.aliasIds : [String(t.dialogId)])
        .some((x) => String(x) === did));
    // 重叠别名无法可靠归属；绝不猜测，以免回复错群。
    if (groups.length > 1) return null;
    if (groups.length === 1) return groups[0].key;
  }

  // 单聊：按对方 imAccountId 匹配。
  // 群消息的 tag11 不是发送者账号（线上见过 255 这种值），所以这段只对单聊有意义。
  const s = targets.find((t) => t.type === 'single'
    && (String(t.receiverId) === String(m.imAccountId) || String(t.receiverId) === did));
  if (s) return s.key;
  return null;
}

async function startWebUI({ cfg, port = 8787, host = '0.0.0.0', token, ticketSecret } = {}) {
  // 兜底：不管从哪个入口进来（daemon / launcher / 测试脚本），都保证设备身份存在。
  // 少了 ssoMac 的话登录会在 /app/rsakey 直接 010401，而且报错完全看不出原因。
  try { device.ensureIdentity(cfg); } catch (e) { log.warn('device', '补设备身份失败: ' + e.message); }

  // 日志默认 info(请求/响应都打印); WP_LOG=debug 追加请求体等细节, WP_LOG=warn 只看告警
  const prevLevel = log.levelName();
  const envLevel = String(process.env.WP_LOG || '').toLowerCase().trim();
  log.configure({ level: log.LEVELS[envLevel] != null ? envLevel : (process.env.WP_DEBUG ? 'debug' : 'info') });

  const api = new ApiClient(cfg);
  let cache = { at: 0, list: [] };
  let watchStatusRevision = 0;

  // ===== 云端托管的 AI =====
  //
  // 平台（jz-cloud）启动实例时注入 JZ_AI_*：
  //   platform（官方）—— JZ_AI_MODE=platform + 网关地址 + 实例自己的令牌，
  //                      上游 key 永远不下发
  //   own（自带密钥）—— JZ_AI_MODE=own + 用户自己的上游地址和 key
  //
  // 两种情况都由平台统一管理，所以：
  //   - 界面显示来源，不给改接口（改了也不生效，运行时读的是环境变量）
  //   - /api/ai/config 直接拒，防止绕过界面直接调接口
  //   - 会话选择 / 触发方式 / 系统提示词 仍然归用户，那部分是「怎么用」不是「连哪」
  //
  // 只认 MODE 是刻意的：光有 BASE_URL 可能只是有人手动设了个网关，那不叫托管。
  const AI_SOURCE = String(process.env.JZ_AI_MODE || '').trim();
  const AI_MANAGED = (AI_SOURCE === 'platform' || AI_SOURCE === 'own')
    && !!String(process.env.JZ_AI_BASE_URL || '').trim();

  // 真正发请求时用的配置。托管模式下环境变量覆盖用户配置，
  // 但 temperature / 触发方式 / 提示词这些仍然沿用 cfg.ai。
  function aiRuntime() {
    if (!AI_MANAGED) return cfg.ai;
    return Object.assign({}, cfg.ai, {
      baseUrl: String(process.env.JZ_AI_BASE_URL || '').trim(),
      apiKey: String(process.env.JZ_AI_TOKEN || ''),
      model: String(process.env.JZ_AI_MODEL || '').trim() || cfg.ai.model,
    });
  }

  // ===== 插件系统 =====
  // 插件能用的能力全部从下面这个 host 走，插件本身拿不到 api / cfg / fs。
  // 想给插件多开一个口子，就在这里加一个方法，而不是把内部对象整个递出去。
  cfg.plugins = device.normalizePlugins(cfg.plugins);
  const pluginMgr = new PluginManager({
    cfg,
    host: {
      // 手表列表：只挑插件用得上的字段。relationId / imei 这类不该给第三方插件
      watches: async () => {
        const list = await watchList();
        return list.map((w) => ({
          watchId: String(w.watchId),
          name: w.name || '',
          model: w.model || '',
          number: w.number || '',
          battery: w.battery == null ? null : Number(w.battery),
          // 和界面同一套三态：字段缺失不能当在线（原来这里是 !== false，缺失就算在线，
          // 与首页的「缺失当离线」正好相反，同一个插件会看到两种答案）
          online: w.onlineStatus,
          lastSeenAt: w.lastSeenAt || null,
          lastLocation: w.lastLocation || null,
        }));
      },
      chatTargets: async () => {
        const list = await loadChatTargets();
        return list.map((t) => ({ key: t.key, type: t.type, name: t.name, sub: t.sub || '' }));
      },
      history: (key, limit) => (chatLog.get(key) || []).slice(-limit),
      location: async (watchId) => {
        const loc = ensure(await api.getWatchLocation(watchId)) || {};
        const lat = loc.latitude != null ? loc.latitude : loc.lat;
        const lng = loc.longitude != null ? loc.longitude : loc.lng;
        if (lat == null || lng == null) return null;
        return {
          latitude: Number(lat),
          longitude: Number(lng),
          address: String(loc.address || loc.poi || loc.addr || ''),
          time: Number(loc.createTime || loc.time || loc.locationTime || 0) || null,
        };
      },
      sendChat: (body) => sendChat(body),
      // 平台接口的逃生舱。方法名的白名单和读写分类在 plugin.js 里做
      apiCall: async (method, args) => {
        const fn = api[method];
        if (typeof fn !== 'function') throw new Error('平台接口不存在: ' + method);
        return fn.apply(api, args || []);
      },
      saveConfig: () => { try { device.save(cfg); } catch (e) { log.warn('plugin', '配置保存失败: ' + e.message); } },
    },
  });

  // ===== 访问令牌(参考 NapCat): 局域网默认可访问, 但必须持令牌才能调接口 =====
  const AUTH_COOKIE = 'wp_auth';
  const AUTH_TTL = 7 * 24 * 3600;          // Cookie 有效期 7 天
  const AUTH_FAIL_WINDOW = 10 * 60 * 1000; // 失败计数窗口 10 分钟
  const AUTH_FAIL_MAX = 8;                 // 窗口内失败超过 8 次就暂时锁住

  function newToken() {
    return 'jz_' + crypto.randomBytes(16).toString('hex');
  }

  function ensureToken() {
    const fromArg = String(token || '').trim();
    if (fromArg) return fromArg;
    const saved = cfg.webui && String(cfg.webui.token || '').trim();
    if (saved) return saved;
    const gen = newToken();
    cfg.webui = Object.assign({}, cfg.webui, { token: gen });
    try {
      device.save(cfg);
    } catch (e) {
      // 沙箱/权限问题下写不进去, 令牌会每次启动都变, 这里只告警不阻断
      log.warn('webui', '令牌保存失败(每次启动都会变): ' + e.message);
    }
    return gen;
  }

  const AUTH_TOKEN = ensureToken();
  // Cookie 里不存明文令牌, 存 sha256; 令牌本身高熵, 不可逆推
  const AUTH_HASH = crypto.createHash('sha256').update(AUTH_TOKEN).digest('hex');
  const authFails = new Map(); // ip -> { count, at }

  function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach((p) => {
      const i = p.indexOf('=');
      if (i < 0) return;
      const k = p.slice(0, i).trim();
      if (k) out[k] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
  }

  function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
  }

  function isAuthed(req) {
    const v = parseCookies(req)[AUTH_COOKIE];
    if (v && safeEqual(v, AUTH_HASH)) return true;
    // 也接受 Authorization: Bearer <token>，方便 curl / 脚本直接调 API
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
    if (m && safeEqual(m[1], AUTH_TOKEN)) return true;
    return false;
  }

  function authCookie() {
    return `${AUTH_COOKIE}=${AUTH_HASH}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_TTL}`;
  }

  // ===== 云端托管票据（可选）=====
  // 托管平台（jz-cloud）不把本实例的访问令牌传进 URL，而是签一张一次性票据：
  //   ticket = base64url(JSON{u:uid, e:过期ms, n:nonce}) + "." + HMAC-SHA256(payload, 共享密钥)
  // 平台和实例共享同一个密钥（平台建实例时生成，通过环境变量注入）。
  // 这样平台侧永远拿不到 wp_auth 的原文，票据泄露也只能用一次、30 秒内。
  const TICKET_SECRET = String(ticketSecret || process.env.INSTANCE_TICKET_SECRET || '').trim();
  const ticketUsed = new Map();   // nonce -> 过期时间

  function verifyTicket(t, want) {
    if (!TICKET_SECRET || !t) return null;
    const s = String(t);
    const dot = s.lastIndexOf('.');
    if (dot <= 0 || dot === s.length - 1) return null;
    const payload = s.slice(0, dot);
    const sig = s.slice(dot + 1);
    const expect = crypto.createHmac('sha256', TICKET_SECRET).update(payload).digest('base64url');
    if (!safeEqual(sig, expect)) return null;

    let j;
    try {
      j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (e) {
      return null;
    }
    if (!j || typeof j.e !== 'number' || Date.now() > j.e) return null;
    // 票据分两种：用户票据（?ticket= 换 Cookie）和平台票据（调 /api/platform/*）。
    // 必须在这里就分开，否则平台票据能被拿去换 WebUI 的登录 Cookie —— 等于绕过登录。
    const kind = j.t === 'platform' ? 'platform' : 'user';
    if (kind !== (want || 'user')) return null;
    // nonce 单次使用，防重放
    if (j.n) {
      if (ticketUsed.has(j.n)) return null;
      ticketUsed.set(j.n, j.e);
      // 顺手清理过期的 nonce，别让 Map 一直涨
      if (ticketUsed.size > 500) {
        const nowMs = Date.now();
        for (const [k, exp] of ticketUsed) if (exp < nowMs) ticketUsed.delete(k);
      }
    }
    return j;
  }

  // ===== 对外 API 令牌(独立于 WebUI 访问令牌, 给第三方脚本/机器人用) =====
  function newGeniusToken() {
    return 'gk_' + crypto.randomBytes(16).toString('hex');
  }

  // 启用状态下确保令牌存在(为空则生成并写回配置)。令牌只有按手表这一种
  function ensureGeniusToken() {
    let dirty = false;
    cfg.extApi = device.normalizeExtApi(cfg.extApi);
    Object.keys(cfg.extApi).forEach((wid) => {
      const e = cfg.extApi[wid];
      if (e && e.enabled && !e.token) { e.token = newGeniusToken(); dirty = true; }
    });
    if (dirty) {
      try { device.save(cfg); } catch (e) { log.warn('geniusapi', '令牌保存失败(每次启动会变): ' + e.message); }
    }
  }

  function clientIp(req) {
    return (req.socket && req.socket.remoteAddress) || '-';
  }

  function authBlocked(ip) {
    const r = authFails.get(ip);
    if (!r) return false;
    if (Date.now() - r.at > AUTH_FAIL_WINDOW) { authFails.delete(ip); return false; }
    return r.count >= AUTH_FAIL_MAX;
  }

  function noteAuthFail(ip) {
    const r = authFails.get(ip);
    if (!r || Date.now() - r.at > AUTH_FAIL_WINDOW) authFails.set(ip, { count: 1, at: Date.now() });
    else { r.count += 1; r.at = Date.now(); }
  }

  function sendJson(res, status, obj) {
    return send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
  }

  // ===== 型号能力(模块开关)缓存 =====
  const CAP_TTL = 10 * 60 * 1000;
  const capCache = new Map(); // watchId -> { at, map, ok }

  async function getCaps(watchId, force) {
    const hit = capCache.get(watchId);
    if (!force && hit && Date.now() - hit.at < CAP_TTL) return hit;
    const map = {};
    let ok = false;
    try {
      const raw = ensure(await api.getModuleSwitches(watchId)) || [];
      const rows = (Array.isArray(raw) ? raw : []).filter((row) => !row || !row.watchId || String(row.watchId) === String(watchId));
      rows.forEach((row) => {
        const list = (row && Array.isArray(row.moduleSwitchs)) ? row.moduleSwitchs : [];
        list.forEach((it) => {
          if (!it || it.module == null) return;
          map[Number(it.module)] = {
            display: it.display == null ? null : Number(it.display),
            tips: it.tips || '',
            description: it.description || '',
            model: it.watchModel || '',
            version: it.watchVersion || '',
            operationType: it.operationType == null ? null : Number(it.operationType),
            operationUrl: it.operationUrl || '',
          };
        });
      });
      ok = true;
    } catch (e) {
      ok = false;
      // 拉取失败时沿用最后一次成功结果, 避免能力门控完全失效
      const stale = capCache.get(watchId);
      if (stale) return { at: Date.now(), map: stale.map, ok: false, stale: true };
    }
    const out = { at: Date.now(), map, ok };
    // 拉取失败不缓存, 避免一次网络抖动导致 10 分钟内都拿不到能力列表
    if (ok) capCache.set(watchId, out);
    return out;
  }

  // 0=支持 1=不支持 2=可见但不可用; 没有下发记录时按官方型号默认策略(unknown -> 放行)
  function capStatus(caps, ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const found = list.map((mid) => (caps && caps.map ? caps.map[mid] : null)).filter((x) => x && x.display != null);
    if (!found.length) return { state: 'unknown', supported: true, tips: '' };
    if (found.some((x) => Number(x.display) === 0)) return { state: 'on', supported: true, tips: '' };
    // 多个模块只要缺任意一个记录, 就按回退处理, 不武断判定不支持
    if (found.length < list.length) return { state: 'unknown', supported: true, tips: '' };
    const tips = found.map((x) => x.tips).filter(Boolean)[0] || '';
    const visible = found.some((x) => Number(x.display) === 2);
    return { state: visible ? 'useless' : 'off', supported: false, tips };
  }

  async function requireCap(watchId, ids, label) {
    const st = capStatus(await getCaps(watchId), ids);
    if (st.state === 'off') throw new Error('该手表型号不支持' + label + (st.tips ? '：' + st.tips : ''));
    if (st.state === 'useless') throw new Error('该手表型号的' + label + '不可用' + (st.tips ? '：' + st.tips : ''));
  }

  // ===== 手表头像: account.icon 是云文件 key, 用 /token/download 换签名地址 =====
  const avatarCache = new Map(); // watchId -> { at, key, url }
  async function getAvatarUrl(watchId, account) {
    // 官方优先用 account.icon; 没有 icon 时回退到 bindNumber_1(客户端本地缓存也用这个 key)
    const icon = (account && account.icon) || '';
    if (/^https?:\/\//i.test(icon)) return icon; // 海外版可能直接下发完整 URL
    const key = icon || (account && account.bindNumber ? account.bindNumber + '_1' : '');
    if (!key) return '';
    const hit = avatarCache.get(watchId);
    if (hit && hit.key === key && Date.now() - hit.at < 10 * 60 * 1000) return hit.url;
    try {
      const r = await api.getFileUrls([key], 2);
      const u = (r.json && r.json.code === '000001' && Array.isArray(r.json.data)) ? r.json.data[0] : '';
      if (u) avatarCache.set(watchId, { at: Date.now(), key, url: u });
      return u || '';
    } catch (e) {
      return '';
    }
  }

  // ===== 聊天状态 =====
  let im = null;
  let imConnecting = null;
  let imRetry = null;                 // 断线后自己排的重连定时器
  let imReconnects = 0;               // 重连次数(诊断)
  let imLastError = '';               // 最近一次连接错误(诊断)
  let chatTargets = null;
  // 会话列表的缓存时间。以前是「拿到一次就一直用」—— 用户新绑一块表、或服务端
  // 多出一个群之后，AI / OneBot / B 站的会话勾选列表里永远看不到它，
  // 只能重启实例。60 秒过期一次，和 watchList 的缓存节奏对齐。
  let chatTargetsAt = 0;
  // 刚绑完表的一小段时间里，服务端可能还没把新的家庭群/单聊算出来。
  // 这期间每进来一次都重新拉，别拿 60 秒内的旧结果糊弄用户。
  let chatTargetsForceUntil = 0;
  const CHAT_TARGETS_TTL = 60000;
  const chatLog = new Map();
  let onebots = new Map();            // watchId -> 实例(每块表一套端口/令牌/会话范围)
  let onebotKeys = new Map();         // watchId -> [会话 key], 该实例只推这些会话
  let watchNames = null;              // [{watchId, name}], 手表名 <-> 会话名 靠它对

  // 绑定手表的实例必须限制会话范围，未匹配时拒绝访问而不是暴露全部会话。
  function onebotCtx(watchId, scopeKeys) {
    const keys = scopeKeys || [];
    const scoped = !!watchId;
    const scope = createOnebotScope(watchId, keys);
    return {
      // 按手表的实例: self_id 用那块表自己的 IM 账号, 插件才分得清"哪块表在说话"
      selfId: () => {
        if (scoped) {
          const s = keys.find((k) => k.indexOf('s:') === 0);
          const n = s ? Number(s.slice(2)) : 0;
          if (n) return n;
        }
        return im ? im.imAccountId : (cfg.imAccountId || 0);
      },
      nickname: () => cfg.userName || 'JZClientForNode',
      online: () => !!(im && im.connected),
      targets: async () => {
        const all = (await loadChatTargets()) || [];
        return scope.filter(all);
      },
      send: (key, body) => {
        if (!scope.allows(key)) throw new Error('会话不在该手表的 OneBot 范围内');
        return sendChat(Object.assign({}, body, { key }));
      },
    };
  }

  // 手表名缓存: 平台没给 watchId 与 imAccountId 的对应关系, 只能靠名字把两边对上
  async function ensureWatchNames(force) {
    // 每次都对一次 watchList：它自己有 60 秒缓存，新鲜时是纯内存返回，
    // 不新鲜时顺手刷新。以前这里是 `if (watchNames) return`，于是「新绑的表」
    // 永远进不了 watchNames —— B 站 / OneBot 的卡片里那块表就退化成默认值（未启用），
    // 用户看到的现象是「点了启用、保存完又变回关闭」（其实配置早就存进去了）。
    // 注意: 这里不能用 safe(), safe 是给 {code,data} 形态的接口响应用的,
    // watchList 返回的是普通数组, 过 ensure() 会直接抛错然后被吞成 null。
    let list = [];
    try { list = (await watchList(force)) || []; } catch (e) { list = []; }
    // 拉失败（没登录 / 平台抖）时保留手上这份，别把界面清空
    if (list.length || !watchNames) {
      watchNames = list.map((w) => ({ watchId: String(w.watchId), name: w.name || '' }));
    }
    return watchNames;
  }

  // 自动给某块手表挑会话: 单聊按手表名匹配, 家庭群看 peers 里有没有同一个 imAccountId。
  // 对不上就返回空数组, 让用户在设置里手选 —— 绝不瞎猜, 免得把别人的消息推错机器人。
  function autoKeysFor(watchId) {
    const list = chatTargets || [];
    const w = (watchNames || []).find((x) => x.watchId === String(watchId));
    const singles = list.filter((t) => t.type === 'single');
    let hit = null;
    if (w && w.name) hit = singles.find((t) => t.name === w.name) || null;
    if (!hit && singles.length === 1) hit = singles[0]; // 只有一块表, 不用猜
    if (!hit) return [];
    const out = [hit.key];
    const im = String(hit.receiverId);
    list.forEach((t) => {
      if (t.type === 'group' && (t.peers || []).some((a) => String(a.imAccountId) === im)) out.push(t.key);
    });
    return out;
  }

  async function refreshOnebotScope() {
    onebotKeys = new Map();
    const wids = Object.keys(cfg.onebotWatches || {});
    if (!wids.length) return;
    await ensureWatchNames(false);
    // 会话列表要在这里主动拉一次: 重启 OneBot 往往发生在用户还没打开「微聊」页的时候,
    // 那时 chatTargets 还是 null, autoKeysFor 会一律返回空 → 实例退化成接收全部会话。
    try { await loadChatTargets(); } catch (e) { /* 拉不到就让用户去设置里手选 */ }
    wids.forEach((wid) => {
      const wc = cfg.onebotWatches[wid] || {};
      const manual = (wc.targets || []).filter(Boolean);
      onebotKeys.set(String(wid), manual.length ? manual.slice() : autoKeysFor(wid));
    });
  }

  // 端口自动分配: 没有全局实例了, 每块表都从 5700 起按 10 错开(5700/5701、5710/5711…)
  function usedPorts(exceptWatchId) {
    const used = new Set();
    Object.keys(cfg.onebotWatches || {}).forEach((k) => {
      if (String(k) === String(exceptWatchId)) return;
      const c = cfg.onebotWatches[k];
      if (!c) return;
      if (c.http && c.http.port) used.add(Number(c.http.port));
      if (c.ws && c.ws.port) used.add(Number(c.ws.port));
    });
    return used;
  }

  function pickPorts(watchId) {
    const used = usedPorts(watchId);
    for (let base = 5700; base < 65000; base += 10) {
      if (!used.has(base) && !used.has(base + 1)) return { http: base, ws: base + 1 };
    }
    return { http: 5700, ws: 5701 };
  }

  // 老版本只有一套全局实例(onebot.enabled + http/ws/wsClient)。升级后这些字段被
  // device.load() 摘到不可枚举的 onebotLegacy 里, 这里把它搬到第一块手表上,
  // 这样已经接好的 AstrBot 不用改端口也不用换令牌。
  async function migrateLegacyOnebot() {
    const legacy = cfg.onebotLegacy;
    if (!legacy) return;
    if (Object.keys(cfg.onebotWatches || {}).length) { delete cfg.onebotLegacy; return; }
    let list = [];
    try { list = (await watchList(false)) || []; } catch (e) { list = []; }
    // 平台接口拿不到手表(登录票据过期时很常见)就退回本地缓存。不兜这一下的话旧配置会一直
    // 挂着不迁移 —— 用户升级后 OneBot 直接停摆, 已经接好的 AstrBot 会以为机器人掉线了。
    let wid = list.length ? String(list[0].watchId) : '';
    if (!wid) {
      const cached = Object.keys(cfg.watchStatus || {});
      if (cached.length) wid = String(cached[0]);
    }
    if (!wid) return; // 本地也没缓存, 下次启动再试
    const wc = device.normalizeOnebotWatch(cfg.onebotWatches[wid] || {});
    wc.enabled = !!legacy.enabled;
    if (legacy.http) wc.http = Object.assign({}, wc.http, legacy.http);
    if (legacy.ws) wc.ws = Object.assign({}, wc.ws, legacy.ws);
    if (legacy.wsClient) wc.wsClient = Object.assign({}, wc.wsClient, legacy.wsClient);
    cfg.onebotWatches = cfg.onebotWatches || {};
    cfg.onebotWatches[wid] = wc;
    delete cfg.onebotLegacy;
    try { device.save(cfg); } catch (e) { log.warn('onebot', '迁移旧配置失败: ' + (e && e.message ? e.message : e)); }
    log.info('onebot', `旧的全局配置已搬到手表 ${wid}（端口和令牌保持不变）`);
  }

  // 启动/重启 OneBot: 先关掉全部旧实例(端口在 listen 时绑定, 改端口只能整体重来)
  async function restartOneBot() {
    for (const inst of onebots.values()) {
      try { await inst.close(); } catch (e) { /* ignore */ }
    }
    onebots = new Map();

    await migrateLegacyOnebot();
    await refreshOnebotScope();

    const wids = Object.keys(cfg.onebotWatches || {});
    for (const wid of wids) {
      const wc = cfg.onebotWatches[wid];
      if (!wc || !wc.enabled) continue;
      const keys = onebotKeys.get(String(wid)) || [];
      if (!keys.length) {
        log.warn('onebot', `手表 ${wid} 没匹配到会话，已禁止访问会话；请在「我的 → OneBot v11 接入」里手动指定`);
      }
      const conf = {
        enabled: true,
        // 心跳和 QQ 兼容是公共设置, 不用每块表配一遍
        heartbeat: cfg.onebot && cfg.onebot.heartbeat != null ? cfg.onebot.heartbeat : 30,
        qqCompat: !(cfg.onebot && cfg.onebot.qqCompat === false),
        http: Object.assign({}, wc.http),
        ws: Object.assign({}, wc.ws),
        wsClient: Object.assign({}, wc.wsClient),
      };
      try {
        const inst = await startOneBot({
          cfg,
          ctx: onebotCtx(String(wid), keys),
          conf,
          // 令牌自动生成后只写回这一块表的配置, 绝不碰别的表
          onSave: (saved) => {
            const cur = device.normalizeOnebotWatch(cfg.onebotWatches[wid] || {});
            cur.http = Object.assign({}, cur.http, { token: saved.http.token });
            cur.ws = Object.assign({}, cur.ws, { token: saved.ws.token });
            cfg.onebotWatches[String(wid)] = cur;
            device.save(cfg);
          },
        });
        onebots.set(String(wid), inst);
        log.info('onebot', `手表 ${wid} 的实例已启动 http:${inst.http.port} ws:${inst.ws.port}`);
      } catch (e) {
        log.error('onebot', `手表 ${wid} 启动失败: ` + (e && e.message ? e.message : e));
      }
    }
    return onebots;
  }

  // 整数收敛: 非法/越界一律回落到默认值
  function clampInt(v, min, max, def) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    const i = Math.round(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
  }

  // 组装对外暴露的 OneBot 状态(供 GET 与保存后回显共用)
  // 顶层只放「公共行为 + 总体运行情况」, 端口/令牌/会话范围全在 watches 里按手表分开
  function onebotState() {
    const c = cfg.onebot || {};
    let clients = 0;
    for (const inst of onebots.values()) clients += inst.clients();
    return {
      heartbeat: c.heartbeat != null ? c.heartbeat : 30,
      qqCompat: c.qqCompat !== false,
      running: onebots.size > 0,
      clients,
      selfId: im ? im.imAccountId : (cfg.imAccountId || 0),
    };
  }

  // 每块手表的实例状态。以平台返回的手表列表为准, 这样「还没配置过」的表也能在界面上出现
  // (前端只渲染当前选中的那块, 但一份完整列表省得来回请求)
  async function onebotWatchesState() {
    await ensureWatchNames(false);
    const configured = cfg.onebotWatches || {};
    // 同上：配置里配过的表必须列出来，不能因为名字列表旧了就消失
    const wids = mergeWatchIds(watchNames, configured);
    if (!wids.length) return [];
    const nameOf = (wid) => ((watchNames || []).find((x) => x.watchId === String(wid)) || {}).name || '';
    const sub = (live, saved, defPort) => {
      const s = saved || {};
      if (live) {
        return { enabled: !!live.enabled, running: !!live.running, host: live.host, port: live.port, token: live.token || '' };
      }
      return { enabled: s.enabled !== false, running: false, host: s.host, port: s.port || defPort, token: s.token || '' };
    };
    return wids.map((wid) => {
      const has = !!configured[wid];
      const wc = device.normalizeOnebotWatch(configured[wid] || {});
      const inst = onebots.get(String(wid)) || null;
      const manual = (wc.targets || []).filter(Boolean);
      // 没配置过的表也预演一下自动匹配结果, 用户一进来就知道会收哪些会话
      const keys = onebotKeys.get(String(wid)) || (manual.length ? manual : autoKeysFor(wid));
      const rcSaved = wc.wsClient || {};
      const rcLive = inst ? inst.wsClient : null;
      return {
        watchId: wid,
        name: nameOf(wid),
        configured: has,
        enabled: !!wc.enabled,
        running: !!inst,
        clients: inst ? inst.clients() : 0,
        keys,
        auto: !manual.length,
        http: sub(inst && inst.http, wc.http, 0),
        ws: sub(inst && inst.ws, wc.ws, 0),
        wsClient: Object.assign({ enabled: false, url: '', token: '', reconnect: 5, connected: false, state: 'idle' },
          rcSaved,
          rcLive ? { enabled: rcLive.enabled, url: rcLive.url, token: rcLive.token, connected: rcLive.connected, state: rcLive.state } : null),
      };
    });
  }

  async function onebotStateAll() {
    // 顺带把可用会话带出去, 前端「只收这些会话」的多选要拿它做选项
    let targets = [];
    try { targets = (await loadChatTargets()) || []; } catch (e) { targets = []; }
    return Object.assign({}, onebotState(), {
      watches: await onebotWatchesState(),
      targets: targets.map((t) => ({ key: t.key, name: t.name, type: t.type })),
    });
  }

  // ===== 微聊 B 站点播 =====
  // 每块表单独开关 / 单独会话范围 / 单独限额。命令只在「那块表启用的会话」里生效:
  //   /搜索 关键词  → 回前 10 条, 带序号
  //   /播放 序号    → 下载上一条搜索里的第 N 条, 当视频消息发出去
  // 搜索结果按「手表 + 会话」隔离: 家庭群里搜的第 3 条, 不会串到单聊里被 /播放 3 拿去用。
  const BILI_SEARCH_TTL = biliBot.SEARCH_TTL;   // 搜索结果留 30 分钟, 过期要重新搜
  const BILI_MAX_RESULTS = biliBot.MAX_RESULTS; // 一次只给 10 条, 序号好记
  const BILI_BARE_TTL = 10 * 60 * 1000;    // 单聊里「搜完直接回个数字」的窗口, 10 分钟
  const biliSearchCache = new Map();        // `${watchId}|${chatKey}` -> { at, keyword, list }
  const biliChains = new Map();             // 同一会话串行, 免得连发 /播放 同时下几个大视频
  const biliQuota = new Map();              // watchId -> { day, n } 当天已点播条数
  const biliMissAt = new Map();             // chatKey -> 上次提醒「没开点播」的时间(防刷屏)
  const biliLastPlay = new Map();           // `${watchId}|${chatKey}` -> { bvid, title, at } 供 /评论 用

  // 某块表实际生效的会话范围(手选优先, 没手选就按手表名自动匹配)
  function biliScopeKeys(wid) {
    const c = (cfg.biliBots || {})[wid] || {};
    const manual = (c.targets || []).filter(Boolean);
    return manual.length ? manual.slice() : autoKeysFor(wid);
  }

  // 有没有任何一块表开了点播。没开就完全不去解析命令 ——
  // 否则用户正常聊天里说「搜索 xxx」会被这个功能抢走, 而它根本没启用
  function biliAnyEnabled() {
    const bots = cfg.biliBots || {};
    return Object.keys(bots).some((w) => bots[w] && bots[w].enabled);
  }

  // 这条会话归哪块表管: 遍历已启用的表, 谁的会话范围里有它就归谁
  //
  // 兜底: 只有一块表启用、但它一个会话都没匹配上(手表没名字 / 还没拉过会话列表)时,
  // 退化成「全都归它」。否则用户明明勾了开关却永远收不到反应, 比配错更难排查。
  // 多块表都启用时不猜 —— 猜错就会把 A 家的视频发到 B 家的群里。
  function biliWatchOf(key) {
    const bots = cfg.biliBots || {};
    const on = Object.keys(bots).filter((w) => bots[w] && bots[w].enabled);
    for (const wid of on) {
      if (biliScopeKeys(wid).indexOf(key) >= 0) return String(wid);
    }
    if (on.length === 1 && !biliScopeKeys(on[0]).length) return String(on[0]);
    return '';
  }

  // 把某块表的会话范围翻成人能看懂的名字
  function biliScopeText(wid) {
    const keys = biliScopeKeys(wid);
    if (!keys.length) return '';
    return keys.map((k) => {
      const t = (chatTargets || []).find((x) => x.key === k);
      if (!t) return k;
      return t.type === 'group' ? '家庭群' : ('单聊 · ' + (t.name || k));
    }).join('、');
  }

  // 命令解析出来了, 但这条会话不归任何启用的表 —— 必须回一句, 不能静默。
  // 同一个会话 1 分钟只提醒一次, 免得用户在群里连发几条被刷屏。
  function biliMissReply(key) {
    const last = biliMissAt.get(key) || 0;
    if (Date.now() - last < 60000) return;
    biliMissAt.set(key, Date.now());
    if (biliMissAt.size > 500) {
      const first = biliMissAt.keys().next();
      if (!first.done) biliMissAt.delete(first.value);
    }
    // 只有一块表启用时能把「现在到底在哪生效」说清楚, 用户一眼就知道差哪一步;
    // 多块表启用就不猜了, 用通用提示
    let msg = biliBot.OUT_OF_SCOPE;
    const on = Object.keys(cfg.biliBots || {}).filter((w) => cfg.biliBots[w] && cfg.biliBots[w].enabled);
    if (on.length === 1) {
      const s = biliScopeText(on[0]);
      if (s) {
        msg = '这条会话没开点播。现在只在「' + s + '」里生效，'
          + '去「我的 → B 站点播」把本会话也勾上再发一次。';
      }
    }
    biliReply(key, msg).catch(() => {});
  }

  async function biliReply(key, text) {
    try { await sendChat({ key, kind: 'text', text }); }
    catch (e) { log.warn('bili', '回复失败: ' + (e && e.message ? e.message : e)); }
  }

  // ===== B 站评论长图 =====
  // 抓评论 -> 排版 -> PNG。全程零依赖(见 bili-comment.js / canvas.js / png.js),
  // 所以云端那些没有 canvas 模块的 Linux 实例也能跑。
  //
  // SESSDATA 是**账号级**的(B 站登录 Cookie), 全局一份, 不按手表分:
  // 不填只能拿到热门的前 3 条评论(B 站对未登录请求就是这么回的), 填了才能翻页拿全。
  function biliCommentCfg() {
    return device.normalizeBiliComment(cfg.biliComment);
  }

  async function buildCommentImage(bvid) {
    const cc = biliCommentCfg();
    const data = await biliComment.fetchComments(bvid, {
      maxComments: cc.maxComments,
      sessdata: cc.sessdata,
      subLimit: 3,
    });
    const r = biliComment.renderComments(data, { maxHeight: cc.maxHeight });
    return { png: r.png, data, width: r.width, height: r.height, shown: r.shown };
  }

  // 图落盘 -> 走 sendChat 的 image 分支(和网页上手动发图同一条路径) -> 删临时文件
  // tag 只用来区分临时文件名, 出问题时一眼能看出是哪张图
  async function sendBiliPng(key, png, tag) {
    const file = path.join(os.tmpdir(),
      'bili_' + (tag || 'img') + '_' + Date.now() + '_' + process.pid + '.png');
    fs.writeFileSync(file, png);
    try {
      await sendChat({ key, kind: 'image', src: file });
    } finally {
      try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    }
  }

  function sendCommentPng(key, cmt) {
    return sendBiliPng(key, cmt.png, 'cmt');
  }

  async function sendCommentImage(key, bvid) {
    const cmt = await buildCommentImage(bvid);
    await sendCommentPng(key, cmt);
    return cmt;
  }

  // ===== B 站搜索结果图 =====
  // 一张图里带封面/标题/UP主/播放/弹幕/时长, 比十行文字好认得多。
  // 出图失败不影响搜索本身, 调用方会回退成文字列表。
  async function buildSearchImage(keyword, list) {
    const r = await biliSearch.renderSearch(list, { keyword });
    return { png: r.png, width: r.width, height: r.height, count: r.count };
  }

  async function biliHandle(wid, key, cmd) {
    const c = device.normalizeBiliWatch((cfg.biliBots || {})[wid] || {});
    if (cmd.kind === 'help') { await biliReply(key, biliBot.HELP); return; }

    if (cmd.kind === 'search') {
      if (!cmd.arg) { await biliReply(key, '用法：/搜索 视频名称\n例如：/搜索 小猪佩奇'); return; }
      // 先回一句「正在搜索」: B 站偶尔要两三秒, 没反馈会以为机器人没反应
      await biliReply(key, '[点播] 正在搜索「' + biliBot.clip(cmd.arg, 20) + '」…');
      let list;
      try {
        list = await bili.search(cmd.arg, { limit: BILI_MAX_RESULTS });
      } catch (e) {
        log.warn('bili', `手表 ${wid} 搜索「${cmd.arg}」失败: ` + e.message);
        await biliReply(key, '[点播] 搜索失败：' + e.message);
        return;
      }
      biliSearchCache.set(wid + '|' + key, { at: Date.now(), keyword: cmd.arg, list });
      // 简单封顶: 缓存按「表 × 会话」累积, 长期运行要给它一个上限, 超过就丢最早那条
      if (biliSearchCache.size > 200) {
        const first = biliSearchCache.keys().next();
        if (!first.done) biliSearchCache.delete(first.value);
      }
      log.info('bili', `手表 ${wid} 搜索「${cmd.arg}」得到 ${list.length} 条`);
      // 默认发图；关掉开关或出图失败就退回文字列表（文字列表永远可用，是兜底）
      if (c.searchImage) {
        try {
          const img = await buildSearchImage(cmd.arg, list);
          await sendBiliPng(key, img.png, 'search');
          log.info('bili', `手表 ${wid} 已发出搜索结果图 ${img.width}x${img.height}（${img.count} 条）`);
          return;
        } catch (e) {
          log.warn('bili', `手表 ${wid} 搜索结果图失败，回退文字列表: `
            + (e && e.message ? e.message : e));
        }
      }
      await biliReply(key, biliBot.formatList(cmd.arg, list));
      return;
    }

    // /评论 [序号|BV号] —— 单独把评论区画成长图发过来(点播时已经自动发过一张)
    if (cmd.kind === 'comments') {
      const arg = String(cmd.arg || '').trim();
      let bvid = '';
      if (arg) {
        if (/^BV[0-9A-Za-z]{8,12}$/i.test(arg)) {
          bvid = arg;
        } else {
          const idx = Number(arg.replace(/[^0-9]/g, ''));
          const hit2 = biliSearchCache.get(wid + '|' + key);
          const it2 = (idx && hit2 && Date.now() - hit2.at <= BILI_SEARCH_TTL)
            ? hit2.list.find((x) => x.index === idx) : null;
          if (it2) bvid = it2.bvid;
        }
      } else {
        const last = biliLastPlay.get(wid + '|' + key);
        // 2 小时内点播过的那个视频；再久就当用户不记得了，让他重新搜
        if (last && Date.now() - last.at < 2 * 3600e3) bvid = last.bvid;
      }
      if (!bvid) {
        await biliReply(key, '还没有可用的视频。先 /搜索 关键词 → /播放 序号，之后直接发 /评论 就行');
        return;
      }
      await biliReply(key, '[评论] 正在抓评论区并画长图，稍等…');
      try {
        const cmt = await sendCommentImage(key, bvid);
        log.info('bili', `手表 ${wid} 已发出评论长图 ${cmt.width}x${cmt.height}（画了 ${cmt.shown} 条）`);
      } catch (e) {
        log.warn('bili', `手表 ${wid} 评论长图失败: ` + (e && e.message ? e.message : e));
        await biliReply(key, '[评论] 生成失败：' + e.message);
      }
      return;
    }

    // /播放 序号
    const n = Number(String(cmd.arg).replace(/[^0-9]/g, ''));
    if (!n) { await biliReply(key, '用法：/播放 序号（要先 /搜索 关键词）'); return; }
    const hit = biliSearchCache.get(wid + '|' + key);
    if (!hit || Date.now() - hit.at > BILI_SEARCH_TTL) {
      await biliReply(key, '搜索结果已经过期了，先 /搜索 关键词 再挑序号');
      return;
    }
    const item = hit.list.find((x) => x.index === n);
    if (!item) { await biliReply(key, '没有第 ' + n + ' 条，刚才只搜到 ' + hit.list.length + ' 条'); return; }
    if (!biliBot.takeQuota(biliQuota, wid, c.maxPerDay)) {
      await biliReply(key, '今天的点播次数用完了（每天 ' + c.maxPerDay + ' 条），明天再来吧');
      return;
    }
    // 超过 30 秒会切成多段发, 先说明白 —— 否则用户看到一串视频会以为机器人在刷屏
    const segs = item.duration > VIDEO_MAX_SEC ? Math.ceil(item.duration / (VIDEO_MAX_SEC - 2)) : 0;
    await biliReply(key, '[点播] 第 ' + n + ' 条：' + biliBot.clip(item.title, 30) + '\n'
      + (segs > 1
        ? '这个视频 ' + bili.fmtDuration(item.duration) + '，超过 ' + VIDEO_MAX_SEC + ' 秒，'
          + '会切成约 ' + segs + ' 段发过来，稍等…'
        : '正在下载，稍等一下…')
      + (c.commentImage ? '\n先把评论区画成长图发过来。' : ''));

    // 评论长图和视频下载**并行**跑: 抓评论只要几百毫秒, 别让它排在几分钟的下载后面。
    // 抓失败不能影响看视频, 所以这里把错误吞成 null。
    let cmtPromise = null;
    if (c.commentImage) {
      cmtPromise = buildCommentImage(item.bvid).catch((e) => {
        log.warn('bili', `手表 ${wid} 抓第 ${n} 条评论失败(视频照发): `
          + (e && e.message ? e.message : e));
        return null;
      });
    }

    let v;
    try {
      v = await bili.downloadVideo(item, { maxDuration: c.maxDuration, maxBytes: c.maxBytes });
    } catch (e) {
      // 下载失败(超时长/超大小/拿不到直链)不该白占一个名额
      biliBot.refundQuota(biliQuota, wid);
      log.warn('bili', `手表 ${wid} 下载第 ${n} 条失败: ` + e.message);
      await biliReply(key, '[点播] 下载失败：' + e.message);
      return;
    }

    // 顺序要求: 先评论长图, 再视频。长图发失败也只是少一张图, 视频照发
    if (cmtPromise) {
      const cmt = await cmtPromise;
      if (cmt) {
        try {
          await sendCommentPng(key, cmt);
          log.info('bili', `手表 ${wid} 已发出评论长图 ${cmt.width}x${cmt.height}（画了 ${cmt.shown} 条）`);
        } catch (e) {
          log.warn('bili', '评论长图发送失败(视频照发): ' + (e && e.message ? e.message : e));
        }
      }
    }

    try {
      // 走 sendChat 的 video 分支: 上传 -> buildVideo -> 发送, 和网页上手动发视频同一条路径
      await sendChat({ key, kind: 'video', src: v.file, duration: v.duration });
      log.info('bili', `手表 ${wid} 点播第 ${n} 条已发出 ${Math.round(v.size / 1024)}KB ${v.quality}`);
      biliLastPlay.set(wid + '|' + key, { bvid: item.bvid, title: item.title, at: Date.now() });
      if (biliLastPlay.size > 200) {
        const first = biliLastPlay.keys().next();
        if (!first.done) biliLastPlay.delete(first.value);
      }
    } catch (e) {
      biliBot.refundQuota(biliQuota, wid);
      await biliReply(key, '[点播] 发送失败：' + e.message);
    } finally {
      // 上传完就把临时文件删掉, 不然几部片子下来磁盘就满了
      bili.cleanup(v);
    }
  }

  // 同一会话串行: 两条 /播放 并发会同时下两个大视频, 微聊那边也可能乱序
  function runBiliCommand(wid, key, cmd) {
    const id = wid + '|' + key;
    const prev = biliChains.get(id) || Promise.resolve();
    const p = prev.then(() => biliHandle(wid, key, cmd)).catch((e) => {
      log.warn('bili', '点播命令失败: ' + (e && e.message ? e.message : e));
    });
    biliChains.set(id, p);
    p.then(() => { if (biliChains.get(id) === p) biliChains.delete(id); });
  }

  // 点播也要「手表名 ↔ 会话」的对应关系, 和 OneBot 一样靠名字对, 得先把两边拉齐
  // 没配置过点播就整段跳过: 启动时不必为一个没用上的功能多打几次平台接口
  async function refreshBiliScope() {
    if (!Object.keys(cfg.biliBots || {}).length) return;
    await ensureWatchNames(false);
    // 用户可能还没打开微聊页, 那时 chatTargets 是 null, 自动匹配会一律返空
    try { await loadChatTargets(); } catch (e) { /* 拉不到就让用户去设置里手选会话 */ }
  }

  async function biliState() {
    await refreshBiliScope();
    // 界面要按手表列出(没配置过的表也得能选), 所以手表名在这里无论如何都要拉一次
    await ensureWatchNames(false);
    let targets = [];
    try { targets = (await loadChatTargets()) || []; } catch (e) { targets = []; }
    const conf = cfg.biliBots || {};
    // 并集：配置里有的表即使这次没从平台拉到名字，也要列出来（否则它会「消失」）
    const wids = mergeWatchIds(watchNames, conf);
    const nameOf = (wid) => ((watchNames || []).find((x) => x.watchId === String(wid)) || {}).name || '';
    return {
      watches: wids.map((wid) => {
        const c = device.normalizeBiliWatch(conf[wid] || {});
        const manual = (c.targets || []).filter(Boolean);
        return {
          watchId: wid,
          name: nameOf(wid),
          configured: !!conf[wid],
          enabled: !!c.enabled,
          // 没配置过的表也预演一下自动匹配结果, 用户一进来就知道会管哪些会话
          keys: manual.length ? manual : autoKeysFor(wid),
          auto: !manual.length,
          maxDuration: c.maxDuration,
          maxBytes: c.maxBytes,
          maxPerDay: c.maxPerDay,
          commentImage: c.commentImage,
          searchImage: c.searchImage,
        };
      }),
      targets: targets.map((t) => ({ key: t.key, name: t.name, type: t.type })),
      // 评论长图的全局设置。sessdata 是敏感 Cookie, 界面上用密码框显示, 但既然本机
      // 服务已经要访问令牌了, 这里照实返回, 否则用户改不了自己填过的值
      comment: biliCommentCfg(),
    };
  }

  // ===== 主页仪表盘: 系统/进程资源 =====
  // CPU 占用率要两次采样求差, 第一次采样在服务启动时就做, 保证首个请求也有基线
  function cpuTimes() {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      const t = c.times || {};
      idle += t.idle || 0;
      total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
    }
    return { idle, total };
  }
  let cpuPrev = cpuTimes();
  let sysWatchTryAt = 0;

  // 系统 CPU 占用(%): 距上次调用的区间使用率
  function cpuPercent() {
    const cur = cpuTimes();
    const dt = cur.total - cpuPrev.total;
    const di = cur.idle - cpuPrev.idle;
    cpuPrev = cur;
    if (dt <= 0) return null;
    return Number(Math.max(0, Math.min(100, (1 - di / dt) * 100)).toFixed(1));
  }

  // 本进程 CPU 占用(%): 相对单核, 多核跑满可超过 100
  let procPrev = { usage: process.cpuUsage(), at: Date.now() };
  function procCpuPercent() {
    const now = Date.now();
    const u = process.cpuUsage();
    const dUs = (u.user - procPrev.usage.user) + (u.system - procPrev.usage.system);
    const dMs = now - procPrev.at;
    procPrev = { usage: u, at: now };
    if (dMs <= 0) return null;
    return Number((dUs / 1000 / dMs * 100).toFixed(1));
  }

  async function sysInfo() {
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const mu = process.memoryUsage();
    const cpus = os.cpus() || [];
    // 主页是登录后第一屏, 缓存为空时补拉一次(内部有 60s 缓存, 不会被 3s 轮询打穿)
    // 拉取失败要节流, 否则未登录/断网时每 3 秒都会打一次服务器
    let watches = cache.list;
    if ((!watches.length || Date.now() - cache.at >= 60000) && cfg.token && Date.now() - sysWatchTryAt > 30000) {
      sysWatchTryAt = Date.now();
      try { watches = await watchList(); } catch (e) { /* 保留上次快照 */ }
    }
    return {
      now: Date.now(),
      system: {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        hostname: os.hostname(),
        cpuModel: String((cpus[0] && cpus[0].model) || '').replace(/\s+/g, ' ').trim(),
        cpuCores: cpus.length,
        cpuPercent: cpuPercent(),
        loadavg: os.loadavg().map((x) => Number(x.toFixed(2))),
        memTotal,
        memUsed: memTotal - memFree,
        memPercent: memTotal ? Number((((memTotal - memFree) / memTotal) * 100).toFixed(1)) : null,
        uptime: os.uptime(),
      },
      process: {
        pid: process.pid,
        node: process.version,
        arch: process.arch,
        cpuPercent: procCpuPercent(),
        rss: mu.rss,
        heapUsed: mu.heapUsed,
        heapTotal: mu.heapTotal,
        external: mu.external,
        uptime: process.uptime(),
      },
      account: {
        userName: cfg.userName || '',
        loggedIn: !!cfg.token,
        mobileId: cfg.mobileId || '',
        imConnected: !!(im && im.connected),
        onebotRunning: onebots.size > 0,
        watchCount: watches.length,
        watches: watches.map((w) => ({
          watchId: w.watchId,
          name: w.name || w.watchId,
          model: w.model || '',
          battery: w.battery != null ? w.battery : null,
          online: w.onlineStatus,
        })),
      },
    };
  }

  // ===== 每日一言(tenapi 主源 -> hitokoto 备源 -> 内置词库兜底) =====
  const YIYAN_FALLBACK = [
    { text: '生活明朗，万物可爱。', from: '', author: '' },
    { text: '慢慢来，比较快。', from: '', author: '' },
    { text: '心之所向，素履以往。', from: '《尘曲》', author: '七堇年' },
    { text: '愿你出走半生，归来仍是少年。', from: '', author: '' },
    { text: '所有的努力都不会白费，只是回报的时间不确定。', from: '', author: '' },
    { text: '保持热爱，奔赴山海。', from: '', author: '' },
    { text: '把日子过成诗，把生活过成画。', from: '', author: '' },
    { text: '星光不问赶路人，时光不负有心人。', from: '', author: '' },
    { text: '与其感慨路难行，不如马上出发。', from: '', author: '' },
    { text: '今天的太阳很大，适合晒一晒心情。', from: '', author: '' },
    { text: '山有峰顶，海有彼岸，漫漫长途终有回转。', from: '', author: '' },
    { text: '世界很大，开心第一。', from: '', author: '' },
    { text: '不必仰望别人，自己亦是风景。', from: '', author: '' },
    { text: '岁月不居，时节如流。', from: '《论盛孝章书》', author: '孔融' },
    { text: '愿你所行皆坦途，所遇皆温柔。', from: '', author: '' },
    { text: '晴天的意义，在于让人想出门走走。', from: '', author: '' },
    { text: '认真生活的人，运气都不会太差。', from: '', author: '' },
    { text: '人生如逆旅，我亦是行人。', from: '《临江仙》', author: '苏轼' },
    { text: '日拱一卒，功不唐捐。', from: '', author: '' },
    { text: '愿有岁月可回首，且以深情共白头。', from: '', author: '' },
    { text: '不驰于空想，不骛于虚声。', from: '', author: '李大钊' },
    { text: '把喜欢的事做到极致，就是价值。', from: '', author: '' },
    { text: '心存善意，定能途遇天使。', from: '《龙猫》', author: '宫崎骏' },
    { text: '半山腰太挤了，去山顶看看吧。', from: '', author: '' },
    { text: '一蓑烟雨任平生。', from: '《定风波》', author: '苏轼' },
    { text: '热爱可抵岁月漫长。', from: '', author: '' },
    { text: '好好吃饭，好好睡觉，好好生活。', from: '', author: '' },
    { text: '愿你成为自己的太阳，无需凭借谁的光。', from: '', author: '' },
    { text: '温柔半两，从容一生。', from: '', author: '' },
    { text: '所有的不期而遇，都是蓄谋已久的欢喜。', from: '', author: '' },
  ];

  let yiyanCache = null;
  let yiyanFailAt = 0; // 主源失败后冷却 10 分钟, 避免每次进主页都卡 6 秒

  // 极简 JSON 请求(只用内置 http/https, 不引依赖)
  function httpJson(url, opt) {
    const o = opt || {};
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (e) { reject(new Error('地址不合法')); return; }
      const lib = u.protocol === 'http:' ? http : https;
      const body = o.body || null;
      const headers = {
        'User-Agent': 'JZClientForNode/1.0 (+https://github.com/laolibuhuifei/JZClient-for-node)',
        Accept: 'application/json,text/plain,*/*',
      };
      if (body) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: o.method || 'GET',
        headers,
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          buf += d;
          if (buf.length > 256 * 1024) req.destroy(new Error('响应过大'));
        });
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('返回的不是 JSON: ' + buf.slice(0, 40))); }
        });
      });
      req.on('error', reject);
      req.setTimeout(o.timeout || 6000, () => req.destroy(new Error('请求超时')));
      if (body) req.write(body);
      req.end();
    });
  }

  // ===== 云端更新提示 =====
  //
  // 只有托管实例才有这套：平台注入 JZ_CONSOLE_URL（平台地址）、INSTANCE_SECRET
  // （实例密钥）、JZ_SUBDOMAIN（实例标识）。本地直接跑的时候这三个都没有，
  // 整块静默跳过 —— 不能因为「本地版没有平台」就报错或弹窗。
  //
  // 认证靠实例密钥做 HMAC：sign = HMAC-SHA256(secret, `${sub}\n${ts}`)。
  // 平台按 subdomain 查到实例、解出自己那份密钥再验一遍，
  // 所以外面的人知道接口地址也调不动（没有密钥）。
  //
  // 结果缓存 10 分钟：一个用户可能开好几个标签页，不能每页都去打一次平台。
  const updateState = { at: 0, data: null };

  function updateCfg() {
    const base = String(process.env.JZ_CONSOLE_URL || '').trim().replace(/\/+$/, '');
    const sub = String(process.env.JZ_SUBDOMAIN || '').trim();
    const sec = String(process.env.INSTANCE_SECRET || '');
    if (!base || !sub || !sec) return null;
    return { base, sub, sec };
  }

  function updateSign(c, ts) {
    return crypto.createHmac('sha256', c.sec).update(c.sub + '\n' + String(ts)).digest('hex');
  }

  // 问平台：有新版吗？日志是什么？强制吗？
  async function checkUpdate(force) {
    const c = updateCfg();
    if (!c) return { managed: false };
    if (!force && updateState.data && Date.now() - updateState.at < 10 * 60 * 1000) {
      return Object.assign({ managed: true, cached: true }, updateState.data);
    }
    const ts = Date.now();
    const url = c.base + '/api/instance/update-info?sub=' + encodeURIComponent(c.sub)
      + '&ts=' + ts + '&sign=' + updateSign(c, ts);
    try {
      const j = await httpJson(url, { timeout: 6000 });
      // 平台有两种返回形状：{ok, latest, ...}（老）和 {ok, data:{latest, ...}}（新）。
      // 2026-11-10 之前这里只读 j.data，而平台当时就是平铺的 —— 每台实例都拿到
      // 一个空对象，hasUpdate 永远 undefined，更新弹窗从来没弹出来过。
      // 现在两种都认，平台再改形状也不会又瞎一次。
      const d = (j && j.data && typeof j.data === 'object') ? j.data : (j || {});
      updateState.at = Date.now();
      updateState.data = d;
      // 打一行就够：以后用户说「没弹窗」，看这条日志立刻知道是没新版、
      // 还是平台没给对、还是前端跳过了，不用再逐层猜。
      if (log.isEnabled('debug')) {
        log.debug('update', `查更新 latest=${d.latest || '-'} running=${d.running || '-'}`
          + ` hasUpdate=${d.hasUpdate} force=${d.force}`);
      }
      return Object.assign({ managed: true }, d);
    } catch (e) {
      // 平台暂时连不上（重启中、网络抖动）不算错误，安静返回上一次的结果
      if (log.isEnabled('debug')) log.debug('update', '查更新失败：' + e.message);
      return Object.assign({ managed: true, error: e.message }, updateState.data || {});
    }
  }

  // 点了「更新并重启」→ 让平台重启这个实例（新进程自然加载新代码）
  async function applyUpdate() {
    const c = updateCfg();
    if (!c) throw new Error('本地运行，没有可更新的平台');
    const ts = Date.now();
    const url = c.base + '/api/instance/apply-update?sub=' + encodeURIComponent(c.sub)
      + '&ts=' + ts + '&sign=' + updateSign(c, ts);
    const j = await httpJson(url, { method: 'POST', timeout: 8000 });
    if (!j || j.ok === false) throw new Error((j && (j.error || j.message)) || '平台拒绝了更新请求');
    return j.data || j;
  }

  async function fetchYiyan(force) {
    const now = Date.now();
    if (!force && yiyanCache && now - yiyanCache.at < 24 * 3600 * 1000) return yiyanCache;
    // 主源: 用户指定的 tenapi
    if (now - yiyanFailAt > 10 * 60 * 1000) {
      try {
        const j = await httpJson('https://tenapi.cn/v2/yiyan', { method: 'POST', body: 'format=json' });
        const d = j && j.data;
        if (d && d.hitokoto) {
          yiyanCache = {
            text: String(d.hitokoto),
            from: d.source || '',
            author: d.author || '',
            cat: d.catname || '',
            at: now,
            upstream: 'tenapi',
          };
          return yiyanCache;
        }
        throw new Error('返回格式不对');
      } catch (e) {
        yiyanFailAt = now;
        log.warn('yiyan', 'tenapi 不可用, 已切备用源: ' + (e && e.message ? e.message : e));
      }
    }

    // 备源: hitokoto 官方
    try {
      const j = await httpJson('https://v1.hitokoto.cn/?encode=json&charset=utf-8');
      if (j && j.hitokoto) {
        yiyanCache = {
          text: String(j.hitokoto),
          from: j.from || '',
          author: j.from_who || '',
          cat: j.type || '',
          at: now,
          upstream: 'hitokoto',
        };
        return yiyanCache;
      }
    } catch (e) {
      log.warn('yiyan', 'hitokoto 不可用: ' + (e && e.message ? e.message : e));
    }

    // 兜底: 内置词库, 按天轮换(至少保证页面上有一句话)
    const q = YIYAN_FALLBACK[Math.floor(now / 86400000) % YIYAN_FALLBACK.length];
    yiyanCache = { text: q.text, from: q.from, author: q.author, cat: '', at: now, upstream: 'local' };
    return yiyanCache;
  }

  // ===== 公告: 拉取项目官方公告服务(客户端只负责渲染) =====
  // 地址写死在 site.config.js, 不开放给用户配置 —— 这是作者发布通知的地方
  let noticeCache = { at: 0, list: [] };
  const NOTICE_BASE = String((SITE.notice && SITE.notice.baseUrl) || '').replace(/\/+$/, '');
  const NOTICE_TTL = Math.max(1, Number((SITE.notice && SITE.notice.cacheMinutes) || 10)) * 60000;

  async function fetchNotices(force) {
    if (!NOTICE_BASE) return { enabled: false, configured: false, notices: [], fetchedAt: 0 };
    if (!force && noticeCache.at && Date.now() - noticeCache.at < NOTICE_TTL) {
      return { enabled: true, configured: true, notices: noticeCache.list, fetchedAt: noticeCache.at, cached: true };
    }
    try {
      const j = await httpJson(NOTICE_BASE + '/api/notices', { timeout: 6000 });
      const list = j && j.data && Array.isArray(j.data.notices) ? j.data.notices : [];
      noticeCache = { at: Date.now(), list };
      return { enabled: true, configured: true, notices: list, fetchedAt: noticeCache.at };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      log.warn('notice', '公告服务不可用: ' + msg);
      // 拉不到就退回上一次缓存; 连缓存都没有就返回空, 前端会静默隐藏公告卡
      return { enabled: true, configured: true, notices: noticeCache.list, fetchedAt: noticeCache.at, error: msg };
    }
  }

  // 公告正文里的站内相对地址(/uploads/x.png)补上公告服务地址。
  // 不补的话, 在手机上打开 WebUI 时会去连客户端自己的地址, 图片全是裂的。
  function absNoticeUrls(md, base) {
    if (!base) return md;
    return String(md == null ? '' : md).replace(/\]\((\/(?!\/)[^)\s]*)/g, (m, p) => '](' + base + p);
  }

  async function fetchNotice(id) {
    const base = NOTICE_BASE;
    if (!base) throw new Error('公告服务地址未配置');
    const j = await httpJson(base + '/api/notices/' + encodeURIComponent(id), { timeout: 6000 });
    const n = j && j.data && j.data.notice;
    if (!n) throw new Error('公告不存在或已被删除');
    return Object.assign({}, n, { content: absNoticeUrls(n.content, base) });
  }

  // ===== AI 助手状态 =====
  // aiRunning 只表示「这一轮进程里是否在听」，真正的开关状态存在 cfg.ai.autoStart，
  // 启动时按它自动恢复（以前只活在内存里，重启服务就变回停止，看着像「AI 坏了」）
  let aiRunning = false;
  const aiHistory = new Map();
  const aiChains = new Map();
  // 「会话没启用」这条提示的限流时间戳（避免家庭群之类未勾选会话刷屏）
  const aiSkipLog = { at: 0 };

  function pushChat(key, msg) {
    const list = chatLog.get(key) || [];
    list.push(msg);
    if (list.length > 200) list.splice(0, list.length - 200);
    chatLog.set(key, list);
  }

  function resolveChatKey(m) {
    return matchChatKey(chatTargets, m);
  }

  function agreeTypeFromSource(src) {
    const map = { 0: 'remote', 1: 'recommend', 2: 'recommendAudit', 3: 'interphone', 4: 'classGroup', 7: 'blueToothAudit', 8: 'geniusNumber' };
    return map[Number(src)] || String(src);
  }

  // ===== AI 自动回复 =====
  //
  // 优化/修复：anjianhe (https://github.com/anjianhe)
  //
  // 会话匹配和关键词匹配的纯逻辑都在 ai-trigger.js（不碰网络，可以直接单测）。
  // 这里只负责把运行时对象（chatTargets / im / cfg）喂进去。
  //
  // 旧实现有两个坑，都是「面板能看见消息、AI 一声不吭」的元凶：
  //   1. findAiSession 只认 receiverId === m.imAccountId，而且用 Number() 比较。
  //      可归档用的 resolveChatKey() 是 receiverId === imAccountId || receiverId === dialogId。
  //      服务端下发时 tag10/tag11 谁在前会随固件和网关版本变，两套规则就劈叉了。
  //   2. 关键词只做 toLowerCase + includes，全角数字、零宽字符、前后空白全不管。
  //      手表输入法把半角发成全角时，界面上看着一模一样，匹配却永远失败。
  //
  // 现在：会话统一按 chatKey 判定（和聊天面板同源），关键词统一先归一化再匹配。
  function aiSessionOf(m, chatKey) {
    const target = (chatTargets || []).find((x) => x.key === chatKey) || null;
    const sess = aiTrigger.matchSession(cfg.ai.sessions, {
      chatKey: chatKey || '',
      dialogId: m.dialogId,
      imAccountId: m.imAccountId,
      selfId: (im && im.imAccountId) || cfg.imAccountId || '',
      peers: target ? (target.peers || []) : [],
    });
    return { sess, target };
  }

  // 返回 { hit, keyword, how }：auto 模式恒命中；keyword 模式按归一化后的前缀/词边界判断
  function aiShouldTrigger(text) {
    const a = cfg.ai;
    if (a.trigger !== 'keyword') return { hit: true, keyword: null, how: 'auto' };
    return aiTrigger.matchKeyword(text, a.keywords, a.keywordsMode);
  }

  // 自动启动 AI（启动阶段和改完配置后都可能用到，失败只告警不阻断）
  // 优化/修复：anjianhe —— 启动状态以前只在内存里，重启服务就变回停止，看着像功能坏了
  async function startAiAuto(reason) {
    const rt = aiRuntime();
    if (!rt.baseUrl) {
      log.warn('ai', `跳过自动启动（${reason}）：没有可用的接口地址`
        + (AI_MANAGED ? '，托管模式下检查 JZ_AI_BASE_URL 有没有注入' : '，请在「接口配置」里填'));
      return false;
    }
    if (!cfg.ai.sessions || !cfg.ai.sessions.length) {
      log.warn('ai', `跳过自动启动（${reason}）：没有启用任何会话`);
      return false;
    }
    await ensureIM();
    aiRunning = true;
    log.info('ai', `已自动启动（${reason}）model=${rt.model || '(默认)'} `
      + `trigger=${cfg.ai.trigger || 'auto'} keywords=${(cfg.ai.keywords || []).length} `
      + `sessions=${cfg.ai.sessions.length} vision=${cfg.ai.vision !== false ? 'on' : 'off'} managed=${AI_MANAGED}`);
    return true;
  }

  function chatKeyOfSession(sess) {
    if (!chatTargets) return null;
    const t = chatTargets.find((x) => (sess.type === 'group'
      ? x.type === 'group' && String(x.dialogId) === String(sess.dialogId)
      : x.type === 'single' && String(x.receiverId) === String(sess.receiverId)));
    return t ? t.key : null;
  }

  // 单聊会话的接收方 id。老配置里可能只有 key（s:<id>）没有 receiverId，
  // 以前直接拿 sess.receiverId 去发，空值会让发送端在参数校验处静默失败。
  // 优化/修复：anjianhe
  function receiverOfSession(sess) {
    if (sess && sess.receiverId != null && sess.receiverId !== '') return sess.receiverId;
    const k = aiTrigger.sessionKeyOf(sess);
    return k.indexOf('s:') === 0 ? k.slice(2) : '';
  }

  // 图片消息的占位正文。图片本身走 image_url part，文字只负责「这是一张图」这件事，
  // 让模型知道该看图而不是去理解这句占位符。
  const IMAGE_PLACEHOLDER = '（发来一张图片，请看看是什么）';

  function queueAiReply(sess, text, imageUrl) {
    // 托管模式下 aiRuntime() 会换成平台的网关地址和实例令牌，
    // 其余字段（temperature / 提示词）还是用户自己配的
    const a = aiRuntime();
    // 串行链的 key 用会话 key 兜底：老配置没有 sess.key 时不会退化成「所有会话共用一条链」
    const chainKey = aiTrigger.sessionKeyOf(sess) || String(sess.key || 'default');
    const prev = aiChains.get(chainKey) || Promise.resolve();
    const p = prev.then(async () => {
      try {
        // 发送目标必须是**整数**：im.js 的 tlv() 对 number 走大端整数编码，对 string 走 UTF-8。
        // 这里如果传字符串，服务端认不出接收方，AI 会「生成了回复但一直发送失败」。
        // （这是我们自己踩过的坑，修复：anjianhe）
        const rawId = sess.type === 'group' ? sess.dialogId : receiverOfSession(sess);
        if (rawId == null || rawId === '') {
          throw new Error('会话没有可用的接收方 id（配置里缺 receiverId / dialogId）');
        }
        const to = aiTrigger.toImId(rawId);

        // 有图就先把图读成 data URL。失败不算致命：正文还在就按纯文本答，
        // 正文也没有（纯图片消息）就只能放弃 —— 但日志里要说清是哪一步没成
        let dataUrl = '';
        if (imageUrl) {
          const got = await vision.toDataUrl(imageUrl, { maxBytes: a.visionMaxBytes });
          if (got.ok) {
            dataUrl = got.dataUrl;
            log.debug('ai', `图片已读取 ${got.mime} ${got.bytes} 字节 ${got.ms}ms`);
          } else {
            log.warn('ai', `图片读取失败(${got.reason})，本条按纯文本处理: ${String(imageUrl).slice(0, 120)}`);
          }
        }
        const bodyText = String(text || '').trim();
        if (!dataUrl && !bodyText) throw new Error('图片读不出来，这条没有可回复的内容');

        // 系统提示词：带图时追加 visionPrompt（用户可改），告诉模型该怎么用图
        const sys = [a.systemPrompt || ''];
        if (dataUrl && a.visionPrompt) sys.push(String(a.visionPrompt));
        const sysText = sys.filter(Boolean).join('\n');

        // 多模态 user 消息：文字在前、图在后（和主流网关的示例顺序一致）
        const userContent = dataUrl
          ? [{ type: 'text', text: bodyText || IMAGE_PLACEHOLDER }, { type: 'image_url', image_url: { url: dataUrl } }]
          : bodyText;

        const h = aiHistory.get(chainKey) || [];
        const msgs = [{ role: 'system', content: sysText }]
          .concat(h)
          .concat([{ role: 'user', content: userContent }]);
        const reply = await aiChat(a, msgs);

        // 历史里只留文字：base64 一张图就几 MB，攒几轮内存和 token 一起爆，
        // 而且下一轮再带一遍图对回答没有任何帮助
        const histUser = dataUrl
          ? (bodyText ? bodyText + ' ' : '') + '[发来一张图片]'
          : bodyText;
        const nh = h.concat([{ role: 'user', content: histUser }, { role: 'assistant', content: reply }]);
        if (nh.length > 20) nh.splice(0, nh.length - 20);
        aiHistory.set(chainKey, nh);

        const c = await ensureIM();
        const r = sess.type === 'group'
          ? await c.sendGroupText(to, c.imAccountId, reply)
          : await c.sendText(to, reply);
        log.info('ai', `回复已发送 ${chainKey} ${r && r.ok ? 'OK' : '失败'} 长度=${String(reply).length}`
          + (dataUrl ? ' 含图' : ''));
        const key = chatKeyOfSession(sess);
        if (key) pushChat(key, { self: true, text: '[AI] ' + reply + (r && r.ok ? '' : '（发送失败）'), time: Date.now() });
      } catch (e) {
        // 以前这里只在页面上塞一句「[AI 出错]」，终端日志完全看不到原因，
        // 用户只能猜。模型名写错、key 过期、reasoner 只回思考不回正文都出在这里。
        const msg = e && e.message ? e.message : String(e);
        log.warn('ai', `回复失败 ${chainKey}: ` + msg);
        const key = chatKeyOfSession(sess);
        if (key) pushChat(key, { self: true, text: '[AI 出错] ' + msg, time: Date.now() });
      }
    });
    aiChains.set(chainKey, p);
  }

  // IM 业务推送类型: 只用于更新本地状态, 不展示在聊天列表
  // 注意: 27 在新式信封(msgNewType=27)下是 relay_video 视频转发, 属于聊天消息;
  // 电量上报是顶层 body.type=27 且 content 为 JSON {battery:..} 且没有 msgNewType 的旧式推送
  function parsePushContent(b) {
    if (b.content == null) return null;
    if (typeof b.content === 'object') return b.content;
    try { return JSON.parse(b.content); } catch (e) { return null; }
  }

  // 判断业务推送: 必须是旧式消息(无 msgNewType), 否则即使是同号类型也是聊天
  function isBusinessMessage(m) {
    const b = m.body || {};
    if (!b || typeof b !== 'object') return false;
    // 新式信封: msgNewType 存在, 属于聊天消息(文本/表情/图片/语音/视频/位置/转发等)
    if (b.msgNewType != null && Number(b.msgNewType) > 0) return false;
    // ⚠️ 带会话信息(dialogId / imAccountId)的一定是聊天消息。
    // 业务推送是账号级的, 没有会话。以前只看 contentType>=1000 就判业务推送,
    // 手表发来的 contentType=1000 的消息会被整条丢掉, 用户侧表现为「收不到手表消息」。
    if (m.dialogId || m.imAccountId) return false;
    // 老式业务推送: body.type 是通知类型, content 一般是字符串 JSON
    const t = Number(b.type);
    if (t === 27) { // 电量
      const c = parsePushContent(b);
      return !!(c && c.battery != null);
    }
    if (t === 88) { // 好友申请
      const c = parsePushContent(b);
      return !!(c && c.friendId);
    }
    if (t === 30 || t === 35 || t === 47) return true; // 宝贝资料/绑定关系/基础信息
    if (t === 11031 || t === 39000010) { // 位置
      const c = parsePushContent(b);
      return !!(c && (c.latitude != null || c.longitude != null));
    }
    // contentType >= 1000 或 body.type >= 1000 的是服务端通知
    if (m.contentType >= 1000) return true;
    if (t >= 1000 && typeof b.content === 'string') return true;
    return false;
  }

  function handleBusinessPush(m) {
    const b = m.body || {};
    const type = Number(b.type);
    const wid = b.watchId || m.watchId || '';
    if (!wid) return;
    const o = parsePushContent(b);
    // 仅记录平台通知的本地接收时间；通知可能延迟或由平台生成，不能证明设备在线。
    // 同一条通知合并写盘，避免重复保存配置。
    const now = Date.now();

    // 27 = 电量提醒 { battery }
    if (type === 27 && o && o.battery != null) {
      setWatchStatus(wid, { lastSeenAt: now, battery: Number(o.battery), batteryAt: now });
      return;
    }
    // 11031 位置通知 / 39000010 实时位置动态
    if ((type === 11031 || type === 39000010) && o && (o.latitude != null || o.longitude != null)) {
      setWatchStatus(wid, {
        lastSeenAt: now,
        lastLat: o.latitude,
        lastLng: o.longitude,
        lastAddress: o.poiNew || o.descNew || '',
        lastLocAt: o.createTime || o.locationPushTime || now,
      });
      return;
    }
    // 30 宝贝资料 / 35 绑定关系 / 47 宝贝基础信息: 标记需要刷新
    if (type === 30 || type === 35 || type === 47) {
      setWatchStatus(wid, { lastSeenAt: now, needRefresh: true });
      return;
    }
    // 其它平台通知只记录接收时间，不推断手表在线。
    setWatchStatus(wid, { lastSeenAt: now });
  }

  function setWatchStatus(wid, patch) {
    cfg.watchStatus = cfg.watchStatus || {};
    cfg.watchStatus[wid] = Object.assign({}, cfg.watchStatus[wid] || {}, patch);
    watchStatusRevision++;
    cache.at = 0; // 推送变更后不能继续使用旧的手表列表快照
    device.save(cfg);
  }

  // 会话列表还没拉到时进来的消息会被丢掉, 用这个计数做限流告警
  const lastDropWarn = { at: 0, n: 0 };
  // 「消息对不上会话 → 顺手刷一次列表」的限流。
  // 不能每次都刷：如果某个会话的 ID 永远对不上（服务端换了 ID 形态），
  // 那每来一条消息就打一次接口，等于拿平台当轮询目标。
  const lastRefreshTry = { at: 0 };

  function onImMessage(m, suppressAuto) {
    const b = m.body || {};
    const type = Number(b.type);
    const biz = isBusinessMessage(m);
    if (log.isEnabled('debug')) {
      try {
        log.debug('im', 'recv ' + JSON.stringify({
          source: m.source, msgType: m.msgType, contentType: m.contentType,
          bodyType: b.type, msgNewType: b.msgNewType, textMsgType: b.textMsgType,
          dialogId: m.dialogId, imAccountId: m.imAccountId, createTime: m.createTime,
          msgId: m.msgId, biz,
          // 判成业务推送时把原文一起打出来, 否则「消息被丢掉」这件事在日志里完全看不出来
          body: biz ? String(JSON.stringify(b)).slice(0, 400) : undefined,
        }));
      } catch (e) { /* ignore */ }
    }

    // 自动同意好友(好友申请也属于业务消息, 不进聊天列表)
    if (!suppressAuto && type === 88 && b.content) {
      const wid = b.watchId || '';
      if ((cfg.autoAgreeWatchIds || []).includes(wid)) {
        try {
          const p = parsePushContent(b);
          if (p && p.friendId) {
            api.agreeFriendApply(wid, p.friendId, agreeTypeFromSource(p.source), p.verification).catch(() => {});
          }
        } catch (e) { /* ignore */ }
      }
    }

    // 业务推送: 更新电量/位置等状态后直接丢弃, 不写入聊天
    if (biz) {
      // 历史业务帧不得把旧电量或位置写成刚收到的新状态。
      if (!suppressAuto) handleBusinessPush(m);
      return;
    }

    // 自己发的消息不当成收到的处理。两边都转字符串再比：以前是严格 ===，
    // 一个环境里 imAccountId 是数字、另一个是字符串时，自己发的会被当成对方发的，
    // AI 就会自己跟自己聊起来。（修复：anjianhe）
    const selfImId = im && im.imAccountId != null ? String(im.imAccountId) : '';
    const msgImId = m.imAccountId != null ? String(m.imAccountId) : '';
    if (selfImId && msgImId && selfImId === msgImId) return;
    const parsed = parseMessage(m.msgType, m.raw);
    const text = describe(parsed);
    // 调试: 表情消息记录 inner 字段, 便于确认字段名
    if (log.isEnabled('debug') && (parsed.kind === 'emoji' || parsed.kind === 'kaomoji')) {
      try { log.debug('im', 'emoji ' + JSON.stringify(parsed.inner || parsed.body).slice(0, 300)); } catch (e) { /* ignore */ }
    }

    // 统一取「可读正文」：聊天面板能显示出来的文字，命令解析和 AI 都必须拿得到。
    // 旧代码这里只认 parsed.kind === 'text' && parsed.text，而部分固件把正文放在
    // 信封内层（msgNewContent），describe() 能找到、parsed.text 却是空串 —— 于是
    // 「B 站点播没反应」和「AI 不触发」会一起出现。现在两处吃同一份正文。
    // 修复：anjianhe
    const bodyText = aiTrigger.aiTextOf(parsed, text);

    // 图片消息：正文恒为空（describe 只给出「[图片 640x480] https://…」这种装饰文本），
    // 但只要有 URL 就能交给多模态模型看。vision 关掉时退回老行为（直接跳过）。
    const isImg = aiTrigger.isImageKind(parsed.kind);
    const imgUrl = isImg ? mediaUrl(parsed) : '';

    // 会话 key 提前算: B 站点播命令要按会话判断归属, 命中后也不能再让 AI 抢答一遍。
    // 用 text || bodyText 判空：describe 给不出的正文，bodyText 可能给得出。
    const key = (text || bodyText) ? resolveChatKey(m) : null;
    // 没开点播就完全不解析命令 —— 这个功能没配置时必须彻底静默
    const biliOn = biliAnyEnabled();
    let biliCmd = (biliOn && key && bodyText) ? biliBot.parseCommand(bodyText) : null;
    let biliWid = biliCmd ? biliWatchOf(key) : '';
    // 单聊里搜完直接回一个数字也算「播放第 N 条」: 列表就摆在上面, 让人再敲一遍
    // /播放 太别扭。只在单聊生效(群里说个数字太容易误触), 10 分钟内有效。
    if (biliOn && !biliCmd && key && /^s:/.test(key) && bodyText) {
      const bare = String(bodyText).trim();
      if (/^\d{1,2}$/.test(bare)) {
        const wid = biliWatchOf(key);
        const hit = wid ? biliSearchCache.get(wid + '|' + key) : null;
        if (hit && Date.now() - hit.at < BILI_BARE_TTL) {
          biliCmd = { kind: 'play', arg: bare };
          biliWid = wid;
        }
      }
    }

    // AI 自动回复(点播命令归点播机器人管, 范围外的点播命令也不让 AI 答, 免得两边抢话)
    //
    // 这段以前是「静默失败」重灾区：条件不满足就什么都不打印，用户只能干瞪眼，
    // 日志里连「为什么没触发」都看不到。现在每一层不通过都留痕：
    //   - 没文本（消息类型不是文本，或正文只存在于信封内层）→ debug
    //   - 会话没勾选 → info，并把当前启用的会话 key 一起打出来，方便对照
    //   - 关键词没命中 → info，打出归一化后的关键词和文本前缀
    //   - 命中 → info，打出单聊/群、命中方式（exact/prefix/contains）
    if (!suppressAuto && aiRunning && !biliCmd) {
      const aiText = bodyText;
      const aiKey = key || resolveChatKey(m);
      // 这张图能不能交给模型看：类型对、拿到 URL、用户没关识图
      const wantImg = !!(isImg && imgUrl && cfg.ai.vision !== false);
      if (!aiText && !wantImg) {
        if (log.isEnabled('debug')) {
          log.debug('ai', `跳过：这条消息没有可回复的正文 kind=${parsed.kind}`
            + (isImg ? `（识图${cfg.ai.vision === false ? '已关闭' : (imgUrl ? '没有图片地址' : '有图但地址为空')}）` : ''));
        }
      } else {
        const found = aiSessionOf(m, aiKey);
        if (!found.sess) {
          // 没勾选的会话天天都有（家庭群、别的表），不能每条都 info 刷屏；
          // 每分钟最多一条，但 debug 下每条都留，排查时切 WP_LOG=debug 就行
          const enabled = (cfg.ai.sessions || []).map((s) => aiTrigger.sessionKeyOf(s)).filter(Boolean);
          const detail = `key=${aiKey || '(未解析)'} enabled=${enabled.length ? JSON.stringify(enabled) : '(空)'}`;
          if (log.isEnabled('debug')) log.debug('ai', `跳过：会话没启用 ${detail}`);
          else if (Date.now() - aiSkipLog.at > 60000) {
            aiSkipLog.at = Date.now();
            log.info('ai', `跳过：这条会话没在「启用 AI 的会话」里 ${detail}（同类提示每分钟最多一条）`);
          }
        } else {
          // 关键词模式下「纯图片」不触发：没有文字就没有可匹配的东西，
          // 一律放行等于把「关键词触发」变成「所有图片都回」，那不是用户要的。
          // 图配文时按文字判定，图跟着一起发过去。
          const trig = aiText
            ? aiShouldTrigger(aiText)
            : (cfg.ai.trigger === 'keyword'
              ? { hit: false, keyword: null, how: '' }
              : { hit: true, keyword: null, how: 'image' });
          if (!trig.hit) {
            if (log.isEnabled('debug')) {
              log.debug('ai', `跳过：关键词未命中 mode=${cfg.ai.keywordsMode || 'auto'} `
                + `keywords=${JSON.stringify((cfg.ai.keywords || []).slice(0, 10))} `
                + `text=${JSON.stringify(aiText.slice(0, 40))}`
                + (wantImg ? '（纯图片消息，关键词模式下不触发）' : ''));
            }
          } else {
            log.info('ai', `触发 → ${found.sess.type === 'group' ? '群' : '单聊'} `
              + `${aiTrigger.sessionKeyOf(found.sess)} `
              + `(${trig.how}${trig.keyword ? ':' + trig.keyword : ''}) `
              + (wantImg ? `图片=yes ` : '')
              + `文本=${JSON.stringify(aiText.slice(0, 30))}`);
            queueAiReply(found.sess, aiText, wantImg ? imgUrl : '');
          }
        }
      }
    }

    if (!text) return;
    if (!key) {
      // 收到的消息对不上任何已知会话 —— 最常见的原因是「刚绑了表，
      // 会话列表还是旧的」（原版靠 IM 推送更新，我们只能 HTTP 拉，会有延迟）。
      // 这里顺手异步刷一次列表，下一条消息就能归档；限流 30 秒，
      // 免得会话 ID 永远对不上时每来一条消息就打一次接口。
      if (Date.now() - lastRefreshTry.at > 30e3) {
        lastRefreshTry.at = Date.now();
        loadChatTargets(true).catch(() => {});
      }
      // 静默丢弃最难排查, 这里限流告警一句。
      // 2026-11-09 补：把「我们手里到底有哪些会话 ID」一起打出来 ——
      // 上次就是群 ID 差 1，日志里只有消息的 dialogId，看不出是 ID 对不上。
      const now = Date.now();
      if (now - lastDropWarn.at > 60000) {
        lastDropWarn.at = now;
        lastDropWarn.n++;
        const groups = (chatTargets || [])
          .filter((t) => t.type === 'group')
          .map((t) => (t.aliasIds && t.aliasIds.length ? t.aliasIds : [t.dialogId]));
        const singles = (chatTargets || [])
          .filter((t) => t.type === 'single')
          .map((t) => t.receiverId);
        log.warn('im', `收到手表消息但找不到对应会话(已丢弃 ${lastDropWarn.n} 条): `
          + JSON.stringify({
            dialogId: m.dialogId,
            imAccountId: m.imAccountId,
            msgType: m.msgType,
            targets: (chatTargets || []).length,
            knownGroups: groups,
            knownSingles: singles,
          }));
      }
      return;
    }
    lastDropWarn.n = 0;
    pushChat(key, { self: false, text, kind: parsed.kind, url: messageUrl(parsed), time: m.createTime || Date.now() });
    if (suppressAuto) {
      log.debug('im', '握手期间的历史或时间未知消息已归档，不执行自动回复或命令');
      return;
    }

    // 插件也收一份。放在 B 站命令和 OneBot 转发之前：插件可能就是个关键词机器人，
    // 让它先看到原文。dispatchMessage 内部逐个 catch，一个插件炸不影响别的
    if (cfg.plugins.enabled !== false && pluginMgr.plugins.size) {
      const tg = (chatTargets || []).find((x) => x.key === key) || {};
      pluginMgr.dispatchMessage({
        key,
        type: tg.type || 'single',
        name: tg.name || '',
        text,
        kind: parsed.kind,
        sender: String(m.imAccountId || ''),
        time: m.createTime || Date.now(),
      }).catch(() => {});
    }

    // B 站点播命令: 自己处理完直接返回, 不再转给 OneBot(否则插件还会把它当普通消息回一遍)
    if (biliCmd && biliWid) { runBiliCommand(biliWid, key, biliCmd); return; }
    // 命令认出来了, 但没有一块启用的表认领这条会话 —— 必须回一句。
    // 线上真踩过: 用户只勾了单聊, 跑到家庭群里发, 机器人一声不响, 以为功能坏了
    if (biliCmd && biliOn) { biliMissReply(key); return; }

    // 转发给 OneBot(第三方框架从这里收事件)。每个实例只收自己那块表范围内的会话
    if (onebots.size) {
      const target = (chatTargets || []).find((x) => x.key === key);
      if (target) {
        const peer = (target.peers || []).find((a) => String(a.imAccountId) === String(m.imAccountId));
        const payload = {
          type: target.type,
          userId: m.imAccountId,
          groupId: target.dialogId,
          senderName: (peer && peer.name) || target.name || '',
          parsed,
          text,
          time: m.createTime || Date.now(),
        };
        onebots.forEach((inst, wid) => {
          const keys = onebotKeys.get(String(wid)) || [];
          // 范围为空或不包含该会话时均不投递，避免跨手表泄露。
          if (!createOnebotScope(wid, keys).allows(key)) return;
          try { inst.pushMessage(payload); } catch (e) {
            log.warn('onebot', `手表 ${wid} 事件推送失败: ` + (e && e.message ? e.message : e));
          }
        });
      }
    }

    if (im && m.syncKey > im.syncKey) {
      im.syncKey = m.syncKey;
      cfg.imSyncKey = m.syncKey;
      device.save(cfg);
    }
  }

  async function ensureIM() {
    // alive() 而不是 connected: 云端实例挂几天之后常见「TCP 还连着但再也收不到东西」,
    // 只看 connected 会一直复用这条死连接, 表现就是界面显示已连接、消息一条都不来
    if (im && im.connected && (!im.alive || im.alive())) return im;
    if (im) {
      log.warn('im', '现有连接已失效，丢弃后重连');
      try { im.close(); } catch (e) { /* ignore */ }
      im = null;
    }
    if (imConnecting) return imConnecting;
    imConnecting = (async () => {
      // 会话列表是归档和匹配的前提；拿不到时先不建立会确认消息的连接。
      // 后台巡检会重试，避免连接后将无法归档的消息确认并丢弃。
      if (!chatTargets) {
        try { await loadChatTargets(); }
        catch (e) {
          log.warn('im', '会话列表未就绪，暂不连接 IM，稍后重试: ' + (e && e.message ? e.message : e));
          throw e;
        }
      }
      // 接口回成功但内容是空的（刚绑表、平台抽风）也不能连：
      // 连上就会把消息确认掉，可是一条都归档不了。
      if (!chatTargets || !chatTargets.length) {
        throw new Error('会话列表为空，暂不连接 IM');
      }
      const prevImId = cfg.imAccountId;
      const c = new ImClient(cfg);
      // 握手期间服务端也可能推送消息；先监听、在身份就绪后再按序处理。
      const early = bufferEarlyMessages(c, (m) => {
        // 对所有来源检查新鲜度；未知时间的同步消息不能冒充实时指令。
        const suppressAuto = !allowMessageSideEffects(m, Date.now());
        onImMessage(m, suppressAuto);
      }, {
        onError: (e) => log.warn('im', '处理接收消息失败: ' + (e && e.message ? e.message : e)),
        onOverflow: () => log.warn('im', '握手期间消息缓冲已满，消息可能丢失'),
      });
      // EventEmitter 的 error 必须在连接前监听，否则握手期间可能直接导致进程异常退出。
      c.on('error', (e) => {
        imLastError = (e && e.message) ? e.message : String(e);
        log.debug('im', '连接错误: ' + imLastError);
      });
      c.on('close', () => {
        if (im !== c) return;
        im = null;
        imReconnects++;
        imLastError = '连接已断开';
        log.warn('im', '连接已断开，5 秒后重连');
        if (!imRetry) {
          imRetry = setTimeout(() => {
            imRetry = null;
            ensureIM().catch((e) => log.warn('im', '重连失败: ' + (e && e.message ? e.message : e)));
          }, 5000);
          if (imRetry.unref) imRetry.unref();
        }
      });
      try {
        await c.connect();
        if (!c.connected || (c.alive && !c.alive())) throw new Error('握手完成后连接已断开');
        cfg.imAccountId = c.imAccountId;
        device.save(cfg);
      // 反向 WS 握手头里的 X-Self-ID 是"连接那一刻"的快照, 而 AstrBot 回消息时会拿
      // 事件里的 self_id 去匹配这条连接。换账号后 self_id 变了, 不重连就会出现
      // "能收到消息但回复发不出去" —— 这里主动重建一次
      if (onebots.size && String(prevImId || '') !== String(c.imAccountId || '')) {
        log.info('onebot', `账号标识变化(${prevImId || 0} → ${c.imAccountId})，重连反向 WS`);
        restartOneBot();
      }
        im = c;
        early.activate();
        await c.sync().catch(() => {});
        return c;
      } catch (e) {
        if (im === c) im = null;
        const dropped = early.dispose();
        if (dropped) log.warn('im', `连接初始化失败，握手缓冲中有 ${dropped} 条消息未处理`);
        try { c.close(); } catch (_) { /* ignore */ }
        throw e;
      }
    })();
    try { return await imConnecting; } finally { imConnecting = null; }
  }

  // IM 连接状态快照(聊天页展示 + 排查用)
  function imStatus() {
    const last = im && im.lastRecvAt ? im.lastRecvAt : 0;
    return {
      connected: !!(im && im.connected),
      alive: !!(im && im.connected && (!im.alive || im.alive())),
      imAccountId: (im && im.imAccountId) || cfg.imAccountId || 0,
      syncKey: (im && im.syncKey) || cfg.imSyncKey || 0,
      frames: (im && im.frames) || 0,
      lastRecvAt: last,
      lastRecvAgo: last ? Math.round((Date.now() - last) / 1000) : null,
      reconnects: imReconnects,
      lastError: imLastError,
    };
  }

  // 后台常驻 IM: 登录后自动连接并保持在线, 断线时定时重连
  // 作用是把手表上报的电量/位置等业务消息实时落到 cfg.watchStatus
  let imTimer = null;
  let imLastState = '';
  function startImBackground() {
    if (imTimer) return;
    const logState = (s) => {
      if (s === imLastState) return;
      imLastState = s;
      if (/失败/.test(s)) log.warn('im', s); else log.info('im', s);
    };
    const tick = () => {
      if (!cfg.token) return;
      ensureIM()
        .then((c) => logState('后台监听在线 imAccountId=' + c.imAccountId))
        .catch((e) => logState('后台监听连接失败: ' + (e && e.message ? e.message : e)));
    };
    tick();
    imTimer = setInterval(tick, 60000);
    if (imTimer.unref) imTimer.unref();
  }

  // 会话列表的构建在 chat-targets.js：同一个家庭出现两条记录、一个家庭绑多块表，
  // 这两种情况在那里统一处理（原来会重复显示、漏掉第二块表）。
  //
  // force=true 绕过期时间。默认 60 秒过期：用户新绑一块表、服务端多出一个群之后，
  // 界面上（AI 的会话勾选、OneBot/B 站的范围选择）最迟一分钟后就能看到，
  // 不用重启实例。以前是「拿到一次就一直用」，新会话永远不出现。
  // 绑表/解绑/切账号后立刻让会话列表过期。
  // 光靠 60 秒 TTL 不够：用户绑完表就在聊天页等着，不会自己切走再切回来。
  function invalidateChatTargets() {
    chatTargets = null;
    chatTargetsAt = 0;
    // 服务端建 IM 会话有一两秒延迟，30 秒内不信缓存（每次进来重拉一次）
    chatTargetsForceUntil = Date.now() + 30e3;
  }

  async function loadChatTargets(force) {
    const bypass = force || Date.now() < chatTargetsForceUntil;
    if (chatTargets && !bypass && Date.now() - chatTargetsAt < CHAT_TARGETS_TTL) return chatTargets;
    const data = ensure(await api.getDialogAccounts());
    const built = buildChatTargets(data.familyDialogs || []);
    // 只缓存非空结果：接口这次回了空（刚绑表、平台抽风）时如果把 [] 缓存下来，
    // 之后每次都命中空数组，ensureIM 会以为「已就绪」照样连，消息全部归档失败。
    if (built.length) {
      chatTargets = built;
      chatTargetsAt = Date.now();
    }
    return built;
  }

  // 微聊单条语音上限 60 秒, 超过就切开逐条发(阈值和 OneBot 那边保持一致)
  const VOICE_MAX_SEC = 58;
  const VOICE_MAX_SEG = 20;

  // 发一条语音, 超过 58 秒自动切段。file 可以是本地路径或 http(s) 地址, 返回实际发出的条数
  async function sendVoiceParts(c, t, file) {
    let dl = '';
    let split = null;
    let sent = 0;
    let src = String(file || '');
    const sendOne = async (p, i, total) => {
      const v = await uploadVoice(cfg, { src: p });
      const voice = buildVoice(v);
      const r = t.type === 'single'
        ? await c.sendSingleVoice(t.receiverId, voice)
        : await c.sendGroupVoice(t.dialogId, c.imAccountId, voice);
      if (!r.ok) throw new Error(r.desc || r.code || '发送失败');
      sent++;
      const label = total > 1
        ? '[语音 ' + (i + 1) + '/' + total + '] ' + v.duration + '秒'
        : '[语音 ' + v.duration + '秒]';
      pushChat(t.key, { self: true, text: label, kind: 'voice', url: v.downloadUrl, time: Date.now() });
      return v;
    };
    try {
      if (/^https?:\/\//i.test(src)) { dl = await downloadToTmp(src, 'voice'); src = dl; }
      const dur = probeDuration(src);
      if (!dur || dur <= VOICE_MAX_SEC) { await sendOne(src, 0, 1); return 1; }
      split = splitAudio(src, VOICE_MAX_SEC);
      if (!split.files.length) throw new Error('音频切分失败(需要 ffmpeg)');
      if (split.files.length > VOICE_MAX_SEG) {
        throw new Error(`语音 ${Math.round(dur)} 秒, 切分后 ${split.files.length} 段超过上限 ${VOICE_MAX_SEG} 段`);
      }
      log.info('webui', `语音 ${Math.round(dur)} 秒超过 ${VOICE_MAX_SEC} 秒上限, 切成 ${split.files.length} 段发送`);
      for (let i = 0; i < split.files.length; i++) {
        // 连发太快平台会吞消息
        if (i) await new Promise((r) => setTimeout(r, 350));
        await sendOne(split.files[i], i, split.files.length);
      }
      return split.files.length;
    } catch (e) {
      // 记下已经发出去几条, 调用方据此判断能不能退回直链兜底(别重复发)
      e.sent = sent;
      throw e;
    } finally {
      if (split) cleanupSplit(split);
      if (dl) { try { fs.unlinkSync(dl); } catch (e) {} }
    }
  }

  // 微聊单条视频上限 30 秒, 超过就切开逐条发(超了手表端根本放不出来)
  const VIDEO_MAX_SEC = 30;
  const VIDEO_MAX_SEG = 30;

  // 发一条视频, 超过 30 秒自动切段。file 可以是本地路径或 http(s) 地址, 返回实际发出的条数。
  // 切段本身在 upload.splitVideo 里(先快切, 关键帧对不上才重编码)。
  async function sendVideoParts(c, t, file, duration) {
    let dl = '';
    let split = null;
    let sent = 0;
    let src = String(file || '');
    const group = t.type === 'group';
    const dialogId = group ? t.dialogId : t.receiverId;
    const sendOne = async (p, i, total) => {
      const v = await uploadVideo(cfg, { src: p, group, dialogId, myImAccountId: c.imAccountId });
      const obj = buildVideo(v);
      const r = group
        ? await c.sendGroupPayload(t.dialogId, c.imAccountId, obj, 1)
        : await c.sendSinglePayload(t.receiverId, obj, 1);
      if (!r.ok) throw new Error(r.desc || r.code || '发送失败');
      sent++;
      const sec = Math.round(v.videoLength || 0);
      // 多段时标上「第几段/共几段」, 不然手表上看到一串视频不知道有没有收全
      const label = total > 1
        ? '[视频 ' + (i + 1) + '/' + total + '] ' + sec + '秒'
        : '[视频' + (sec ? ' ' + sec + '秒' : '') + ']';
      pushChat(t.key, { self: true, text: label, kind: 'video', url: (v.source && v.source.downloadUrl) || '', time: Date.now() });
      return v;
    };
    try {
      if (/^https?:\/\//i.test(src)) { dl = await downloadToTmp(src, 'video'); src = dl; }
      const dur = Number(duration) || probeDuration(src);
      if (!dur || dur <= VIDEO_MAX_SEC) { await sendOne(src, 0, 1); return 1; }
      split = await splitVideo(src, VIDEO_MAX_SEC);
      if (!split.files.length) throw new Error('视频切分失败（需要 ffmpeg）');
      if (split.files.length > VIDEO_MAX_SEG) {
        throw new Error(`视频 ${Math.round(dur)} 秒，切分后 ${split.files.length} 段超过上限 ${VIDEO_MAX_SEG} 段`);
      }
      log.info('webui', `视频 ${Math.round(dur)} 秒超过 ${VIDEO_MAX_SEC} 秒上限, 切成 ${split.files.length} 段`
        + (split.reencoded ? '(重编码切分)' : '(直接切流)'));
      for (let i = 0; i < split.files.length; i++) {
        // 连发太快平台会吞消息, 视频比语音更重, 间隔给大一点
        if (i) await new Promise((r) => setTimeout(r, 500));
        await sendOne(split.files[i], i, split.files.length);
      }
      return split.files.length;
    } catch (e) {
      // 记下已经发出去几条, 调用方据此判断能不能退回直链兜底(别重复发)
      e.sent = sent;
      throw e;
    } finally {
      if (split) cleanupSplit(split);
      if (dl) { try { fs.unlinkSync(dl); } catch (e) {} }
    }
  }

  async function sendChat(body) {
    const key = String(body.key || '');
    const targets = await loadChatTargets();
    const t = targets.find((x) => x.key === key);
    if (!t) throw new Error('会话不存在');
    const c = await ensureIM();
    const kind = body.kind || 'text';
    let obj;
    let label;
    let url = '';
    let msgType = 1;

    if (kind === 'text') {
      const text = String(body.text || '').trim();
      if (!text) throw new Error('内容不能为空');
      obj = buildText(text);
      label = text;
    } else if (kind === 'emoji') {
      const preset = EMOJI_PRESET.emojis[Number(body.index) - 1];
      if (!preset) throw new Error('表情不存在');
      obj = buildEmoji(preset);
      label = '[表情] ' + preset.desc;
      // 本地预览图, 让发出的表情在气泡里也能看到图片
      url = emojiAsset(preset.code);
    } else if (kind === 'location') {
      const lat = Number(body.latitude);
      const lng = Number(body.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('经纬度不正确');
      obj = buildLocation(lat, lng, String(body.poi || ''));
      label = '[位置] ' + (body.poi || (lat + ',' + lng));
    } else if (kind === 'link') {
      const url2 = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(url2)) throw new Error('链接格式不正确');
      const biz = Number(body.businessType || 0);
      const title = String(body.desc || '').trim() || url2;
      const appName = String(body.appName || '').trim() || LINK_APP_NAME;

      // 封面: 手选/手填的图 > 自动抓网页图标 > 不带封面
      // 封面只是锦上添花, 任何一步失败都只记日志, 不能把整条消息堵掉
      let source = null;
      try {
        let cover = await loadLinkImage(body.cover, LINK_COVER_MAX);
        if (!cover) cover = await fetchFavicon(url2);
        if (cover && cover.buf) {
          const img = await uploadImage(cfg, {
            buf: cover.buf,
            filename: cover.filename,
            group: t.type === 'group',
            dialogId: t.type === 'group' ? t.dialogId : t.receiverId,
            myImAccountId: c.imAccountId,
          });
          source = img.source;
        }
      } catch (e) {
        log.warn('chat', '链接封面处理失败(消息照发): ' + e.message);
      }

      // 来源小图标: 手选的图 > 项目自带图标
      let iconBuf = null;
      try {
        const picked = await loadLinkImage(body.icon, LINK_ICON_MAX);
        iconBuf = picked ? picked.buf : defaultLinkIcon();
      } catch (e) {
        log.warn('chat', '链接图标处理失败(改用默认图标): ' + e.message);
        iconBuf = defaultLinkIcon();
      }

      obj = buildLink({
        url: url2,
        desc: title,
        appName,
        businessType: biz,
        source,
        icon: iconBuf,
      });
      label = '[链接] ' + title;
      url = url2;
    } else if (kind === 'kaomoji') {
      const content = String(body.text || '').trim();
      if (!content) throw new Error('颜文字内容不能为空');
      obj = buildKaomoji(content);
      label = content;
    } else if (kind === 'image') {
      const src = String(body.src || '').trim();
      if (!src) throw new Error('图片地址不能为空');
      const loaded = await loadImageSource(src);
      const img = await uploadImage(cfg, {
        buf: loaded.buf,
        filename: loaded.filename,
        group: t.type === 'group',
        dialogId: t.type === 'group' ? t.dialogId : t.receiverId,
        myImAccountId: c.imAccountId,
      });
      obj = buildPhoto(img);
      label = '[图片]';
      url = (img.source && img.source.downloadUrl) || '';
    } else if (kind === 'voice') {
      const src = String(body.src || '').trim();
      if (!src) throw new Error('音频地址不能为空');
      // 正常路径自己发完(可能切成多条), 直接返回; 下载不下来才走下面的直链兜底
      try {
        const parts = await sendVoiceParts(c, t, src);
        return { url: '', parts };
      } catch (e) {
        // 已经发出去几条就不能再补发整条, 否则重复
        if (!/^https?:\/\//i.test(src) || e.sent) throw e;
        // 下载不下来只能直接引用外链。但 audioType 不能瞎填 1(Opus)：
        // 手表只认 AMR(0) 和自定义 Opus(1)，其它格式发过去就是一条点不开的语音。
        // 这里按后缀猜一个最接近的，猜不出就明确告诉调用方，别发废消息。
        const isAmrLink = /\.amr(\?|#|$)/i.test(src);
        const isOpusLink = /\.(opus|ogg)(\?|#|$)/i.test(src);
        if (!isAmrLink && !isOpusLink) {
          throw new Error('音频下载失败，且外链不是 .amr/.opus，手表放不了：' + String(e.message || e).slice(0, 120));
        }
        const v = {
          key: '',
          downloadUrl: src,
          duration: Number(body.duration) || 0,
          audioType: isAmrLink ? 0 : 1,
          deadline: 0,
        };
        log.warn('chat', `音频下载失败，按外链直发（${isAmrLink ? 'AMR' : 'Opus'}）：${String(src).slice(0, 100)}`);
        obj = buildVoice(v);
        msgType = 2;
        label = '[语音 ' + v.duration + '秒]';
        url = v.downloadUrl;
      }
    } else if (kind === 'video') {
      const src = String(body.src || '').trim();
      if (!src) throw new Error('视频地址不能为空');
      const dur = Number(body.duration) || 0;
      // 外链且不超时长(或不知道时长): 保持原来的「不下载、直接引用」, 别平白多传一次
      if (/^https?:\/\//i.test(src) && (!dur || dur <= VIDEO_MAX_SEC)) {
        const v = directVideo(src, dur);
        obj = buildVideo(v);
        label = '[视频]';
        url = (v.source && v.source.downloadUrl) || '';
      } else {
        // 本地文件 / 超过 30 秒的外链: 走上传, 超长自动切段, 自己发完直接返回
        const parts = await sendVideoParts(c, t, src, dur);
        return { url: '', parts };
      }
    } else {
      throw new Error('不支持的消息类型');
    }

    const r = t.type === 'single'
      ? await c.sendSinglePayload(t.receiverId, obj, msgType)
      : await c.sendGroupPayload(t.dialogId, c.imAccountId, obj, msgType);
    if (!r.ok) throw new Error(r.desc || r.code || '发送失败');
    pushChat(key, { self: true, text: label, kind: kind === 'image' ? 'photo' : kind, url, time: Date.now() });
    return { url };
  }

  async function watchList(force) {
    if (!force && Date.now() - cache.at < 60000) return cache.list;
    const revision = watchStatusRevision;
    const data = ensure(await api.getMobileInit());
    const raw = data.mobileWatchs || [];
    const list = [];
    for (const w of raw) {
      const d = (await safe(() => api.getWatchAccount(w.watchId))) || {};
      const st = (cfg.watchStatus && cfg.watchStatus[w.watchId]) || {};
      list.push({
        watchId: w.watchId,
        relationId: w.id,
        salutation: w.salutation || '',
        name: d.name || '',
        model: d.model || '',
        number: d.number || '',
        ...selectBattery({ apiValue: d.battery, pushValue: st.battery, pushAt: st.batteryAt, pushTimeKind: 'received' }),
        onlineStatus: selectOnline(d.online, d.watchOnline),
        firmware: d.firmware || '',
        imei: d.imei || '',
        online: d.online,
        watchOnline: d.watchOnline,
        lossSwitch: d.lossSwitch != null ? Number(d.lossSwitch) : 0,
        // 最近一次收到该表平台通知的本地时间，不代表设备采样或在线时间
        lastSeenAt: st.lastSeenAt || null,
        lastLocation: st.lastLat != null ? { latitude: st.lastLat, longitude: st.lastLng, address: st.lastAddress || '', time: st.lastLocAt || null } : null,
      });
    }
    // 拉取期间若有新推送，这份快照不能被标记为新鲜缓存。
    cache = { at: revision === watchStatusRevision ? Date.now() : 0, list };
    return list;
  }

  // 登录/验证成功后统一写入会话
  async function finishLogin(account, data, rsaKey) {
    cfg.token = typeof data === 'string' ? data : JSON.stringify(data);
    cfg.userName = account;
    cfg.ssoRsaKey = rsaKey;
    try { cfg.authId = JSON.parse(cfg.token).accountId; } catch (e) { /* ignore */ }
    device.save(cfg);

    cache.at = 0;
    capCache.clear();
    avatarCache.clear();
    chatTargets = null;
    chatLog.clear();
    watchNames = null;   // 换账号后手表名要重新取, 否则按手表分开的会话匹配会串
    if (im) { try { im.close(); } catch (e) { /* ignore */ } im = null; }

    const init = await safe(() => api.getMobileInit());
    const acc = (init && init.mobileAccount) || {};
    if (acc.id) cfg.mobileId = acc.id;
    if (acc.authId) cfg.authId = acc.authId;
    device.save(cfg);
    startImBackground();
    // 登录后手表列表/会话才拿得到, 按手表分开的实例要按新数据重新算一次会话范围
    refreshOnebotScope().catch(() => {});
    // 点播的会话范围同理, 换账号后手表名和会话都会变
    refreshBiliScope().catch(() => {});
  }

  // ===== 对外 API: 加好友口令 + 好友管理 =====
  // 统一前缀 /api/ext/*, 用按手表的独立令牌(前缀 gk_, 存在 cfg.extApi[watchId]),
  // 不走 WebUI 的 Cookie 鉴权。令牌即身份, 只能操作它对应的那块表:
  //   GET    /api/ext/genius                取加好友口令
  //   GET    /api/ext/friends               好友列表
  //   GET    /api/ext/friends/:friendId     好友详情
  //   DELETE /api/ext/friends/:friendId     删除好友(必须带 confirm=<好友记录 id>)
  // 某块表的开关关闭时, 它的令牌一律 401

  // 给好友记录补一个头像直链。平台返回的是文件 key, 要再换一次下载地址
  async function withFriendAvatars(friends) {
    const list = Array.isArray(friends) ? friends : [];
    const keys = [];
    list.forEach((f) => {
      const k = (f && (f.customIcon || f.icon)) || '';
      if (k && keys.indexOf(k) < 0) keys.push(k);
    });
    const urlMap = {};
    if (keys.length) {
      const urls = await safe(() => api.getFileUrls(keys, 1));
      if (Array.isArray(urls)) keys.forEach((k, i) => { urlMap[k] = urls[i] || ''; });
    }
    return list.map((f) => {
      const k = (f && (f.customIcon || f.icon)) || '';
      return Object.assign({}, f, { avatar: urlMap[k] || '' });
    });
  }

  // 好友列表没有分页也没有"按 id 查单个"的接口, 详情就地从列表里挑。
  // id 优先级最高, 其余字段兜底, 让调用方用 watchfriend 记录 id / friendId / IM 账号 / 号码
  // 任意一个都能定位; 按名字匹配时必须唯一, 重名就报错让人改用 id
  function pickFriend(friends, key) {
    const k = String(key == null ? '' : key).trim();
    if (!k) return null;
    const fields = ['id', 'friendId', 'imAccountId', 'number', 'bindNumber'];
    for (const f of fields) {
      const hit = friends.find((x) => x && x[f] != null && String(x[f]) === k);
      if (hit) return hit;
    }
    const byName = friends.filter((x) => x && (String(x.friendName || '') === k || String(x.friendRealName || '') === k));
    return byName.length === 1 ? byName[0] : null;
  }

  async function handleExtGenius(req, res, query, target) {
    const config = await safe(() => api.getGeniusConfig());
    const account = await safe(() => api.getGeniusAccount(target.watchId));
    const geniusNumber = (account && account.geniusNumber) || '';
    if (!geniusNumber) {
      return sendJson(res, 200, { ok: false, error: '该手表没有 geniusNumber，无法生成口令' });
    }

    let r;
    try {
      r = await api.getGeniusCommand(target.watchId, geniusNumber);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: '获取口令失败: ' + (e && e.message ? e.message : e) });
    }
    const command = r && r.json && r.json.code === '000001' ? r.json.data : null;
    if (!command || !command.command) {
      const msg = (r && r.json && r.json.message) || '未知错误';
      return sendJson(res, 200, { ok: false, error: '获取口令失败: ' + msg });
    }

    log.info('geniusapi', `下发口令 watchId=${target.watchId} ip=${clientIp(req)}`);
    return sendJson(res, 200, {
      ok: true,
      data: {
        watchId: target.watchId,
        watchName: target.name || '',
        geniusNumber,
        command: command.command,
        expire: (config && config.commandExpireDescription) || '',
        at: Date.now(),
      },
    });
  }

  async function handleExtFriends(req, res, parts, query, target) {
    const key = parts[3] ? decodeURIComponent(parts[3]) : '';
    let friends;
    try {
      friends = await withFriendAvatars(ensure(await api.getWatchFriends(target.watchId)) || []);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: '获取好友列表失败: ' + (e && e.message ? e.message : e) });
    }

    // 列表
    if (!key) {
      return sendJson(res, 200, {
        ok: true,
        data: { watchId: target.watchId, watchName: target.name || '', total: friends.length, friends },
      });
    }

    const f = pickFriend(friends, key);
    if (!f) return sendJson(res, 404, { ok: false, error: '找不到该好友: ' + key });
    const name = f.friendName || f.friendRealName || '';

    // 删除
    if (req.method === 'DELETE') {
      const confirm = String(query.get('confirm') || '').trim();
      const expect = String(f.id);
      if (confirm !== expect) {
        // 破坏性操作, 确认值必须与目标 id 完全一致, 防止脚本参数写错就把人删了
        return sendJson(res, 400, {
          ok: false,
          error: '删除好友是破坏性操作，需要带 confirm=<好友记录 id> 二次确认',
          data: { friendId: expect, name },
        });
      }
      try {
        ensure(await api.deleteWatchFriend(f.id));
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: '删除失败: ' + (e && e.message ? e.message : e) });
      }
      log.info('geniusapi', `删除好友 watchId=${target.watchId} friend=${expect} ip=${clientIp(req)}`);
      return sendJson(res, 200, { ok: true, data: { deleted: true, friendId: expect, name } });
    }

    // 详情: 平台返回的字段原样带出, 不裁剪, 免得版本一变就少字段
    return sendJson(res, 200, {
      ok: true,
      data: { watchId: target.watchId, watchName: target.name || '', friend: f },
    });
  }

  async function handleExtApi(req, res, parts, query) {
    const sub = String(parts[2] || '');
    if (sub !== 'genius' && sub !== 'friends') {
      return sendJson(res, 404, { ok: false, error: '接口不存在' });
    }
    // 令牌只有按手表这一种: cfg.extApi[watchId]。令牌即身份, 拿到它就锁定那块表
    const perWatch = cfg.extApi || {};
    const watchTokens = Object.keys(perWatch).filter((wid) => perWatch[wid] && perWatch[wid].enabled && perWatch[wid].token);
    if (!watchTokens.length) {
      return sendJson(res, 403, { ok: false, error: '该接口未启用，请在 WebUI「我的 → 对外 API」里为这块手表打开' });
    }
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
    const tk = String(query.get('token') || (m ? m[1] : '')).trim();
    let scopeWatch = '';
    for (const wid of watchTokens) {
      if (safeEqual(tk, perWatch[wid].token)) { scopeWatch = String(wid); break; }
    }
    if (!scopeWatch) {
      log.warn('geniusapi', `令牌不正确 ip=${clientIp(req)}`);
      return sendJson(res, 401, { ok: false, error: '令牌不正确' });
    }

    // /api/ext/friends/:id 额外接受 DELETE(删除好友); 其余只收 GET/POST。
    // 删除只认 DELETE, 用 GET 触发会被浏览器预取 / 爬虫 / 链接预览误伤
    const hasId = sub === 'friends' && parts[3];
    const allow = hasId ? ['GET', 'POST', 'DELETE'] : ['GET', 'POST'];
    if (allow.indexOf(req.method) < 0) {
      return sendJson(res, 405, { ok: false, error: '该接口只支持 ' + allow.join(' / ') });
    }

    let list;
    try {
      list = await watchList(false);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: '获取手表列表失败: ' + (e && e.message ? e.message : e) });
    }
    if (!list.length) return sendJson(res, 200, { ok: false, error: '当前账号没有绑定手表' });

    // 令牌锁死目标表; 传了 watchId 也只能是它自己
    let wid = String(query.get('watchId') || '').trim();
    if (wid && wid !== scopeWatch) {
      return sendJson(res, 403, { ok: false, error: '这个令牌只对应手表 ' + scopeWatch + '，不能操作 ' + wid });
    }
    wid = scopeWatch;
    const target = list.find((w) => String(w.watchId) === wid);
    if (!target) return sendJson(res, 404, { ok: false, error: '找不到该手表: ' + wid });

    if (sub === 'friends') return handleExtFriends(req, res, parts, query, target);
    return handleExtGenius(req, res, query, target);
  }

  // ===== 实时日志: SSE 推送 =====
  // 零依赖, 直接往 response 里写 text/event-stream。EventSource 同源会自动带 Cookie,
  // 所以不用为它单独开鉴权口子(前端 fetch 也是靠 Cookie 的, 没有 Authorization 头)
  function streamLogs(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx 反代时默认会缓冲 event-stream, 这个头让它直通
      'X-Accel-Buffering': 'no',
    });
    if (res.flushHeaders) res.flushHeaders();

    // 先补一屏历史, 打开页面就能看到上下文
    res.write('retry: 3000\n');
    res.write('event: init\ndata: ' + JSON.stringify({
      level: log.levelName(),
      seq: log.seq(),
      entries: log.recent(200),
    }) + '\n\n');

    const unsub = log.subscribe((e) => {
      try { res.write('data: ' + JSON.stringify(e) + '\n\n'); } catch (err) { /* 连接已断, 下面 cleanup 会收尾 */ }
    });
    // 心跳: 防止反代/浏览器把空闲连接掐掉(20 秒一次注释行, 前端不会当成消息)
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
    }, 20000);
    if (hb.unref) hb.unref();

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearInterval(hb);
      unsub();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    res.on('close', cleanup);
  }

  // ===== 插件：管理接口 + 插件自己的接口 =====

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  };

  function mimeOf(file) {
    return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  }

  // 插件页面是独立文档（跑在 iframe 里），得让它知道自己的 id 和接口前缀。
  // 顺手做两件事：把主题塞进去（iframe 里没有父页面的 CSS 变量，不告诉它就会在
  // 深色模式下白得刺眼）；把自身高度报给父页面（否则要么出现双层滚动条，
  // 要么底部被截掉一截）。
  function injectPluginBridge(html, id) {
    const cfgObj = JSON.stringify({ id, api: '/api/plugin/' + encodeURIComponent(id) + '/api' });
    const bridge = '<script>window.JZ_PLUGIN=' + cfgObj + ';'
      + 'try{var t=localStorage.getItem("jz_theme");if(t)document.documentElement.setAttribute("data-theme",t);}catch(e){}'
      + '(function(){'
      + 'function report(){try{var h=Math.ceil(document.documentElement.getBoundingClientRect().height);'
      + 'parent.postMessage({__jzPluginHeight:h},"*");}catch(e){}}'
      + 'window.addEventListener("load",function(){report();'
      + 'if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement);}'
      + 'setInterval(report,1200);});'
      + '})();'
      + '<\/script>';
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + bridge);
    return bridge + html;
  }

  async function handlePlugins(req, res, parts, query) {
    const sub = parts[2] || '';

    // 列表。前端拿这个渲染插件卡片 + 生成导航栏里那些插件入口
    if (!sub && req.method === 'GET') {
      return ok(res, {
        enabled: cfg.plugins.enabled !== false,
        // full = 本地版，能自己上传；managed = 云端版，只能装插件市场里的
        mode: PLUGIN_MODE,
        // 云端模式下来源页地址（平台通过 JZ_CONSOLE_URL 注入），前端拿它做「去插件市场」的链接
        consoleUrl: String(process.env.JZ_CONSOLE_URL || '').trim(),
        dirs: { user: require('./plugin').USER_DIR, builtin: require('./plugin').BUILTIN_DIR },
        list: pluginMgr.list(),
      });
    }

    // 上传 zip：body 就是文件原始字节（前端 File.arrayBuffer() 直接塞进来），
    // 文件名走 query。不用 multipart 是因为解析器得自己写，而我们只需要一个文件
    if (sub === 'upload' && req.method === 'POST') {
      // 云端模式下先挡掉，别白读 16MB 再报错
      if (PLUGIN_MODE === 'managed') throw new Error(MANAGED_HINT);
      const buf = await readRawBody(req, 16 * 1024 * 1024);
      const name = String(query.get('name') || 'plugin.zip');
      const r = await pluginMgr.install(buf, name);
      log.info('plugin', `已安装插件 ${r.id} v${r.version}` + (r.loaded ? '' : '（加载失败: ' + r.error + '）'));
      return ok(res, { result: r, plugins: pluginMgr.list() });
    }

    // 总开关：关掉后所有插件都不加载、也不收消息
    if (sub === 'toggle' && req.method === 'POST') {
      const b = await readBody(req);
      cfg.plugins.enabled = !!b.enabled;
      device.save(cfg);
      if (!cfg.plugins.enabled) {
        pluginMgr.closeAll();
        pluginMgr.plugins.clear();
        log.info('plugin', '插件系统已关闭，所有插件停止运行');
      } else {
        await pluginMgr.init();
        log.info('plugin', '插件系统已开启');
      }
      return ok(res, { enabled: cfg.plugins.enabled, list: pluginMgr.list() });
    }

    // 重新扫描目录。用户直接往 ~/.watch-parent-cli/plugins 里丢文件夹时用这个，
    // 不用重启程序
    if (sub === 'rescan' && req.method === 'POST') {
      pluginMgr.closeAll();
      pluginMgr.plugins.clear();
      pluginMgr.lastError.clear();
      await pluginMgr.init();
      return ok(res, { list: pluginMgr.list() });
    }

    const id = decodeURIComponent(sub);
    const action = parts[3] || '';
    const p = pluginMgr.get(id);

    // 封面图
    if (action === 'cover' && req.method === 'GET') {
      const c = pluginMgr.coverFile(id);
      if (c.url) { res.writeHead(302, { Location: c.url }); return res.end(); }
      const buf = fs.readFileSync(c.file);
      res.writeHead(200, { 'Content-Type': mimeOf(c.file), 'Cache-Control': 'no-cache', 'Content-Length': buf.length });
      return res.end(buf);
    }

    if (action === 'enable' && req.method === 'POST') {
      if (!p) throw new Error('插件不存在');
      if (!cfg.plugins.enabled) throw new Error('插件系统总开关是关的，先打开它');
      const list = await pluginMgr.enable(id);
      log.info('plugin', `已启用插件 ${id}`);
      return ok(res, { list });
    }

    if (action === 'disable' && req.method === 'POST') {
      if (!p) throw new Error('插件不存在');
      const list = await pluginMgr.disable(id);
      log.info('plugin', `已禁用插件 ${id}`);
      return ok(res, { list });
    }

    if (action === 'reload' && req.method === 'POST') {
      if (!p) throw new Error('插件不存在');
      const list = await pluginMgr.reload(id);
      return ok(res, { list });
    }

    if (action === 'config' && req.method === 'GET') {
      if (!p) throw new Error('插件不存在');
      return ok(res, { config: p.configAll(), fields: p.manifest.config });
    }

    if (action === 'config' && req.method === 'POST') {
      if (!p) throw new Error('插件不存在');
      const b = await readBody(req);
      const vals = p.configSet(b.values || b);
      log.info('plugin', `插件 ${id} 的配置已更新`);
      return ok(res, { config: vals, list: pluginMgr.list() });
    }

    // 卸载：不可逆（插件目录连数据一起删），确认值必须和 id 一致
    if (action === 'uninstall' && req.method === 'POST') {
      if (!p) throw new Error('插件不存在');
      const b = await readBody(req);
      if (String(b.confirm || '') !== id) {
        throw new Error('卸载需要二次确认：confirm 字段要填插件的 id（' + id + '）');
      }
      const list = await pluginMgr.uninstall(id);
      return ok(res, { list });
    }

    throw new Error('接口不存在');
  }

  // 插件自己的东西：/api/plugin/<id>/ui/* 静态页面、/api/plugin/<id>/api/* 自定义接口
  async function handlePluginSelf(req, res, parts, query) {
    const id = decodeURIComponent(parts[2]);
    const rest = parts.slice(3);

    if (rest[0] === 'ui') {
      const rel = rest.slice(1).join('/');
      const { file } = pluginMgr.uiFile(id, rel);
      const buf = fs.readFileSync(file);
      const type = mimeOf(file);
      // 插件页每次都重新读，改完刷新就生效，不用重启（插件页面本来就是调试期改动最频繁的）
      if (type.indexOf('text/html') === 0) {
        const html = injectPluginBridge(buf.toString('utf8'), id);
        return send(res, 200, type, html);
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': buf.length });
      return res.end(buf);
    }

    if (rest[0] === 'api') {
      const q = {};
      query.forEach((v, k) => { q[k] = v; });

      let body = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const raw = await readRawBody(req, 4 * 1024 * 1024);
        const ct = String(req.headers['content-type'] || '');
        if (/json/i.test(ct)) {
          try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (e) { body = {}; }
        } else {
          body = raw.toString('utf8');
        }
      }

      const ctx = {
        method: req.method,
        path: '/' + rest.slice(1).join('/'),
        query: q,
        body,
        headers: {
          'content-type': req.headers['content-type'] || '',
          'user-agent': req.headers['user-agent'] || '',
        },
        ip: clientIp(req),
      };
      const r = await pluginMgr.handleRequest(id, ctx);
      const payload = Buffer.isBuffer(r.body)
        ? r.body
        : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      res.writeHead(r.status, { 'Content-Type': r.type, 'Cache-Control': 'no-store', 'Content-Length': payload.length });
      return res.end(payload);
    }

    throw new Error('接口不存在');
  }

  // ===== 云端托管平台专用接口 =====
  // 平台和实例共享 INSTANCE_SECRET，平台用它对一张 t:'platform' 的票据签名来调这里。
  // 只有平台知道密钥，所以这条通道等价于「平台身份」，不需要也不接受 Cookie。
  //
  // 为什么不让平台直接往实例目录写文件：实例降权到 jzinstN、HOME 是 700，
  // 平台（admin-0）根本没有写权限。走 HTTP 让实例自己装，是唯一不需要 root 的路子。
  async function handlePlatform(req, res, parts, query) {
    const tk = String(req.headers['x-jz-ticket'] || query.get('ticket') || '').trim();
    if (!verifyTicket(tk, 'platform')) {
      log.warn('platform', `平台票据校验失败 ip=${clientIp(req)}`);
      return sendJson(res, 401, { ok: false, error: '平台票据无效或已过期' });
    }

    const action = parts[3] || '';

    if (parts[2] === 'plugins' && !action && req.method === 'GET') {
      return ok(res, { mode: PLUGIN_MODE, list: pluginMgr.list() });
    }

    if (parts[2] === 'plugins' && action === 'install' && req.method === 'POST') {
      const buf = await readRawBody(req, 16 * 1024 * 1024);
      const name = String(query.get('name') || 'plugin.zip');
      const r = await pluginMgr.install(buf, name, { by: 'platform' });
      log.info('plugin', `平台下发安装 ${r.id} v${r.version}` + (r.loaded ? '' : '（加载失败: ' + r.error + '）'));
      return ok(res, { result: r, list: pluginMgr.list() });
    }

    if (parts[2] === 'plugins' && action === 'uninstall' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String((b && b.id) || '').trim();
      if (!id) throw new Error('缺少插件 id');
      // 平台只能卸「平台装过的」。内置插件和用户自己传的都不归它管，
      // 否则平台侧一个越权调用就能把用户本地装的插件删了
      if (!pluginMgr.isManaged(id)) throw new Error('这个插件不是从插件市场装的，平台不能卸载');
      const list = await pluginMgr.uninstall(id);
      log.info('plugin', `平台下发卸载 ${id}`);
      return ok(res, { list });
    }

    throw new Error('接口不存在');
  }

  async function handleApi(req, res, parts, query) {
    // ===== 插件 =====
    // 注意单复数：/api/plugins/* 是管理（列表/上传/启停），/api/plugin/<id>/* 是插件自己的
    if (parts[1] === 'plugins') return handlePlugins(req, res, parts, query);
    if (parts[1] === 'plugin' && parts[2]) return handlePluginSelf(req, res, parts, query);

    if (parts[1] === 'watches') return ok(res, { watches: await watchList(query.get('refresh') === '1') });
    if (parts[1] === 'notices') return ok(res, { notices: ensure(await api.getNoticeNew()) });

    // 云端更新：查有没有新版 / 用户在弹窗里点了「更新并重启」
    // check 是只读的，apply 会让平台重启本实例（连接会断，前端负责等它回来）
    if (parts[1] === 'update') {
      if ((parts[2] === 'check' || !parts[2]) && req.method === 'GET') {
        return ok(res, await checkUpdate(query.get('force') === '1'));
      }
      if (parts[2] === 'apply' && req.method === 'POST') {
        return ok(res, await applyUpdate());
      }
      throw new Error('接口不存在');
    }

    // 主页: 系统/进程资源 + 账号概览(前端每 3 秒轮询)
    if (parts[1] === 'system') return ok(res, await sysInfo());

    // 每日一言: 当天缓存, ?refresh=1 强制换一条
    if (parts[1] === 'yiyan') return ok(res, await fetchYiyan(query.get('refresh') === '1'));

    // 实时日志: 拉取 / SSE 推送 / 切级别 / 清空
    if (parts[1] === 'logs') {
      if (!parts[2] && req.method === 'GET') {
        return ok(res, {
          level: log.levelName(),
          levels: ['debug', 'info', 'warn', 'error', 'silent'],
          seq: log.seq(),
          subscribers: log.subscriberCount(),
          entries: log.recent(clampInt(query.get('limit') || 300, 1, 1000, 300), Number(query.get('since') || 0) || 0),
        });
      }
      if (parts[2] === 'stream' && req.method === 'GET') {
        streamLogs(req, res);
        return null; // 响应由 streamLogs 接管, 不能再走 ok()/JSON 包装
      }
      if (parts[2] === 'level' && req.method === 'POST') {
        const b = await readBody(req);
        const name = String(b.level || '').toLowerCase();
        if (log.LEVELS[name] == null) throw new Error('级别只能是 debug / info / warn / error / silent');
        log.setLevel(name);
        // 这条会在切级别之后写, 所以切到 silent 时看不到 —— 前端会回读 level 确认
        log.info('webui', '日志级别已切换为 ' + name);
        return ok(res, { level: log.levelName() });
      }
      if (!parts[2] && req.method === 'DELETE') {
        const seq = log.clear();
        return ok(res, { cleared: true, seq });
      }
      throw new Error('接口不存在');
    }

    // OneBot 接入信息与设置
    if (parts[1] === 'onebot') {
      // 保存公共设置: 心跳 / QQ 兼容。端口、令牌、会话范围都是按手表的, 见下面的 watch 路由
      if (parts[2] === 'config' && req.method === 'POST') {
        const b = await readBody(req);
        const o = Object.assign({}, cfg.onebot || {});
        if (b.heartbeat != null) o.heartbeat = clampInt(b.heartbeat, 0, 600, 30);
        if (b.qqCompat != null) o.qqCompat = !!b.qqCompat;
        cfg.onebot = o;
        device.save(cfg);
        await restartOneBot();
        return ok(res, await onebotStateAll());
      }

      // 按手表分开的实例: 保存某块表的端口 / 令牌 / 会话范围
      if (parts[2] === 'watch' && parts[3] === 'token' && req.method === 'POST') {
        const b = await readBody(req);
        const wid = String(b.watchId || '').trim();
        const which = String(b.which || '');
        if (!wid) throw new Error('缺少 watchId');
        if (which !== 'http' && which !== 'ws') throw new Error('which 只能是 http 或 ws');
        const wc = device.normalizeOnebotWatch((cfg.onebotWatches || {})[wid] || {});
        wc[which] = Object.assign({}, wc[which], { token: '' });
        cfg.onebotWatches = cfg.onebotWatches || {};
        cfg.onebotWatches[wid] = wc;
        device.save(cfg);
        await restartOneBot();
        return ok(res, await onebotStateAll());
      }

      if (parts[2] === 'watch' && req.method === 'POST') {
        const b = await readBody(req);
        const wid = String(b.watchId || '').trim();
        if (!wid) throw new Error('缺少 watchId');
        const wc = device.normalizeOnebotWatch((cfg.onebotWatches || {})[wid] || {});

        if (b.enabled != null) wc.enabled = !!b.enabled;
        if (b.http) {
          if (b.http.enabled != null) wc.http.enabled = !!b.http.enabled;
          if (b.http.host != null && String(b.http.host).trim()) wc.http.host = String(b.http.host).trim();
          if (b.http.port != null) wc.http.port = clampInt(b.http.port, 0, 65535, 0);
        }
        if (b.ws) {
          if (b.ws.enabled != null) wc.ws.enabled = !!b.ws.enabled;
          if (b.ws.host != null && String(b.ws.host).trim()) wc.ws.host = String(b.ws.host).trim();
          if (b.ws.port != null) wc.ws.port = clampInt(b.ws.port, 0, 65535, 0);
        }
        if (b.wsClient) {
          if (b.wsClient.enabled != null) wc.wsClient.enabled = !!b.wsClient.enabled;
          if (b.wsClient.url != null) wc.wsClient.url = String(b.wsClient.url).trim();
          if (b.wsClient.token != null) wc.wsClient.token = String(b.wsClient.token).trim();
          if (b.wsClient.reconnect != null) wc.wsClient.reconnect = clampInt(b.wsClient.reconnect, 1, 3600, 5);
        }
        if (wc.wsClient.enabled && !/^wss?:\/\//i.test(wc.wsClient.url)) {
          throw new Error('反向 WS 地址必须以 ws:// 或 wss:// 开头');
        }
        // targets: 空数组 = 按手表自动匹配; 传了就只认这些会话
        if (b.targets != null) {
          const arr = Array.isArray(b.targets) ? b.targets : [];
          wc.targets = arr.map((x) => String(x)).filter((x) => /^[sg]:.+/.test(x));
        }
        // 端口没填就自动分配, 避免和别的手表撞车
        if (!wc.http.port || !wc.ws.port) {
          const p = pickPorts(wid);
          if (!wc.http.port) wc.http.port = p.http;
          if (!wc.ws.port) wc.ws.port = p.ws;
        }
        if (wc.http.enabled && wc.ws.enabled && Number(wc.http.port) === Number(wc.ws.port)) {
          throw new Error('HTTP 与 WS 不能使用同一个端口');
        }
        const used = usedPorts(wid);
        if (wc.http.enabled && used.has(Number(wc.http.port))) throw new Error(`HTTP 端口 ${wc.http.port} 已经被别的实例占用`);
        if (wc.ws.enabled && used.has(Number(wc.ws.port))) throw new Error(`WS 端口 ${wc.ws.port} 已经被别的实例占用`);

        cfg.onebotWatches = cfg.onebotWatches || {};
        cfg.onebotWatches[wid] = wc;
        device.save(cfg);
        log.info('onebot', `手表 ${wid} 的配置已保存（${wc.enabled ? '启用' : '停用'}）`);
        await restartOneBot();
        return ok(res, await onebotStateAll());
      }

      // 注意: 没有全局令牌路由了。令牌一律按手表, 走 /api/onebot/watch/token

      if (!parts[2] && req.method === 'GET') return ok(res, await onebotStateAll());
      throw new Error('接口不存在');
    }

    // ===== 微聊 B 站点播(按手表) =====
    // 配置只有按手表这一种: cfg.biliBots[watchId], 每块表自己的开关/会话范围/限额
    if (parts[1] === 'bili') {
      if (!parts[2] && req.method === 'GET') return ok(res, await biliState());

      // 保存某块表的点播设置
      if (parts[2] === 'watch' && req.method === 'POST') {
        const b = await readBody(req);
        const wid = String(b.watchId || '').trim();
        if (!wid) throw new Error('缺少 watchId：点播是按手表分开设置的');
        const c = device.normalizeBiliWatch((cfg.biliBots || {})[wid] || {});
        if (b.enabled != null) c.enabled = !!b.enabled;
        // 时长/大小/每天条数都收敛到合理区间; 大小上限卡在 100MB, 微聊视频上传本身就过不去
        if (b.maxDuration != null) c.maxDuration = clampInt(b.maxDuration, 0, 7200, c.maxDuration);
        if (b.maxBytes != null) c.maxBytes = clampInt(b.maxBytes, 0, 100 * 1024 * 1024, c.maxBytes);
        if (b.maxPerDay != null) c.maxPerDay = clampInt(b.maxPerDay, 0, 999, c.maxPerDay);
        if (b.commentImage != null) c.commentImage = !!b.commentImage;
        if (b.searchImage != null) c.searchImage = !!b.searchImage;
        if (b.targets != null) {
          const arr = Array.isArray(b.targets) ? b.targets : [];
          c.targets = arr.map((x) => String(x)).filter((x) => /^[sg]:.+/.test(x));
        }
        cfg.biliBots = cfg.biliBots || {};
        cfg.biliBots[wid] = c;
        device.save(cfg);
        log.info('bili', `手表 ${wid} 的点播已${c.enabled ? '启用' : '关闭'}（`
          + (c.targets.length ? '指定 ' + c.targets.length + ' 个会话' : '按手表自动匹配会话') + '）');
        return ok(res, await biliState());
      }

      // 测试搜索: 网页上点一下就能确认 B 站通不通, 不用真去手表上发命令
      if (parts[2] === 'search' && !parts[3] && req.method === 'GET') {
        const kw = String(query.get('kw') || '').trim();
        if (!kw) throw new Error('缺少搜索关键词');
        const list = await bili.search(kw, { limit: BILI_MAX_RESULTS });
        return ok(res, { keyword: kw, list });
      }

      // 预览搜索结果图: 和手表上收到的是同一张图, 直接回 PNG(前端用 <img src> 打开)
      if (parts[2] === 'search' && parts[3] === 'preview' && req.method === 'GET') {
        const kw = String(query.get('kw') || '').trim();
        if (!kw) throw new Error('缺少搜索关键词');
        const list = await bili.search(kw, { limit: BILI_MAX_RESULTS });
        const img = await buildSearchImage(kw, list);
        log.info('bili', `预览搜索结果图「${kw}」：${img.width}x${img.height}（${img.count} 条）`);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': img.png.length,
          'Cache-Control': 'no-store',
          'X-Search-Count': String(img.count),
        });
        return res.end(img.png);
      }

      // 评论长图的全局设置(账号级的 SESSDATA + 抓多少条 / 图多高)
      if (parts[2] === 'comment' && !parts[3]) {
        if (req.method === 'GET') return ok(res, biliCommentCfg());
        if (req.method === 'POST') {
          const b = await readBody(req);
          const cur = biliCommentCfg();
          cfg.biliComment = device.normalizeBiliComment({
            sessdata: b.sessdata != null ? String(b.sessdata) : cur.sessdata,
            maxComments: b.maxComments != null ? b.maxComments : cur.maxComments,
            maxHeight: b.maxHeight != null ? b.maxHeight : cur.maxHeight,
          });
          device.save(cfg);
          log.info('bili', '评论长图设置已更新（'
            + (cfg.biliComment.sessdata ? '已填 SESSDATA' : '没填 SESSDATA，只能取热门评论') + '）');
          return ok(res, biliCommentCfg());
        }
      }

      // 预览: 网页上填个 BV 号就能直接看到长图长什么样, 不用真去手表上点播一遍
      // 直接回 PNG(不是 JSON), 前端用 <img src> 打开就行
      if (parts[2] === 'comment' && parts[3] === 'preview' && req.method === 'GET') {
        const bvid = String(query.get('bvid') || '').trim();
        if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) throw new Error('视频编号不对（要 BV 开头的那种）');
        const cmt = await buildCommentImage(bvid);
        log.info('bili', `预览评论长图 ${bvid}：${cmt.width}x${cmt.height}（画了 ${cmt.shown} 条）`);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': cmt.png.length,
          'Cache-Control': 'no-store',
          // 顺手把统计塞进响应头, 前端不用再多调一次接口
          'X-Comment-Shown': String(cmt.shown),
          'X-Comment-Total': String(cmt.data.total || 0),
          'X-Comment-Complete': cmt.data.complete ? '1' : '0',
        });
        return res.end(cmt.png);
      }

      throw new Error('接口不存在');
    }

    // ===== 对外 API: 加好友口令 / 好友管理 =====
    // 令牌只有按手表这一种: extApi[watchId], 令牌即身份, 只能操作自己那块表
    if (parts[1] === 'genius-api') {
      const state = async () => {
        const per = cfg.extApi || {};
        await ensureWatchNames(false);
        const watches = (watchNames || []).map((w) => {
          const e = per[w.watchId] || {};
          return { watchId: w.watchId, name: w.name, enabled: !!e.enabled, token: e.token || '' };
        });
        return { watches };
      };
      if (!parts[2] && req.method === 'GET') return ok(res, await state());

      // 开关和重置令牌都必须指定是哪块表
      if ((parts[2] === 'config' || parts[2] === 'token') && req.method === 'POST') {
        const b = await readBody(req);
        const wid = String(b.watchId || '').trim();
        if (!wid) throw new Error('缺少 watchId：对外接口的令牌是按手表分开的');
        cfg.extApi = cfg.extApi || {};
        const e = Object.assign({ enabled: false, token: '' }, cfg.extApi[wid] || {});
        if (parts[2] === 'config') {
          if (b.enabled != null) e.enabled = !!b.enabled;
          // 开启时若还没令牌, 立刻生成一个, 用户马上就能复制去用
          if (e.enabled && !e.token) e.token = newGeniusToken();
        } else {
          e.token = newGeniusToken();
        }
        cfg.extApi[wid] = e;
        device.save(cfg);
        log.info('geniusapi', `手表 ${wid} 的对外接口已` + (parts[2] === 'token' ? '重置令牌' : (e.enabled ? '启用' : '关闭')));
        return ok(res, await state());
      }

      throw new Error('接口不存在');
    }

    // ===== 公告: 代理项目官方公告服务(客户端只拉取 + 渲染) =====
    if (parts[1] === 'announcements') {
      if (!parts[2]) return ok(res, await fetchNotices(query.get('refresh') === '1'));
      return ok(res, { notice: await fetchNotice(parts[2]) });
    }

    // ===== 账号 / 配置 =====
    if (parts[1] === 'account') {
      if (parts[2] === 'login' && req.method === 'POST') {
        const b = await readBody(req);
        const account = String(b.account || '').trim();
        const password = String(b.password || '');
        if (!account || !password) throw new Error('请输入账号和密码');
        const r = await sso.loginByPassword(cfg, account, password);
        if (!r.json || r.json.code !== '000001') {
          if (r.json && r.json.code === '010410') {
            let ch = {};
            try { ch = typeof r.json.data === 'string' ? JSON.parse(r.json.data) : (r.json.data || {}); } catch (e) { ch = {}; }
            return ok(res, {
              needVerify: true,
              account,
              challenge: {
                checkCode: ch.checkCode,
                checkTypes: ch.checkTypes || [],
                endTime: ch.endTime,
                mobileNumber: ch.mobileNumber,
              },
            });
          }
          const msg = (r.json && (r.json.desc || r.json.message)) || '账号或密码错误';
          throw new Error('登录失败: ' + msg);
        }
        await finishLogin(account, r.json.data, r.rsaKey);
        return ok(res, { userName: cfg.userName, loggedIn: true });
      }

      // 新设备验证: 获取密保问题
      if (parts[2] === 'verify' && parts[3] === 'questions' && req.method === 'POST') {
        const b = await readBody(req);
        const account = String(b.account || '').trim();
        const checkCode = String(b.checkCode || '');
        if (!account || !checkCode) throw new Error('缺少验证参数');
        const r = await sso.getSecurityQuestions(cfg, { userName: account, checkCode, changeDeviceType: 0 });
        const j = r.json || {};
        if (j.code !== '000001') throw new Error('获取密保问题失败: ' + (j.desc || j.code || '未知错误'));
        let data = j.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
        data = data || {};
        return ok(res, {
          questions: data.securityQuestions || [],
          tip: data.tip || '',
          endTime: data.endTime || 0,
          checkCode,
        });
      }

      // 新设备验证: 提交密保答案并换取登录票据
      if (parts[2] === 'verify' && parts[3] === 'question' && req.method === 'POST') {
        const b = await readBody(req);
        const account = String(b.account || '').trim();
        const checkCode = String(b.checkCode || '');
        const questionId = String(b.questionId || '');
        const answer = String(b.answer || '').trim();
        // 密码只在这一步的内存里过一下, 不落盘; 用于换票失败时兜底重新登录
        const password = String(b.password || '');
        if (!account || !checkCode || !questionId || !answer) throw new Error('请填写完整验证信息');

        const vr = await sso.validateSecurityQuestion(cfg, { userName: account, checkCode, questionId, answer, changeDeviceType: 0 });
        if (!vr.json || vr.json.code !== '000001') {
          const vj = vr.json || {};
          throw new Error('密保验证失败: ' + (vj.desc || vj.code || '未知错误'));
        }

        // 换票: 000002 会自动间隔重试(见 sso.changeDeviceLoginRetry 的注释)
        const cr = await sso.changeDeviceLoginRetry(cfg, {
          mobilePhone: account,
          checkCode,
          checkType: 4,
          changeDeviceType: 0,
          randCode: '',
        });
        if (cr.json && cr.json.code === '000001') {
          await finishLogin(account, cr.json.data, cr.rsaKey);
          return ok(res, { userName: cfg.userName, loggedIn: true });
        }

        // 换票还是失败: 走「大退重登」那条路 —— 验证通过后服务端已经信任这台设备,
        // 重新用账密 loginV3 就能直接拿到票据(用户实测有效)。密码没带上来就明确提示。
        const cj = cr.json || {};
        const code = cj.code || '';
        if (password) {
          log.warn('account', `换取票据失败(${code}), 改用账密重新登录`);
          const rr = await sso.loginByPassword(cfg, account, password);
          if (rr.json && rr.json.code === '000001') {
            await finishLogin(account, rr.json.data, rr.rsaKey);
            return ok(res, { userName: cfg.userName, loggedIn: true, viaRelogin: true });
          }
          const rj = rr.json || {};
          throw new Error('换取登录票据失败: ' + (cj.desc || code || '未知错误') +
            '；重新登录也没成功: ' + (rj.desc || rj.code || '未知错误'));
        }
        throw new Error('换取登录票据失败: ' + (cj.desc || code || '未知错误') +
          '。验证其实已经通过了，点「登录」再登一次就能进去（服务端这时已经认这台设备）');
      }
      if (parts[2] === 'logout' && req.method === 'POST') {
        cfg.token = null;
        cfg.authId = null;
        cfg.mobileId = null;
        device.save(cfg);
        cache.at = 0;
        capCache.clear();
        avatarCache.clear();
        chatTargets = null;
        chatLog.clear();
        if (im) { try { im.close(); } catch (e) { /* ignore */ } im = null; }
        return ok(res, { result: true });
      }
      return ok(res, {
        userName: cfg.userName || '',
        loggedIn: !!cfg.token,
        authId: cfg.authId || '',
        mobileId: cfg.mobileId || '',
      });
    }

    // ===== WebUI 外观: 自定义背景 =====
    if (parts[1] === 'ui' && parts[2] === 'background') {
      if (req.method === 'GET') return ok(res, { background: cfg.uiBackground || null });
      if (req.method === 'POST') {
        const b = await readBody(req);
        const bg = b && typeof b.background === 'string' ? b.background : null;
        if (bg && bg.length > 7 * 1024 * 1024) throw new Error('背景图过大, 请控制在 5MB 以内');
        cfg.uiBackground = bg || null;
        device.save(cfg);
        return ok(res, { background: cfg.uiBackground });
      }
    }

    // ===== 白名单链接库 =====
    // 发链接卡片时的预设列表。几万条，全部存在 ~/.watch-parent-cli/links.txt，
    // 由平台后台统一维护、客户端定时拉取。地址写死（平台注入 / 官方链接库），用户改不了。
    // 界面不再一次拿全量（2MB JSON + 两万多个 option 会卡死浏览器），
    // 搜索走 /api/links/search 服务端匹配，一次只回 60 条
    if (parts[1] === 'links') {
      // GET /api/links —— 状态：条数 / 来源 / 上次同步 / 生效地址（不含列表本体）
      if (!parts[2] || parts[2] === 'state') {
        return ok(res, linkLib.state(cfg));
      }
      // GET /api/links/search?q=&limit=&offset= —— 服务端搜索
      if (parts[2] === 'search') {
        return ok(res, linkLib.search(query.get('q') || '', {
          limit: query.get('limit'),
          offset: query.get('offset'),
        }));
      }
      // 原始文本：只读，给导出/排障用（界面不再调它）
      if (parts[2] === 'text') {
        if (req.method === 'GET') return ok(res, { text: linkLib.currentText() });
        // 写入口留着给脚本和排障，界面上已经不提供（列表由平台统一维护）
        if (req.method === 'POST') {
          const b = await readBody(req);
          const r = linkLib.saveText(b && typeof b.text === 'string' ? b.text : '');
          return ok(res, { count: r.count, state: linkLib.state(cfg) });
        }
      }
      // 手动同步一次远端
      if (parts[2] === 'refresh' && req.method === 'POST') {
        const r = await linkLib.refresh(cfg, { force: true });
        if (!r.ok) throw new Error(r.error || '同步失败');
        return ok(res, { count: r.count, notModified: !!r.notModified, state: linkLib.state(cfg) });
      }
      // 自动同步开关。地址不可改，所以这里只认 auto 一个字段
      if (parts[2] === 'auto' && req.method === 'POST') {
        const b = await readBody(req);
        const on = !(b && b.auto === false);
        cfg.links = device.normalizeLinks({ auto: on });
        device.save(cfg);
        // 开关变了要重起定时器，否则关掉了还在跑、打开了又不起
        linkLib.startAutoRefresh(cfg, log);
        return ok(res, { state: linkLib.state(cfg) });
      }
      // 丢掉本地覆盖，回到程序自带的内置表（排障用，界面不提供）
      if (parts[2] === 'reset' && req.method === 'POST') {
        const r = linkLib.reset();
        linkLib.startAutoRefresh(cfg, log);
        return ok(res, { count: r.count, state: linkLib.state(cfg) });
      }
      // 地址是不可改的：老客户端如果还在调 /api/links/remote，明确拒掉而不是装作成功
      throw new Error('链接库地址由平台统一下发，不能修改');
    }

    if (parts[1] === 'config') {
      const show = JSON.parse(JSON.stringify(cfg));
      if (show.token) show.token = String(show.token).slice(0, 24) + '...';
      if (show.ai && show.ai.apiKey) show.ai.apiKey = String(show.ai.apiKey).slice(0, 6) + '...';
      return ok(res, { config: show });
    }

    // ===== AI 助手 =====
    if (parts[1] === 'ai') {
      const a = cfg.ai;
      if (parts[2] === 'config' && req.method === 'POST') {
        // 托管模式下接口地址/密钥/模型由平台统一提供，改了也不生效
        // （运行时读的是 JZ_AI_* 环境变量），所以直接拒，而不是「假装保存成功」
        if (AI_MANAGED) throw new Error('AI 接口由云端平台统一配置，实例里不能修改');
        const b = await readBody(req);
        if (b.baseUrl != null) a.baseUrl = String(b.baseUrl).trim();
        if (b.apiKey) a.apiKey = String(b.apiKey);
        if (b.model != null && String(b.model).trim()) a.model = String(b.model).trim();
        if (b.temperature != null && b.temperature !== '') a.temperature = Number(b.temperature);
        device.save(cfg);
        return ok(res, { result: true });
      }
      if (parts[2] === 'sessions' && req.method === 'POST') {
        // 优化/修复：anjianhe —— 会话 key 统一成 s:/g:，并把没对上的 key 回给前端
        const b = await readBody(req);
        const keys = Array.isArray(b.keys) ? b.keys.map(String) : [];
        const targets = await loadChatTargets();
        const picked = [];
        const missed = [];
        keys.forEach((k) => {
          const t = targets.find((x) => x.key === k);
          if (!t) { missed.push(k); return; }
          // key 统一成聊天会话的写法（s:/g:），和 resolveChatKey 完全对齐
          picked.push(t.type === 'group'
            ? { key: 'g:' + t.dialogId, type: 'group', name: t.name, dialogId: t.dialogId }
            : { key: 's:' + t.receiverId, type: 'single', name: t.name, receiverId: t.receiverId });
        });
        a.sessions = picked;
        device.save(cfg);
        log.info('ai', `启用会话已更新 ${picked.length} 个`
          + (missed.length ? `；${missed.length} 个没对上会话列表（会话还没加载完时会这样，刷新后重勾）: ${JSON.stringify(missed.slice(0, 5))}` : ''));
        return ok(res, { count: picked.length, missed });
      }
      if (parts[2] === 'trigger' && req.method === 'POST') {
        const b = await readBody(req);
        a.trigger = b.trigger === 'keyword' ? 'keyword' : 'auto';
        // 关键词统一走归一化：全角折半角、去零宽、去重，避免「看着一样但就是匹配不上」
        if (b.keywords != null) a.keywords = aiTrigger.splitKeywords(b.keywords);
        if (b.keywordsMode != null) {
          const mode = String(b.keywordsMode);
          a.keywordsMode = ['auto', 'prefix', 'contains'].indexOf(mode) >= 0 ? mode : 'auto';
        }
        device.save(cfg);
        log.info('ai', `触发方式已更新 trigger=${a.trigger} mode=${a.keywordsMode || 'auto'} keywords=${JSON.stringify(a.keywords || [])}`);
        return ok(res, { trigger: a.trigger, keywords: a.keywords, keywordsMode: a.keywordsMode || 'auto' });
      }
      if (parts[2] === 'prompt' && req.method === 'POST') {
        const b = await readBody(req);
        a.systemPrompt = String(b.systemPrompt || '');
        device.save(cfg);
        return ok(res, { systemPrompt: a.systemPrompt });
      }
      // 识图设置：开关 + 单图上限 + 看图提示词。
      // 托管模式下这些都属于「怎么用」，不是「连哪」，所以照常允许改
      if (parts[2] === 'vision' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.vision != null) a.vision = b.vision !== false && b.vision !== 'false';
        if (b.visionMaxBytes != null && b.visionMaxBytes !== '') {
          const n = Number(b.visionMaxBytes);
          if (Number.isFinite(n)) a.visionMaxBytes = Math.min(5 * 1024 * 1024, Math.max(256 * 1024, n));
        }
        if (b.visionPrompt != null) a.visionPrompt = String(b.visionPrompt);
        device.save(cfg);
        log.info('ai', `识图设置已更新 vision=${a.vision !== false} maxBytes=${a.visionMaxBytes}`);
        return ok(res, { vision: a.vision !== false, visionMaxBytes: a.visionMaxBytes, visionPrompt: a.visionPrompt });
      }
      if (parts[2] === 'start' && req.method === 'POST') {
        // 优化/修复：anjianhe —— 启动失败要说清楚是缺地址、缺模型还是缺会话；
        // 启动成功则落盘 autoStart，进程重启后自动恢复
        // 托管模式下 baseUrl 来自环境变量，不能只看 cfg.ai.baseUrl
        const rt = aiRuntime();
        if (!rt.baseUrl) {
          throw new Error(AI_MANAGED
            ? '托管模式没拿到 AI 网关地址（JZ_AI_BASE_URL），检查实例环境变量'
            : '请先配置 AI 接口地址');
        }
        if (!rt.model) {
          throw new Error('没有模型名：托管模式由 JZ_AI_MODEL 下发，自带密钥时请在「接口配置」里填');
        }
        await startAiAuto('手动启动');
        if (!aiRunning) throw new Error('没有启用任何会话，AI 不会开始监听');
        // 记住这次启动，进程/WebUI 重启后自动恢复，不用每次回来手动点一下
        a.autoStart = true;
        device.save(cfg);
        return ok(res, { running: true, model: rt.model, managed: AI_MANAGED });
      }
      if (parts[2] === 'stop' && req.method === 'POST') {
        aiRunning = false;
        a.autoStart = false;
        device.save(cfg);
        log.info('ai', 'AI 已停止（下次启动不再自动恢复，除非重新点启动）');
        return ok(res, { running: false });
      }
      // 一键自检：绕过 IM 和会话判断，直接拿配置发一句话给模型。
      // 「AI 不回复」时先点这个 —— 上游通不通、模型名对不对，一次就分清了。
      // 新增：anjianhe（对应前端「自检（直连模型）」按钮）
      if (parts[2] === 'test' && req.method === 'POST') {
        const rt = aiRuntime();
        if (!rt.baseUrl) {
          throw new Error(AI_MANAGED
            ? '托管模式没拿到 AI 网关地址（JZ_AI_BASE_URL）'
            : '请先配置 AI 接口地址');
        }
        const b = await readBody(req).catch(() => ({}));
        const text = String((b && b.text) || '连通性测试，请只回复 ok').slice(0, 200);
        const t0 = Date.now();
        try {
          const reply = await aiChat(rt, [
            { role: 'system', content: String(rt.systemPrompt || '').slice(0, 1000) },
            { role: 'user', content: text },
          ]);
          return ok(res, {
            ok: true, managed: AI_MANAGED, source: AI_SOURCE,
            model: rt.model || '', ms: Date.now() - t0, reply: String(reply).slice(0, 500),
          });
        } catch (e) {
          // 把上游错误原样抛给前端：401/402/429/模型不存在，用户需要看到原文
          throw new Error('AI 自检失败（' + (rt.model || '未设置模型') + '）: '
            + (e && e.message ? e.message : String(e)));
        }
      }

      const targets = await loadChatTargets().catch(() => []);
      // 用 sessionKeyOf 生成「启用了哪些会话」：老配置里存的可能是 single:123，
      // 直接拼 's:'+receiverId 会在 receiverId 缺失时得到 's:undefined'，勾选状态全丢
      const enabledKeys = (a.sessions || []).map((s) => aiTrigger.sessionKeyOf(s)).filter(Boolean);
      const rt = aiRuntime();
      return ok(res, {
        // managed=true 时前端把「接口配置」整块换成只读；
        // source 决定文案（platform=官方 AI，own=自带密钥）
        managed: AI_MANAGED,
        source: AI_MANAGED ? AI_SOURCE : '',
        config: {
          // 托管模式下 baseUrl 显示网关地址没意义（用户也改不了），前端会换成固定文案；
          // 这里仍然回真实值，方便脚本排障
          baseUrl: rt.baseUrl || '',
          hasKey: !!rt.apiKey,
          apiKeyMask: rt.apiKey ? String(rt.apiKey).slice(0, 6) + '...' : '',
          model: rt.model || '',
          temperature: a.temperature,
          trigger: a.trigger || 'auto',
          keywords: a.keywords || [],
          keywordsMode: a.keywordsMode || 'auto',
          timeoutMs: a.timeoutMs,
          systemPrompt: a.systemPrompt || '',
          // 识图：托管模式下模型由平台定，能不能看图取决于上游模型，
          // 所以这里只回「用户有没有开」，不保证一定可用（自检会暴露真实能力）
          vision: a.vision !== false,
          visionMaxBytes: a.visionMaxBytes,
          visionPrompt: a.visionPrompt || '',
        },
        sessions: a.sessions,
        // autoStart=true 表示「上次是开着的」，进程重启会自动恢复
        autoStart: a.autoStart !== false,
        running: aiRunning,
        connected: !!(im && im.connected),
        targets: targets.map((t) => ({
          key: t.key, type: t.type, name: t.name, sub: t.sub || '',
          enabled: enabledKeys.includes(t.key),
        })),
        // 排查用：触发链上各环节的当前值，一眼看出是哪一步空的
        // 新增：anjianhe
        diagnostics: {
          selfImAccountId: (im && im.imAccountId) || cfg.imAccountId || 0,
          chatTargets: (chatTargets || []).length,
          sessions: (a.sessions || []).length,
          keywords: (a.keywords || []).length,
          hasBaseUrl: !!rt.baseUrl,
          hasKey: !!rt.apiKey,
          model: rt.model || '',
        },
      });
    }

    // ===== 聊天 =====
    if (parts[1] === 'chats') {
      if (parts[2] === 'emojis') {
        // url 为本地预览图地址, 供前端九宫格直接渲染 <img>
        return ok(res, {
          emojis: EMOJI_PRESET.emojis.map((e, i) => ({
            index: i + 1,
            code: e.code,
            desc: e.desc,
            descEn: e.descEn || '',
            url: emojiAsset(e.code),
          })),
        });
      }
      if (parts[2] === 'link-presets') {
        // 手表端 H5 白名单链接。几万条，默认只回元信息（不带列表本体），
        // 界面正常走 /api/links/search；真要全量（脚本/导出）带 ?full=1
        return ok(res, linkLib.state(cfg, { full: query.get('full') === '1' }));
      }
      if (parts[2] === 'connect' && req.method === 'POST') {
        const c = await ensureIM();
        return ok(res, { connected: true, imAccountId: c.imAccountId });
      }
      if (parts[2] === 'status') {
        return ok(res, imStatus());
      }
      if (parts[2] === 'messages') {
        // 顺带把连接状态捎回去: 前端每 3 秒轮询这一个接口就够了,
        // 「连上了但一直没收到数据」要能在页面上看出来, 否则只能干等
        return ok(res, { messages: chatLog.get(query.get('key') || '') || [], im: imStatus() });
      }
      if (parts[2] === 'send' && req.method === 'POST') {
        const r = await sendChat(await readBody(req));
        return ok(res, { result: true, url: r && r.url, parts: r && r.parts });
      }
      if (parts[2] === 'voice' && req.method === 'POST') {
        const b = await readBody(req);
        const key = String(b.key || '');
        const targets = await loadChatTargets();
        const t = targets.find((x) => x.key === key);
        if (!t) throw new Error('会话不存在');
        const data = String(b.data || '');
        if (!data) throw new Error('录音数据为空');
        const buf = Buffer.from(data, 'base64');
        if (!buf.length) throw new Error('录音数据为空');
        if (buf.length > 10 * 1024 * 1024) throw new Error('录音超过 10MB');
        const ext = /mp4|m4a/i.test(String(b.mime || '')) ? '.m4a' : '.webm';
        const c = await ensureIM();
        // 浏览器录音没有时长上限, 超过 60 秒同样要切开; 落临时文件才能交给 ffmpeg
        const tmp = path.join(os.tmpdir(), 'watch_rec_' + crypto.randomBytes(6).toString('hex') + ext);
        fs.writeFileSync(tmp, buf);
        try {
          const n = await sendVoiceParts(c, t, tmp);
          return ok(res, { result: true, parts: n });
        } finally {
          try { fs.unlinkSync(tmp); } catch (e) {}
        }
      }
      if (parts[2] === 'media' && req.method === 'POST') {
        const key = String(query.get('key') || '');
        const kind = query.get('kind') === 'video' ? 'video' : 'image';
        const filename = String(query.get('filename') || (kind === 'video' ? 'video.mp4' : 'image.jpg'));
        const targets = await loadChatTargets();
        const t = targets.find((x) => x.key === key);
        if (!t) throw new Error('会话不存在');
        const buf = await readRawBody(req, 100 * 1024 * 1024);
        if (!buf.length) throw new Error('文件为空');
        const c = await ensureIM();
        const group = t.type === 'group';
        const dialogId = group ? t.dialogId : t.receiverId;
        // 视频超过 30 秒要切段, 而 ffmpeg 只吃文件 —— 先落盘再交给 sendVideoParts
        if (kind === 'video') {
          const ext = path.extname(filename) || '.mp4';
          const tmp = path.join(os.tmpdir(), 'watch_vid_' + crypto.randomBytes(6).toString('hex') + ext);
          fs.writeFileSync(tmp, buf);
          try {
            const n = await sendVideoParts(c, t, tmp);
            return ok(res, { result: true, parts: n });
          } finally {
            try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
          }
        }
        const img = await uploadImage(cfg, { buf, filename, group, dialogId, myImAccountId: c.imAccountId });
        const obj = buildPhoto(img);
        const r = group
          ? await c.sendGroupPayload(t.dialogId, c.imAccountId, obj)
          : await c.sendSinglePayload(t.receiverId, obj);
        if (!r.ok) throw new Error(r.desc || r.code || '发送失败');
        const url = (img.source && img.source.downloadUrl) || '';
        pushChat(key, { self: true, text: '[图片]', kind: 'photo', url, time: Date.now() });
        return ok(res, { result: true, url });
      }
      const targets = await loadChatTargets(query.get('refresh') === '1');
      const st = imStatus();
      return ok(res, {
        targets: targets.map((t) => ({
          key: t.key, type: t.type, name: t.name, sub: t.sub, count: (chatLog.get(t.key) || []).length,
        })),
        connected: st.alive,
        im: st,
      });
    }

    // ===== 绑定手表 =====
    if (parts[1] === 'bind') {
      const b = await readBody(req);
      if (parts[2] === 'lookup') {
        const bindNumber = String(b.bindNumber || '').trim();
        if (!bindNumber) throw new Error('请输入绑定号');
        const r = await api.getWatchByBindNumber(bindNumber, b.randcode ? String(b.randcode) : undefined);
        log.debug('bind', 'lookup ' + JSON.stringify({
          bindNumber,
          hasCode: !!b.randcode,
          code: r.json && r.json.code,
          desc: r.json && r.json.desc,
        }));
        if (r.json && r.json.code !== '000001' && isWatchCodeResponse(r.json)) {
          return ok(res, { needCode: true, hint: r.json.desc || '需要手表验证码' });
        }
        const watch = ensure(r) || {};
        const watchId = watch.id || watch.watchId;
        const relations = (await safe(() => api.getWatchRelations(watchId))) || [];
        const admin = relations.find((x) => x && Number(x.type) === 0) || null;
        const alreadyBound = relations.some((x) => x && x.mobileId === cfg.mobileId);
        const needMobileCheck = !!(await safe(() => api.needMobileCheck(watchId)));
        // 可选的天才号: 当前账号全部 + 未绑定手表的, 按 id 去重
        const [allTalents, noBindTalents, geniusLimit] = await Promise.all([
          safe(() => api.getAllDetailGeniusAccounts(cfg.mobileId, bindNumber)),
          safe(() => api.getNoBindGeniusAccounts(cfg.mobileId, bindNumber)),
          safe(() => api.getGeniusAccountNumberInfo(bindNumber)),
        ]);
        const talents = [];
        for (const arr of [allTalents, noBindTalents]) {
          if (!Array.isArray(arr)) continue;
          for (const x of arr) {
            if (!x || !x.id || talents.some((y) => y.id === x.id)) continue;
            talents.push({
              id: x.id,
              geniusNumber: x.geniusNumber || '',
              name: x.name || '',
              bindNumber: x.bindNumber || '',
              watchId: x.watchId || '',
              isLogin: Number(x.isLogin || 0),
              isOwnGeniusAccount: x.isOwnGeniusAccount !== false,
            });
          }
        }
        log.debug('bind', 'lookup result ' + JSON.stringify({
          watchId,
          relations: relations.length,
          hasAdmin: !!admin,
          alreadyBound,
          talents: talents.length,
        }));
        return ok(res, {
          watch: { watchId, model: watch.shortModel || watch.model || '' },
          relations,
          admin,
          alreadyBound,
          needMobileCheck,
          talents,
          geniusLimit: geniusLimit || null,
        });
      }
      if (parts[2] === 'submit') {
        const watchId = String(b.watchId || '');
        if (!watchId) throw new Error('缺少 watchId');
        const type = Number(b.type);
        if (type !== 0 && type !== 3) throw new Error('绑定类型不正确');

        if (type === 3) {
          const relations = (await safe(() => api.getWatchRelations(watchId))) || [];
          const admin = relations.find((x) => x && Number(x.type) === 0);
          if (!admin) throw new Error('未找到管理员');
          const need = !!(await safe(() => api.needMobileCheck(watchId)));
          if (need) {
            const num = String(b.adminNumber || admin.mobileNumber || '').trim();
            if (!num) return ok(res, { needAdminNumber: true, hint: '请输入管理员完整手机号' });
            const v = ensure(await api.verifyAdminMobile(watchId, num));
            if (!v || v.pass !== true) {
              const left = v && v.remainingCount;
              throw new Error('管理员手机号校验未通过' + (left != null && left !== undefined ? `（剩余 ${left} 次）` : ''));
            }
          }
        }

        // 选择了旧天才号: 先迁移到新表(recovery 0=保留旧表数据 1=不保留)
        let transferred = false;
        if (b.origGeniusId) {
          const origWatchId = String(b.origWatchId || '');
          if (!origWatchId) throw new Error('缺少旧手表 watchId');
          const mr = await api.migrateGeniusAccount({
            destBindNumber: String(b.bindNumber || ''),
            destWatchId: watchId,
            origBindNumber: String(b.origBindNumber || ''),
            origGeniusId: String(b.origGeniusId || ''),
            origWatchId,
            recovery: Number(b.recovery || 0),
            tipsShow: 1,
            randcode: b.transferCode ? String(b.transferCode) : undefined,
          });
          const mj = unwrap(mr);
          if (mj.code !== '000001') {
            if (/管理员|权限|验证/.test(mj.desc || '')) {
              return ok(res, { needAdminCode: true, hint: mj.desc, origWatchId });
            }
            throw new Error(`[${mj.code}] ${mj.desc || '迁移失败'}`);
          }
          transferred = true;
        }

        const r = await api.createMobileWatch({
          mobileId: cfg.mobileId,
          watchId,
          salutation: String(b.salutation || '家长'),
          type,
          randcode: b.randcode ? String(b.randcode) : undefined,
        });
        if (r.json && r.json.code !== '000001' && isWatchCodeResponse(r.json)) {
          return ok(res, { needCode: true, hint: r.json.desc || '需要手表验证码' });
        }
        const cj = unwrap(r);
        if (cj.code !== '000001') {
          // 迁移接口本身可能已经建立了绑定关系
          if (transferred && /已绑定|已经绑定|重复/.test(cj.desc || '')) {
            cache.at = 0;
            invalidateChatTargets();
            return ok(res, { result: true, transferred });
          }
          throw new Error(`[${cj.code}] ${cj.desc || '绑定失败'}`);
        }
        cache.at = 0;
        // 新绑的表在服务端会立刻多出一个家庭群 + 一个单聊。
        // 以前这里只清 watchList 的缓存，chatTargets 还留着旧的一份（最多 60 秒，
        // 1.3.7 之前是永久），用户绑完表切到聊天页还是看不到它 —— 只能重启实例。
        invalidateChatTargets();
        return ok(res, { result: true, transferred });
      }
      // 非旧表管理员做迁移: 给旧表管理员发验证码
      if (parts[2] === 'transfercode') {
        const r = await api.sendTalentTransferRandcode({
          mobileId: cfg.mobileId,
          watchId: String(b.origWatchId || ''),
          adminPhoneNumber: String(b.phone || ''),
          noAdminPhoneNumber: cfg.userName,
        });
        const d = ensure(r) || {};
        if (!d.randCodeKey) throw new Error('服务端未返回验证码校验标识');
        return ok(res, {
          randCodeKey: d.randCodeKey,
          adminPhoneNumber: d.adminPhoneNumber || '',
          adminSalutation: d.adminSalutation || '',
        });
      }
      throw new Error('接口不存在');
    }

    if (parts[1] !== 'watch' || !parts[2]) throw new Error('接口不存在');
    const id = decodeURIComponent(parts[2]);
    const action = parts[3] || 'overview';

    // ===== 型号能力(模块开关) =====
    if (action === 'capabilities') {
      const caps = await getCaps(id, query.get('refresh') === '1');
      const account = (await safe(() => api.getWatchAccount(id))) || {};
      return ok(res, {
        ok: caps.ok,
        modules: caps.map,
        watch: {
          innerModel: account.innerModel || '',
          model: account.model || '',
          firmware: account.firmware || '',
        },
      });
    }

    // ===== 概览 =====
    if (action === 'overview') {
      const account = ensure(await api.getWatchAccount(id));
      // 这三个互不依赖, 串行 await 最坏要等 3 个平台超时(各 15 秒), 并发就只等最慢的那个
      const [members, classModes, guard] = await Promise.all([
        safe(() => api.getWatchMembers(id)),
        safe(() => api.getClassModes(id)),
        safe(() => api.getGuardStatus(id)),
      ]);
      const status = (cfg.watchStatus && cfg.watchStatus[id]) || {};
      const avatarUrl = await getAvatarUrl(id, account);
      const batteryInfo = selectBattery({ apiValue: account.battery, pushValue: status.battery, pushAt: status.batteryAt, pushTimeKind: 'received' });
      const onlineStatus = selectOnline(account.online, account.watchOnline);
      return ok(res, { account, members, classModes, guard, status, avatarUrl, batteryInfo, onlineStatus });
    }

    // ===== 轻量状态(电量等), 供前端轮询 =====
    if (action === 'status') {
      let list;
      try { list = await watchList(false); }
      catch (e) { list = cache.list; } // 平台不可用时仍可返回已有快照或本地推送
      const w = list.find((x) => x.watchId === id) || {};
      const st = (cfg.watchStatus && cfg.watchStatus[id]) || {};
      const batteryInfo = w.battery != null && w.batterySource === 'api'
        ? { battery: w.battery, batteryAt: w.batteryAt || null, batterySource: w.batterySource, batteryTimeKind: w.batteryTimeKind || null }
        : selectBattery({ pushValue: st.battery, pushAt: st.batteryAt, pushTimeKind: 'received' });
      return ok(res, {
        ...batteryInfo,
        onlineStatus: w.onlineStatus == null ? null : w.onlineStatus,
        lastLat: st.lastLat != null ? st.lastLat : null,
        lastLng: st.lastLng != null ? st.lastLng : null,
        lastAddress: st.lastAddress || '',
        lastLocAt: st.lastLocAt || null,
        lastSeenAt: st.lastSeenAt || null,
        lastSeenAgo: st.lastSeenAt ? Math.max(0, Math.round((Date.now() - st.lastSeenAt) / 1000)) : null,
        online: w.online,
        watchOnline: w.watchOnline,
      });
    }

    // ===== 手表头像 =====
    if (action === 'avatar') {
      const account = ensure(await api.getWatchAccount(id));
      return ok(res, { url: await getAvatarUrl(id, account), icon: account.icon || '' });
    }

    if (action === 'location') {
      const location = ensure(await api.getWatchLocation(id));
      const account = (await safe(() => api.getWatchAccount(id))) || {};
      return ok(res, {
        location,
        lossSwitch: Number(account.lossSwitch) || 0,
        watchOnline: account.watchOnline,
        online: account.online,
        onlineStatus: selectOnline(account.online, account.watchOnline),
      });
    }

    if (action === 'track') {
      const date = query.get('date') || new Date().toISOString().slice(0, 10);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
      if (!m) throw new Error('日期格式应为 YYYY-MM-DD');
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0).getTime();
      const data = ensure(await api.getLocationTrack(id, t));
      return ok(res, { date, points: (data && data.locationContrail) || [] });
    }

    if (action === 'health') {
      await requireCap(id, MODULES.health, '健康数据');
      const date = query.get('date') || new Date().toISOString().slice(0, 10);
      const home = await safe(() => api.getHealthHome(id, date));
      const sport = await safe(() => api.getSportHome(id, date));
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 18, 0, 0).getTime();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();
      const sleep = await safe(() => api.getSleepDetail(id, start, end));
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const temperature = await safe(() => api.getTemperature(id, dayStart, dayStart + 86400000));
      const heartRate = await safe(() => api.getHeartRate(id, date));
      return ok(res, { date, home, sport, sleep, temperature, heartRate });
    }

    // ===== 通讯录 =====
    if (action === 'contacts') {
      if (req.method === 'GET') return ok(res, { contacts: ensure(await api.getContacts(id)) });
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (!b.salutation || !b.mobileNumber) throw new Error('称呼和号码不能为空');
        const r = await api.addContact({
          watchId: id,
          mobileNumber: String(b.mobileNumber),
          shortNumber: b.shortNumber ? String(b.shortNumber) : undefined,
          salutation: String(b.salutation),
          type: 3,
          role: 0,
          status: 0,
          countryCode: '86',
        });
        return ok(res, { result: ensure(r) });
      }
      if (req.method === 'PUT' && parts[4]) {
        const b = await readBody(req);
        const list = ensure(await api.getContacts(id)) || [];
        const cur = list.find((x) => String(x.id) === String(decodeURIComponent(parts[4])));
        if (!cur) throw new Error('联系人不存在');
        ensure(await api.updateContact({
          id: cur.id,
          watchId: id,
          mobileNumberNew: String(b.mobileNumber || cur.mobileNumberNew || cur.mobileNumber || ''),
          shortNumber: b.shortNumber ? String(b.shortNumber) : (cur.shortNumber || undefined),
          mobileNumberIsHide: cur.mobileNumberIsHide || 0,
          shortNumberIsHide: cur.shortNumberIsHide || 0,
          salutation: String(b.salutation || cur.salutation || ''),
          type: Number(cur.type),
          role: cur.role || 0,
          countryCode: cur.countryCode || '86',
          autoCall: cur.autoCall || 0,
          sn: cur.sn || 0,
        }));
        return ok(res, { result: true });
      }
      if (req.method === 'DELETE' && parts[4]) {
        return ok(res, { result: ensure(await api.deleteContact(decodeURIComponent(parts[4]))) });
      }
      throw new Error('不支持的方法');
    }

    // ===== 安全区域 =====
    if (action === 'guard') {
      if (req.method === 'GET') {
        const status = await safe(() => api.getGuardStatus(id));
        const common = await safe(() => api.getCommonAreas(id));
        const danger = await safe(() => api.getDangerAreas(id));
        return ok(res, { status, common, danger });
      }
      if (req.method === 'POST' && parts[4] === 'danger') {
        const b = await readBody(req);
        const latitude = Number(b.latitude);
        const longitude = Number(b.longitude);
        const radius = Number(b.radius || 300);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('经纬度不正确');
        ensure(await api.addDangerArea({ watchId: id, latitude, longitude, radius }));
        return ok(res, { result: true });
      }
      if (req.method === 'DELETE' && parts[4] === 'danger' && parts[5]) {
        ensure(await api.deleteDangerArea(id, parts[5]));
        return ok(res, { result: true });
      }
      throw new Error('不支持的方法');
    }

    // ===== 设置 =====
    if (action === 'settings') {
      // 时区总表(按需拉取, 不随设置页一起返回)
      if (req.method === 'GET' && parts[4] === 'timezones') {
        const list = await safe(() => api.getGlobalTimeZones());
        return ok(res, { list: list || [] });
      }
      if (req.method === 'GET') {
        const volume = await safe(() => api.getVolume(id));
        const sms = await safe(() => api.getSmsSync(id));
        const time0 = await safe(() => api.getTimeManageList(id, 0));
        const time1 = await safe(() => api.getTimeManageList(id, 1));
        const endurance = await safe(() => api.getEndurance(id));
        const charges = await safe(() => api.getWatchCharges(id));
        const classModes = await safe(() => api.getClassModes(id));
        const disableMode = await safe(() => api.getDisableModeSetting(id));
        const systemMode = await safe(() => api.getSystemMode(id));
        const beforeSchool = await safe(() => api.getBeforeSchool(id));
        const account = await safe(() => api.getWatchAccount(id));
        const receiveType = await safe(() => api.getReceiveType(id));
        const flow = await safe(() => api.getDataFlowLimit(id));
        const chargeAlert = await safe(() => api.getChargeAlertSwitch());
        const languages = account
          ? await safe(() => api.getWatchLanguages(account.innerModel || account.model, account.firmware))
          : null;
        const caps = await getCaps(id);
        return ok(res, {
          volume, sms, time0, time1, endurance, charges, classModes, disableMode, systemMode, beforeSchool, receiveType,
          flow, chargeAlert, languages,
          capabilities: caps.map,
          capabilityOk: caps.ok,
          capabilityStale: !!caps.stale,
          watch: account ? {
            innerModel: account.innerModel || '',
            model: account.model || '',
            firmware: account.firmware || '',
          } : null,
          timezone: account ? {
            globalTimeZone: account.globalTimeZone,
            globalTimeZoneV2: account.globalTimeZoneV2,
            language: account.language,
          } : null,
          waterSwitch: account ? account.waterSwitch : null,
          waterInterval: account ? account.waterInterval : null,
          waterAlarm: account ? account.waterAlarm : null,
          powerLowProtectSwitch: account ? account.powerLowProtectSwitch : null,
          locationAlertSwitch: account ? account.locationAlertSwitch : null,
          interactionCallSwitch: account ? account.interactionCallSwitch : null,
        });
      }
      // 时间管理: 睡眠模式(type=1) / 定时开关机(type=0)
      if (parts[4] === 'time') {
        if (req.method === 'POST') {
          const b = await readBody(req);
          const type = Number(b.type) === 1 ? 1 : 0;
          if (!b.startTime || !b.endTime) throw new Error('请填写开始与结束时间');
          if (type === 1) await requireCap(id, MODULES.sleepMode, '睡眠模式');
          ensure(await api.addTimeManage(id, {
            name: b.name || (type === 1 ? '睡眠模式' : '定时开关机'),
            type,
            startTime: clock(b.startTime),
            endTime: clock(b.endTime),
            classWeek: b.classWeek == null || b.classWeek === '' ? 31 : Number(b.classWeek),
            switchStatus: 1,
          }));
          return ok(res, { result: true });
        }
        if (req.method === 'PUT') {
          const b = await readBody(req);
          if (!b.id) throw new Error('缺少时段 ID');
          const type = Number(b.type) === 1 ? 1 : 0;
          if (type === 1) await requireCap(id, MODULES.sleepMode, '睡眠模式');
          const list = (await safe(() => api.getTimeManageList(id, type))) || [];
          const cur = list.find((x) => String(x.id) === String(b.id));
          if (!cur) throw new Error('时段不存在');
          const next = Object.assign({}, cur, {
            name: b.name || cur.name,
            startTime: b.startTime ? clock(b.startTime) : cur.startTime,
            endTime: b.endTime ? clock(b.endTime) : cur.endTime,
            classWeek: b.classWeek == null || b.classWeek === '' ? cur.classWeek : Number(b.classWeek),
            switchStatus: b.switchStatus == null ? cur.switchStatus : Number(b.switchStatus),
          });
          ensure(await api.updateTimeManage(next));
          return ok(res, { result: true });
        }
        if (req.method === 'DELETE' && parts[5]) {
          const type = Number(query.get('type')) === 1 ? 1 : 0;
          if (type === 1) await requireCap(id, MODULES.sleepMode, '睡眠模式');
          ensure(await api.deleteTimeManage(id, decodeURIComponent(parts[5]), type));
          return ok(res, { result: true });
        }
        throw new Error('不支持的方法');
      }
      // 上课禁用时段
      if (parts[4] === 'classmode') {
        if (req.method === 'POST' && parts[5] === 'add') {
          const b = await readBody(req);
          await requireCap(id, MODULES.multiClassMode, '多时段上课禁用');
          const periods = parsePeriods(b.startTime, b.endTime);
          if (!periods.length) throw new Error('请填写开始与结束时间');
          ensure(await api.addClassMode(id, {
            title: b.title || '上课禁用',
            classWeek: b.classWeek == null || b.classWeek === '' ? 31 : Number(b.classWeek),
            periods,
            holidaySwitch: b.holidaySwitch === true || b.holidaySwitch === '1',
          }));
          return ok(res, { result: true });
        }
        if (req.method === 'PUT' && parts[5]) {
          const b = await readBody(req);
          await requireCap(id, MODULES.multiClassMode, '多时段上课禁用');
          const className = decodeURIComponent(parts[5]);
          const list = (await safe(() => api.getClassModes(id))) || [];
          const cur = list.find((x) => String(x.classId) === className || String(x.id) === className);
          if (!cur) throw new Error('时段不存在');
          const next = {};
          ['classId', 'classWeek', 'createTime', 'holidaySwitch', 'id', 'timePeriod', 'title', 'type', 'watchId']
            .forEach((k) => { if (cur[k] !== undefined && cur[k] !== null) next[k] = cur[k]; });
          if (b.title) next.title = b.title;
          if (b.classWeek != null && b.classWeek !== '') next.classWeek = Number(b.classWeek);
          if (b.startTime && b.endTime) next.timePeriod = JSON.stringify(parsePeriods(b.startTime, b.endTime));
          if (b.classSwitch != null) next.classSwitch = Number(b.classSwitch);
          next.tempSwitch = 0;
          ensure(await api.updateClassMode(next));
          return ok(res, { result: true });
        }
        if (req.method === 'DELETE' && parts[5]) {
          await requireCap(id, MODULES.multiClassMode, '多时段上课禁用');
          ensure(await api.deleteClassMode(decodeURIComponent(parts[5])));
          return ok(res, { result: true });
        }
      }
      if (req.method === 'POST' && parts[4] === 'classmode') {
        const b = await readBody(req);
        ensure(await api.setClassDisabled(id, !!b.disabled));
        return ok(res, { result: true });
      }
      // 模式限制(上课/睡眠/续航 是否允许聊天与通话)
      if (req.method === 'POST' && parts[4] === 'disablemode') {
        const b = await readBody(req);
        ensure(await api.updateDisableModeSetting(id, {
          classModeWeichat: Number(b.classModeWeichat),
          classModeCall: Number(b.classModeCall),
          sleepModeWeichat: Number(b.sleepModeWeichat),
          sleepModeCall: Number(b.sleepModeCall),
          enduranceWeichat: Number(b.enduranceWeichat),
          enduranceCall: Number(b.enduranceCall),
        }));
        return ok(res, { result: true });
      }
      // 省电: 切换续航模式 / 修改自动设置
      if (req.method === 'POST' && parts[4] === 'endurance') {
        const b = await readBody(req);
        if (b.enduranceType != null) ensure(await api.changeEndurance(id, b.enduranceType));
        if (b.autoSwitch != null || b.threshold != null || b.smartPowerSaveSwitch != null) {
          const cur = (await safe(() => api.getEndurance(id))) || {};
          ensure(await api.updateEnduranceSetting(id, {
            autoSwitch: b.autoSwitch != null ? Number(b.autoSwitch) : cur.autoSwitch,
            threshold: b.threshold != null ? Number(b.threshold) : cur.threshold,
            smartPowerSaveSwitch: b.smartPowerSaveSwitch != null ? Number(b.smartPowerSaveSwitch) : cur.smartPowerSaveSwitch,
          }));
        }
        return ok(res, { result: true });
      }
      // 系统模式: status 0=标准 1=超长待机
      if (req.method === 'POST' && parts[4] === 'systemmode') {
        const b = await readBody(req);
        ensure(await api.switchSystemMode(id, Number(b.status) === 1 ? 1 : 0));
        return ok(res, { result: true });
      }
      // 上学前模式开关
      if (req.method === 'POST' && parts[4] === 'beforeschool') {
        const b = await readBody(req);
        ensure(await api.updateBeforeSchool(id, b.status ? 1 : 0));
        return ok(res, { result: true });
      }
      // 提醒与通话开关: 这几个字段只能整对象提交(PUT /watchaccount)
      if (req.method === 'POST' && parts[4] === 'watchswitch') {
        const b = await readBody(req);
        const allow = ['waterSwitch', 'waterAlarm', 'waterInterval', 'powerLowProtectSwitch', 'locationAlertSwitch', 'interactionCallSwitch'];
        const patch = {};
        allow.forEach((k) => {
          if (b[k] !== undefined && b[k] !== null && b[k] !== '') patch[k] = Number(b[k]);
        });
        if (!Object.keys(patch).length) throw new Error('没有需要修改的字段');
        ensure(await api.updateWatchAccount(id, patch));
        return ok(res, { result: true, patch });
      }
      // 短信接收设置: 与当前值相同时服务端会返回 000008 illegal operation
      if (req.method === 'POST' && parts[4] === 'receivetype') {
        const b = await readBody(req);
        ensure(await api.updateReceiveType(id, Number(b.receiveType), Number(b.isDisplayAll)));
        return ok(res, { result: true });
      }
      // 流量限制
      if (req.method === 'POST' && parts[4] === 'flow') {
        const b = await readBody(req);
        await requireCap(id, MODULES.dataFlow, '流量限制');
        ensure(await api.setDataFlowLimit(id, Number(b.stream)));
        return ok(res, { result: true });
      }
      // 手表语言
      if (req.method === 'POST' && parts[4] === 'language') {
        const b = await readBody(req);
        if (!b.language) throw new Error('请选择语言');
        await requireCap(id, MODULES.watchLanguage, '手表语言');
        ensure(await api.setWatchLanguage(id, String(b.language)));
        return ok(res, { result: true });
      }
      // 手表时区: 传时区标识(如 Asia/Shanghai), GMT 偏移从总表里取
      if (req.method === 'POST' && parts[4] === 'timezone') {
        const b = await readBody(req);
        const key = String(b.zoneKey || '').trim();
        if (!key) throw new Error('请填写时区标识');
        await requireCap(id, [MODULES.timeZoneNew, MODULES.timeZone], '时区设置');
        const list = (await safe(() => api.getGlobalTimeZones())) || [];
        const hit = list.find((x) => x.k === key);
        if (!hit) throw new Error('时区标识不存在: ' + key);
        ensure(await api.setWatchTimeZone(id, hit.gmt || '', hit.k));
        return ok(res, { result: true });
      }
      // 话费提醒(000058 = 状态未变化, desc 仍为 success)
      if (req.method === 'POST' && parts[4] === 'chargealert') {
        const b = await readBody(req);
        const u = unwrap(await api.updateChargeAlertSwitch(b.chargeSwitch ? 1 : 0));
        if (u.code !== '000001' && u.code !== '000058') throw new Error(`[${u.code}] ${u.desc || '请求失败'}`);
        return ok(res, { result: true, changed: u.code === '000001' });
      }
      if (req.method === 'POST' && parts[4] === 'volume') {
        const b = await readBody(req);
        ensure(await api.updateVolume(id, {
          type: 0,
          soundMode: Number(b.soundMode || 0),
          disableMode: Number(b.disableMode || 0),
          soundLevel: b.soundLevel === '' || b.soundLevel == null ? null : Number(b.soundLevel),
          totalLevel: b.totalLevel === '' || b.totalLevel == null ? null : Number(b.totalLevel),
          modeDefault: b.modeDefault || undefined,
        }));
        return ok(res, { result: true });
      }
      throw new Error('不支持的方法');
    }

    // ===== 自动接听授权(谁能自动接听手表来电) =====
    if (action === 'autocall') {
      const list = (await safe(() => api.getContacts(id))) || [];
      const contacts = list
        .filter((x) => x.id && x.autoCall != null && Number(x.type) !== 6)
        .map((x) => ({
          id: x.id,
          name: x.salutation || x.name || x.mobileNumber || '-',
          number: x.mobileNumber || '',
          shortNumber: x.shortNumber || '',
          type: x.type,
          autoCall: Number(x.autoCall) === 1,
        }));
      if (req.method === 'GET') return ok(res, { contacts });
      if (req.method === 'POST') {
        const b = await readBody(req);
        await requireCap(id, MODULES.autoCall, '自动接听授权');
        const target = list.find((x) => String(x.id) === String(b.id));
        if (!target) throw new Error('联系人不存在');
        ensure(await api.updateAutoCallList(id, [{
          id: target.id,
          mobileNumber: target.mobileNumber,
          shortNumber: target.shortNumber,
          type: target.type,
          autoCall: b.autoCall ? 1 : 0,
        }]));
        return ok(res, { result: true });
      }
      throw new Error('不支持的方法');
    }

    if (action === 'lost') {
      if (req.method === 'POST' && !parts[4]) {
        const b = await readBody(req);
        const enabled = !!b.enabled;
        ensure(await api.setLossSwitch(id, enabled));
        cache = { at: 0, list: [] };
        return ok(res, { result: true, lossSwitch: enabled ? 1 : 0 });
      }
      if (parts[4] === 'photos' && req.method === 'GET') {
        const raw = ensure(await api.getLostPhotos(id));
        const list = Array.isArray(raw) ? raw : ((raw && (raw.photos || raw.list || raw.pictureList || raw.data)) || []);
        // 服务端字段名随版本不同, 这里按常见命名提取
        const pick = (p) => {
          const urlKeys = ['url', 'picUrl', 'pictureUrl', 'photoUrl', 'imageUrl', 'downloadUrl', 'storeAddr', 'fileUrl'];
          for (const k of urlKeys) {
            const v = p[k];
            if (typeof v === 'string' && v) return /^https?:/i.test(v) ? { url: v } : { key: v };
          }
          const keyKeys = ['key', 'fileKey', 'picKey', 'pictureKey', 'resourceKey', 'resoureKey'];
          for (const k of keyKeys) {
            if (typeof p[k] === 'string' && p[k]) return { key: p[k] };
          }
          return {};
        };
        const place = (p) => {
          const l = p.location || p.pictureLocation || p.netLostPictureLocation;
          if (typeof l === 'string') return l;
          if (l && typeof l === 'object') {
            return [l.province, l.city, l.region, l.descForStrategy || l.address || l.desc].filter(Boolean).join(' ');
          }
          return p.address || '';
        };
        const keys = [];
        const picked = list.map((p) => {
          const x = pick(p || {});
          if (x.key && keys.indexOf(x.key) < 0) keys.push(x.key);
          return x;
        });
        const urlMap = {};
        if (keys.length) {
          const urls = await safe(() => api.getFileUrls(keys, 1));
          if (Array.isArray(urls)) keys.forEach((k, i) => { urlMap[k] = urls[i] || ''; });
        }
        const photos = list.map((p, i) => ({
          id: (p && p.id) || '',
          url: picked[i].url || urlMap[picked[i].key] || '',
          location: place(p || {}),
          createTime: p && (p.createTime || p.pictureTime || p.uploadTime || p.takePhotoTime || p.time),
        })).filter((p) => p.url);
        return ok(res, { photos });
      }
      if (parts[4] === 'wifi' && req.method === 'GET') {
        const raw = ensure(await api.getLostWifi(id));
        const list = Array.isArray(raw) ? raw : ((raw && (raw.wifiList || raw.list || raw.data)) || []);
        // 实测字段: { mac, wifiName, signalth }
        const wifi = list.map((x) => (typeof x === 'string'
          ? { name: x }
          : {
            name: x.ssid || x.wifiName || x.name || '',
            signal: x.signal != null ? x.signal : (x.signalth != null ? x.signalth : (x.rssi != null ? x.rssi : (x.level || 0))),
            mac: x.mac || x.bssid || '',
          }));
        // 空列表时附带手表侧诊断: 附近 WiFi 是手表自己扫描上报的, 服务端没有触发扫描的接口
        let meta = null;
        if (!wifi.length) {
          const loc = (await safe(() => api.getWatchLocation(id))) || {};
          meta = { wifiCount: loc.wifiCount, reportTime: loc.createTime || null };
        }
        return ok(res, { wifi, meta });
      }
      if (parts[4] === 'message') {
        if (req.method === 'GET') {
          const raw = ensure(await api.getLostMessage(id));
          const message = typeof raw === 'string' ? raw : ((raw && (raw.message || raw.content || raw.leaveMessage)) || '');
          return ok(res, { message });
        }
        if (req.method === 'POST') {
          const b = await readBody(req);
          const message = String(b.message || '').slice(0, 500);
          if (!message) throw new Error('留言不能为空');
          ensure(await api.setLostMessage(id, message));
          return ok(res, { result: true });
        }
      }
      if (parts[4] === 'sound' && req.method === 'POST') {
        const acc = (await safe(() => api.getWatchAccount(id))) || {};
        if (Number(acc.lossSwitch) !== 1) throw new Error('请先开启丢表模式再响铃');
        const b = await readBody(req);
        ensure(await api.playLostSound(id, b.action === 'stop'));
        return ok(res, { result: true });
      }
      throw new Error('不支持的操作');
    }

    // ===== 应用 / WiFi =====
    if (action === 'apps') {
      const storeSwitch = await safe(() => api.getStoreSwitch(id));
      const installed = (await safe(() => api.getUserApps(id))) || [];
      const account = (await safe(() => api.getWatchAccount(id))) || {};
      const catalog = (await safe(() => api.getStoreApps(id, account.model, account.firmware))) || [];
      const byPkg = {};
      catalog.forEach((a) => { if (a && a.packageName) byPkg[a.packageName] = a; });
      const apps = installed.map((x) => {
        const c = byPkg[x.packageName] || {};
        return Object.assign({}, c, x, {
          name: c.name || x.name || x.packageName,
          icon: c.icon || x.icon || '',
          versionName: c.versionName || '',
          size: c.size || 0,
        });
      });
      const model = account.innerModel || account.model || '';
      const levels = await safe(() => api.getAllAppLevels());
      const duration = await safe(() => api.getDurationSetting(id, model));
      const todayUse = await safe(() => api.getTodayUse(id, model));
      const report = await safe(() => api.getReportSwitch(id));
      return ok(res, { storeSwitch, apps, levels, duration, todayUse, report });
    }

    // ===== 应用商店设置 / 应用管控 =====
    if (action === 'appstore') {
      if (req.method === 'GET') {
        const account = (await safe(() => api.getWatchAccount(id))) || {};
        const model = account.innerModel || account.model || '';
        const storeSwitch = await safe(() => api.getStoreSwitch(id));
        const levels = await safe(() => api.getAllAppLevels());
        const duration = await safe(() => api.getDurationSetting(id, model));
        const todayUse = await safe(() => api.getTodayUse(id, model));
        const report = await safe(() => api.getReportSwitch(id));
        const authorities = model ? await safe(() => api.getAppAuthorities({ watchId: id, model, firmware: account.firmware || '' })) : null;
        return ok(res, { storeSwitch, levels, duration, todayUse, report, authorities, model });
      }
      if (req.method === 'POST' && parts[4] === 'store') {
        const b = await readBody(req);
        ensure(await api.updateStoreSwitch(id, {
          autoUpdateSwitch: b.autoUpdateSwitch,
          downChannelSwitch: b.downChannelSwitch,
          watchAllowSwitch: b.watchAllowSwitch,
          allowDownloadSwitch: b.allowDownloadSwitch,
          watchAuthoriseSwitch: b.watchAuthoriseSwitch,
          userAppLevel: b.userAppLevel,
          personalRecommend: b.personalRecommend,
        }));
        return ok(res, { result: true });
      }
      if (req.method === 'POST' && parts[4] === 'duration') {
        const b = await readBody(req);
        ensure(await api.updateDurationSetting(id, {
          isOpen: Number(b.isOpen) ? 1 : 0,
          totalDuration: Number(b.totalDuration),
          remindSwitch: Number(b.remindSwitch) ? 1 : 0,
          remindDuration: Number(b.remindDuration),
          watchVersionType: 0,
        }));
        return ok(res, { result: true });
      }
      if (req.method === 'POST' && parts[4] === 'report') {
        const b = await readBody(req);
        ensure(await api.updateReportSwitch(id, b.reportSwitch, b.nickname));
        return ok(res, { result: true });
      }
      throw new Error('不支持的方法');
    }

    // ===== 聊天管控 =====
    if (action === 'chatcontrol') {
      const PRIVACY_IDS = [2764, 2763, 2905, 3422, 2665, 2367, 3185, 3917, 2368, 2366, 2369, 2370, 2917];
      if (req.method === 'GET') {
        const parentAudit = await safe(() => api.getParentAuditSwitch(id));
        const subs = await safe(() => api.getSubSwitches(id));
        const privacy = await safe(() => api.getPrivacyItems(id, PRIVACY_IDS));
        return ok(res, { parentAudit, subs, privacy });
      }
      if (req.method === 'POST' && parts[4] === 'parentaudit') {
        const b = await readBody(req);
        ensure(await api.setParentAuditSwitch(id, b.v ? 1 : 0));
        return ok(res, { result: true });
      }
      // 单个设置项开关（隐私/健康监测这类）。switchId 是服务端的常量表，
      // 只能改 status，不认识的 id 服务端会自己拒掉。
      if (req.method === 'POST' && parts[4] === 'privacy') {
        const b = await readBody(req);
        const sid = Number(b.switchId);
        if (!sid) throw new Error('缺少 switchId');
        ensure(await api.updatePrivacyItem(sid, b.status ? 1 : 0));
        return ok(res, { result: true, switchId: sid, status: b.status ? 1 : 0 });
      }
      throw new Error('不支持的方法');
    }

    if (action === 'wifi') {
      await requireCap(id, MODULES.wifi, 'WiFi 设置');
      const list = await safe(() => api.getWatchWifiList(id));
      const max = await safe(() => api.getWatchWifiMax());
      return ok(res, { list, max });
    }

    // ===== 闹钟 =====
    if (action === 'alarms') {
      if (req.method === 'GET') return ok(res, { alarms: ensure(await api.getAlarms(id)) });
      if (req.method === 'POST' && parts.length === 4) {
        const b = await readBody(req);
        const hours = Number(b.hours);
        const minutes = Number(b.minutes);
        if (!(hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59)) throw new Error('时间不正确');
        ensure(await api.addAlarm({
          watchId: id,
          mobileId: cfg.mobileId,
          title: String(b.title || '闹钟'),
          hours,
          minutes,
          weeks: Number(b.weeks || 127),
          status: 1,
          soundSwitch: 1,
          vibrationSwitch: 1,
          display: 1,
          weatherAlarmSwitch: 0,
        }));
        return ok(res, { result: true });
      }
      if (req.method === 'POST' && parts[5] === 'toggle') {
        const list = ensure(await api.getAlarms(id)) || [];
        const alarm = list.find((x) => String(x.id) === String(parts[4]));
        if (!alarm) throw new Error('闹钟不存在');
        const next = Object.assign({}, alarm, { status: Number(alarm.status) === 1 ? 0 : 1 });
        ensure(await api.updateAlarm(next));
        return ok(res, { result: true });
      }
      if (req.method === 'DELETE' && parts[4]) {
        ensure(await api.deleteAlarm(decodeURIComponent(parts[4])));
        return ok(res, { result: true });
      }
      throw new Error('不支持的方法');
    }

    // ===== 隐藏功能 =====
    if (action === 'hidden') {
      const baseState = await safe(() => api.getBaseState(id));
      const shutdown = await safe(() => api.getShutdownStatus(id));
      const shutdownLocations = await safe(() => api.getShutdownLocations(id));
      const markAreas = await safe(() => api.getMarkAreas(id));
      const accessibility = await safe(() => api.getAccessibility(id));
      const authorizes = await safe(() => api.getAuthorizes(id));
      const notices = await safe(() => api.getNoticeNew());
      const disableMode = await safe(() => api.getDisableModeSetting(id));
      const noticeContent = await safe(() => api.getNoticeContent(id));
      const whiteApps = await safe(() => api.getFuncWhiteApp(id));
      const beforeSchool = await safe(() => api.getBeforeSchool(id));
      const baiduNetdisk = await safe(() => api.getBaiduNetdisk(id));
      const autoCall = await safe(() => api.getAutoCallSwitch(id));
      const userAgreement = await safe(() => api.getUserAgreement());
      const systemMode = await safe(() => api.getSystemMode(id));
      const receiveType = await safe(() => api.getReceiveType(id));
      const watchAccount = await safe(() => api.getWatchAccount(id));
      const bindNumber = watchAccount && watchAccount.bindNumber;
      const nfcPending = bindNumber ? await safe(() => api.getNfcPendingCards(id, bindNumber)) : null;
      const nfcCards = bindNumber ? await safe(() => api.getNfcCards(id, bindNumber)) : null;
      return ok(res, {
        baseState, shutdown, shutdownLocations, markAreas, accessibility, authorizes, notices,
        disableMode, noticeContent, whiteApps, beforeSchool, baiduNetdisk, autoCall, userAgreement,
        systemMode, receiveType, nfcPending, nfcCards,
      });
    }

    // ===== 好友 =====
    if (action === 'friends') {
      if (req.method === 'GET') {
        const friends = await withFriendAvatars(ensure(await api.getWatchFriends(id)) || []);
        return ok(res, { friends });
      }
      if (req.method === 'DELETE' && parts[4]) {
        ensure(await api.deleteWatchFriend(decodeURIComponent(parts[4])));
        return ok(res, { result: true });
      }
      throw new Error('不支持的方法');
    }

    // ===== 加好友口令 =====
    if (action === 'genius') {
      const config = await safe(() => api.getGeniusConfig());
      const account = await safe(() => api.getGeniusAccount(id));
      const geniusNumber = (account && account.geniusNumber) || '';
      let command = null;
      if (geniusNumber) {
        const r = await api.getGeniusCommand(id, geniusNumber);
        if (r.json && r.json.code === '000001') command = r.json.data;
      }
      return ok(res, { config, geniusNumber, command });
    }

    // ===== 宝贝资料 =====
    if (action === 'profile') {
      if (req.method === 'GET') return ok(res, { account: ensure(await api.getWatchAccount(id)) });
      if (req.method === 'POST') {
        const b = await readBody(req);
        let changed = false;
        if (b.name) { ensure(await api.updateBabyName(id, String(b.name))); changed = true; }
        if (b.realName) { ensure(await api.updateBabyRealName(id, String(b.realName))); changed = true; }

        const attrs = {};
        if (b.birthday) {
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b.birthday));
          if (!m) throw new Error('生日格式应为 YYYY-MM-DD');
          attrs.birthday = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
        }
        if (b.height !== '' && b.height != null) attrs.height = Number(b.height);
        if (b.weight !== '' && b.weight != null) attrs.doubleWeight = Number(b.weight);
        if (b.gender !== '' && b.gender != null) attrs.gender = Number(b.gender);
        if (b.grade !== '' && b.grade != null) attrs.grade = Number(b.grade);
        if (b.classes !== '' && b.classes != null) attrs.classes = Number(b.classes);
        if (Object.keys(attrs).length) { ensure(await api.updateWatchAttributes(id, attrs)); changed = true; }

        if (!changed) throw new Error('没有需要保存的字段');
        cache.at = 0;
        return ok(res, { result: true });
      }
      throw new Error('不支持的方法');
    }

    // ===== 自动同意好友 =====
    if (action === 'autoagree') {
      if (req.method === 'GET') return ok(res, { enabled: (cfg.autoAgreeWatchIds || []).includes(id) });
      if (req.method === 'POST') {
        const b = await readBody(req);
        const set = new Set(cfg.autoAgreeWatchIds || []);
        if (b.enabled) set.add(id); else set.delete(id);
        cfg.autoAgreeWatchIds = Array.from(set);
        device.save(cfg);
        if (b.enabled) await ensureIM().catch(() => {});
        return ok(res, { enabled: !!b.enabled });
      }
      throw new Error('不支持的方法');
    }

    // ===== 解绑 =====
    if (action === 'unbind' && req.method === 'POST') {
      const b = await readBody(req);
      const relationId = String(b.relationId || '');
      if (!relationId) throw new Error('缺少关系 ID');
      ensure(await api.unbind(relationId));
      cache.at = 0;
      invalidateChatTargets();
      return ok(res, { result: true });
    }

    throw new Error('接口不存在');
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: '请求地址不合法' });
    }
    const parts = url.pathname.split('/').filter(Boolean);

    // 请求日志: 静态资源(字体/表情图)只在 debug 级别打印, 避免刷屏
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      // 日志流是长连接, 断开时打一行 ms=几十万的记录没有意义, 直接跳过
      if (url.pathname === '/api/logs/stream') return;
      if (parts[0] === 'assets') {
        if (log.isEnabled('debug')) log.request(req.method, url.pathname, res.statusCode, ms, res._bytes);
        return;
      }
      log.request(req.method, url.pathname, res.statusCode, ms, res._bytes, res._failed);
    });

    try {
      // 首页: 带 ?token= 时自动种 Cookie 再跳回干净 URL(方便从终端直接点链接进来)
      if (!parts.length) {
        // 云端托管：带 ?ticket= 时验签换 Cookie，令牌本身不出现在 URL 里
        const qticket = url.searchParams.get('ticket');
        if (qticket) {
          if (verifyTicket(qticket)) {
            res.writeHead(302, { 'Set-Cookie': authCookie(), Location: '/' });
            return res.end();
          }
          log.warn('webui', `托管票据校验失败 ip=${clientIp(req)}`);
          res.writeHead(302, { Location: '/?auth=fail' });
          return res.end();
        }

        const qt = url.searchParams.get('token');
        if (qt) {
          if (safeEqual(qt, AUTH_TOKEN)) {
            res.writeHead(302, { 'Set-Cookie': authCookie(), Location: '/' });
            return res.end();
          }
          log.warn('webui', `URL 令牌错误 ip=${clientIp(req)}`);
          res.writeHead(302, { Location: '/?auth=fail' });
          return res.end();
        }
        return sendHtml(req, res);
      }

      // ===== 令牌接口(免鉴权) =====
      if (parts[0] === 'api' && parts[1] === 'auth') {
        if (parts[2] === 'status') {
          return sendJson(res, 200, { ok: true, data: { authed: isAuthed(req) } });
        }
        if (parts[2] === 'login' && req.method === 'POST') {
          const ip = clientIp(req);
          if (authBlocked(ip)) {
            return sendJson(res, 429, { ok: false, error: '令牌错误次数过多，请 10 分钟后再试' });
          }
          const b = await readBody(req);
          if (!safeEqual(String(b.token || '').trim(), AUTH_TOKEN)) {
            noteAuthFail(ip);
            log.warn('webui', `令牌错误 ip=${ip}`);
            await new Promise((r) => setTimeout(r, 400)); // 拖慢暴力破解
            return sendJson(res, 401, { ok: false, error: '令牌不正确' });
          }
          authFails.delete(ip);
          res.setHeader('Set-Cookie', authCookie());
          log.info('webui', `令牌验证通过 ip=${ip}`);
          return sendJson(res, 200, { ok: true, data: { authed: true } });
        }
        if (parts[2] === 'logout' && req.method === 'POST') {
          res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
          return sendJson(res, 200, { ok: true, data: { authed: false } });
        }
        return sendJson(res, 404, { ok: false, error: '接口不存在' });
      }

      // 对外 API: 用自己的令牌校验, 不走 WebUI 的 Cookie 鉴权
      // 必须 await: 直接 return 一个 Promise 的话, 它 reject 时已经离开 try 的作用域,
      // 下面的 catch 抓不到 → 变成未捕获的 rejection, 整个进程直接挂掉
      if (parts[0] === 'api' && parts[1] === 'ext') {
        return await handleExtApi(req, res, parts, url.searchParams);
      }

      // 云端托管平台专用: 用平台票据（t:'platform'）校验，同样不走 Cookie
      if (parts[0] === 'api' && parts[1] === 'platform') {
        return await handlePlatform(req, res, parts, url.searchParams);
      }

      // 其余 /api 一律要求已持令牌
      if (parts[0] === 'api' && !isAuthed(req)) {
        return sendJson(res, 401, { ok: false, unauthorized: true, error: '未授权，请先输入访问令牌' });
      }

      if (parts[0] === 'assets' && parts[1] === 'fonts' && parts[2]) {
        const name = path.basename(parts[2]);
        const file = path.join(__dirname, 'assets', 'fonts', name);
        if (!fs.existsSync(file)) return send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
        // 以前这里写死 font/ttf，现在有 .woff2 了，按后缀给，否则浏览器可能不认
        const ftype = /\.woff2$/i.test(name) ? 'font/woff2'
          : /\.woff$/i.test(name) ? 'font/woff'
            : /\.otf$/i.test(name) ? 'font/otf'
              : 'font/ttf';
        const buf = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': ftype, 'Cache-Control': 'public, max-age=604800', 'Content-Length': buf.length });
        return res.end(buf);
      }
      // 表情预览图: /assets/emoji/<code>.png
      if (parts[0] === 'assets' && parts[1] === 'emoji' && parts[2]) {
        const file = path.join(EMOJI_DIR, path.basename(parts[2]));
        if (!fs.existsSync(file)) return send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
        const buf = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800', 'Content-Length': buf.length });
        return res.end(buf);
      }
      // 顶层静态资源: 项目图标 /assets/icon.png、/assets/icon-180.png
      if (parts[0] === 'assets' && parts[1] && parts.length === 2) {
        const name = path.basename(parts[1]);
        const file = path.join(__dirname, 'assets', name);
        if (!fs.existsSync(file)) return send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
        const ext = path.extname(name).toLowerCase();
        const type = ext === '.png' ? 'image/png'
          : ext === '.svg' ? 'image/svg+xml'
            : ext === '.ico' ? 'image/x-icon'
              : 'application/octet-stream';
        const buf = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800', 'Content-Length': buf.length });
        return res.end(buf);
      }
      if (parts[0] !== 'api') {
        return send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
      }
      await handleApi(req, res, parts, url.searchParams);
    } catch (e) {
      log.error('webui', `${req.method} ${url.pathname} 失败: ${e && e.message ? e.message : e}`);
      fail(res, e);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  log.info('webui', `服务已启动 http://${host}:${port}`);
  log.info('webui', `日志级别 ${log.levelName()}（WP_LOG=debug 看请求体细节，WP_LOG=warn 只看告警）`);

  // 会话列表必须先拉到: 收消息时要靠它把 dialogId/imAccountId 映射成会话 key,
  // 没拉到时进来的消息会被直接丢掉, 而且日志里完全看不出来。
  // 以前只靠 refreshBiliScope() 顺带拉一次, 没配置 B 站点播(或开关全关)时就一直是空的。
  await loadChatTargets().catch((e) => {
    log.warn('im', '会话列表拉取失败，收到的手表消息会暂时无法归档: ' + (e && e.message ? e.message : e));
  });

  startImBackground();

  // AI 自动回复的「启动」状态以前只活在内存变量里：WebUI/进程一重启就变回停止，
  // 界面上看着「已停止」，用户以为功能坏了，日志里也找不到任何线索。
  // 这里按 cfg.ai.autoStart 自动恢复；配置不全时只告警一句，不拖慢其它功能。
  // 完全没配过 AI 的（没地址也没勾会话）就安静跳过，别每次启动都刷一行警告。
  // 优化/修复：anjianhe
  const aiConfigured = !!((cfg.ai && (cfg.ai.sessions || []).length)
    || String((cfg.ai && cfg.ai.baseUrl) || '').trim() || AI_MANAGED);
  if (cfg.ai && cfg.ai.autoStart !== false && aiConfigured) {
    startAiAuto('上次退出时处于开启状态').catch((e) => {
      log.warn('ai', '自动启动失败（不影响其它功能）: ' + (e && e.message ? e.message : e));
    });
  }
  // 对外 API 令牌: 启用状态下确保已生成
  ensureGeniusToken();

  // OneBot v11 桥接(HTTP API + 正向 WS + 反向 WS), 供 AstrBot / NoneBot 等第三方框架接入
  await restartOneBot();

  // B 站点播: 先把「手表名 ↔ 会话」拉齐, 否则「按手表自动匹配会话」会一个都匹配不到
  await refreshBiliScope().catch(() => {});

  // 插件: 扫描用户目录和程序自带的 plugins/, 按启用状态加载。
  // 放在最后是因为插件的 onLoad 里可能要用手表列表/会话列表, 前面没准备好就会拿到空
  await pluginMgr.init().catch((e) => {
    log.warn('plugin', '插件初始化失败: ' + (e && e.message ? e.message : e));
  });

  // 白名单链接库：配了远端地址（自己填的，或云端平台注入的 JZ_LINKS_URL）才会起定时器。
  // 放在最后，别让它跟登录、IM 抢启动阶段的网络
  linkLib.startAutoRefresh(cfg, log);

  return {
    server,
    token: AUTH_TOKEN,
    url: `http://${host}:${port}`,
    // 按手表分开的实例(watchId -> 实例), 测试与 CLI 都要能拿到
    onebots,
    // CLI 打印用: 每块表的地址/令牌快照(实例是活的, 这里取一份静态值)
    onebotSummary: () => {
      const out = [];
      onebots.forEach((inst, wid) => {
        const nm = (watchNames || []).find((x) => x.watchId === String(wid)) || {};
        out.push({
          watchId: String(wid),
          name: nm.name || '',
          http: { enabled: inst.http.enabled, running: inst.http.running, port: inst.http.port, token: inst.http.token },
          ws: { enabled: inst.ws.enabled, running: inst.ws.running, port: inst.ws.port, token: inst.ws.token },
          wsClient: {
            enabled: inst.wsClient.enabled, url: inst.wsClient.url,
            connected: inst.wsClient.connected, state: inst.wsClient.state,
          },
        });
      });
      return out;
    },
    close: () => new Promise((resolve) => {
      server.close(async () => {
        // 插件先停: 它们的定时器和 fetch 还在跑, 不清理会拖住进程退出
        try { pluginMgr.closeAll(); } catch (e) { /* ignore */ }
        // 链接库的定时器同理
        try { linkLib.stopAutoRefresh(); } catch (e) { /* ignore */ }
        for (const inst of onebots.values()) {
          try { await inst.close(); } catch (e) { /* ignore */ }
        }
        onebots = new Map();
        // 关闭后恢复原级别, 避免日志行串到 CLI 菜单里
        log.setLevel(prevLevel);
        resolve();
      });
    }),
  };
}

module.exports = { startWebUI, chatIdsOf, matchChatKey };
