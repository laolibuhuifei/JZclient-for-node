// 设备标识与本地配置持久化(~/.watch-parent-cli/config.json)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(os.homedir(), '.watch-parent-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  deviceId: null,        // SSO 设备标识(同时用作 SSO 的 mac)
  nDeviceId: null,       // SSO nDeviceId 头/业务参数
  ssoMac: null,          // SSO 公共参数 mac
  machineId: null,       // 业务层 machineId
  mac: null,             // 业务层 mac
  token: null,           // 登录 ticket
  mobileId: null,        // 业务账号 ID
  authId: null,          // SSO authId(业务头)
  userName: null,        // 登录账号
  areaCode: '86',        // 区号
  ssoRsaKey: null,       // SSO RSA 公钥缓存
  bizRsaKey: null,       // 业务 RSA 公钥缓存
  bizDeviceId: null,     // 业务设备 ID
  bizMac: null,          // 业务 mac
  bizMachineId: null,    // 业务 machineId
  registId: null,        // 推送 registId
  apiHost: null,         // 业务网关(默认取 site.config.js)
  imDeviceId: null,      // IM 设备标识
  imSyncKey: 0,          // IM 已同步到的 syncKey
  imAccountId: null,     // 自己的 IM 账号 ID
  watchStatus: {},       // IM 推送缓存的手表状态 { watchId: { battery, lastLat, lastLng, ... } }
  autoAgreeWatchIds: [], // 自动同意好友申请的手表
  webui: {
    port: 8787,          // WebUI 监听端口
    host: '0.0.0.0',     // 默认允许局域网访问(接口需访问令牌)
    token: '',           // 访问令牌, 为空时首次启动自动生成并写回
  },
  // OneBot v11 桥接的**公共行为**设置。端口/令牌/会话范围都是按手表分开的,
  // 见下面的 onebotWatches —— 这里只放每块表都要用同一份的开关
  onebot: {
    heartbeat: 30,       // 心跳间隔(秒), 0 = 关闭
    // QQ 兼容层: 微聊做不到的动作(撤回/禁言/戳一戳等)静默成功, 让按 QQ 写的插件不崩
    qqCompat: true,
  },
  ai: {
    baseUrl: '',         // OpenAI 兼容地址, 例如 https://api.openai.com/v1
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    trigger: 'auto',     // auto=自动回复, keyword=关键词触发
    keywords: [],
    systemPrompt: '你是一个家长端聊天助手。请用简短、口语化的中文回复，不要使用表情符号。',
    sessions: [],        // 启用 AI 的会话 { key, type, name, receiverId|dialogId }
  },
  // 按手表分开的 OneBot 实例: watchId -> { enabled, http:{}, ws:{}, wsClient:{}, targets:[] }
  // 每块表一套自己的端口/令牌, 各自只推自己那块表的会话。port=0 表示自动分配(见 webui.js)
  onebotWatches: {},
  // 按手表分开的对外 API 令牌: watchId -> { enabled, token }。令牌即身份, 只能操作对应的那块表
  extApi: {},
  // 按手表分开的微聊 B 站点播: watchId -> { enabled, targets, maxDuration, maxBytes, maxPerDay }
  // 每块表单独开关、单独会话范围、单独限额 —— 家里两块表, 一块给老大开一块不给, 互不影响
  biliBots: {},
  // 公告服务地址写死在 src/site.config.js 的 notice.baseUrl, 不放进用户配置
};

// 单块手表的 OneBot 默认配置(端口 0 = 由 webui 自动分配)
function onebotWatchDefaults() {
  return {
    enabled: false,
    http: { enabled: true, host: '0.0.0.0', port: 0, token: '' },
    ws: { enabled: true, host: '0.0.0.0', port: 0, token: '' },
    wsClient: { enabled: false, url: '', token: '', reconnect: 5 },
    targets: [],   // 手动指定的会话 key(s:xxx / g:xxx); 空数组 = 按手表自动匹配
  };
}

function normalizeOnebotWatch(raw) {
  const d = onebotWatchDefaults();
  const r = raw && typeof raw === 'object' ? raw : {};
  return Object.assign({}, d, r, {
    http: Object.assign({}, d.http, r.http || {}),
    ws: Object.assign({}, d.ws, r.ws || {}),
    wsClient: Object.assign({}, d.wsClient, r.wsClient || {}),
    targets: Array.isArray(r.targets) ? r.targets.map(String) : [],
  });
}

function normalizeOnebotWatches(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach((k) => { out[String(k)] = normalizeOnebotWatch(raw[k]); });
  }
  return out;
}

function normalizeExtApi(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach((k) => {
      const v = raw[k] || {};
      out[String(k)] = { enabled: !!v.enabled, token: String(v.token || '') };
    });
  }
  return out;
}

