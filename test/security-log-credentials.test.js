'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

function raw(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('请求超时')));
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    socket.on('data', chunk => { data += chunk; });
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

test('WebUI 查询参数及 WebUI、OneBot 启动令牌不进入日志', async t => {
  const saved = [];
  function mock(name, exports) {
    const id = require.resolve('../src/' + name);
    saved.push([id, require.cache[id]]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof options === 'object' ? options.host : args[1];
    if (host !== '127.0.0.1') throw new Error('离线测试禁止非回环连接');
    return originalConnect.apply(this, args);
  };
  const oldLog = process.env.WP_LOG;
  process.env.WP_LOG = 'debug';
  const oldWrite = process.stdout.write;
  let output = '';
  process.stdout.write = function (chunk, ...args) {
    output += String(chunk);
    return oldWrite.call(this, chunk, ...args);
  };
  t.after(() => {
    process.stdout.write = oldWrite;
    net.Socket.prototype.connect = originalConnect;
    if (oldLog === undefined) delete process.env.WP_LOG; else process.env.WP_LOG = oldLog;
    delete require.cache[require.resolve('../src/webui')];
    for (const [id, old] of saved) { if (old) require.cache[id] = old; else delete require.cache[id]; }
  });
  class PluginManager { constructor() { this.plugins = new Map(); } async init() {} closeAll() {} }
  mock('api', { ApiClient: class {}, MODULES: {} });
  mock('im', { ImClient: class {} });
  mock('plugin', { PluginManager });
  mock('link-presets', { startAutoRefresh() {}, stopAutoRefresh() {} });
  mock('device', {
    ensureIdentity() {}, normalizePlugins: x => x || {}, normalizeExtApi: x => x || {},
    save() { throw new Error('离线测试禁止写入配置'); },
    load() { throw new Error('离线测试禁止读取配置'); },
  });
  const log = require('../src/logger');
  const previousLevel = log.levelName();
  t.after(() => log.setLevel(previousLevel));
  const since = log.seq();
  const { startWebUI } = require('../src/webui');
  const { startOneBot } = require('../src/onebot');
  const webToken = 'fictional-web-start-secret-97';
  const httpToken = 'fictional-onebot-http-secret-84';
  const wsToken = 'fictional-onebot-ws-secret-63';
  const querySecret = 'fictional-query-value-51';
  const cfg = { ai: { autoStart: false, sessions: [] }, plugins: { enabled: false }, onebotWatches: {}, biliBots: {}, watchStatus: {}, links: { auto: false } };
  const web = await startWebUI({ cfg, host: '127.0.0.1', port: 0, token: webToken });
  t.after(() => web.close());
  const hp = await freePort();
  let wp = await freePort();
  while (wp === hp) wp = await freePort();
  const onebot = await startOneBot({ cfg: {}, ctx: {}, conf: { heartbeat: 0, http: { enabled: true, host: '127.0.0.1', port: hp, token: httpToken }, ws: { enabled: true, host: '127.0.0.1', port: wp, token: wsToken } } });
  t.after(() => onebot.close());
  assert.equal(onebot.http.running, true);
  assert.equal(onebot.ws.running, true);
  const response = await raw(web.server.address().port, `/api/auth/status?arbitrary=${querySecret}&token=${webToken}`);
  assert.match(response, /^HTTP\/1\.1 (?:200|302)\b/);
  // 等待响应结束回调写入请求日志，分别验证终端和 WebUI 内存日志。
  await new Promise(resolve => setImmediate(resolve));
  const entries = log.recent(800, since);
  assert.ok(entries.some(e => e.tag === 'HTTP' && e.text.includes('/api/auth/status')));
  assert.ok(entries.some(e => e.cat === 'webui' && e.text.includes('服务已启动')));
  assert.ok(entries.some(e => e.cat === 'onebot' && e.text.includes('HTTP API')));
  assert.ok(entries.some(e => e.cat === 'onebot' && e.text.includes('WS 服务')));
  for (const secret of [webToken, httpToken, wsToken, querySecret]) {
    assert.ok(!output.includes(secret), '终端日志泄露虚构凭据');
    assert.ok(!JSON.stringify(entries).includes(secret), '内存日志泄露虚构凭据');
  }
  const requestEntry = entries.find(e => e.tag === 'HTTP' && e.text.includes('/api/auth/status'));
  assert.ok(!requestEntry.text.includes('?'), '请求日志不应包含任何查询字符串');
});
