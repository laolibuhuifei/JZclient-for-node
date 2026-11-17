import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import React, { act, useState } from 'react';
import { JSDOM } from 'jsdom';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let directory;
let filename;
let components;

test.before(async () => {
  const cache = path.join(frontend, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(path.join(cache, 'guard-place-checks-'));
  filename = path.join(directory, 'guard.mjs');
  const result = await build({
    absWorkingDir: frontend,
    stdin: {
      contents: `
        export { default as GuardPage } from './src/pages/GuardPage';
        export { default as GuardPlacePicker } from './src/components/location/GuardPlacePicker';
        export { default as TileMap } from './src/components/location/TileMap';
        export { TestAppContext } from './src/context/AppContext';
      `,
      loader: 'tsx', resolveDir: frontend, sourcefile: 'guard-place-checks-entry.tsx',
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node18', packages: 'external',
    loader: { '.css': 'empty' }, outfile: filename, write: false,
    plugins: [{
      name: 'guard-test-context',
      setup(builder) {
        builder.onResolve({ filter: /(?:^|\/)context\/AppContext$/ }, () => ({ path: 'app-context', namespace: 'guard-test-context' }));
        builder.onLoad({ filter: /.*/, namespace: 'guard-test-context' }, () => ({
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, error: String(data) }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

function place(id, name, latitude = 31.2304, longitude = 121.4737) {
  return { id, name, latitude, longitude, address: `测试城市 · ${name}`, coordinateSystem: 'gcj02', sourceCoordinateSystem: 'wgs84', provider: 'fixture' };
}

function namedButton(container, label) {
  const matches = [...container.querySelectorAll('button')].filter(button => (button.getAttribute('aria-label') || button.textContent).replace(/\s+/g, ' ').trim() === label);
  assert.equal(matches.length, 1, `应有一个按钮“${label}”`);
  return matches[0];
}

async function click(element) {
  assert.ok(element, '点击目标应存在');
  await act(async () => { element.click(); await delay(0); });
}

async function input(element, value) {
  const setter = Object.getOwnPropertyDescriptor(element.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new element.ownerDocument.defaultView.Event('input', { bubbles: true }));
    await delay(0);
  });
}

async function key(element, value, options = {}) {
  const event = new element.ownerDocument.defaultView.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  await act(async () => { element.dispatchEvent(event); await delay(0); });
  return event;
}

async function pointer(element, type, clientX, clientY) {
  const event = new element.ownerDocument.defaultView.MouseEvent(type, { clientX, clientY, button: 0, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  await act(async () => { element.dispatchEvent(event); await delay(0); });
}

async function settle() { await act(async () => { await delay(0); }); }

async function mount(t, Harness, handleRequest = () => { throw new Error('此用例不应发起请求'); }) {
  const dom = new JSDOM('<!doctype html><html><body><main id="fixture"></main></body></html>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent']) replace(name, dom.window[name]);
  replace('IS_REACT_ACT_ENVIRONMENT', true);
  // These pre-existing selection/save checks intentionally use immediate views.
  // Fractional zoom frames and interruption are covered by map-motion-checks.
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const requests = [];
  const blocked = [];
  replace('fetch', (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl), 'http://127.0.0.1');
    const request = { url, method: options.method || 'GET', signal: options.signal, body: options.body };
    requests.push(request);
    if (url.origin !== 'http://127.0.0.1' || !url.pathname.startsWith('/api/')) {
      blocked.push(request);
      return Promise.reject(new Error('不允许真实外部请求'));
    }
    try { return Promise.resolve(handleRequest(request)); }
    catch (error) { blocked.push(request); return Promise.reject(error); }
  });
  // JSDOM does not fetch map images. These dimensions only stand in for the
  // viewport measurement; coordinates and pointer handlers remain real.
  const originalBounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('location-map-viewport')) return { x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 460, width: 800, height: 440, toJSON() {} };
    return originalBounds.call(this);
  };
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('fixture');
  const root = createRoot(container);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await act(async () => root.unmount());
  };
  t.after(async () => {
    await close();
    assert.deepEqual(blocked, [], '所有请求必须由离线测试明确模拟');
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  });
  await act(async () => { root.render(React.createElement(Harness)); await delay(0); });
  return { dom, container, requests, close };
}

function pickerHarness(controls, initialCenter = { latitude: 31.2304, longitude: 121.4737 }) {
  return function Harness() {
    const [value, setValue] = useState(null);
    controls.value = value;
    return React.createElement(components.GuardPlacePicker, { value, radius: 300, initialCenter, disabled: false, onChange: setValue });
  };
}

test('地点搜索仅明确提交时请求，编辑或取消会终止搜索且迟到结果不能覆盖新关键词', async t => {
  const controls = {};
  const pending = [];
  const ui = await mount(t, pickerHarness(controls), request => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url.pathname, '/api/map/search');
    const response = deferred();
    pending.push({ request, response });
    // Intentionally ignore AbortSignal here, as a late transport/result must
    // still be rejected by the component's cancellation and request identity.
    return response.promise;
  });
  const query = ui.container.querySelector('.guard-place-query');
  await input(query, '城');
  assert.equal(ui.requests.length, 0, '输入单个字不能发起每键外部搜索');
  await key(query, 'Enter');
  assert.equal(ui.requests.length, 0);
  assert.match(ui.container.querySelector('[role="alert"]').textContent, /2～80/);
  await input(query, ' 城市图书 ');
  assert.equal(ui.requests.length, 0);
  await click(namedButton(ui.container, '搜索地点'));
  assert.equal(pending[0].request.url.searchParams.get('q'), '城市图书');
  assert.equal(Number(pending[0].request.url.searchParams.get('latitude')), 31.2304);
  assert.equal(Number(pending[0].request.url.searchParams.get('longitude')), 121.4737);
  assert.ok(ui.container.querySelector('.guard-place-search-cancel'));
  await input(query, '社区公园');
  assert.equal(pending[0].request.signal.aborted, true, '修改关键词应取消旧请求');
  await key(query, 'Enter');
  assert.equal(pending.length, 2);
  await act(async () => { pending[1].response.resolve(jsonResponse({ places: [place('new', '新公园')] })); await delay(0); });
  assert.match(ui.container.querySelector('.guard-place-results').textContent, /新公园/);
  await act(async () => { pending[0].response.resolve(jsonResponse({ places: [place('old', '旧图书馆')] })); await delay(0); });
  assert.doesNotMatch(ui.container.textContent, /旧图书馆/, '已取消请求迟到也不能替换新结果');
  await input(query, '另一个地点');
  await click(namedButton(ui.container, '搜索地点'));
  await click(namedButton(ui.container, '取消地点搜索'));
  assert.equal(pending[2].request.signal.aborted, true);
  assert.match(ui.container.querySelector('[role="status"]').textContent, /已取消/);
  await act(async () => { pending[2].response.resolve(jsonResponse({ places: [place('cancelled', '取消后返回')] })); await delay(0); });
  assert.equal(ui.container.querySelector('.guard-place-results'), null);
  await input(query, '离开页面');
  await key(query, 'Enter');
  await ui.close();
  assert.equal(pending[3].request.signal.aborted, true, '卸载应终止正在搜索的请求');
  await act(async () => { pending[3].response.resolve(jsonResponse({ places: [] })); await delay(0); });
});

test('地点搜索处理空结果和重试，只接受地图坐标，结果可以用方向键和 Enter 选择', async t => {
  const controls = {};
  let response = jsonResponse({ places: [] });
  const ui = await mount(t, pickerHarness(controls), request => {
    assert.equal(request.url.pathname, '/api/map/search');
    return response;
  });
  const query = ui.container.querySelector('.guard-place-query');
  await input(query, '测试地点');
  await key(query, 'Enter');
  assert.match(ui.container.querySelector('.guard-place-search-empty').textContent, /没有找到/);
  response = jsonResponse('测试搜索暂时不可用', 503);
  await click(namedButton(ui.container, '搜索地点'));
  const searchError = ui.container.querySelector('.guard-place-search-error');
  assert.match(searchError.textContent, /测试搜索暂时不可用/);
  assert.equal(query.getAttribute('aria-invalid'), 'true');
  assert.ok(query.getAttribute('aria-describedby').includes(searchError.querySelector('p').id));
  response = jsonResponse({ places: [
    { ...place('wrong-space', '另一坐标系'), coordinateSystem: 'wgs84' },
    place('invalid', '无效纬度', 120, 121),
    place('zero', '零点地点', 0, 0),
    place('park', '河畔公园', 31.25, 121.49),
  ] });
  await click(namedButton(ui.container, '重新搜索'));
  const list = ui.container.querySelector('.guard-place-results');
  const choices = [...list.querySelectorAll('button')];
  assert.equal(choices.length, 2, '不能把其他坐标系或无效坐标放入地图选择');
  assert.equal(query.getAttribute('aria-invalid'), null);
  await key(query, 'ArrowDown');
  assert.equal(ui.dom.window.document.activeElement, choices[0]);
  await key(choices[0], 'ArrowDown');
  assert.equal(ui.dom.window.document.activeElement, choices[1]);
  await key(choices[1], 'Home');
  assert.equal(ui.dom.window.document.activeElement, choices[0]);
  // Native button Enter activation is browser behavior; click invokes the same
  // selection callback after verifying actual keyboard navigation above.
  await click(choices[0]);
  assert.equal(controls.value.latitude, 0);
  assert.equal(controls.value.longitude, 0);
  assert.equal(choices[0].getAttribute('aria-pressed'), 'true');
  assert.match(ui.container.querySelector('.guard-place-coordinates').textContent, /^0\.000000, 0\.000000$/);
  assert.ok(ui.container.querySelector('.location-accuracy-circle'));
});

test('区域保存不需要输入经纬度，搜索 Enter 不触发保存，零坐标和半径只提交原有三个字段', async t => {
  const watchId = 'watch/测试';
  const base = `/api/watch/${encodeURIComponent(watchId)}/guard`;
  let saveResponse = deferred();
  const writes = [];
  function Harness() {
    const context = { watchId, watch: { watchId, lastLocation: { latitude: 0, longitude: 0 } }, navigate() {} };
    return React.createElement(components.TestAppContext.Provider, { value: context }, React.createElement(components.GuardPage));
  }
  const ui = await mount(t, Harness, request => {
    if (request.method === 'GET' && request.url.pathname === base) return jsonResponse({ status: {}, common: { commonAreaList: [] }, danger: { dangerAreaList: [] } });
    if (request.method === 'GET' && request.url.pathname === '/api/map/search') return jsonResponse({ places: [place('zero', '零坐标测试地点', 0, 0)] });
    if (request.method === 'POST' && request.url.pathname === `${base}/danger`) { writes.push(request); return saveResponse.promise; }
    throw new Error(`未模拟接口：${request.method} ${request.url.pathname}`);
  });
  await click(namedButton(ui.container, '添加区域'));
  let modal = ui.dom.window.document.querySelector('.guard-place-dialog');
  assert.ok(modal);
  assert.equal(modal.querySelectorAll('input[type="number"]').length, 1, '只保留范围半径，不要求手填经纬度');
  assert.equal(modal.querySelector('.location-map-marker'), null, '初始地图中心不是默认已选区域');
  assert.equal(namedButton(modal, '添加区域').disabled, true);
  await input(modal.querySelector('.guard-place-query'), '零坐标');
  const enter = await key(modal.querySelector('.guard-place-query'), 'Enter');
  assert.equal(enter.defaultPrevented, true, '搜索 Enter 必须阻止父表单保存');
  assert.equal(writes.length, 0);
  await click(modal.querySelector('.guard-place-results button'));
  const radius = modal.querySelector('.guard-area-radius-input');
  await input(radius, '-1');
  assert.equal(namedButton(modal, '添加区域').disabled, true);
  assert.equal(radius.getAttribute('aria-invalid'), 'true');
  await input(radius, '425');
  assert.equal(namedButton(modal, '添加区域').disabled, false);
  await click(namedButton(modal, '添加区域'));
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].body), { latitude: 0, longitude: 0, radius: 425 });
  assert.equal(modal.querySelector('fieldset').disabled, true);
  assert.equal(modal.querySelector('.guard-place-query').disabled, true);
  assert.equal(modal.querySelector('[aria-label="关闭弹窗"]'), null, '保存中不能关闭编辑弹窗');
  await key(modal, 'Escape');
  assert.ok(ui.dom.window.document.querySelector('.guard-place-dialog'));
  await act(async () => { saveResponse.resolve(jsonResponse('模拟保存失败', 503)); await delay(0); });
  modal = ui.dom.window.document.querySelector('.guard-place-dialog');
  assert.match(modal.textContent, /模拟保存失败/);
  assert.equal(modal.querySelector('.guard-area-radius-input').value, '425');
  assert.match(modal.querySelector('.guard-place-coordinates').textContent, /0\.000000, 0\.000000/);
  assert.equal(modal.querySelector('fieldset').disabled, false);
  saveResponse = deferred();
  await click(namedButton(modal, '添加区域'));
  await act(async () => { saveResponse.resolve(jsonResponse({ result: true })); await delay(0); });
  assert.equal(ui.dom.window.document.querySelector('.guard-place-dialog'), null);
  assert.equal(writes.length, 2);
  assert.equal(ui.requests.filter(request => request.method === 'GET' && request.url.pathname === base).length, 2, '保存成功后刷新原设备的区域');
});

