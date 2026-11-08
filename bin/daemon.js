#!/usr/bin/env node
// 非交互启动入口 —— 安卓 App 的「本地模式」用这个，不是 bin/jzclient.js。
//
// 为什么要单独一个文件：jzclient.js → src/cli.js 是给人用的交互式 CLI
// （readline 菜单、ANSI 颜色、等按键），塞进 App 里既没人敲键盘，输出也没人看。
// 这里只做三件事：读配置 → 起 WebUI → 挂一个能让 App 叫停的退出端点。
//
// 为什么需要退出端点：libnode 是用 JNI 内嵌进 App 进程的，node::Start() 是阻塞调用、
// **没有 stop API**。要「停止本地服务」只能让 Node 自己 process.exit()，
// 所以这里在 port+1 上单独起一个小 HTTP 服务，只认 token 的 POST /__exit。
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = Number(arg('port', process.env.JZ_PORT || 8788)) || 8788;
const HOST = arg('host', '127.0.0.1');
const EXIT_TOKEN = process.env.JZ_EXIT_TOKEN || crypto.randomBytes(16).toString('hex');

// 崩溃只能用文件记录下来：Android 上 Node 的 stdout/stderr 是 /dev/null，
// console.error 谁都不会看见，App 只能靠读这个文件把原因显示给用户。
const ERR_FILE = path.join(ROOT, 'daemon-error.log');
const READY_FILE = path.join(ROOT, 'daemon-ready.json');

function recordErr(kind, e) {
  try {
    const detail = e && e.stack ? e.stack : String(e);
    fs.appendFileSync(ERR_FILE, `[${new Date().toISOString()}] ${kind}: ${detail}\n`);
  } catch (_) { /* 连日志都写不了就没办法了 */ }
}

process.on('uncaughtException', (e) => { recordErr('uncaughtException', e); process.exit(1); });
process.on('unhandledRejection', (e) => { recordErr('unhandledRejection', e); });

(async () => {
  let srv;
  try {
    // 每次启动先清掉上一轮的痕迹，否则 App 可能读到过期的 ready/error
    try { fs.unlinkSync(ERR_FILE); } catch (_) {}
    try { fs.unlinkSync(READY_FILE); } catch (_) {}

    const device = require('../src/device');
    const { startWebUI } = require('../src/webui');

    const cfg = device.load();
    // 强制锁回环。cli.js 的默认值是 0.0.0.0（方便电脑上局域网访问），
    // 但手机上那样等于把整个 WebUI 暴露给同一个 WiFi 的所有人。
    cfg.webui = Object.assign({}, cfg.webui, { port: PORT, host: HOST });
    device.save(cfg);

    srv = await startWebUI({ cfg, port: PORT, host: HOST });

    fs.writeFileSync(READY_FILE, JSON.stringify({
      ok: true,
      port: PORT,
      url: srv.url,
      // WebView 要用它换登录态：/?token=<token>
      token: srv.token,
      exitPort: PORT + 1,
      exitToken: EXIT_TOKEN,
      at: Date.now(),
    }));
    console.log('[daemon] WebUI 已就绪 ' + srv.url);
  } catch (e) {
    recordErr('startup', e);
    process.exit(1);
  }

  const exitSrv = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/__exit') {
      res.writeHead(404);
      return res.end();
    }
    if (req.headers['x-jz-token'] !== EXIT_TOKEN) {
      res.writeHead(403);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    // 先把 200 发出去，再关服务 —— 直接 exit 的话 App 那边读不到响应，
    // 会误以为「退出失败」然后又去杀一遍
    setTimeout(async () => {
      try { await srv.close(); } catch (_) {}
      process.exit(0);
    }, 80);
  });
  exitSrv.on('error', (e) => recordErr('exit-server', e));
  exitSrv.listen(PORT + 1, '127.0.0.1', () => {
    console.log('[daemon] 退出端点 127.0.0.1:' + (PORT + 1));
  });
})();
