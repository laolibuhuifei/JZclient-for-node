'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');

test('状态接口使用内存数据并在推送后刷新缓存', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jz-status-'));
  const originalHome = os.homedir;
  os.homedir = () => home;
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const a = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof a === 'object' ? a.host : args[1];
    if (host !== '127.0.0.1') throw new Error('测试禁止非回环连接');
    return originalConnect.apply(this, args);
  };
  const replaced = [];
  function mock(module, exports) {
    const id = require.resolve('../src/' + module);
    replaced.push([id, require.cache[id]]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  let account = { name: '模拟手表', battery: 0 };
  let reads = 0;
  let failInit = false;
  let im;
  const result = (data) => ({ json: { code: '000001', data } });
  class ApiClient {
    async getDialogAccounts() { return result({ familyDialogs: [] }); }
    async getMobileInit() { reads++; if (failInit) throw new Error('模拟平台不可用'); return result({ mobileWatchs: [{ watchId: 'id' }] }); }
    async getWatchAccount() { return result({ ...account }); }
    async getWatchMembers() { return result([]); }
    async getClassModes() { return result([]); }
    async getGuardStatus() { return result({}); }
  }
  class ImClient extends EventEmitter {
    constructor() { super(); im = this; this.connected = false; this.imAccountId = 'mock'; }
    async connect() { this.connected = true; }
    async sync() {}
    close() { this.connected = false; }
  }
  class PluginManager {
    constructor() { this.plugins = new Map(); }
    async init() {}
    closeAll() {}
  }
  mock('api', { ApiClient, MODULES: {} });
  mock('im', { ImClient });
  mock('plugin', { PluginManager });
  mock('link-presets', { startAutoRefresh() {}, stopAutoRefresh() {} });
  mock('onebot', { startOneBot() { throw new Error('不应启动 OneBot'); } });
  const device = require('../src/device');
  const oldSave = device.save;
  device.save = () => {};
  const { startWebUI } = require('../src/webui');
  let app;
  t.after(async () => {
    cfg.token = null; // startWebUI 的后台定时器未由 close 清理，禁止后续重连。
    if (im) im.close();
    if (app) await app.close();
    device.save = oldSave;
    delete require.cache[require.resolve('../src/webui')];
    delete require.cache[require.resolve('../src/device')];
    for (const [id, old] of replaced) { if (old) require.cache[id] = old; else delete require.cache[id]; }
    net.Socket.prototype.connect = originalConnect;
    os.homedir = originalHome;
    const resolved = fs.realpathSync(home);
    const tmp = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) !== tmp || !path.basename(resolved).startsWith('jz-status-')) {
      throw new Error('测试临时目录不在预期位置，拒绝处理');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const cfg = { token: '模拟登录', ai: { autoStart: false, sessions: [] }, plugins: { enabled: false }, onebotWatches: {}, biliBots: {}, watchStatus: {}, links: { auto: false } };
  app = await startWebUI({ cfg, host: '127.0.0.1', port: 0, token: 'test-token' });
  const port = app.server.address().port;
  const get = (url) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: { authorization: 'Bearer test-token' }, agent: false }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; });
      res.on('end', () => { try { const parsed = JSON.parse(body); assert.equal(parsed.ok, true, parsed.error); resolve(parsed.data); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  const system = await get('/api/system');
  const overview = await get('/api/watch/id/overview');
  const status = await get('/api/watch/id/status');
  assert.equal(system.account.watches[0].battery, 0);
  assert.equal(system.account.watches[0].online, null);
  assert.deepEqual(overview.batteryInfo, { battery: 0, batterySource: 'api', batteryAt: null, batteryTimeKind: null });
  assert.equal(overview.onlineStatus, null);
  for (const key of ['battery', 'batterySource', 'batteryAt', 'batteryTimeKind']) assert.equal(status[key], overview.batteryInfo[key]);
  assert.equal(status.onlineStatus, null);
  const before = reads;
  account = { name: '模拟手表', battery: null };
  im.emit('message', { body: { type: 27, watchId: 'id', content: JSON.stringify({ battery: 75 }) } });
  const after = await get('/api/watch/id/status');
  assert.ok(reads > before, '推送应使列表缓存失效');
  assert.equal(after.battery, 75);
  assert.equal(after.batterySource, 'push');
  assert.equal(after.batteryTimeKind, 'received');
  assert.ok(after.batteryAt > 0);
  const overviewAfter = await get('/api/watch/id/overview');
  const systemAfter = await get('/api/system');
  for (const key of ['battery', 'batterySource', 'batteryAt', 'batteryTimeKind']) assert.equal(after[key], overviewAfter.batteryInfo[key]);
  assert.equal(systemAfter.account.watches[0].battery, after.battery);
  assert.equal(systemAfter.account.watches[0].online, null);
  const savedTime = cfg.watchStatus.id.batteryAt;
  im.emit('message', { source: 'sync', createTime: Date.now() - 3_600_000, body: { type: 27, watchId: 'id', content: JSON.stringify({ battery: 10 }) } });
  assert.equal(cfg.watchStatus.id.battery, 75, '旧同步状态不得覆盖新电量');
  assert.equal(cfg.watchStatus.id.batteryAt, savedTime);
  failInit = true;
  im.emit('message', { source: 'push', body: { type: 27, watchId: 'id', content: JSON.stringify({ battery: 60 }) } });
  const offline = await get('/api/watch/id/status');
  assert.equal(offline.battery, 60, '平台不可用时返回本地较新的推送');
  assert.equal(offline.batterySource, 'push');
});
