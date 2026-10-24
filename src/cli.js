// 精简命令行: 只负责账号(登录/切换/登出/信息)与 WebUI 启停
// 其余全部功能(手表/定位/聊天/应用/设置…)都在 WebUI 里, 参考 NapCat 的用法。
const readline = require('readline');
const os = require('os');
const crypto = require('crypto');
const device = require('./device');
const sso = require('./sso');
const { ApiClient } = require('./api');
const { startWebUI } = require('./webui');
const { maskSensitive } = require('./mask');
const log = require('./logger');

// 终端输出统一脱敏(手机号/身份证/邮箱/银行卡)
const rawLog = console.log.bind(console);
console.log = (...args) => rawLog(...args.map((a) => (typeof a === 'string' ? maskSensitive(a) : a)));

// ============ 终端基础设施 ============

let rl = null;
let suppressCloseExit = false;

function openRl() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', () => { if (!suppressCloseExit) exitApp(0); });
}

const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

const TTY = process.stdout.isTTY;

// 终端样式
const useColor = TTY;
const c = {
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};
const err = (m) => console.log(c.red(m));
const ok = (m) => console.log(c.green(m));

function line() {
  const cols = Math.min(process.stdout.columns || 80, 72);
  console.log(c.dim('─'.repeat(cols)));
}