test('区域地图区分点击与拖动，键盘确认中心，选点保持缩放且位置浏览模式兼容', async t => {
  const controls = { picked: [], view: null, recenter: null, setMode: null };
  const onViewChange = next => { controls.view = next; };
  function Harness() {
    const [selected, setSelected] = useState({ latitude: 31.2304, longitude: 121.4737 });
    const [recenterKey, setRecenterKey] = useState(0);
    const [selectable, setSelectable] = useState(true);
    controls.recenter = next => { setSelected(next); setRecenterKey(value => value + 1); };
    controls.setMode = setSelectable;
    return React.createElement(components.TileMap, {
      ...selected, recenterKey, showMarker: true, onViewChange,
      onPick: selectable ? next => { controls.picked.push(next); setSelected(next); } : undefined,
    });
  }
  const ui = await mount(t, Harness);
  const map = ui.container.querySelector('.location-map-viewport');
  await click(namedButton(ui.container, '放大地图'));
  assert.equal(new URL(ui.container.querySelector('.location-map-tile').src).searchParams.get('z'), '17');
  const initialCenter = { ...controls.view };
  await pointer(map, 'pointerdown', 450, 240);
  await pointer(map, 'pointerup', 450, 240);
  assert.equal(controls.picked.length, 1);
  assert.ok(controls.picked[0].longitude > initialCenter.longitude, '视口右侧点击应选择中心以东的位置');
  assert.deepEqual(controls.view, initialCenter, '点选不会重置当前地图视口');
  assert.equal(new URL(ui.container.querySelector('.location-map-tile').src).searchParams.get('z'), '17');
  await pointer(map, 'pointerdown', 410, 240);
  await pointer(map, 'pointermove', 510, 240);
  await pointer(map, 'pointerup', 510, 240);
  assert.equal(controls.picked.length, 1, '拖动地图不能误添加中心点');
  assert.ok(controls.view.longitude < initialCenter.longitude);
  await key(map, 'ArrowRight');
  const keyboardCenter = { ...controls.view };
  await key(map, 'Enter');
  assert.equal(controls.picked.length, 2);
  assert.deepEqual(controls.picked.at(-1), keyboardCenter);
  await act(async () => { controls.recenter({ latitude: 30.5, longitude: 120.5 }); await delay(0); });
  assert.deepEqual(controls.view, { latitude: 30.5, longitude: 120.5 });
  assert.equal(new URL(ui.container.querySelector('.location-map-tile').src).searchParams.get('z'), '17', '搜索选点居中也保留缩放');
  await act(async () => { controls.setMode(false); await delay(0); });
  assert.equal(new URL(ui.container.querySelector('.location-map-tile').src).searchParams.get('z'), '16', '原位置浏览模式继续使用初始缩放');
  assert.equal(ui.container.querySelector('.location-map-pick-center'), null);
  await pointer(map, 'pointerdown', 450, 240);
  await pointer(map, 'pointerup', 450, 240);
  assert.equal(controls.picked.length, 2, '普通位置地图不能触发区域选点');
  await key(map, 'Enter');
  assert.equal(controls.picked.length, 2);
  await settle();
});
