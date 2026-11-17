import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let directory;
let actual;
let components;
const written = [];
const globalOverrides = new WeakMap();

async function bundle(name, contents, plugins = []) {
  const filename = path.join(directory, `${name}.mjs`);
  const result = await build({
    absWorkingDir: frontend,
    stdin: { contents, loader: 'tsx', resolveDir: frontend, sourcefile: `${name}-entry.tsx` },
    bundle: true, platform: 'node', format: 'esm', target: 'node18', packages: 'external',
    loader: { '.css': 'empty' }, outfile: filename, write: false, plugins,
  });
  await writeFile(filename, result.outputFiles[0].contents);
  written.push(filename);
  return import(pathToFileURL(filename).href);
}

test.before(async () => {
  const cache = path.join(frontend, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(path.join(cache, 'react-checks-'));
  actual = await bundle('actual', `
    export * from './src/components/chat/model';
    export * from './src/components/location/mapMath';
    export * from './src/components/location/locationUtils';
    export * from './src/lib/api';
    export { useResource } from './src/lib/hooks';
    export { AppProvider, useApp } from './src/context/AppContext';
    export { formatWeekdays } from './src/components/device/DeviceForm';
    export { default as AnnouncementMarkdown } from './src/pages/AnnouncementMarkdown';
  `);
  components = await bundle('components', `
    export { default as OneBotPanel } from './src/components/integrations/OneBotPanel';
    export { default as ChatPage } from './src/pages/ChatPage';
  `, [{
    name: 'test-read-state',
    setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)context\/AppContext$/ }, () => ({ path: 'app-context', namespace: 'test-state' }));
      builder.onResolve({ filter: /(?:^|\/)lib\/hooks$/ }, () => ({ path: 'resource', namespace: 'test-state' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-state' }, ({ path: name }) => ({
        contents: name === 'app-context'
          ? 'export const useApp = () => globalThis.__JZ_REACT_CONTEXT; export const useOptionalApp = () => null;'
          : 'export const useResource = () => ({ data: globalThis.__JZ_REACT_RESOURCE, loading: false, error: null, reload: async () => {} });',
        loader: 'js',
      }));
    },
  }]);
});

test.after(async () => {
  delete globalThis.__JZ_REACT_CONTEXT;
  delete globalThis.__JZ_REACT_RESOURCE;
  for (const filename of written) await unlink(filename);
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

function browser(t) {
  const dom = new JSDOM('<!doctype html><html><body><main id="fixture"></main></body></html>', {
    url: 'http://127.0.0.1/', pretendToBeVisual: true,
  });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'CustomEvent', 'Event', 'MouseEvent']) {
    replaceGlobal(t, key, dom.window[key]);
  }
  replaceGlobal(t, 'IS_REACT_ACT_ENVIRONMENT', true);
  t.after(() => dom.window.close());
  return { dom, container: dom.window.document.getElementById('fixture') };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, data }), { status, headers: { 'Content-Type': 'application/json' } });
}

function pendingFetch(t) {
  const requests = [];
  replaceGlobal(t, 'fetch', (url, options) => new Promise((resolve, reject) => {
    requests.push({ url, options, resolve, reject });
    const abort = () => reject(options.signal.reason || new DOMException('Cancelled', 'AbortError'));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  }));
  return requests;
}

