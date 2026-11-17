import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let directory;
let filename;
let components;
const globalOverrides = new WeakMap();

test.before(async () => {
  const cache = path.join(frontend, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(path.join(cache, 'home-checks-'));
  filename = path.join(directory, 'home.mjs');
  const result = await build({
    absWorkingDir: frontend,
    stdin: {
      contents: `
        export { default as HomePage } from './src/pages/HomePage';
        export { default as ChatPage } from './src/pages/ChatPage';
        export { TestAppContext } from './src/context/AppContext';
      `,
      loader: 'tsx', resolveDir: frontend, sourcefile: 'home-checks-entry.tsx',
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node18', packages: 'external',
    loader: { '.css': 'empty' }, outfile: filename, write: false,
    plugins: [{
      name: 'home-test-context',
      setup(builder) {
        builder.onResolve({ filter: /(?:^|\/)context\/AppContext$/ }, () => ({ path: 'app-context', namespace: 'home-test-context' }));
        builder.onLoad({ filter: /.*/, namespace: 'home-test-context' }, () => ({
          contents: `
            import { createContext, useContext } from 'react';
            export const TestAppContext = createContext(null);
            export const useApp = () => useContext(TestAppContext);
            export const useOptionalApp = () => null;
          `,
          loader: 'js', resolveDir: frontend,
        }));
      },
    }],
  });
  await writeFile(filename, result.outputFiles[0].contents);
  components = await import(pathToFileURL(filename).href);
});

test.after(async () => {
  if (filename) await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (directory) await rmdir(directory);
});

function replaceGlobal(t, key, value) {
  let originals = globalOverrides.get(t);
  if (!originals) {
    originals = new Map();
    globalOverrides.set(t, originals);
    t.after(() => {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    });
  }
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

function jsonResponse(data, status = 200) {
  const body = status < 400 ? { ok: true, data } : { ok: false, error: String(data) };
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function abortable(result, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', aborted);
    const aborted = () => { cleanup(); reject(signal.reason || new DOMException('Cancelled', 'AbortError')); };
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    Promise.resolve(result).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function fixtureSystem(overrides = {}) {
  return {
    account: {
      loggedIn: true, userName: '测试家长', imConnected: true, watchCount: 2,
      watches: [
        { watchId: 'watch-a', name: '太阳手表', model: 'Z8', battery: 72, online: true },
        { watchId: 'watch-b', name: '月亮手表', model: 'Z9', battery: 36, online: false },
      ],
      ...overrides,
    },
    system: { platform: 'win32', arch: 'x64', memTotal: 8192, memUsed: 2048, memPercent: 25, cpuPercent: 12 },
    process: { uptime: 120, rss: 256, heapUsed: 128, cpuPercent: 2 },
  };
}

function fixtureWatches() {
  return [
    { watchId: 'watch-b', name: '缓存中的月亮手表', model: '旧型号', battery: 99, onlineStatus: true, imei: '867000000000002', number: '13900000002', firmware: 'Z9_FIXTURE_2.0' },
    { watchId: 'watch-a', name: '缓存中的太阳手表', model: '旧型号', battery: 1, onlineStatus: false, imei: '867000000000001', number: '13900000001', firmware: 'Z8_FIXTURE_1.0' },
  ];
}

function fixtureLocations() {
  return {
    'watch-a': { location: { latitude: 31.2304, longitude: 121.4737, desc: '太阳手表测试位置', createTime: 1700000000, radius: 30 }, onlineStatus: true },
    'watch-b': { location: { latitude: 0, longitude: 0, desc: '月亮手表零点位置', createTime: 1700000100, radius: 0 }, onlineStatus: false },
    'watch-c': { location: null, onlineStatus: null },
  };
}

function accessibleName(element) {
  return (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim();
}

function buttons(container, name) {
  return [...container.querySelectorAll('button')].filter(element => typeof name === 'string'
    ? accessibleName(element) === name : name.test(accessibleName(element)));
}

function button(container, name) {
  const matches = buttons(container, name);
  assert.equal(matches.length, 1, `应有一个按钮：${name}，实际为 ${matches.length}`);
  return matches[0];
}

function watchCard(container, name) {
  const card = button(container, name).closest('.home-watch-card');
  assert.ok(card, `${name} 应有对应的手表选择卡片`);
  return card;
}

function deviceDialog(home) {
  const dialogs = [...home.dom.window.document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(element => {
    const title = home.dom.window.document.getElementById(element.getAttribute('aria-labelledby'));
    return title?.textContent.trim() === '手表设备信息';
  });
  assert.equal(dialogs.length, 1, '设备资料应在有名称的模态弹窗中显示');
  return dialogs[0];
}

async function openDeviceDialog(home, name) {
  const trigger = button(home.container, `查看${name}的设备信息`);
  trigger.focus();
  await click(trigger);
  return { trigger, dialog: deviceDialog(home) };
}

function definition(container, label) {
  const terms = [...container.querySelectorAll('dt')].filter(element => element.textContent.trim() === label);
  assert.equal(terms.length, 1, `应有一个信息字段：${label}`);
  const value = terms[0].nextElementSibling;
  assert.equal(value?.tagName, 'DD', `${label} 应有对应字段值`);
  return value;
}

function runtimeTrends(home) {
  const trends = home.container.querySelector('.home-runtime-trends[data-sample-count]');
  assert.ok(trends, '运行状态应显示来自系统响应的真实趋势');
  return trends;
}

function runtimeSampleCount(home) {
  const count = Number(runtimeTrends(home).getAttribute('data-sample-count'));
  assert.ok(Number.isInteger(count) && count >= 0, '趋势采样数应是非负整数');
  return count;
}

function runtimeFigure(home, series) {
  const figure = runtimeTrends(home).querySelector(`figure[data-series="${series}"]`);
  assert.ok(figure, `运行趋势应有 ${series} 的独立图表与读数`);
  assert.ok(figure.querySelector('.home-runtime-trend-current'), '图表应显示最新读数');
  return figure;
}

function runtimeCurrent(home, series) {
  return runtimeFigure(home, series).querySelector('.home-runtime-trend-current').textContent.trim();
}

async function refreshHome(home) {
  await act(async () => { home.dom.window.dispatchEvent(new home.dom.window.Event('jz:refresh')); await delay(0); });
}

async function click(element) {
  await act(async () => { element.click(); await delay(0); });
}

async function mountHome(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="fixture"></main></body></html>', {
    url: 'http://127.0.0.1/', pretendToBeVisual: true,
  });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'CustomEvent', 'Event', 'MouseEvent']) {
    replaceGlobal(t, key, dom.window[key]);
  }
  replaceGlobal(t, 'IS_REACT_ACT_ENVIRONMENT', true);
  t.after(() => dom.window.close());
  const container = dom.window.document.getElementById('fixture');
  const server = {
    system: options.system || fixtureSystem(),
    systemResponse: options.systemResponse ?? null,
    quote: { text: '此刻保留的第一条一言。', author: '测试作者' },
    quoteResponse: null,
    locations: options.locations ?? fixtureLocations(),
    locationResponse: options.locationResponse ?? null,
    targets: options.targets ?? [
      { key: 's:unrelated', name: '无关旧会话', type: 'single' },
      { key: 's:another', name: '月亮手表', type: 'single' },
    ],
    avatars: options.avatars ?? {},
  };
  const requests = [];
  const blocked = [];
  replaceGlobal(t, 'fetch', (url, requestOptions = {}) => {
    const request = { url: String(url), method: requestOptions.method || 'GET', signal: requestOptions.signal };
    requests.push(request);
    const allowed = ['/api/system', '/api/announcements', '/api/yiyan', '/api/yiyan?refresh=1', '/api/chats'];
    const locationMatch = /^\/api\/watch\/([^/]+)\/location$/.exec(request.url);
    const profileMatch = /^\/api\/watch\/([^/]+)\/profile$/.exec(request.url);
    const chatAvatar = server.targets.some(target => target.type === 'single' && request.url === `/api/chats/avatar?key=${encodeURIComponent(target.key)}`);
    const watchAvatar = /^\/api\/watch\/([^/]+)\/avatar$/.exec(request.url);
    const chatMessages = server.targets.some(target => request.url === `/api/chats/messages?key=${encodeURIComponent(target.key)}`);
    if (request.method !== 'GET' || (!allowed.includes(request.url) && !locationMatch && !profileMatch && !chatAvatar && !watchAvatar && !chatMessages)) {
      blocked.push(request);
      return Promise.reject(new Error(`未模拟的请求：${request.method} ${request.url}`));
    }
    let response;
    if (request.url === '/api/system') response = server.systemResponse ? server.systemResponse(request) : jsonResponse(server.system);
    else if (request.url === '/api/announcements') response = jsonResponse({ notices: [] });
    else if (request.url === '/api/chats') response = jsonResponse({ targets: server.targets, im: { connected: true, alive: true } });
    else if (profileMatch) response = jsonResponse({ account: {} });
    else if (watchAvatar) response = jsonResponse({ url: server.avatars[decodeURIComponent(watchAvatar[1])] || '' });
    else if (chatMessages) response = jsonResponse({ messages: [], im: { connected: true, alive: true } });
    else if (chatAvatar) response = jsonResponse({ url: '' });
    else if (locationMatch) {
      const id = decodeURIComponent(locationMatch[1]);
      response = server.locationResponse ? server.locationResponse(id, request) : jsonResponse(server.locations[id] ?? { location: null, onlineStatus: null });
    }
    else response = server.quoteResponse ? server.quoteResponse(request.url) : jsonResponse(server.quote);
    return abortable(response, requestOptions.signal);
  });
  t.after(() => assert.deepEqual(blocked, [], '所有请求必须来自明确模拟的只读接口'));
  const controls = { navigations: [], watchWrites: [], state: null };
  function Harness() {
    const [watchId, updateWatchId] = useState(options.watchId || 'watch-a');
    const [tokenInvalid, updateTokenInvalid] = useState(!!options.tokenInvalid);
    const [route, updateRoute] = useState({ page: 'home', params: options.params || {} });
    controls.setTokenInvalid = updateTokenInvalid;
    controls.state = { watchId, tokenInvalid, ...route };
    const watches = options.watches ?? server.system.account.watches;
    const context = {
      watchId, tokenInvalid, page: route.page, params: route.params,
      account: server.system.account, watches,
      watch: watches.find(item => item.watchId === watchId),
      loading: false, plugins: [], refreshWatches: async () => {},
      setWatchId(id) { controls.watchWrites.push(String(id)); updateWatchId(String(id)); },
      navigate(page, params = {}) { controls.navigations.push({ page, params }); updateRoute({ page, params }); },
    };
    const Page = options.renderChat && route.page === 'chat' ? components.ChatPage : components.HomePage;
    return React.createElement(components.TestAppContext.Provider, { value: context }, React.createElement(Page));
  }
  const root = createRoot(container);
  const close = () => act(async () => root.unmount());
  try {
    await act(async () => { root.render(React.createElement(Harness)); await delay(0); });
  } catch (error) { await close(); throw error; }
  return { container, dom, server, controls, requests, close };
}

test('主页切换手表后，数据刷新及位置、详情、守护入口保留所选 watchId', async t => {
  const home = await mountHome(t);
  try {
    await click(button(home.container, '月亮手表'));
    assert.equal(home.controls.state.watchId, 'watch-b');
    assert.equal(button(home.container, '月亮手表').getAttribute('aria-pressed'), 'true');
    home.server.system.account.watches[1].battery = 24;
    await act(async () => { home.dom.window.dispatchEvent(new home.dom.window.Event('jz:refresh')); await delay(0); });
    assert.equal(home.requests.filter(request => request.url === '/api/system').length, 2);
    assert.equal(button(home.container, '月亮手表').getAttribute('aria-pressed'), 'true');
    assert.match(home.container.textContent, /24%/);
    for (const [name, page] of [['打开定位页', 'location'], ['设备详情', 'overview'], [/^安全区域/, 'guard']]) {
      const container = page === 'overview' ? (await openDeviceDialog(home, '月亮手表')).dialog : home.container;
      await click(button(container, name));
      assert.deepEqual(home.controls.navigations.at(-1), { page, params: {} });
      assert.equal(home.controls.state.watchId, 'watch-b');
      assert.equal(home.controls.watchWrites.at(-1), 'watch-b');
    }
  } finally { await home.close(); }
});

test('单设备名称为卡片留出完整显示宽度，不占满首页主栏', async t => {
  const system = fixtureSystem();
  system.account.watches = [{ watchId: 'watch-a', name: '桉桉也是喵cat', model: 'Z8', battery: 72, online: true }];
  system.account.watchCount = 1;
  const home = await mountHome(t, { system });
  try {
    const picker = home.container.querySelector('.home-watch-picker');
    assert.ok(picker, '主页应有手表选择器');
    assert.equal(picker.style.getPropertyValue('--home-watch-single-ch'), String(Array.from('桉桉也是喵cat').length));
    const card = watchCard(home.container, '桉桉也是喵cat');
    assert.equal(card.querySelector('.home-watch-name > strong').textContent, '桉桉也是喵cat');
    assert.equal(card.querySelector('.home-watch-more'), null);
  } finally { await home.close(); }
});

test('更多设备选择回显到主卡片，刷新后保持所选设备并将定位交给该设备', async t => {
  const system = fixtureSystem();
  system.account.watches.push({ watchId: 'watch-c', name: '星星手表', model: 'Z10', battery: 50, online: null });
  system.account.watchCount = 3;
  const home = await mountHome(t, { system });
  try {
    const more = button(home.container, '更多手表');
    const overflow = home.container.querySelector('[popover="auto"]');
    const primary = home.container.querySelector('[aria-label="选择当前手表"]');
    assert.ok(overflow, '更多设备应通过原生浮层显示');
    assert.equal(more.getAttribute('aria-controls'), overflow.id);
    assert.equal(button(overflow, '星星手表').getAttribute('aria-pressed'), 'false');
    await click(button(overflow, '星星手表'));
    assert.equal(home.controls.state.watchId, 'watch-c');
    assert.deepEqual(home.controls.watchWrites, ['watch-c']);
    assert.equal(button(primary, '星星手表').getAttribute('aria-pressed'), 'true', '选中的额外设备应回显在主卡片');
    assert.ok(button(overflow, '月亮手表'), '原来的第二台设备仍可从更多列表选择');
    home.server.system.account.watches[2].battery = 18;
    await act(async () => { home.dom.window.dispatchEvent(new home.dom.window.Event('jz:refresh')); await delay(0); });
    assert.equal(home.requests.filter(request => request.url === '/api/system').length, 2);
    assert.equal(button(primary, '星星手表').getAttribute('aria-pressed'), 'true');
    assert.equal(home.controls.state.watchId, 'watch-c');
    assert.match(home.container.textContent, /18%/);
    await click(button(home.container, '打开定位页'));
    assert.deepEqual(home.controls.navigations.at(-1), { page: 'location', params: {} });
    assert.equal(home.controls.watchWrites.at(-1), 'watch-c');
    assert.equal(home.controls.state.watchId, 'watch-c');
  } finally { await home.close(); }
});

test('主页资料弹窗按 watchId 合并完整设备信息，实时摘要优先且刷新保留对应设备', async t => {
  const home = await mountHome(t, { watchId: 'watch-b', watches: fixtureWatches() });
  try {
    const region = home.container.querySelector('section[aria-label="我的手表"]');
    assert.ok(region);
    assert.equal(home.container.querySelector('section[aria-label="手表设备信息"]'), null, '设备资料应由手表名称旁的按钮打开');
    const { dialog: deviceInfo } = await openDeviceDialog(home, '月亮手表');
    const assertDeviceDetails = () => {
      for (const [label, value] of [
        ['设备 ID · watchId', 'watch-b'], ['IMEI', '867000000000002'],
        ['手表号码', '13900000002'], ['固件版本', 'Z9_FIXTURE_2.0'],
      ]) {
        const field = definition(deviceInfo, label);
        assert.equal(field.textContent.trim(), value, `${label} 应属于选中的 B 手表`);
        assert.equal(field.closest('details:not([open]), [hidden], [aria-hidden="true"]'), null, '设备关键字段不应折叠或隐藏');
      }
      assert.equal(button(region, '月亮手表').getAttribute('aria-pressed'), 'true');
      assert.equal(home.controls.state.watchId, 'watch-b');
      assert.doesNotMatch(deviceInfo.textContent, /867000000000001|13900000001|Z8_FIXTURE_1\.0/);
    };
    assertDeviceDetails();
    const identity = watchCard(region, '月亮手表');
    assert.match(identity.textContent, /月亮手表.*Z9.*离线/);
    assert.doesNotMatch(identity.textContent, /缓存中的|旧型号|在线/);
    assert.match(region.textContent, /36%/);
    assert.doesNotMatch(region.textContent, /99%/);
    home.server.system.account.watches[1].battery = 17;
    home.server.system.account.watches[1].online = true;
    await act(async () => { home.dom.window.dispatchEvent(new home.dom.window.Event('jz:refresh')); await delay(0); });
    assert.equal(home.requests.filter(request => request.url === '/api/system').length, 2);
    assertDeviceDetails();
    assert.match(watchCard(region, '月亮手表').textContent, /月亮手表.*Z9.*在线/);
    assert.match(region.textContent, /17%/);
    assert.doesNotMatch(region.textContent, /36%|99%/);
    await click(button(deviceInfo, '设备详情'));
    assert.deepEqual(home.controls.navigations.at(-1), { page: 'overview', params: {} });
    assert.equal(home.controls.watchWrites.at(-1), 'watch-b');
  } finally { await home.close(); }
});

test('查看未选中的手表只打开对应资料，关闭恢复焦点，设备详情才选择该手表', async t => {
  const home = await mountHome(t, { watches: fixtureWatches() });
  try {
    const trigger = button(home.container, '查看月亮手表的设备信息');
    assert.equal(trigger.closest('button') === trigger && trigger.parentElement.closest('button') == null, true, '信息与选择控件不能互相嵌套');
    assert.doesNotMatch(home.dom.window.document.body.textContent, /867000000000002|13900000002|Z9_FIXTURE_2\.0/);
    const { dialog } = await openDeviceDialog(home, '月亮手表');
    assert.equal(definition(dialog, '设备 ID · watchId').textContent.trim(), 'watch-b');
    assert.equal(definition(dialog, 'IMEI').textContent.trim(), '867000000000002');
    assert.equal(definition(dialog, '手表号码').textContent.trim(), '13900000002');
    assert.doesNotMatch(dialog.textContent, /watch-a|867000000000001|13900000001|Z8_FIXTURE_1\.0/);
    assert.equal(home.controls.state.watchId, 'watch-a', '查看资料不应切换地图与当前设备');
    assert.deepEqual(home.controls.watchWrites, []);
    assert.deepEqual(home.controls.navigations, []);
    assert.ok(dialog.contains(home.dom.window.document.activeElement), '打开弹窗后焦点应进入弹窗');
    await click(button(dialog, '关闭弹窗'));
    assert.equal(home.dom.window.document.querySelector('[aria-modal="true"]'), null);
    assert.equal(home.dom.window.document.activeElement, trigger, '关闭后恢复名称旁的信息按钮焦点');
    assert.equal(home.controls.state.watchId, 'watch-a');
    const reopened = await openDeviceDialog(home, '月亮手表');
    await click(button(reopened.dialog, '设备详情'));
    assert.deepEqual(home.controls.navigations, [{ page: 'overview', params: {} }]);
    assert.deepEqual(home.controls.watchWrites, ['watch-b']);
    assert.equal(home.controls.state.watchId, 'watch-b', '详情页必须使用资料所对应的设备 ID');
    assert.equal(home.dom.window.document.querySelector('[aria-modal="true"]'), null, '导航后关闭资料弹窗');
  } finally { await home.close(); }
});

test('更多手表列表的信息按钮显示所点设备，不替换主卡片或发起其他设备请求', async t => {
  const system = fixtureSystem();
  system.account.watches.push({ watchId: 'watch-c', name: '星星手表', model: 'Z10', battery: 50, online: null });
  system.account.watchCount = 3;
  const watches = [...fixtureWatches(), { watchId: 'watch-c', imei: '867000000000003', number: '13900000003', firmware: 'Z10_FIXTURE_3.0' }];
  const home = await mountHome(t, { system, watches });
  try {
    const primary = home.container.querySelector('[aria-label="选择当前手表"]');
    const overflow = home.container.querySelector('[popover="auto"]');
    assert.ok(button(overflow, '查看星星手表的设备信息'));
    const { dialog } = await openDeviceDialog(home, '星星手表');
    assert.equal(definition(dialog, '设备 ID · watchId').textContent.trim(), 'watch-c');
    assert.equal(definition(dialog, 'IMEI').textContent.trim(), '867000000000003');
    assert.equal(definition(dialog, '固件版本').textContent.trim(), 'Z10_FIXTURE_3.0');
    assert.equal(home.controls.state.watchId, 'watch-a');
    assert.deepEqual(home.controls.watchWrites, []);
    assert.deepEqual(home.controls.navigations, []);
    assert.deepEqual(buttons(primary, /^星星手表$/), [], '查看资料不应替换主列表中的第二台设备');
    assert.deepEqual(home.requests.filter(request => /\/location$/.test(request.url)).map(request => request.url), ['/api/watch/watch-a/location']);
  } finally { await home.close(); }
});

test('主页把零电量显示为 0%，不当作缺失数据', async t => {
  const system = fixtureSystem();
  system.account.watches[1].battery = 0;
  const home = await mountHome(t, { system, watchId: 'watch-b' });
  try {
    const heading = [...home.container.querySelectorAll('h2')].find(element => element.textContent.trim() === '我的手表');
    const region = heading?.closest('section');
    assert.ok(region, '设备信息应在有名称的手表区域中');
    assert.match(region.textContent, /(?:^|\D)0%(?:\D|$)/);
    const card = watchCard(region, '月亮手表');
    const battery = card.querySelector('.home-battery-dial[role="meter"][aria-label="手表剩余电量"]');
    assert.ok(battery, '已知电量应作为可访问的仪表显示');
    assert.equal(battery.getAttribute('aria-valuenow'), '0');
    assert.equal(battery.getAttribute('aria-valuetext'), '0%');
    const outline = card.querySelector('.home-watch-battery-outline[aria-label="手表剩余电量"]');
    assert.ok(outline, '窄屏应提供能显示电量的卡片描边');
    assert.equal(outline.getAttribute('role'), 'meter');
    assert.equal(outline.getAttribute('aria-valuenow'), '0', '窄屏描边也必须保留0电量');
    assert.equal(outline.getAttribute('aria-valuetext'), '0%');
    await click(button(home.container, '打开定位页'));
    assert.equal(home.controls.state.watchId, 'watch-b');
    assert.equal(home.controls.navigations.at(-1).page, 'location');
  } finally { await home.close(); }
});

test('电量未知时圆环与窄屏描边都不提供假的零电量读数', async t => {
  const system = fixtureSystem();
  system.account.watches[1].battery = null;
  const home = await mountHome(t, { system, watchId: 'watch-b' });
  try {
    const card = watchCard(home.container, '月亮手表');
    for (const selector of ['.home-battery-dial', '.home-watch-battery-outline']) {
      const battery = card.querySelector(`${selector}[aria-label="手表剩余电量未知"]`);
      assert.ok(battery, `${selector} 应提供未知电量的无障碍说明`);
      assert.equal(battery.getAttribute('role'), 'img');
      assert.equal([...battery.attributes].some(attribute => attribute.name.startsWith('aria-value')), false, '未知电量图像不能提供仪表数值或误导读屏软件');
    }
    assert.doesNotMatch(card.textContent, /0%/);
    assert.equal(home.controls.state.watchId, 'watch-b');
    assert.deepEqual(home.controls.watchWrites, []);
  } finally { await home.close(); }
});

test('主页位置切换取消旧设备请求，零坐标仍显示地图且迟到结果不能覆盖当前设备', async t => {
  const locations = fixtureLocations();
  let finishA;
  const home = await mountHome(t, {
    locationResponse: id => id === 'watch-a'
      ? new Promise(resolve => { finishA = resolve; })
      : jsonResponse(locations[id]),
  });
  try {
    const originalRequest = home.requests.find(request => request.url === '/api/watch/watch-a/location');
    assert.ok(originalRequest, '初始位置请求应使用 A 手表 ID');
    assert.equal(originalRequest.signal.aborted, false);
    await click(button(home.container, '月亮手表'));
    assert.equal(originalRequest.signal.aborted, true, '切换设备应取消上一设备的读取');
    assert.deepEqual(home.requests.filter(request => /\/location$/.test(request.url)).map(request => request.url), [
      '/api/watch/watch-a/location', '/api/watch/watch-b/location',
    ]);
    const location = home.container.querySelector('section[aria-label="手表最近位置"]');
    assert.ok(location.querySelector('[role="region"][aria-label^="手表位置地图"]'), '经纬度零点应能显示地图');
    assert.match(location.textContent, /月亮手表零点位置/);
    assert.match(location.textContent, /0\.000000, 0\.000000/);
    assert.doesNotMatch(location.textContent, /暂无位置数据/);
    await act(async () => { finishA(jsonResponse(locations['watch-a'])); await delay(0); });
    assert.match(location.textContent, /月亮手表零点位置/);
    assert.doesNotMatch(location.textContent, /太阳手表测试位置|31\.230400|121\.473700/);
    await click(button(location, '打开定位页'));
    assert.deepEqual(home.controls.navigations.at(-1), { page: 'location', params: {} });
    assert.equal(home.controls.watchWrites.at(-1), 'watch-b');
  } finally { await home.close(); }
});

test('主页位置读取失败保留当前设备的地址和地图，重试成功后更新内容', async t => {
  const home = await mountHome(t, { watchId: 'watch-b' });
  try {
    const location = home.container.querySelector('section[aria-label="手表最近位置"]');
    assert.match(location.textContent, /月亮手表零点位置/);
    home.server.locationResponse = () => jsonResponse('模拟位置接口失败', 503);
    await act(async () => { home.dom.window.dispatchEvent(new home.dom.window.Event('jz:refresh')); await delay(0); });
    assert.match(location.textContent, /月亮手表零点位置/);
    assert.ok(location.querySelector('[role="region"][aria-label^="手表位置地图"]'));
    const status = [...location.querySelectorAll('[role="status"]')].map(element => element.textContent).join(' ');
    assert.match(status, /位置刷新失败.*保留/);
    home.server.locations['watch-b'] = { location: { latitude: 22.5431, longitude: 114.0579, desc: '月亮手表更新位置', createTime: 1700000200 }, onlineStatus: true };
    home.server.locationResponse = null;
    await click(button(location, '重试读取手表位置'));
    assert.match(location.textContent, /月亮手表更新位置/);
    assert.match(location.textContent, /22\.543100, 114\.057900/);
    assert.doesNotMatch(location.textContent, /月亮手表零点位置|位置刷新失败/);
    assert.equal(home.controls.state.watchId, 'watch-b');
    assert.deepEqual(home.controls.watchWrites, [], '读取或重试位置不应修改设备选择');
    assert.deepEqual(home.requests.filter(request => /\/location$/.test(request.url)).map(request => request.url), Array(3).fill('/api/watch/watch-b/location'));
  } finally { await home.close(); }
});

test('家长令牌失效时隐藏仍被 system 缓存的设备，并将设备操作引导到登录', async t => {
  const watches = fixtureWatches();
  const home = await mountHome(t, { watchId: 'watch-b', watches });
  try {
    assert.ok(button(home.container, '月亮手表'));
    const { dialog } = await openDeviceDialog(home, '月亮手表');
    assert.match(dialog.textContent, /867000000000002/);
    await act(async () => { home.controls.setTokenInvalid(true); await delay(0); });
    assert.equal(home.server.system.account.loggedIn, true, '系统缓存仍声称已登录');
    assert.equal(home.server.system.account.watches.length, 2, '系统缓存仍持有两块手表');
    assert.equal(home.dom.window.document.querySelector('[aria-modal="true"]'), null, '令牌失效应立即移除已经打开的资料弹窗');
    assert.doesNotMatch(home.dom.window.document.body.textContent, /太阳手表|月亮手表/);
    for (const watch of watches) {
      for (const value of [watch.watchId, watch.imei, watch.number, watch.firmware]) {
        assert.equal(home.dom.window.document.body.textContent.includes(value), false, '过期后不能显示缓存设备的标识与详细字段');
      }
    }
    assert.match(home.container.textContent, /登录已过期/);
    for (const name of ['重新登录', '绑定手表', /^安全区域/]) {
      await click(button(home.container, name));
      assert.equal(home.controls.navigations.at(-1).page, 'account');
    }
    assert.deepEqual(home.controls.watchWrites, [], '失效状态不能重新选中缓存设备');
    await act(async () => { home.controls.setTokenInvalid(false); await delay(0); });
    assert.equal(home.dom.window.document.querySelector('[aria-modal="true"]'), null, '重新连接后不应自动重新打开过期前的资料弹窗');
  } finally { await home.close(); }
});

test('一言刷新期间与失败后保留原文，重试成功后替换，普通刷新恢复缓存请求', async t => {
  const home = await mountHome(t);
  try {
    const original = home.server.quote.text;
    const quoteAside = home.container.querySelector('aside[aria-label="每日一言"]');
    assert.ok(quoteAside, '一言应为独立命名的补充内容');
    assert.equal(quoteAside.parentElement.querySelector('h1')?.textContent.trim(), '主页', '一言应位于主页标题所在区域');
    assert.ok(quoteAside.textContent.includes(original));
    assert.ok(button(quoteAside, '换一句一言'));
    let finish;
    home.server.quoteResponse = () => new Promise(resolve => { finish = resolve; });
    await click(button(home.container, /换一句一言/));
    assert.ok(home.container.textContent.includes(original));
    assert.equal(button(home.container, /换一句一言/).disabled, true);
    await act(async () => { finish(jsonResponse('模拟一言服务失败', 503)); await delay(0); });
    assert.ok(home.container.textContent.includes(original));
    assert.equal(button(home.container, /换一句一言/).disabled, false);
    const statuses = [...home.container.querySelectorAll('[role="status"], [role="alert"]')].map(element => element.textContent).join(' ');
    assert.match(statuses, /刷新失败.*保留/);
    home.server.quote = { text: '重试后到达的第二条一言。', author: '另一位作者' };
    home.server.quoteResponse = () => jsonResponse(home.server.quote);
    await click(button(home.container, /换一句一言/));
    assert.ok(home.container.textContent.includes(home.server.quote.text));
    assert.ok(!home.container.textContent.includes(original));
    assert.doesNotMatch(home.container.textContent, /刷新失败，已保留/);
    assert.equal(home.requests.filter(request => request.url === '/api/yiyan?refresh=1').length, 2);
    await act(async () => { home.dom.window.dispatchEvent(new home.dom.window.Event('jz:refresh')); await delay(0); });
    assert.equal(home.requests.filter(request => request.url.startsWith('/api/yiyan')).at(-1).url, '/api/yiyan');
  } finally { await home.close(); }
});

test('运行趋势只为成功的系统响应积累，手表切换和失败刷新保留已有历史', async t => {
  const originalNow = Date.now;
  let receivedAt = 1700000000000;
  Date.now = () => receivedAt;
  t.after(() => { Date.now = originalNow; });
  const home = await mountHome(t);
  try {
    assert.equal(runtimeSampleCount(home), 1, '初次读取应从一个真实数据点开始');
    receivedAt += 3000;
    home.server.system.system.cpuPercent = 35;
    home.server.system.system.memPercent = 40;
    home.server.system.process.uptime = 123;
    await refreshHome(home);
    assert.equal(home.requests.filter(request => request.url === '/api/system').length, 2);
    assert.equal(runtimeSampleCount(home), 2, '新的成功响应应追加一个采样点');
    assert.match(runtimeTrends(home).textContent, /35%/);
    assert.match(runtimeTrends(home).textContent, /40%/);
    for (const series of ['cpu', 'memory']) {
      const lines = runtimeFigure(home, series).querySelectorAll('.home-runtime-trend-line');
      assert.equal(lines.length, 1, '连续成功的两次读取应形成同一段趋势');
      assert.equal(lines[0].getAttribute('points').trim().split(/\s+/).length, 2);
    }
    await click(button(home.container, '月亮手表'));
    assert.equal(home.controls.state.watchId, 'watch-b');
    assert.equal(home.requests.filter(request => request.url === '/api/system').length, 2, '切换手表不应额外请求运行状态');
    assert.equal(runtimeSampleCount(home), 2, '系统趋势不应随设备切换重置或增加点');
    receivedAt += 3000;
    home.server.systemResponse = () => jsonResponse('模拟系统接口失败', 503);
    await refreshHome(home);
    assert.equal(home.requests.filter(request => request.url === '/api/system').length, 3, '失败刷新应确实尝试系统读取');
    assert.equal(runtimeSampleCount(home), 2, '失败响应不能冒充新的采样');
    assert.match(runtimeTrends(home).textContent, /35%/);
    assert.match(runtimeTrends(home).textContent, /40%/);
    assert.ok(home.container.querySelector('.home-stale[role="status"]'), '失败时应说明当前展示缓存数据');
    receivedAt += 3000;
    home.server.systemResponse = null;
    home.server.system.system.cpuPercent = 5;
    home.server.system.system.memPercent = 10;
    home.server.system.process.uptime = 126;
    await refreshHome(home);
    assert.equal(runtimeSampleCount(home), 3, '恢复连接后继续追加，保留成功响应的历史');
    for (const series of ['cpu', 'memory']) {
      const figure = runtimeFigure(home, series);
      const lines = figure.querySelectorAll('.home-runtime-trend-line');
      assert.equal(lines.length, 1, '短暂中断后，新的单点不能跨越失败读取连接到上一段');
      assert.equal(lines[0].getAttribute('points').trim().split(/\s+/).length, 2, '恢复前的成功历史保持原样');
      assert.equal(figure.querySelectorAll('circle').length, 0, '不再绘制圆点，恢复后的首次真实读数等待下一次采样形成独立线段');
    }
    receivedAt += 3000;
    home.server.system.process.uptime = 129;
    await refreshHome(home);
    assert.equal(runtimeSampleCount(home), 4);
    for (const series of ['cpu', 'memory']) {
      const lines = runtimeFigure(home, series).querySelectorAll('.home-runtime-trend-line');
      assert.equal(lines.length, 2, '恢复后第二次成功读取从新点形成第二段趋势');
      assert.deepEqual([...lines].map(line => line.getAttribute('points').trim().split(/\s+/).length), [2, 2]);
    }
    assert.equal(home.controls.state.watchId, 'watch-b');
    assert.deepEqual(home.controls.watchWrites, ['watch-b']);
  } finally { await home.close(); }
});

test('运行趋势区分零值与缺失，并在进程变化或运行时长回退时从新响应重新采样', async t => {
  const system = fixtureSystem();
  Object.assign(system.system, { cpuPercent: 0, memPercent: null });
  Object.assign(system.process, { pid: 4020, uptime: 600 });
  const home = await mountHome(t, { system });
  try {
    assert.equal(runtimeSampleCount(home), 1);
    assert.match(runtimeCurrent(home, 'cpu'), /^0(?:\.0)?%$/, '真实 CPU 零值应有百分比读数');
    assert.equal(runtimeCurrent(home, 'memory'), '—', '缺失内存数据不能显示为0%');
    assert.equal(runtimeFigure(home, 'cpu').getAttribute('data-valid-samples'), '1');
    assert.equal(runtimeFigure(home, 'memory').getAttribute('data-valid-samples'), '0', '缺失读数不能形成假的历史采样点');
    assert.equal(runtimeFigure(home, 'cpu').querySelector('[role="img"]')?.getAttribute('aria-label'), '系统 CPU 使用率趋势');
    assert.equal(runtimeFigure(home, 'memory').querySelector('[role="img"]')?.getAttribute('aria-label'), '系统内存占用趋势');
    home.server.system.system.cpuPercent = null;
    home.server.system.system.memPercent = 0;
    home.server.system.process.uptime = 603;
    await refreshHome(home);
    assert.equal(runtimeSampleCount(home), 2);
    assert.equal(runtimeCurrent(home, 'cpu'), '—', 'CPU 缺失时不能沿用上一响应的0%作为当前值');
    assert.match(runtimeCurrent(home, 'memory'), /^0(?:\.0)?%$/, '真实内存零值应加入历史');
    assert.equal(runtimeFigure(home, 'cpu').getAttribute('data-valid-samples'), '1');
    assert.equal(runtimeFigure(home, 'memory').getAttribute('data-valid-samples'), '1');
    Object.assign(home.server.system.process, { pid: 4021, uptime: 606 });
    Object.assign(home.server.system.system, { cpuPercent: 23, memPercent: 64 });
    await refreshHome(home);
    assert.equal(runtimeSampleCount(home), 1, '进程 PID 变化时不能连接到上一个进程的历史');
    assert.match(runtimeCurrent(home, 'cpu'), /^23(?:\.0)?%$/);
    assert.match(runtimeCurrent(home, 'memory'), /^64(?:\.0)?%$/);
    home.server.system.process.uptime = 609;
    await refreshHome(home);
    assert.equal(runtimeSampleCount(home), 2, '同一个进程的后续成功读取应继续积累');
    home.server.system.process.uptime = 3;
    home.server.system.system.cpuPercent = 7;
    await refreshHome(home);
    assert.equal(runtimeSampleCount(home), 1, '即使 PID 没变，运行时长回退也应清理旧历史');
    assert.match(runtimeCurrent(home, 'cpu'), /^7(?:\.0)?%$/);
    assert.equal(home.controls.state.watchId, 'watch-a');
    assert.deepEqual(home.controls.watchWrites, []);
  } finally { await home.close(); }
});

test('主页运行环境直接显示接口提供的系统、Node.js 和主机信息', async t => {
  const system = fixtureSystem();
  Object.assign(system.system, { platform: 'linux', arch: 'arm64', release: 'fixture-kernel-6.10', hostname: 'fixture-host-arm', cpuModel: 'Fixture ARM CPU', cpuCores: 6 });
  Object.assign(system.process, { node: 'v22.14.0', arch: 'arm64' });
  const home = await mountHome(t, { system });
  try {
    const environment = home.container.querySelector('section#home-panel-environment[aria-label="面板运行环境"]');
    assert.ok(environment, '主页应提供可直接查看的面板运行环境区域');
    for (const [label, expected] of [
      ['系统架构', 'Linux · arm64'], ['Node.js', 'v22.14.0 · arm64'],
      ['主机名', 'fixture-host-arm'], ['处理器', 'Fixture ARM CPU'],
    ]) {
      const field = definition(environment, label);
      assert.equal(field.textContent.trim(), expected, `${label} 必须使用接口提供的数据`);
      assert.equal(field.closest('details:not([open]), [hidden], [aria-hidden="true"]'), null, '主要运行环境字段不应折叠或隐藏');
    }
    const trigger = button(environment, '进程与账号详情');
    const panel = home.dom.window.document.getElementById(trigger.getAttribute('aria-controls'));
    assert.ok(panel, '详情入口必须关联独立的浮层');
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', '详情初始收起');
    assert.equal(panel.getAttribute('popover'), 'auto', '补充环境信息使用原生浮层');
    assert.equal(panel.getAttribute('role'), 'dialog');
    assert.notEqual(panel.getAttribute('aria-modal'), 'true', '详情浮层不应阻止访问面板其余内容');
    assert.equal(home.dom.window.document.getElementById(panel.getAttribute('aria-labelledby'))?.textContent.trim(), '进程与账号详情');
    assert.equal(environment.querySelector('details'), null, '详情不再在卡片内部向下撑开');
    const kernel = definition(panel, '内核版本');
    assert.equal(kernel.textContent.trim(), 'fixture-kernel-6.10');
    assert.equal(definition(panel, '处理器核心').textContent.trim(), '6 核');
  } finally { await home.close(); }
});

test('未登录的设备入口进入账号页，已登录但无手表的设备入口进入绑定页', async t => {
  for (const loggedIn of [false, true]) {
    await t.test(loggedIn ? '已登录但未绑定' : '尚未登录', async subtest => {
      const home = await mountHome(subtest, { system: fixtureSystem({ loggedIn, watches: [], watchCount: 0 }) });
      try {
        const destination = loggedIn ? 'bind' : 'account';
        if (!loggedIn) {
          await click(button(home.container, '登录家长账号'));
          assert.equal(home.controls.navigations.at(-1).page, destination);
        }
        const bindingButtons = buttons(home.container, '绑定手表');
        assert.ok(bindingButtons.length, '首页应保留绑定入口');
        for (const binding of bindingButtons) {
          await click(binding);
          assert.equal(home.controls.navigations.at(-1).page, destination);
        }
        await click(button(home.container, /^安全区域/));
        assert.equal(home.controls.navigations.at(-1).page, destination);
        assert.deepEqual(home.controls.watchWrites, []);
        if (loggedIn) {
          await click(button(home.container, '查看聊天与消息连接'));
          assert.equal(home.controls.navigations.at(-1).page, 'chat', '无设备元数据时仍可查看已有会话');
        }
      } finally { await home.close(); }
    });
  }
});

test('首页聊天入口打开会话列表，保留手表选择且不默认打开旧会话或按名称猜收件人', async t => {
  const home = await mountHome(t, { watchId: 'watch-b', params: { key: 's:unrelated' }, renderChat: true });
  try {
    await click(button(home.container, '查看聊天与消息连接'));
    assert.deepEqual(home.controls.navigations.at(-1), { page: 'chat', params: {} });
    assert.equal(home.controls.state.watchId, 'watch-b');
    assert.deepEqual(home.controls.watchWrites, [], '选择聊天会话不应重新设置设备');
    const list = home.container.querySelector('[aria-label="会话列表"]');
    assert.ok(list);
    assert.match(list.textContent, /无关旧会话/);
    assert.match(list.textContent, /月亮手表/);
    assert.match(home.container.textContent, /从一段对话开始/);
    assert.equal(list.querySelector('[aria-pressed="true"]'), null);
    assert.equal(home.container.querySelector('[aria-label="消息内容"]'), null);
    assert.equal(home.requests.some(request => request.url.startsWith('/api/chats/messages')), false);
  } finally { await home.close(); }
});

test('聊天使用会话明确watchId加载资料头像，列表、标题与发送弹窗不借用当前手表头像', async t => {
  const home = await mountHome(t, {
    watchId: 'watch-b', renderChat: true,
    targets: [
      { key: 's:im-a', name: '同名宝贝', type: 'single', watchId: 'watch-a' },
      { key: 's:im-b', name: '同名宝贝', type: 'single', watchId: 'watch-b' },
    ],
    avatars: { 'watch-a': 'https://example.invalid/profile-a.jpg', 'watch-b': 'https://example.invalid/profile-b.png' },
  });
  try {
    await click(button(home.container, '查看聊天与消息连接'));
    const conversations = home.container.querySelectorAll('.chat-target');
    assert.equal(conversations.length, 2);
    assert.equal(conversations[0].querySelector('img')?.src, 'https://example.invalid/profile-a.jpg');
    assert.equal(conversations[1].querySelector('img')?.src, 'https://example.invalid/profile-b.png');
    assert.equal(home.requests.some(request => request.url.startsWith('/api/chats/avatar')), false, '已明确关联设备时直接读取资料头像');
    await click(conversations[0]);
    assert.equal(home.container.querySelector('.chat-thread-header img')?.src, 'https://example.invalid/profile-a.jpg');
    await click(button(home.container, '更多发送方式'));
    assert.equal(home.dom.window.document.querySelector('.chat-composer-recipient img')?.src, 'https://example.invalid/profile-a.jpg');
    assert.equal(home.controls.state.watchId, 'watch-b');
    assert.deepEqual(home.controls.watchWrites, []);
    assert.ok(home.requests.every(request => request.method === 'GET'), '只展示资料与草稿，不能发送真实消息');
  } finally { await home.close(); }
});