// 单块手表的 B 站点播默认值
//   maxDuration 秒, 0 = 不限; maxBytes 字节, 上限卡在 100MB(微聊视频上传本身就卡这个数);
//   maxPerDay 每天最多点播几条, 0 = 不限 —— 防小孩一口气刷十几条大视频把带宽和磁盘打满
function biliWatchDefaults() {
  return {
    enabled: false,
    targets: [],                 // 会话 key(s:xxx / g:xxx); 空数组 = 按手表自动匹配
    maxDuration: 600,            // 10 分钟
    maxBytes: 100 * 1024 * 1024, // 100MB
    maxPerDay: 20,
  };
}

// 数值收敛: 非法/越界一律回落到默认值, 免得手改配置文件把机器人搞崩
function biliInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function normalizeBiliWatch(raw) {
  const d = biliWatchDefaults();
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!r.enabled,
    targets: Array.isArray(r.targets) ? r.targets.map(String).filter(Boolean) : [],
    maxDuration: biliInt(r.maxDuration, 0, 7200, d.maxDuration),
    maxBytes: biliInt(r.maxBytes, 0, d.maxBytes, d.maxBytes),
    maxPerDay: biliInt(r.maxPerDay, 0, 999, d.maxPerDay),
  };
}

function normalizeBiliBots(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach((k) => { out[String(k)] = normalizeBiliWatch(raw[k]); });
  }
  return out;
}

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
      cfg.ai = Object.assign({}, DEFAULTS.ai, cfg.ai || {});
      cfg.webui = Object.assign({}, DEFAULTS.webui, cfg.webui || {});
      // 老配置里的 onebot.http / ws / wsClient / enabled 属于「全局实例」时代。
      // 现在只有按手表的实例了, 但直接丢掉会让老用户已经接好的端口和令牌全废,
      // 所以先摘到 onebotLegacy 里(不可枚举, 不会被写回文件), 交给 webui.js 的
      // restartOneBot 搬到第一块手表上。
      const old = cfg.onebot || {};
      const legacy = (old.enabled || old.http || old.ws || old.wsClient)
        ? { enabled: old.enabled !== false, http: old.http || null, ws: old.ws || null, wsClient: old.wsClient || null }
        : null;
      cfg.onebot = Object.assign({}, DEFAULTS.onebot, old);
      ['enabled', 'http', 'ws', 'wsClient'].forEach((k) => { delete cfg.onebot[k]; });
      delete cfg.geniusApi;
      if (legacy) {
        Object.defineProperty(cfg, 'onebotLegacy', {
          value: legacy, enumerable: false, configurable: true, writable: true,
        });
      }
      cfg.onebotWatches = normalizeOnebotWatches(cfg.onebotWatches);
      cfg.extApi = normalizeExtApi(cfg.extApi);
      cfg.biliBots = normalizeBiliBots(cfg.biliBots);
      if (!Array.isArray(cfg.ai.sessions)) cfg.ai.sessions = [];
      if (!Array.isArray(cfg.ai.keywords)) cfg.ai.keywords = [];
      return cfg;
    }
  } catch (e) { /* 损坏则用默认 */ }
  return Object.assign({}, DEFAULTS, {
    webui: Object.assign({}, DEFAULTS.webui),
    onebot: Object.assign({}, DEFAULTS.onebot),
    ai: Object.assign({}, DEFAULTS.ai),
    onebotWatches: {},
    extApi: {},
    biliBots: {},
  });
}

function save(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// 确保设备标识存在(不存在则生成并持久化)
function ensureIdentity(cfg) {
  let changed = false;
  if (!cfg.deviceId) {
    cfg.deviceId = crypto.randomUUID().replace(/-/g, '');
    changed = true;
  }
  if (!cfg.nDeviceId) {
    cfg.nDeviceId = cfg.deviceId;
    changed = true;
  }
  if (!cfg.machineId) {
    cfg.machineId = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
    changed = true;
  }
  if (!cfg.ssoMac) {
    cfg.ssoMac = crypto.randomBytes(16).toString('hex');
    changed = true;
  }
  if (!cfg.mac) {
    const b = crypto.randomBytes(6);
    b[0] = (b[0] & 0xfc) | 0x02;
    cfg.mac = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
    changed = true;
  }
  if (!cfg.imDeviceId) {
    cfg.imDeviceId = crypto.randomUUID().replace(/-/g, '').toUpperCase();
    changed = true;
  }
  if (changed) save(cfg);
  return cfg;
}

module.exports = {
  load, save, ensureIdentity, CONFIG_FILE,
  // 按手表配置的归一化工具(webui 保存单个手表的 OneBot / 点播配置时要用)
  onebotWatchDefaults, normalizeOnebotWatch, normalizeExtApi,
  biliWatchDefaults, normalizeBiliWatch, normalizeBiliBots,
};