test('OneBot 手表名称在 React 文本中安全转义，动态属性也不能注入 HTML', t => {
  replaceGlobal(t, 'window', { location: { hostname: '127.0.0.1' } });
  const attack = '<img src=x onerror="alert(1)">&\'测试';
  globalThis.__JZ_REACT_CONTEXT = { watchId: 'watch-1', watch: { name: attack }, navigate() {} };
  globalThis.__JZ_REACT_RESOURCE = {
    watches: [{ watchId: 'watch-1', name: attack, enabled: true, running: true, http: {}, ws: {}, wsClient: { enabled: true, url: attack } }],
    targets: [],
  };
  const html = renderToStaticMarkup(React.createElement(components.OneBotPanel));
  assert.match(html, /当前手表/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;&#x27;测试/);
  assert.doesNotMatch(html, /<img\b/i);
  const dom = new JSDOM(html);
  const title = [...dom.window.document.querySelectorAll('[title]')].find(node => node.getAttribute('title') === attack);
  assert.ok(title, '原始字符串留在正常 title 属性中');
  assert.equal(dom.window.document.querySelector('[onerror]'), null);
  assert.ok(dom.window.document.body.textContent.includes(attack), '恶意手表名以普通文字完整显示');
  dom.window.close();
});

test('公告 Markdown 保留格式，同时将 HTML 和危险链接当作文本', () => {
  const html = renderToStaticMarkup(React.createElement(actual.AnnouncementMarkdown, {
    source: '# 更新\n\n**新增**\n\n<script>alert(1)</script>\n\n[危险](javascript:alert)\n\n| 名称 | 状态 |\n| --- | --- |\n| 手表 | 正常 |',
  }));
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector('h1')?.textContent, '更新');
  assert.equal(dom.window.document.querySelector('strong')?.textContent, '新增');
  assert.ok(dom.window.document.querySelector('table'));
  assert.doesNotMatch(html, /<script|href="javascript:/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  dom.window.close();
});

test('聊天相同轮询响应保持消息对象和 React key', () => {
  let number = 0;
  const allocate = () => `message-${++number}`;
  const messages = [{ kind: 'voice', url: '/audio/1.mp3', time: 1700000000, text: '语音' }, { kind: 'video', url: '/video/1.mp4', time: 1700000001 }];
  const previous = actual.reconcileMessages([], messages, allocate);
  const next = actual.reconcileMessages(previous, structuredClone(messages), allocate);
  assert.strictEqual(next, previous);
  assert.strictEqual(next[0].message, messages[0]);
  assert.equal(number, 2, '未为相同轮询重新分配 React key');
});

test('聊天 200 条滑动窗口只替换新条目，重复内容仍各有唯一 key', () => {
  let number = 0;
  const allocate = () => String(++number);
  const original = Array.from({ length: 200 }, (_, index) => ({ kind: index === 100 ? 'video' : 'text', text: `消息 ${index}`, time: 1700000000 + index }));
  const before = actual.reconcileMessages([], original, allocate);
  const after = actual.reconcileMessages(before, [...structuredClone(original.slice(1)), { kind: 'text', text: '新消息', time: 1700000200 }], allocate);
  assert.strictEqual(after[99], before[100], '窗口左移后保留正在播放的条目');
  assert.equal(number, 201);
  const duplicate = { kind: 'text', text: '完全相同', time: 1700001000 };
  const duplicates = actual.reconcileMessages([], [duplicate, { ...duplicate }], allocate);
  assert.notEqual(duplicates[0].key, duplicates[1].key);
  const rerendered = actual.reconcileMessages(duplicates, [{ ...duplicate }, { ...duplicate }], allocate);
  assert.strictEqual(rerendered, duplicates);
});

test('消息媒体只接受 HTTP(S) 和同源路径', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///secret', '//other.invalid/file', 'vbscript:msgbox(1)']) {
    assert.equal(actual.safeMessageUrl(value), '', value);
  }
  assert.equal(actual.safeMessageUrl('/api/chats/media?id=1'), '/api/chats/media?id=1');
  assert.equal(actual.safeMessageUrl('https://media.example.invalid/video.mp4'), 'https://media.example.invalid/video.mp4');
  assert.match(actual.imStateText({ connected: true, alive: false }), /异常/);
});

