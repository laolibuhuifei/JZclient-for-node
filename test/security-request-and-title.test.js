'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const originalConnect = net.Socket.prototype.connect;
test.before(() => {
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof options === 'object' ? options.host : args[1];
    if (host !== '127.0.0.1') throw new Error('离线测试禁止非回环连接');
    return originalConnect.apply(this, args);
  };
});
test.after(() => { net.Socket.prototype.connect = originalConnect; });

function raw(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('请求超时')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.startsWith('HTTP/1.1 101 ') && data.includes('\r\n\r\n')) { socket.destroy(); resolve(data); }
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function request(target, host, extra = '') {
  return `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n${extra || 'Connection: close\r\n'}\r\n`;
}
function status(response, code) { assert.match(response, new RegExp(`^HTTP/1\\.1 ${code}\\b`)); }

test('WebUI 对畸形 URL 返回 400，之后继续处理正常鉴权', async t => {
  const saved = [];
  function mock(name, exports) {
    const id = require.resolve('../src/' + name);
    saved.push([id, require.cache[id]]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  class PluginManager { constructor() { this.plugins = new Map(); } async init() {} closeAll() {} }
  mock('api', { ApiClient: class {}, MODULES: {} });
  mock('im', { ImClient: class {} });
  mock('plugin', { PluginManager });
  mock('link-presets', { startAutoRefresh() {}, stopAutoRefresh() {} });
  mock('onebot', { startOneBot() { throw new Error('离线测试禁止启动 OneBot'); } });
  const device = require('../src/device');
  const oldIdentity = device.ensureIdentity;
  device.ensureIdentity = () => {};
  t.after(() => {
    device.ensureIdentity = oldIdentity;
    delete require.cache[require.resolve('../src/webui')];
    for (const [id, old] of saved) { if (old) require.cache[id] = old; else delete require.cache[id]; }
  });
  const { startWebUI } = require('../src/webui');
  const cfg = { ai: { autoStart: false, sessions: [] }, plugins: { enabled: false }, onebotWatches: {}, biliBots: {}, watchStatus: {}, links: { auto: false } };
  const app = await startWebUI({ cfg, host: '127.0.0.1', port: 0, token: 'test-token' });
  t.after(() => app.close());
  const port = app.server.address().port;
  status(await raw(port, request('/', '[')), 400);
  status(await raw(port, request('http://[/', 'localhost')), 400);
  status(await raw(port, request('/api/auth/status', 'localhost')), 200);
  status(await raw(port, request('/api/system', 'localhost')), 401);
});

test('OneBot HTTP 和 WS 畸形 URL 不影响服务与鉴权', async t => {
  const { startOneBot } = require('../src/onebot');
  const hp = await freePort();
  let wp = await freePort();
  while (wp === hp) wp = await freePort();
  const app = await startOneBot({ cfg: {}, ctx: {}, conf: { heartbeat: 0, http: { enabled: true, host: '127.0.0.1', port: hp, token: 'http-token' }, ws: { enabled: true, host: '127.0.0.1', port: wp, token: 'ws-token' } } });
  t.after(() => app.close());
  assert.equal(app.http.running, true);
  assert.equal(app.ws.running, true);
  for (const [target, host] of [['/', '['], ['http://[/', 'localhost']]) {
    status(await raw(hp, request(target, host)), 400);
    status(await raw(wp, request(target, host, 'Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'.replace('Upgrade: websocket\r\n', 'Upgrade: websocket\r\nConnection: Upgrade\r\n'))), 400);
  }
  status(await raw(hp, request('/', 'localhost')), 401);
  status(await raw(hp, request('/?access_token=http-token', 'localhost')), 200);
  const upgrade = 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n';
  status(await raw(wp, request('/', 'localhost', upgrade)), 401);
  status(await raw(wp, request('/?access_token=ws-token', 'localhost', upgrade)), 101);
});

test('OneBot 手表名称在标题文本和属性中安全转义', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/webui.html'), 'utf8');
  const escStart = html.indexOf('  function esc(v){');
  const escEnd = html.indexOf('\n  }', escStart) + 4;
  const start = html.indexOf('  async function loadOneBotCard(){');
  const marker = '    box.innerHTML = html;';
  const end = html.indexOf(marker, start) + marker.length;
  assert.ok(escStart >= 0 && start >= 0 && end >= marker.length);
  const box = { innerHTML: '' };
  const name = '<img src=x onerror="alert(1)">&\'测试';
  const context = { box, state: { id: '1' }, currentWatch: () => ({}), $: () => box, location: { hostname: 'localhost' }, api: async () => ({ watches: [{ watchId: '1', name, http: {}, ws: {}, wsClient: {} }] }) };
  vm.runInNewContext(html.slice(escStart, escEnd) + '\nvar obSecOpen = null;\n' + html.slice(start, end) + '\n}\nthis.run = loadOneBotCard;', context);
  await context.run();
  assert.doesNotMatch(box.innerHTML, /<img src=x/);
  assert.match(box.innerHTML, /data-sec="本表设置 · &lt;img/);
  assert.match(box.innerHTML, /<span>本表设置 · &lt;img/);
  assert.match(box.innerHTML, /&quot;alert\(1\)&quot;/);
});
