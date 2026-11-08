'use strict';
// 小红书桥接服务（独立进程，可单独打包给别人）
//
// 定位：把「需要真实浏览器签名」的小红书操作，包装成普通 HTTP 接口。
// 调用方（JZClient / 脚本 / 别的服务）只需要 POST JSON，不碰浏览器。
//
// 安全：默认只监听 127.0.0.1；所有接口要 Bearer 令牌（data/token.txt 自动生成）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const browser = require('./browser');
const login = require('./login');
const publish = require('./publish');
const im = require('./im');
const xhsApi = require('./xhs-api');
const safety = require('./safety');

const DATA = browser.DATA;
const PORT = Number(process.env.XHS_PORT || 18811);
const HOST = process.env.XHS_HOST || '127.0.0.1';

function token() {
  const f = path.join(DATA, 'token.txt');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { /* 生成 */ }
  const t = 'xhs_' + crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  return t;
}
const TOKEN = token();

// 空闲自动关浏览器：内存紧张，不能让它常驻吃 1GB。
// 默认 3 分钟没有任何请求就关，下次操作会自动重新拉起（登录态在 profile 里，不丢）。
const IDLE_MS = Number(process.env.XHS_IDLE_MS || 3 * 60e3);
let lastUse = Date.now();
setInterval(() => {
  if (browser.isRunning() && Date.now() - lastUse > IDLE_MS) {
    console.log('[xhs-bridge] 空闲 ' + Math.round(IDLE_MS / 1000) + 's，关闭浏览器释放内存');
    browser.close().catch(() => {});
  }
}, 30000).unref();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
const ok = (res, data) => json(res, 200, { ok: true, data });
const fail = (res, e, code) => json(res, code || 400, { ok: false, error: e && e.message ? e.message : String(e) });

function auth(req, url) {
  const h = String(req.headers.authorization || '');
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const q = url.searchParams.get('token') || '';
  return bearer === TOKEN || q === TOKEN;
}

function body(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  lastUse = Date.now();

  if (p === '/' || p === '/v1/health') {
    return ok(res, {
      service: 'xhs-bridge',
      version: '0.1.0',
      browserRunning: browser.isRunning(),
      port: PORT,
      time: Date.now(),
    });
  }
  if (!auth(req, url)) return json(res, 401, { ok: false, unauthorized: true, error: '未授权' });

  try {
    if (p === '/v1/login/open' && req.method === 'POST') return ok(res, await login.open());
    if (p === '/v1/login/qr' && req.method === 'GET') {
      return ok(res, await login.qr(url.searchParams.get('refresh') === '1'));
    }
    if (p === '/v1/login/status' && req.method === 'GET') return ok(res, await login.status());
    if (p === '/v1/login/logout' && req.method === 'POST') return ok(res, await login.logout());

    if (p === '/v1/safety' && req.method === 'GET') return ok(res, safety.state());
    if (p === '/v1/safety' && req.method === 'POST') return ok(res, safety.update(await body(req)));

    if (p === '/v1/search' && req.method === 'GET') {
      await safety.before('search');
      return ok(res, await xhsApi.search(url.searchParams.get('kw'), url.searchParams.get('limit')));
    }
    if (p === '/v1/note-by-click' && req.method === 'GET') {
      await safety.before('note');
      return ok(res, await xhsApi.noteByClick(url.searchParams.get('kw'), url.searchParams.get('idx')));
    }
    if (p === '/v1/note' && req.method === 'GET') {
      await safety.before('note');
      return ok(res, await xhsApi.note(url.searchParams.get('url'), url.searchParams.get('token')));
    }
    if (p === '/v1/publish/video' && req.method === 'POST') {
      const b = await body(req);
      await safety.before('publish');
      return ok(res, await publish.publishVideo(b));
    }
    if (p === '/v1/im/chats' && req.method === 'GET') {
      await safety.before('dm');
      return ok(res, await im.listChats());
    }
    if (p === '/v1/im/send' && req.method === 'POST') {
      const b = await body(req);
      await safety.before('dm');
      return ok(res, await im.send(b));
    }

    if (p === '/v1/browser/close' && req.method === 'POST') {
      await browser.close();
      return ok(res, { closed: true });
    }
    if (p === '/v1/screenshot' && req.method === 'GET') {
      const buf = await browser.withPage(async (page) => page.screenshot({ fullPage: false }));
      return ok(res, { image: 'data:image/png;base64,' + buf.toString('base64'), at: Date.now() });
    }
    return json(res, 404, { ok: false, error: '接口不存在' });
  } catch (e) {
    return fail(res, e, e && e.status ? e.status : 400);
  }
});

server.listen(PORT, HOST, () => {
  console.log('[xhs-bridge] http://' + HOST + ':' + PORT);
  console.log('[xhs-bridge] token ' + TOKEN);
  console.log('[xhs-bridge] 浏览器目录 ' + browser.PROFILE);
});

process.on('SIGTERM', async () => { await browser.close(); process.exit(0); });
process.on('SIGHUP', async () => { await browser.close(); process.exit(0); });
process.on('SIGINT', async () => { await browser.close(); process.exit(0); });