test('API 将对象编码为 JSON 并返回 data，保留 cookie 和自定义头', async t => {
  let recorded;
  replaceGlobal(t, 'fetch', async (url, options) => { recorded = { url, options }; return jsonResponse({ saved: true }); });
  assert.deepEqual(await actual.post('/api/watch/test/settings', { enabled: true, count: 0 }, { headers: { 'X-Test': 'value' } }), { saved: true });
  assert.equal(recorded.options.method, 'POST');
  assert.equal(recorded.options.credentials, 'same-origin');
  assert.equal(recorded.options.headers.get('Content-Type'), 'application/json');
  assert.equal(recorded.options.headers.get('X-Test'), 'value');
  assert.deepEqual(JSON.parse(recorded.options.body), { enabled: true, count: 0 });
});

test('API 图片/视频 Blob 和 FormData 上传不被 JSON 化', async t => {
  const recorded = [];
  replaceGlobal(t, 'fetch', async (_url, options) => { recorded.push(options); return jsonResponse({ uploaded: true }); });
  const file = new Blob(['binary\u0000data'], { type: 'video/mp4' });
  await actual.api('/api/chats/media?kind=video', { method: 'POST', body: file, timeoutMs: 300000 });
  assert.strictEqual(recorded[0].body, file);
  assert.equal(recorded[0].headers.has('Content-Type'), false, '由 fetch 根据 Blob 设置媒体类型');
  const form = new FormData(); form.append('file', file, 'demo.mp4');
  await actual.api('/api/upload', { method: 'POST', body: form });
  assert.strictEqual(recorded[1].body, form);
  assert.equal(recorded[1].headers.has('Content-Type'), false, 'FormData 边界必须由 fetch 提供');
});

test('API 401 触发访问令牌重新验证，并保留接口错误信息', async t => {
  const events = [];
  replaceGlobal(t, 'window', { dispatchEvent: event => events.push(event.type) });
  replaceGlobal(t, 'fetch', async () => new Response(JSON.stringify({ ok: false, unauthorized: true, error: 'expired' }), { status: 401 }));
  await assert.rejects(actual.api('/api/system'), error => error instanceof actual.ApiError && error.status === 401);
  assert.deepEqual(events, ['jz:unauthorized']);
  replaceGlobal(t, 'fetch', async () => new Response(JSON.stringify({ ok: false, error: '设备暂时离线' }), { status: 503 }));
  await assert.rejects(actual.api('/api/watch/demo/status'), /设备暂时离线/);
});

test('家长登录失效发出独立通知，普通参数错误不进入面板访问令牌验证', async t => {
  const events = [];
  replaceGlobal(t, 'window', { dispatchEvent: event => events.push(event.type) });
  replaceGlobal(t, 'fetch', async () => new Response(JSON.stringify({ ok: false, parentSessionExpired: true, error: '[000003] request parameter is invalid.' }), { status: 200 }));
  await assert.rejects(actual.api('/api/chats'), /家长账号登录已失效，请重新登录/);
  assert.deepEqual(events, ['jz:parent-session-expired']);
  replaceGlobal(t, 'fetch', async () => new Response(JSON.stringify({ ok: false, error: '[000003] request parameter is invalid.' }), { status: 200 }));
  await assert.rejects(actual.api('/api/watch/demo/profile', { method: 'POST', body: {} }), /000003/);
  assert.equal(events.length, 1, '表单参数错误不能使家长登录失效');
});

