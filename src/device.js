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
  // OneBot v11 桥接(给 AstrBot / NoneBot 等第三方框架用)
  onebot: {
    enabled: true,
    heartbeat: 30,       // 心跳间隔(秒), 0 = 关闭
    // QQ 兼容层: 微聊做不到的动作(撤回/禁言/戳一戳等)静默成功, 让按 QQ 写的插件不崩
    qqCompat: true,
    http: { enabled: true, host: '0.0.0.0', port: 5700, token: '' }, // HTTP API, token 为空自动生成
    ws: { enabled: true, host: '0.0.0.0', port: 5701, token: '' },   // 正向 WebSocket(对方连进来)
    wsClient: {          // 反向 WebSocket(我们主动连到 AstrBot 等)
      enabled: false,
      url: '',           // AstrBot 填 ws://127.0.0.1:6199/ws, NapCat 一般填 ws://127.0.0.1:3001/
      token: '',
      reconnect: 5,      // 断线重连间隔(秒)
    },
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
  // 对外 API: 给第三方脚本/机器人取加好友口令(独立令牌, 不走 WebUI 的访问令牌)
  geniusApi: {
    enabled: false,      // 关闭时对外接口一律 403
    token: '',           // 为空时首次启用自动生成并写回
  },
  // 公告服务地址写死在 src/site.config.js 的 notice.baseUrl, 不放进用户配置
};

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
      cfg.ai = Object.assign({}, DEFAULTS.ai, cfg.ai || {});
      cfg.webui = Object.assign({}, DEFAULTS.webui, cfg.webui || {});
      cfg.onebot = Object.assign({}, DEFAULTS.onebot, cfg.onebot || {});
      cfg.onebot.http = Object.assign({}, DEFAULTS.onebot.http, (cfg.onebot || {}).http || {});
      cfg.onebot.ws = Object.assign({}, DEFAULTS.onebot.ws, (cfg.onebot || {}).ws || {});
      cfg.onebot.wsClient = Object.assign({}, DEFAULTS.onebot.wsClient, (cfg.onebot || {}).wsClient || {});
      cfg.geniusApi = Object.assign({}, DEFAULTS.geniusApi, cfg.geniusApi || {});
      if (!Array.isArray(cfg.ai.sessions)) cfg.ai.sessions = [];
      if (!Array.isArray(cfg.ai.keywords)) cfg.ai.keywords = [];
      return cfg;
    }
  } catch (e) { /* 损坏则用默认 */ }
  return Object.assign({}, DEFAULTS, {
    webui: Object.assign({}, DEFAULTS.webui),
    onebot: {
      enabled: DEFAULTS.onebot.enabled,
      heartbeat: DEFAULTS.onebot.heartbeat,
      qqCompat: DEFAULTS.onebot.qqCompat,
      http: Object.assign({}, DEFAULTS.onebot.http),
      ws: Object.assign({}, DEFAULTS.onebot.ws),
      wsClient: Object.assign({}, DEFAULTS.onebot.wsClient),
    },
    ai: Object.assign({}, DEFAULTS.ai),
    geniusApi: Object.assign({}, DEFAULTS.geniusApi),
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

module.exports = { load, save, ensureIdentity, CONFIG_FILE };