// 隐藏输入(密码): 关闭主 readline 后直接读 raw 输入,避免任何回显
function askHidden(q) {
  return new Promise((resolve) => {
    if (!TTY) { ask(q).then(resolve); return; }
    suppressCloseExit = true;
    if (rl) rl.close();
    rl = null;

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    process.stdout.write(q);

    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      suppressCloseExit = false;
      openRl();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          exitApp(0);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (ch >= ' ') {
          value += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

// 5x5 点阵字体,用于生成大字 logo
const FONT = {
  J: ['..###', '....#', '....#', '#...#', '.###.'],
  Z: ['#####', '...#.', '..#..', '.#...', '#####'],
  C: ['.####', '#....', '#....', '#....', '.####'],
  l: ['##...', '.#...', '.#...', '.#...', '###..'],
  i: ['.#...', '.....', '.#...', '.#...', '.#...'],
  e: ['.....', '.###.', '#####', '#....', '.###.'],
  n: ['.....', '####.', '#...#', '#...#', '#...#'],
  t: ['.#...', '####.', '.#...', '.#...', '..##.'],
  F: ['#####', '#....', '####.', '#....', '#....'],
  o: ['.....', '.###.', '#...#', '#...#', '.###.'],
  r: ['.....', '#.##.', '##..#', '#....', '#....'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  d: ['....#', '....#', '.####', '#...#', '.####'],
  ' ': ['.....', '.....', '.....', '.....', '.....'],
};

// 用方块字符渲染大字
function renderBanner(text) {
  const rows = ['', '', '', '', ''];
  [...text].forEach((ch, idx) => {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 5; r++) {
      rows[r] += (idx ? ' ' : '') + g[r].replace(/#/g, '█');
    }
  });
  return rows.join('\n');
}

const BANNER_WIDE = renderBanner('JZClientForNode');
const BANNER_MID = renderBanner('JZClient') + '\n\n' + renderBanner('ForNode');
const BANNER_MINI = renderBanner('JZ') + '\n  JZClientForNode';
const CREDIT = 'by contributors · GPL-3.0 · Copyright (C) 2026 JZClientForNode · 无担保';

function textWidth(s) {
  return Math.max(...s.split('\n').map((l) => l.length), 0);
}

const WIDE_WIDTH = textWidth(BANNER_WIDE);
const MID_WIDTH = textWidth(BANNER_MID);
const MINI_WIDTH = textWidth(BANNER_MINI);

// 根据终端宽度自适应选择大字 logo
function pickLogo() {
  const cols = process.stdout.columns || 80;
  let art;
  if (cols >= WIDE_WIDTH) art = BANNER_WIDE;
  else if (cols >= MID_WIDTH) art = BANNER_MID;
  else if (cols >= MINI_WIDTH) art = BANNER_MINI;
  else art = 'JZClientForNode';
  return art + '\n' + c.dim('  ' + CREDIT);
}

// ============ 全局状态 ============

let cfg = device.ensureIdentity(device.load());
let api = new ApiClient(cfg);
let watches = [];
let srv = null;       // WebUI 服务句柄, 非空表示正在运行
let exiting = false;

// ============ 错误码 ============

const ERROR_TEXT = {
  '000001': '成功',
  '000003': 'RSA 公钥失效',
  '000004': '请求参数无效',
  '000005': '资源不存在',
  '000016': '请求参数无效',
  '010402': '账号或密码错误',
  '010403': '登录态不合法',
  '010406': '登录已过期，请重新登录',
  '010401': '签名无效',
  '010410': '换设备登录，需要验证账号',
  '010304': '验证信息已失效',
  '010215': '答案错误',
  '010216': '今日验证次数已用完',
  '010217': '请选择其他验证方式',
  '010203': '账号不存在',
};

function explain(json) {
  if (!json || !json.code) return '无响应';
  return `[${json.code}] ${ERROR_TEXT[json.code] || json.desc || ''}`;
}

// ============ 账号 ============

const CHANGE_DEVICE_TYPES = {
  1: '旧设备验证(旧手机收码)',
  2: '家庭成员辅助验证',
  3: '短信验证码',
  4: '密保问题(可选手表天才号)',
  6: '未知方式',
};

function parseJsonData(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return {}; }
}

// 登录态失效时清掉本地票据
function checkAuth(json) {
  if (json && json.code === '010406') {
    err('登录已过期，请使用「1) 登录/切换账号」重新登录。');
    cfg.token = null;
    device.save(cfg);
    return false;
  }
  return true;
}

// 拉取账号信息与手表列表(只用于展示, 业务都在 WebUI 里做)
async function loadAccount() {
  const r = await api.getMobileInit();
  if (!r.json || r.json.code !== '000001') {
    err('获取账号信息失败: ' + explain(r.json));
    if (r.text && !r.json) console.log(c.dim(String(r.text).slice(0, 300)));
    checkAuth(r.json);
    return false;
  }
  const data = r.json.data || {};
  const acc = data.mobileAccount || {};
  if (acc.id) cfg.mobileId = acc.id;
  if (acc.authId) cfg.authId = acc.authId;
  device.save(cfg);

  watches = (data.mobileWatchs || []).map((w) => ({
    relationId: w.id,
    watchId: w.watchId,
    salutation: w.salutation || '',
  }));
  return true;
}

// 新设备登录二次验证: 目前实现密保问题(含手表天才号)
async function verifyNewDevice(challenge, account) {
  const types = Array.isArray(challenge.checkTypes) ? challenge.checkTypes : [];
  console.log('该账号在新设备登录，需要先完成安全验证。可选方式:');
  types.forEach((t) => console.log(`  - ${t}) ${CHANGE_DEVICE_TYPES[t] || '方式 ' + t}`));

  const hasQuestion = types.length === 0 || types.includes(4);
  if (!hasQuestion) {
    err('服务端未提供密保问题验证，当前版本暂不支持其它方式。');
    return false;
  }

  const qr = await sso.getSecurityQuestions(cfg, {
    userName: account,
    checkCode: challenge.checkCode,
    changeDeviceType: 0,
  });
  if (!qr.json || qr.json.code !== '000001') {
    err('获取密保问题失败: ' + explain(qr.json));
    return false;
  }

  const data = parseJsonData(qr.json.data);
  const list = Array.isArray(data.securityQuestions) ? data.securityQuestions : [];
  if (!list.length) {
    err('没有可用的密保问题。');
    return false;
  }

  console.log('请选择要回答的密保问题:');
  let geniusIdx = -1;
  list.forEach((q, i) => {
    if (/天才号/.test(q.question || '')) geniusIdx = i;
    console.log(`  ${i + 1}) ${q.question}${q.content ? c.dim('  ' + q.content) : ''}`);
  });
  const def = geniusIdx >= 0 ? geniusIdx + 1 : 1;
  const pick = await ask(`序号(默认 ${def}，q 取消): `);
  if (pick.toLowerCase() === 'q') return false;
  const idx = (pick ? parseInt(pick, 10) : def) - 1;
  const q = list[idx];
  if (!q) { err('无效序号'); return false; }

  const tip = await ask(`请输入「${q.question}」的答案: `);
  if (!tip) { err('答案不能为空'); return false; }

  const vr = await sso.validateSecurityQuestion(cfg, {
    userName: account,
    checkCode: challenge.checkCode,
    questionId: q.questionId,
    answer: tip,
    changeDeviceType: 0,
  });
  if (!vr.json || vr.json.code !== '000001') {
    err('密保验证失败: ' + explain(vr.json));
    return false;
  }
  ok('密保验证通过，正在换取登录票据...');

  const cr = await sso.changeDeviceLogin(cfg, {
    mobilePhone: account,
    checkCode: challenge.checkCode,
    checkType: 4,
    changeDeviceType: 0,
    randCode: '',
  });
  if (!cr.json || cr.json.code !== '000001') {
    err('换取登录票据失败: ' + explain(cr.json));
    return false;
  }

  cfg.token = typeof cr.json.data === 'string' ? cr.json.data : JSON.stringify(cr.json.data);
  cfg.userName = account;
  cfg.ssoRsaKey = cr.rsaKey;
  try { cfg.authId = JSON.parse(cfg.token).accountId; } catch (e) { /* ignore */ }
  device.save(cfg);
  api = new ApiClient(cfg);
  watches = [];

  ok('登录成功。');
  if (await loadAccount()) console.log(`已加载 ${watches.length} 块手表。`);
  return true;
}

async function doLogin() {
  const account = (await ask(`账号${cfg.userName ? c.dim('(' + maskSensitive(cfg.userName) + ')') : ''}: `)) || cfg.userName;
  if (!account) { err('请输入账号'); return false; }
  const password = await askHidden('密码(不显示): ');
  if (!password) { err('请输入密码'); return false; }

  process.stdout.write('登录中... ');
  let r;
  try {
    r = await sso.loginByPassword(cfg, account, password);
  } catch (e) {
    console.log('');
    err('登录请求失败: ' + e.message);
    return false;
  }
  console.log(explain(r.json));

  if (!r.json || r.json.code !== '000001') {
    if (r.json && r.json.code === '010410') {
      const done = await verifyNewDevice(parseJsonData(r.json.data), account);
      if (!done) console.log(c.dim('新设备验证未完成，未登录。'));
      return done;
    }
    if (r.json && r.json.code === '010402') {
      console.log(c.dim(`账号: ${account}。密码区分大小写，输入时不回显，请确认没有输错。`));
    } else if (r.json) {
      console.log(JSON.stringify(r.json));
    }
    return false;
  }

  cfg.token = typeof r.json.data === 'string' ? r.json.data : JSON.stringify(r.json.data);
  cfg.userName = account;
  cfg.ssoRsaKey = r.rsaKey;
  try { cfg.authId = JSON.parse(cfg.token).accountId; } catch (e) { /* ignore */ }
  device.save(cfg);
  api = new ApiClient(cfg);
  watches = [];

  ok('登录成功。');
  if (await loadAccount()) console.log(`已加载 ${watches.length} 块手表。`);
  return true;
}

async function doLogout() {
  if (!cfg.token) { console.log(c.dim('当前未登录。')); return; }
  const sure = (await ask('确认退出登录?(yes/n): ')).toLowerCase();
  if (sure !== 'yes') { console.log('已取消'); return; }

  // 服务依赖登录态, 先停掉
  await stopServer();

  cfg.token = null;
  cfg.mobileId = null;
  cfg.authId = null;
  cfg.ssoRsaKey = null;
  cfg.imAccountId = null;
  cfg.imSyncKey = 0;
  cfg.watchStatus = {};
  device.save(cfg);
  api = new ApiClient(cfg);
  watches = [];
  ok('已退出登录，本地票据已清除。');
}

async function doAccountInfo() {
  if (!cfg.token) { err('当前未登录。'); return; }
  line();
  console.log(`${c.dim('账号')}    ${cfg.userName || '-'}`);
  console.log(`${c.dim('状态')}    ${c.green('已登录')}`);
  console.log(`${c.dim('手机ID')}  ${cfg.mobileId || '-'}`);
  console.log(`${c.dim('authId')}  ${cfg.authId || '-'}`);
  console.log(`${c.dim('IM ID')}   ${cfg.imAccountId || c.dim('(未连接)')}`);

  if (!watches.length) await loadAccount();
  if (watches.length) {
    console.log(`${c.dim('手表')}    ${watches.length} 块`);
    watches.forEach((w, i) => {
      console.log(`        ${i + 1}. ${w.watchId}${w.salutation ? c.dim('  ' + w.salutation) : ''}`);
    });
  } else {
    console.log(`${c.dim('手表')}    ${c.dim('无')}`);
  }
  line();
}

function doConfig() {
  line();
  console.log(`${c.dim('配置文件')}  ${device.CONFIG_FILE}`);
  console.log(`${c.dim('WebUI')}     http://${cfg.webui.host}:${cfg.webui.port}${srv ? c.green('  (运行中)') : c.dim('  (未启动)')}`);
  console.log('');
  console.log(c.dim('  账号字段已脱敏，修改请直接编辑上面的 JSON 文件。令牌用 t 查看。'));
  const safe = Object.assign({}, cfg);
  ['token', 'ssoRsaKey', 'bizRsaKey', 'deviceId', 'nDeviceId', 'ssoMac', 'mac',
    'machineId', 'bizDeviceId', 'bizMac', 'bizMachineId', 'imDeviceId'].forEach((k) => {
    if (safe[k]) safe[k] = '***';
  });
  if (safe.ai && safe.ai.apiKey) safe.ai.apiKey = '***';
  if (safe.webui && safe.webui.token) safe.webui.token = '***';
  if (safe.onebot) {
    if (safe.onebot.http && safe.onebot.http.token) safe.onebot.http.token = '***';
    if (safe.onebot.ws && safe.onebot.ws.token) safe.onebot.ws.token = '***';
  }
  console.log(c.dim(JSON.stringify(safe, null, 2)));
  line();
}

// ============ WebUI 启停 ============

function lanIps() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((k) => {
    (ifaces[k] || []).forEach((a) => {
      if (a && a.family === 'IPv4' && !a.internal) ips.push(a.address);
    });
  });
  return ips;
}

async function startServer() {
  if (srv) return true;
  if (!cfg.token) { err('请先登录再启动 WebUI。'); return false; }

  const port = Number(cfg.webui.port) || 8787;
  const host = cfg.webui.host || '127.0.0.1';
  try {
    srv = await startWebUI({ cfg, port, host });
  } catch (e) {
    srv = null;
    err('WebUI 启动失败: ' + e.message);
    if (e && e.code === 'EADDRINUSE') console.log(c.dim(`  端口 ${port} 被占用，改 ${device.CONFIG_FILE} 里的 webui.port`));
    return false;
  }

  console.log('');
  ok(`WebUI 已启动  http://127.0.0.1:${port}`);
  if (host === '0.0.0.0') {
    const ips = lanIps();
    ips.forEach((ip) => console.log(`  局域网  http://${ip}:${port}`));
    if (!ips.length) console.log(c.dim('  未检测到局域网 IPv4 地址'));
    console.log(c.dim('  局域网内可访问，但必须输入访问令牌才能操作。'));
  }
  if (srv && srv.token) {
    console.log('');
    console.log(`  ${c.dim('访问令牌')}  ${c.bold(srv.token)}`);
    console.log(c.dim(`  快捷链接    http://127.0.0.1:${port}/?token=${srv.token}`));
  }
  if (srv && srv.onebot) {
    const ob = srv.onebot;
    // 只启用反向 WS 时也要打印这一段(此时 http/ws 可能都是关的)
    const any = (ob.http && ob.http.running) || (ob.ws && ob.ws.running) || (ob.wsClient && ob.wsClient.enabled);
    if (any) {
      console.log('');
      console.log(c.dim('  OneBot v11'));
      if (ob.http && ob.http.running) {
        console.log(`    ${c.dim('HTTP API')}  http://127.0.0.1:${ob.http.port}   ${c.dim('令牌')} ${c.bold(ob.http.token)}`);
      }
      if (ob.ws && ob.ws.running) {
        console.log(`    ${c.dim('WS')}        ws://127.0.0.1:${ob.ws.port}   ${c.dim('令牌')} ${c.bold(ob.ws.token)}`);
        if (host === '0.0.0.0') {
          lanIps().forEach((ip) => console.log(c.dim(`    局域网    ws://${ip}:${ob.ws.port}/?access_token=${ob.ws.token}`)));
        }
      }
      if (ob.wsClient && ob.wsClient.enabled) {
        console.log(`    ${c.dim('反向 WS')}  ${ob.wsClient.url}  ${ob.wsClient.connected ? c.green('已连接') : c.yellow('连接中')}`);
      }
    }
  }
  return true;
}

async function stopServer() {
  if (!srv) return;
  const s = srv;
  srv = null;
  try { await s.close(); } catch (e) { /* ignore */ }
  console.log(c.dim('WebUI 已停止'));
}

async function toggleServer() {
  if (srv) await stopServer();
  else await startServer();
}

// ===== 访问令牌 =====

function currentToken() {
  return (srv && srv.token) || (cfg.webui && cfg.webui.token) || '';
}

function showToken() {
  const tok = currentToken();
  if (!tok) { console.log(c.dim('  还没有令牌，启动 WebUI 后会自动生成。')); return; }
  const port = cfg.webui.port;
  const lan = cfg.webui.host === '0.0.0.0';
  line();
  console.log(`${c.dim('访问令牌')}  ${c.bold(tok)}`);
  console.log(`${c.dim('快捷链接')}  http://127.0.0.1:${port}/?token=${tok}`);
  if (lan) lanIps().forEach((ip) => console.log(`              http://${ip}:${port}/?token=${tok}`));
  console.log('');
  console.log(c.dim('  浏览器打开链接可直接进入；也可以只打开首页，在登录页粘贴令牌。'));
  console.log(c.dim('  输入 t new 重新生成令牌（已登录的浏览器会被踢下线）。'));
  line();
}

async function resetToken() {
  const sure = (await ask('重新生成令牌会把已登录的浏览器踢下线，继续?(yes/n): ')).toLowerCase();
  if (sure !== 'yes') { console.log('已取消'); return; }
  const tok = 'jz_' + crypto.randomBytes(16).toString('hex');
  cfg.webui = Object.assign({}, cfg.webui, { token: tok });
  try { device.save(cfg); } catch (e) { err('令牌保存失败: ' + e.message); return; }
  const wasRunning = !!srv;
  if (wasRunning) { await stopServer(); await startServer(); }
  ok('令牌已重置' + (wasRunning ? '，WebUI 已用新令牌重启' : ''));
  console.log(`${c.dim('新令牌')} ${c.bold(tok)}`);
}

// ===== OneBot v11 接入信息 =====

function showOneBot() {
  const conf = cfg.onebot || {};
  const ob = srv && srv.onebot;
  const host = (conf.ws && conf.ws.host) || '0.0.0.0';
  line();
  if (!conf.enabled) {
    console.log(`${c.dim('OneBot')}  未启用（配置里 onebot.enabled = false）`);
    line();
    return;
  }
  if (!ob) {
    console.log(`${c.dim('OneBot')}  已启用但未运行，输入 5 启动 WebUI 后会一起起来`);
    line();
    return;
  }
  console.log(`${c.dim('OneBot v11')}  ${(ob.http && ob.http.running) || (ob.ws && ob.ws.running) || (ob.wsClient && ob.wsClient.enabled) ? '运行中' : '未运行(端口可能被占用)'}`);
  if (ob.http.enabled) {
    console.log(`  ${c.dim('HTTP API')}  http://127.0.0.1:${ob.http.port}${ob.http.running ? '' : c.red('  ✗')}`);
    console.log(`  ${c.dim('HTTP 令牌')} ${c.bold(ob.http.token)}`);
  }
  if (ob.ws.enabled) {
    console.log(`  ${c.dim('WS 地址')}  ws://127.0.0.1:${ob.ws.port}${ob.ws.running ? '' : c.red('  ✗')}`);
    if (host === '0.0.0.0') lanIps().forEach((ip) => console.log(`             ws://${ip}:${ob.ws.port}`));
    console.log(`  ${c.dim('WS 令牌')}  ${c.bold(ob.ws.token)}`);
    console.log(c.dim('  接入 AstrBot: OneBot v11(aiocqhttp) → 上面的 WS 地址 + access_token'));
  }
  const rc = ob.wsClient || {};
  if (rc.enabled) {
    console.log(`  ${c.dim('反向 WS')}  ${rc.url || '-'}  ${rc.connected ? c.green('已连接') : c.yellow('未连接/重连中')}`);
  } else {
    console.log(c.dim('  反向 WS   未启用（onebot.wsClient.enabled = false）'));
  }
  console.log('');
  console.log(c.dim('  输入 o new 重新生成 OneBot 令牌'));
  line();
}

async function resetOneBotToken() {
  const sure = (await ask('重置 OneBot 令牌会断开已接入的机器人，继续?(yes/n): ')).toLowerCase();
  if (sure !== 'yes') { console.log('已取消'); return; }
  cfg.onebot = cfg.onebot || {};
  cfg.onebot.http = Object.assign({}, cfg.onebot.http, { token: '' });
  cfg.onebot.ws = Object.assign({}, cfg.onebot.ws, { token: '' });
  try { device.save(cfg); } catch (e) { err('保存失败: ' + e.message); return; }
  const was = !!srv;
  if (was) { await stopServer(); await startServer(); }
  ok('OneBot 令牌已重置' + (was ? '，服务已重启' : ''));
}

// ============ 界面 ============

function screenHeader() {
  const status = cfg.token ? c.green('已登录') : c.yellow('未登录');
  const acc = cfg.userName ? maskSensitive(cfg.userName) : '-';
  const port = cfg.webui.port;
  const web = srv ? c.green(`运行中 :${port}`) : c.dim('未启动');
  console.log('');
  console.log(`${c.bold('JZClientForNode')}  ${c.dim('账号')} ${acc}  ${c.dim('状态')} ${status}  ${c.dim('WebUI')} ${web}`);
  line();
  console.log('  1) 登录/切换账号    2) 退出登录    3) 账号信息');
  console.log('  4) 查看配置         5) 启停 WebUI    t) 访问令牌');
  console.log('  o) OneBot 接入');
  console.log(c.dim('  0/q) 退出    h) 帮助'));
}

const HELP = `  ${c.bold('命令')}
    1  登录 / 切换账号(已登录时会先停掉 WebUI)
    2  退出登录(清除本地票据)
    3  账号信息(账号 / 手表列表)
    4  查看配置(脱敏后打印 config.json)
    5  启动或停止 WebUI
    t  查看访问令牌与快捷链接
    t new  重新生成访问令牌
    o  查看 OneBot v11 接入信息
    o new  重新生成 OneBot 令牌
    h  显示本帮助
    0  退出

  ${c.bold('说明')}
    这个命令行只负责账号。手表、定位、聊天、通讯录、安全区域、
    应用管理、闹钟、设置等功能全部在 WebUI 里, 浏览器打开即可。
    WebUI 默认监听 0.0.0.0(局域网可访问), 但所有接口都要访问令牌,
    首次启动会自动生成并写回配置。
    端口、监听地址和令牌在 ${device.CONFIG_FILE} 的 webui 字段里:
      "webui": { "port": 8787, "host": "0.0.0.0", "token": "jz_..." }
    想只允许本机访问就把 host 改成 "127.0.0.1"。

    OneBot v11 默认开启(HTTP 5700 / WS 5701), 用 o 看地址和令牌。
    在 AstrBot 里选 OneBot v11(aiocqhttp), 填 WS 地址 + access_token 即可接入。`;

// 等输入期间保持提示行干净: 日志写入前擦掉当前行, 写完重绘提示符
async function prompt(q) {
  if (TTY) {
    log.setPromptRedraw({
      before: () => process.stdout.write('\r\x1b[2K'),
      after: () => process.stdout.write(q),
    });
  }
  const a = await ask(q);
  log.setPromptRedraw(null);
  return a;
}

async function exitApp(code = 0) {
  if (exiting) return;
  exiting = true;
  log.setPromptRedraw(null);
  suppressCloseExit = true;
  await stopServer();
  if (rl) rl.close();
  process.exit(code);
}

async function mainLoop() {
  console.log(pickLogo());
  console.log(c.dim('  配置文件: ' + device.CONFIG_FILE));

  // 未登录: 直接引导登录, 不摆菜单
  if (!cfg.token) {
    screenHeader();
    console.log(c.dim('  未登录，先登录账号。其余功能登录后都在 WebUI 里操作。'));
    const done = await doLogin();
    if (!done) {
      console.log('');
      console.log(c.dim('  登录未完成。输入 1 重试，q 退出。'));
    }
  }

  // 已登录: 自动拉起 WebUI(参考 NapCat)
  if (cfg.token) {
    if (await startServer()) {
      console.log(c.dim('  下方实时打印请求/响应日志（WP_LOG=debug 更详细）。'));
      console.log(c.dim('  输入 5 停止服务，输入 0 退出。'));
    }
  }

  while (true) {
    if (TTY) console.log('');
    const a = (await prompt('> ')).toLowerCase();
    if (a === '0' || a === 'q' || a === 'quit' || a === 'exit') return exitApp(0);
    if (!a) continue;

    if (a === 'h' || a === '?' || a === 'help') { console.log(HELP); continue; }

    if (a === '1') {
      // 换账号前先停服务, 否则旧的 token 还在服务内存里
      if (srv) await stopServer();
      const done = await doLogin();
      if (done) await startServer();
      continue;
    }

    if (a === '2') { await doLogout(); continue; }
    if (a === '3') { await doAccountInfo(); continue; }
    if (a === '4') { doConfig(); continue; }
    if (a === '5') { await toggleServer(); continue; }
    if (a === 't') { showToken(); continue; }
    if (a === 't new' || a === 't reset') { await resetToken(); continue; }
    if (a === 'o') { showOneBot(); continue; }
    if (a === 'o new' || a === 'o reset') { await resetOneBotToken(); continue; }

    console.log(c.dim('  未知命令，输入 h 看帮助。'));
  }
}

process.on('SIGINT', () => { exitApp(0); });
process.on('SIGTERM', () => { exitApp(0); });

openRl();
mainLoop().catch((e) => {
  err('出错: ' + (e && e.message ? e.message : e));
  exitApp(1);
});