test('真实共享状态处理登录失效：隐藏旧设备并在重新登录刷新后恢复', async t => {
  const { dom, container } = browser(t);
  replaceGlobal(t, 'location', dom.window.location);
  const requests = [];
  let state;
  let watchError = false;
  replaceGlobal(t, 'fetch', async (url, options) => {
    requests.push({ url, method: options.method || 'GET' });
    if (url === '/api/account?check=1') return jsonResponse({ loggedIn: true, userName: 'test-parent', sessionExpired: false });
    if (url === '/api/watches?refresh=1') return watchError
      ? new Response(JSON.stringify({ ok: false, error: '[000003] request parameter is invalid.' }), { status: 200 })
      : jsonResponse({ watches: [{ watchId: 'test-watch' }] });
    if (url === '/api/plugins') return jsonResponse({ list: [] });
    if (url === '/api/ui/background') return jsonResponse({ background: null });
    if (url === '/api/chats') return new Response(JSON.stringify({ ok: false, parentSessionExpired: true, error: 'expired' }), { status: 200 });
    throw new Error('Unexpected request');
  });
  function Reader() { state = actual.useApp(); return React.createElement('span', {}, state.tokenInvalid ? '需要重新登录' : '账号可用'); }
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(actual.AppProvider, {}, React.createElement(Reader))); await delay(0); });
    assert.equal(state.watches.length, 1);
    watchError = true;
    await act(async () => { await state.refreshWatches(); await delay(0); });
    assert.equal(state.tokenInvalid, false, '未带失效标记的参数错误不能使家长账号失效');
    assert.equal(state.watches.length, 1, '普通读取错误保留已读取的设备');
    assert.match(state.watchError, /000003/);
    watchError = false;
    await act(async () => { await assert.rejects(actual.api('/api/chats')); await delay(0); });
    assert.equal(state.tokenInvalid, true);
    assert.equal(state.watches.length, 0);
    assert.equal(state.watchId, '');
    assert.match(container.textContent, /需要重新登录/);
    await act(async () => { await state.refreshWatches(); await delay(0); });
    assert.equal(state.tokenInvalid, false);
    assert.equal(state.watches.length, 1);
    assert.match(container.textContent, /账号可用/);
    assert.equal(requests.every(request => request.method === 'GET'), true);
  } finally { await act(async () => root.unmount()); }
});

test('API 即使传入 AbortSignal 也执行超时，用户取消保留取消语义', async t => {
  const requests = pendingFetch(t);
  const controller = new AbortController();
  await assert.rejects(actual.api('/api/slow', { signal: controller.signal, timeoutMs: 20 }), /请求超时/);
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(controller.signal.aborted, false, '封装不应中止调用者的 controller');
  const cancelled = new AbortController();
  const operation = actual.api('/api/cancelled', { signal: cancelled.signal, timeoutMs: 2000 });
  cancelled.abort(new DOMException('用户取消', 'AbortError'));
  await assert.rejects(operation, error => error.name === 'AbortError' && error.message === '用户取消');
});

test('地图以经纬度零点和跨日期变更线正确定位', () => {
  assert.deepEqual(actual.toTile(0, 0, 0), { x: 0.5, y: 0.5 });
  assert.deepEqual(actual.readCoordinates({ latitude: 0, longitude: 0 }), { latitude: 0, longitude: 0 });
  assert.deepEqual(actual.readCoordinates({ baiduLatitude: '31.2', baiduLongitude: '121.5' }), { latitude: 31.2, longitude: 121.5 });
  for (const bad of [{ latitude: null, longitude: 1 }, { latitude: '', longitude: 1 }, { latitude: 91, longitude: 1 }, { latitude: 1, longitude: 181 }]) assert.equal(actual.readCoordinates(bad), null);
  const crossing = actual.markerOffset(-179.9, 0, 179.9, 0, 2);
  assert.ok(crossing.x > 0 && crossing.x < 1, '隔经线约0.2°的点应显示在右侧相邻位置');
  assert.equal(crossing.y, 0);
  const polar = actual.toTile(0, 90, 10);
  assert.ok(Number.isFinite(polar.y));
  assert.ok(Math.abs(polar.y) < 1e-7, '北极夹紧到墨卡托可显示边界');
});

