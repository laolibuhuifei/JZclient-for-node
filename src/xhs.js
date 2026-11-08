'use strict';
// 小红书桥接客户端
//
// 真正的签名/浏览器在独立服务 xhs-bridge 里（默认 127.0.0.1:18811）。
// 这里只发普通 HTTP，不碰浏览器，也不做任何签名。
const log = require('./logger');

const DEF_BASE = 'http://127.0.0.1:18811';

function conf(cfg) {
  const c = (cfg && cfg.xhs) || {};
  return {
    baseUrl: String(c.baseUrl || DEF_BASE).replace(/\/+$/, ''),
    token: String(c.token || ''),
  };
}

async function call(cfg, path, opts) {
  const c = conf(cfg);
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  if (c.token) headers.Authorization = 'Bearer ' + c.token;
  if (o.body && typeof o.body !== 'string') {
    o.body = JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(c.baseUrl + path, {
    method: o.method || 'GET',
    headers,
    body: o.body,
    signal: AbortSignal.timeout(o.timeout || 120000),
  });
  let j;
  const text = await r.text();
  try { j = JSON.parse(text); } catch (e) {
    throw new Error('桥接服务返回的不是 JSON（HTTP ' + r.status + '）');
  }
  if (r.status === 401 || j.unauthorized) throw new Error('桥接服务令牌不对，请到设置里更新');
  if (!j.ok) throw new Error(j.error || '桥接服务返回失败');
  return j.data;
}

const health = (cfg) => call(cfg, '/v1/health', { timeout: 8000 });
const open = (cfg) => call(cfg, '/v1/login/open', { method: 'POST', body: {} });
const qr = (cfg, force) => call(cfg, '/v1/login/qr' + (force ? '?refresh=1' : ''), { timeout: 90000 });
const status = (cfg) => call(cfg, '/v1/login/status', { timeout: 60000 });
const logout = (cfg) => call(cfg, '/v1/login/logout', { method: 'POST', body: {} });
const publish = (cfg, payload) => call(cfg, '/v1/publish/video', { method: 'POST', body: payload, timeout: 180000 });
const chats = (cfg) => call(cfg, '/v1/im/chats', { timeout: 90000 });
const send = (cfg, payload) => call(cfg, '/v1/im/send', { method: 'POST', body: payload, timeout: 90000 });
const search = (cfg, kw, limit) => call(cfg, '/v1/search?kw=' + encodeURIComponent(kw) + '&limit=' + (Number(limit) || 10), { timeout: 150000 });
const note = (cfg, url, token) => call(cfg, '/v1/note?url=' + encodeURIComponent(url)
  + '&token=' + encodeURIComponent(token || ''), { timeout: 150000 });
const noteByClick = (cfg, kw, idx) => call(cfg, '/v1/note-by-click?kw=' + encodeURIComponent(kw)
  + '&idx=' + (Number(idx) || 1), { timeout: 180000 });
const safety = (cfg) => call(cfg, '/v1/safety', { timeout: 15000 });
const setSafety = (cfg, patch) => call(cfg, '/v1/safety', { method: 'POST', body: patch, timeout: 15000 });
const screenshot = (cfg) => call(cfg, '/v1/screenshot', { timeout: 30000 });

module.exports = { conf, health, open, qr, status, logout, publish, chats, send, safety, setSafety, screenshot, search, note, noteByClick };