test('地图拖动和缩放往返保持实际坐标，星期位掩码保持后端含义', () => {
  for (const point of [[121.4737, 31.2304], [0, 0], [-73.98, 40.76], [179.9, -45]]) {
    for (const zoom of [1, 7, 12, 18]) {
      const tile = actual.toTile(...point, zoom);
      const back = actual.fromTile(tile.x, tile.y, zoom);
      assert.ok(Math.abs(back.longitude - point[0]) < 1e-8);
      assert.ok(Math.abs(back.latitude - point[1]) < 1e-8);
    }
  }
  assert.equal(actual.formatWeekdays(31), '周一至周五');
  assert.equal(actual.formatWeekdays(96), '周末');
  assert.equal(actual.formatWeekdays(127), '每天');
  assert.equal(actual.formatWeekdays(1 | 64), '周一、周日');
});

test('React 聊天轮询后保留同一个音视频 DOM 元素', async t => {
  const { container, dom } = browser(t);
  const context = { account: { loggedIn: true }, navigate() {}, params: { key: 's:100' }, loading: false, tokenInvalid: false };
  globalThis.__JZ_REACT_CONTEXT = context;
  globalThis.__JZ_REACT_RESOURCE = { targets: [{ key: 's:100', name: '演示手表', type: 'single' }], im: { connected: true, alive: true } };
  let messages = [
    { kind: 'voice', url: '/fixture/audio.mp3', text: '语音', time: 1700000001 },
    { kind: 'video', url: '/fixture/video.mp4', time: 1700000002 },
  ];
  let reads = 0;
  replaceGlobal(t, 'fetch', async url => {
    assert.match(url, /^\/api\/chats\/messages\?key=s%3A100$/);
    reads++;
    return jsonResponse({ messages: structuredClone(messages), im: { connected: true, alive: true } });
  });
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(components.ChatPage)); await delay(0); });
    const audio = container.querySelector('audio'); const video = container.querySelector('video');
    assert.ok(audio && video, '测试必须实际渲染出两个媒体播放器');
    Object.defineProperty(video, 'currentTime', { value: 8, writable: true });
    messages = [...messages, { kind: 'text', text: '新消息', time: 1700000003 }];
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); await delay(0); });
    assert.equal(reads, 2);
    assert.strictEqual(container.querySelector('audio'), audio);
    assert.strictEqual(container.querySelector('video'), video);
    assert.equal(video.currentTime, 8);
    assert.match(container.textContent, /新消息/);
  } finally { await act(async () => root.unmount()); }
});

test('useResource 慢请求不会被定时轮询反复取消', async t => {
  const { container } = browser(t);
  let calls = 0; let finish; let firstSignal;
  function Harness() {
    const resource = actual.useResource(signal => {
      calls++; firstSignal ||= signal;
      return new Promise(resolve => { finish = resolve; });
    }, [], 15);
    return React.createElement('output', null, resource.data || (resource.loading ? 'loading' : 'idle'));
  }
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Harness)); });
    await act(async () => { await delay(55); });
    assert.equal(calls, 1, '未完成时应跳过轮询，避免首页慢请求永远不完成');
    assert.equal(firstSignal.aborted, false);
    await act(async () => { finish('ready'); await delay(0); });
    assert.equal(container.textContent, 'ready');
  } finally { await act(async () => root.unmount()); }
  assert.equal(firstSignal.aborted, true, '卸载页面后取消已绑定的请求');
});

test('useResource 切换手表时取消旧请求，迟到结果不能覆盖新设备', async t => {
  const { container } = browser(t);
  const pending = [];
  function Harness({ watchId }) {
    const resource = actual.useResource(signal => new Promise(resolve => pending.push({ watchId, signal, resolve })), [watchId]);
    return React.createElement('output', null, resource.data?.name || 'loading');
  }
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Harness, { watchId: 'first' })); });
    await act(async () => { root.render(React.createElement(Harness, { watchId: 'second' })); });
    assert.equal(pending.length, 2);
    assert.equal(pending[0].signal.aborted, true);
    await act(async () => { pending[1].resolve({ name: '第二块表' }); await delay(0); });
    await act(async () => { pending[0].resolve({ name: '旧表迟到响应' }); await delay(0); });
    assert.equal(container.textContent, '第二块表');
  } finally { await act(async () => root.unmount()); }
});
