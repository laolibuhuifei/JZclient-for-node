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
const initialPoint = { latitude: 31.2304, longitude: 121.4737 };
let directory;
let filename;
let components;

test.before(async () => {
  const cache = path.join(frontend, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(path.join(cache, 'map-motion-checks-'));
  filename = path.join(directory, 'maps.mjs');
  const result = await build({
    absWorkingDir: frontend,
    stdin: {
      contents: `
        export { default as TileMap } from './src/components/location/TileMap';
        export { default as GuardPlacePicker } from './src/components/location/GuardPlacePicker';
        export { default as GuardPage } from './src/pages/GuardPage';
        export { TestAppContext } from './src/context/AppContext';
      `,
      loader: 'tsx', resolveDir: frontend, sourcefile: 'map-motion-checks-entry.tsx',
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node18', packages: 'external',
    loader: { '.css': 'empty' }, outfile: filename, write: false,
    plugins: [{
      name: 'map-test-context',
      setup(builder) {
        builder.onResolve({ filter: /(?:^|\/)context\/AppContext$/ }, () => ({ path: 'app-context', namespace: 'map-test-context' }));
        builder.onLoad({ filter: /.*/, namespace: 'map-test-context' }, () => ({
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

function namedButton(container, label) {
  const matches = [...container.querySelectorAll('button')].filter(button => (button.getAttribute('aria-label') || button.textContent).replace(/\s+/g, ' ').trim() === label);
  assert.equal(matches.length, 1, `应有一个按钮“${label}”`);
  return matches[0];
}

async function click(element) {
  assert.ok(element, '点击目标应存在');
  await act(async () => { element.click(); await delay(0); });
}

async function key(element, value) {
  const event = new element.ownerDocument.defaultView.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
  await act(async () => element.dispatchEvent(event));
  return event;
}

async function pointer(element, type, clientX, clientY) {
  const event = new element.ownerDocument.defaultView.MouseEvent(type, { clientX, clientY, button: 0, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  await act(async () => element.dispatchEvent(event));
}

async function wheel(element, deltaY, clientX = 610, clientY = 340) {
  const event = new element.ownerDocument.defaultView.WheelEvent('wheel', { deltaY, clientX, clientY, bubbles: true, cancelable: true });
  await act(async () => element.dispatchEvent(event));
  return event;
}

async function input(element, value) {
  const setter = Object.getOwnPropertyDescriptor(element.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new element.ownerDocument.defaultView.Event('input', { bubbles: true }));
    await delay(0);
  });
}

function jsonResponse(data) {
  return new Response(JSON.stringify({ ok: true, data }), { headers: { 'Content-Type': 'application/json' } });
}

async function mount(t, Harness, handleRequest = () => { throw new Error('此用例不应发起请求'); }, displayScale = 1) {
  const dom = new JSDOM('<!doctype html><html><body><main id="fixture"></main></body></html>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
  dom.window.document.documentElement.style.setProperty('--ui-scale', String(displayScale));
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent']) replace(name, dom.window[name]);
  replace('IS_REACT_ACT_ENVIRONMENT', true);
  const requests = [];
  const blocked = [];
  replace('fetch', (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl), 'http://127.0.0.1');
    const request = { url, method: options.method || 'GET', body: options.body, signal: options.signal };
    requests.push(request);
    if (url.origin !== 'http://127.0.0.1' || !url.pathname.startsWith('/api/')) {
      blocked.push(request);
      return Promise.reject(new Error('测试禁止真实外部请求'));
    }
    try { return Promise.resolve(handleRequest(request)); }
    catch (error) { blocked.push(request); return Promise.reject(error); }
  });

  // The clock is deterministic; JSDOM never downloads the image URLs.
  let frameClock = 0;
  let nextFrameId = 1;
  let hidden = false;
  const frames = new Map();
  Object.defineProperty(dom.window.performance, 'now', { value: () => frameClock });
  Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => hidden });
  dom.window.requestAnimationFrame = callback => { const id = nextFrameId++; frames.set(id, callback); return id; };
  dom.window.cancelAnimationFrame = id => frames.delete(id);
  const preference = new dom.window.EventTarget();
  preference.matches = false;
  dom.window.matchMedia = () => preference;
  const observers = [];
  dom.window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.active = true; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.active = false; }
  };
  const originalBounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('location-map-viewport')) return { x: 10 * displayScale, y: 20 * displayScale, left: 10 * displayScale, top: 20 * displayScale, right: 810 * displayScale, bottom: 460 * displayScale, width: 800 * displayScale, height: 440 * displayScale, toJSON() {} };
    if (this.classList.contains('guard-radius-info-button')) return { x: 980, y: 730, left: 980, top: 730, right: 1024, bottom: 774, width: 44, height: 44, toJSON() {} };
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
    assert.deepEqual(blocked, [], '所有请求都必须由离线 fixture 明确模拟');
    assert.equal(frames.size, 0, '卸载时必须清理全部动画帧');
    assert.ok(observers.every(observer => !observer.active), '卸载时必须清理可见性观察器');
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  });
  await act(async () => { root.render(React.createElement(Harness)); await delay(0); });
  return {
    dom, container, requests, frames, observers, close,
    async tick(elapsed) {
      frameClock += elapsed;
      await act(async () => {
        const scheduled = [...frames.values()];
        frames.clear();
        for (const callback of scheduled) callback(frameClock);
      });
    },
    async reduced(value) {
      await act(async () => { preference.matches = value; preference.dispatchEvent(new dom.window.Event('change')); });
    },
    async hidden(value) {
      await act(async () => { hidden = value; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); });
    },
    async visible(value) {
      await act(async () => {
        for (const observer of observers.filter(item => item.active)) observer.callback([{ target: observer.target, isIntersecting: value }]);
      });
    },
  };
}

function mapHarness(controls, radius = 300) {
  controls.picked = [];
  const onViewChange = value => { controls.center = value; };
  return function Harness() {
    const [selected, setSelected] = useState(initialPoint);
    const [disabled, setDisabled] = useState(false);
    controls.selected = selected;
    controls.setDisabled = setDisabled;
    return React.createElement(components.TileMap, {
      ...selected, radius, disabled, recenterKey: 0, onViewChange,
      onPick: value => { controls.picked.push(value); setSelected(value); },
    });
  };
}

function map(ui) { return ui.container.querySelector('.location-map'); }
function viewport(ui) { return ui.container.querySelector('.location-map-viewport'); }
function zoom(ui) { return Number(map(ui).dataset.zoom); }
function currentView(ui, controls) { return { ...controls.center, zoom: zoom(ui) }; }

function near(actual, expected, tolerance = 1e-7, description = '数值应保持一致') {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${description}: ${actual} ≈ ${expected}`);
}

// Independent Web Mercator reference, expressed in world CSS pixels. It checks
// visible component geometry rather than importing the implementation helpers.
function world(point, level) {
  const size = 256 * 2 ** level;
  const radians = point.latitude * Math.PI / 180;
  return { x: (point.longitude + 180) / 360 * size, y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * size, size };
}

function pointAt(view, x, y) {
  const center = world(view, view.zoom);
  return {
    longitude: (center.x + x) / center.size * 360 - 180,
    latitude: Math.atan(Math.sinh(Math.PI - 2 * Math.PI * (center.y + y) / center.size)) * 180 / Math.PI,
  };
}

function nearPoint(actual, expected) {
  near(actual.latitude, expected.latitude, 1e-9, '纬度应匹配当前可见投影');
  near(actual.longitude, expected.longitude, 1e-9, '经度应匹配当前可见投影');
}

function assertGeometry(ui, controls, radius = 300) {
  const view = currentView(ui, controls);
  const center = world(view, view.zoom);
  const selected = world(controls.selected, view.zoom);
  const marker = ui.container.querySelector('.location-map-marker');
  near(Number.parseFloat(marker.style.left), 400 + selected.x - center.x, 1e-6, '标记横坐标');
  near(Number.parseFloat(marker.style.top), 220 + selected.y - center.y, 1e-6, '标记纵坐标');
  const circle = ui.container.querySelector('.location-accuracy-circle');
  near(Number(circle.getAttribute('cx')), Number.parseFloat(marker.style.left));
  near(Number(circle.getAttribute('cy')), Number.parseFloat(marker.style.top));
  const expectedRadius = radius * 256 * 2 ** view.zoom / (2 * Math.PI * 6378137 * Math.cos(controls.selected.latitude * Math.PI / 180));
  near(Number(circle.getAttribute('r')), expectedRadius, 1e-5, '半径应与当前缩放匹配');
  for (const image of ui.container.querySelectorAll('.location-map-tile')) {
    const url = new URL(image.src);
    const rasterZoom = Number(url.searchParams.get('z'));
    assert.equal(Number.isInteger(rasterZoom), true, '服务商只接受整数瓦片层级');
    const transform = image.style.transform.match(/^translate3d\(([^p]+)px, ([^p]+)px, 0\) scale\(([^)]+)\)$/);
    assert.ok(transform, '瓦片必须使用一致的缩放与平移投影');
    const scale = 2 ** (view.zoom - rasterZoom);
    near(Number(transform[3]), scale, 1e-9);
    const expectedX = Number(url.searchParams.get('x')) * 256 * scale - center.x + 400;
    const wrappedDifference = Number(transform[1]) - expectedX;
    near(wrappedDifference - Math.round(wrappedDifference / center.size) * center.size, 0, 1e-6, '瓦片横坐标与日期变更线副本');
    near(Number(transform[2]), Number(url.searchParams.get('y')) * 256 * scale - center.y + 220, 1e-6, '瓦片纵坐标');
  }
}

function assertStopped(ui) {
  assert.equal(ui.frames.size, 0, '停止后不得保留动画帧');
  assert.equal(map(ui).dataset.animating, 'false');
  assert.equal(map(ui).dataset.zoom, map(ui).dataset.targetZoom);
}

test('地图缩放逐帧过渡，偏离中心的标记、区域半径与瓦片始终使用同一可见投影', async t => {
  const controls = {};
  const ui = await mount(t, mapHarness(controls));
  assert.deepEqual(controls.center, initialPoint, '合法坐标不应被无意义的归一化改写');
  await key(viewport(ui), 'ArrowRight');
  const center = { ...controls.center };
  const firstRadius = Number(ui.container.querySelector('.location-accuracy-circle').getAttribute('r'));
  await click(namedButton(ui.container, '放大地图'));
  assert.equal(zoom(ui), 16, '点击时不能直接跳到目标层级');
  assert.equal(map(ui).dataset.targetZoom, '17');
  assert.equal(ui.frames.size, 1);
  await ui.tick(65);
  const first = zoom(ui);
  assert.ok(first > 16 && first < 17);
  assertGeometry(ui, controls);
  await ui.tick(65);
  const second = zoom(ui);
  assert.ok(second > first && second < 17);
  assertGeometry(ui, controls);
  assert.deepEqual(controls.center, center, '围绕视口中心缩放不能漂移中心坐标');
  await ui.tick(400);
  assert.equal(zoom(ui), 17);
  assertStopped(ui);
  assertGeometry(ui, controls);
  near(Number(ui.container.querySelector('.location-accuracy-circle').getAttribute('r')), firstRadius * 2);
});

test('快速连续和反向缩放从可见帧接续，跨越完整缩放范围时瓦片数量保持有界', async t => {
  const controls = {};
  const ui = await mount(t, mapHarness(controls));
  await click(namedButton(ui.container, '放大地图'));
  await ui.tick(60);
  const interrupted = zoom(ui);
  await click(namedButton(ui.container, '放大地图'));
  assert.equal(zoom(ui), interrupted, '追加缩放不能从旧起点或上个目标回跳');
  assert.equal(map(ui).dataset.targetZoom, '18');
  assert.equal(ui.frames.size, 1, '被替换的动画必须取消');
  await ui.tick(55);
  const reversing = zoom(ui);
  assert.ok(reversing > 17 && reversing < 18);
  await click(namedButton(ui.container, '缩小地图'));
  assert.equal(zoom(ui), reversing);
  assert.equal(map(ui).dataset.targetZoom, '17');
  await ui.tick(65);
  assert.ok(zoom(ui) < reversing && zoom(ui) > 17, '反向命令应从当前显示位置自然返回');
  await ui.tick(400);
  assertStopped(ui);
  await click(namedButton(ui.container, '放大地图'));
  await click(namedButton(ui.container, '放大地图'));
  await ui.tick(400);
  assert.equal(zoom(ui), 19);
  for (let index = 0; index < 16; index++) await click(namedButton(ui.container, '缩小地图'));
  assert.equal(zoom(ui), 19);
  assert.equal(map(ui).dataset.targetZoom, '3');
  for (let index = 0; index < 21; index++) {
    assert.ok(ui.container.querySelectorAll('.location-map-tile').length < 200, '远目标不能枚举数百万张未来层级的瓦片');
    assertGeometry(ui, controls);
    await ui.tick(13);
  }
  assert.equal(zoom(ui), 3);
  assert.equal(namedButton(ui.container, '缩小地图').disabled, true);
  assertStopped(ui);
});

test('滚轮缩放固定鼠标下的地点，动画中点击或拖动使用当前可见视图', async t => {
  const controls = {};
  const ui = await mount(t, mapHarness(controls));
  const before = currentView(ui, controls);
  const cursorPoint = pointAt(before, 200, 100);
  const event = await wheel(viewport(ui), -140);
  assert.equal(event.defaultPrevented, true, '地图滚轮缩放不应同时滚动父页面');
  assert.equal(map(ui).dataset.targetZoom, '16.5');
  await ui.tick(65);
  nearPoint(pointAt(currentView(ui, controls), 200, 100), cursorPoint);
  assertGeometry(ui, controls);
  await ui.tick(40);
  const visible = currentView(ui, controls);
  nearPoint(pointAt(visible, 200, 100), cursorPoint);
  const expectedPick = pointAt(visible, 120, -40);
  await pointer(viewport(ui), 'pointerdown', 530, 200);
  assertStopped(ui);
  assert.equal(zoom(ui), visible.zoom, '开始点击或拖拽时冻结当前可见帧');
  await pointer(viewport(ui), 'pointerup', 530, 200);
  assert.equal(controls.picked.length, 1);
  nearPoint(controls.picked[0], expectedPick);
  nearPoint(controls.center, visible);
  await click(namedButton(ui.container, '放大地图'));
  await ui.tick(70);
  const dragStart = currentView(ui, controls);
  const expectedCenter = pointAt(dragStart, -80, -40);
  await pointer(viewport(ui), 'pointerdown', 410, 240);
  await pointer(viewport(ui), 'pointermove', 490, 280);
  await pointer(viewport(ui), 'pointerup', 490, 280);
  assert.equal(controls.picked.length, 1, '拖拽不能误触发选择');
  assert.equal(zoom(ui), dragStart.zoom);
  nearPoint(controls.center, expectedCenter);
  assertGeometry(ui, controls);
  assertStopped(ui);
});

test('90%显示比例下，地图选点、拖动和滚轮仍匹配可见坐标且不误保存', async t => {
  const controls = {};
  const ui = await mount(t, mapHarness(controls), undefined, .9);
  const before = currentView(ui, controls);
  const selected = pointAt(before, 120, -40);
  await pointer(viewport(ui), 'pointerdown', 530 * .9, 200 * .9);
  await pointer(viewport(ui), 'pointerup', 530 * .9, 200 * .9);
  nearPoint(controls.picked[0], selected);
  assertGeometry(ui, controls);
  const cursorPoint = pointAt(currentView(ui, controls), 200, 100);
  await wheel(viewport(ui), -140, 610 * .9, 340 * .9);
  await ui.tick(400);
  nearPoint(pointAt(currentView(ui, controls), 200, 100), cursorPoint);
  const dragStart = currentView(ui, controls);
  await pointer(viewport(ui), 'pointerdown', 410 * .9, 240 * .9);
  await pointer(viewport(ui), 'pointermove', 490 * .9, 280 * .9);
  await pointer(viewport(ui), 'pointerup', 490 * .9, 280 * .9);
  nearPoint(controls.center, pointAt(dragStart, -80, -40));
  assert.equal(controls.picked.length, 1, '拖动不会新增选点');
  assertGeometry(ui, controls);
  assert.equal(ui.requests.length, 0);
});

test('新层级尚未加载时保留已加载底图，快速缩放不会提前移除旧影像', async t => {
  const controls = {};
  const ui = await mount(t, mapHarness(controls));
  await act(async () => {
    for (const image of ui.container.querySelectorAll('.location-map-tile')) image.dispatchEvent(new ui.dom.window.Event('load'));
  });
  await click(namedButton(ui.container, '放大地图'));
  await click(namedButton(ui.container, '放大地图'));
  await ui.tick(400);
  assert.equal(zoom(ui), 18);
  let loaded = [...ui.container.querySelectorAll('.location-map-tile')].filter(image => image.style.opacity === '1');
  assert.ok(loaded.length > 0, '18级未到达前仍应显示已加载的16级底图');
  assert.ok(loaded.every(image => new URL(image.src).searchParams.get('z') === '16'));
  assertGeometry(ui, controls);
  for (let index = 0; index < 5; index++) await click(namedButton(ui.container, '缩小地图'));
  await ui.tick(400);
  assert.equal(zoom(ui), 13);
  loaded = [...ui.container.querySelectorAll('.location-map-tile')].filter(image => image.style.opacity === '1');
  assert.ok(loaded.length > 0, '缩小时有限的已加载区域仍保留为底图');
  assert.ok(ui.container.querySelectorAll('.location-map-tile').length < 200);
  assertGeometry(ui, controls);
});

test('普通与卫星切换使用对应真实图源，保留选点和半径，并提供失败重试', async t => {
  const controls = {};
  const ui = await mount(t, mapHarness(controls));
  const firstRadius = ui.container.querySelector('.location-accuracy-circle').getAttribute('r');
  const center = { ...controls.center };
  for (const image of ui.container.querySelectorAll('.location-map-tile')) {
    const url = new URL(image.src);
    assert.match(url.hostname, /^webrd0[1-4]\.is\.autonavi\.com$/);
    assert.equal(url.searchParams.get('style'), '8');
  }
  await click(namedButton(ui.container, '卫星地图'));
  assert.equal(namedButton(ui.container, '卫星地图').getAttribute('aria-pressed'), 'true');
  assert.equal(namedButton(ui.container, '普通地图').getAttribute('aria-pressed'), 'false');
  assert.equal(namedButton(ui.container, '卫星地图').textContent, '', '图层按钮只显示图标');
  assert.equal(map(ui).dataset.layer, 'satellite');
  assert.equal(zoom(ui), 16);
  assert.deepEqual(controls.center, center);
  assert.equal(controls.picked.length, 0);
  assert.equal(ui.container.querySelector('.location-accuracy-circle').getAttribute('r'), firstRadius);
  for (const image of ui.container.querySelectorAll('.location-map-tile')) {
    const url = new URL(image.src);
    assert.match(url.hostname, /^webst0[1-4]\.is\.autonavi\.com$/);
    assert.equal(url.searchParams.get('style'), '6', '卫星层必须是实际影像，不能叠加不透明的普通图');
  }
  await act(async () => {
    for (const image of ui.container.querySelectorAll('.location-map-tile')) image.dispatchEvent(new ui.dom.window.Event('error'));
  });
  assert.match(ui.container.querySelector('.location-map-unavailable').textContent, /卫星影像暂时无法加载/);
  await click(namedButton(ui.container, '重新加载'));
  assert.equal(ui.container.querySelector('.location-map-unavailable'), null);
  assert.equal(new URL(ui.container.querySelector('.location-map-tile').src).searchParams.get('retry'), '1');
  await act(async () => {
    for (const image of ui.container.querySelectorAll('.location-map-tile')) image.dispatchEvent(new ui.dom.window.Event('load'));
  });
  assert.ok([...ui.container.querySelectorAll('.location-map-tile')].every(image => image.style.opacity === '1'));
  await click(namedButton(ui.container, '普通地图'));
  assert.equal(map(ui).dataset.layer, 'normal');
  assert.deepEqual(controls.selected, initialPoint);
  assert.equal(ui.requests.length, 0);
});

test('地图全屏与退出跟随浏览器事件，保留选点、图层和缩放，退出回焦且禁用仍能退出', async t => {
  const controls = {};
  const ui = await mount(t, mapHarness(controls), undefined, .9);
  const document = ui.dom.window.document;
  let fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  const enter = namedButton(ui.container, '全屏显示地图');
  let enterCalls = 0;
  let exitCalls = 0;
  map(ui).requestFullscreen = async () => {
    enterCalls++;
    fullscreenElement = map(ui);
    document.dispatchEvent(new ui.dom.window.Event('fullscreenchange'));
  };
  document.exitFullscreen = async () => {
    exitCalls++;
    fullscreenElement = null;
    document.dispatchEvent(new ui.dom.window.Event('fullscreenchange'));
  };
  await click(namedButton(ui.container, '卫星地图'));
  await click(namedButton(ui.container, '放大地图'));
  await ui.tick(300);
  const before = currentView(ui, controls);
  await click(enter);
  assert.equal(enterCalls, 1);
  assert.equal(map(ui).dataset.fullscreen, 'true');
  assert.equal(map(ui).dataset.layer, 'satellite');
  nearPoint(currentView(ui, controls), before);
  assert.equal(zoom(ui), before.zoom);
  assert.deepEqual(controls.selected, initialPoint);
  assertGeometry(ui, controls);
  await act(async () => controls.setDisabled(true));
  const exit = namedButton(ui.container, '退出地图全屏');
  assert.equal(exit.disabled, false, '业务保存禁用地图期间仍可退出全屏');
  await click(exit);
  assert.equal(exitCalls, 1);
  assert.equal(map(ui).dataset.fullscreen, 'false');
  assert.equal(document.activeElement, enter);
  assert.equal(ui.requests.length, 0);
});

test('浏览器拒绝或不支持原生全屏时回退页内全屏，Escape退出并保留地图状态', async t => {
  const controls = {};
  const ui = await mount(t, mapHarness(controls));
  const document = ui.dom.window.document;
  let fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  await click(namedButton(ui.container, '卫星地图'));
  await click(namedButton(ui.container, '全屏显示地图'));
  assert.equal(document.querySelector('.map-fullscreen-modal .location-map').dataset.fullscreen, 'true');
  assert.equal(document.querySelector('.map-fullscreen-modal .location-map').dataset.layer, 'satellite');
  await key(document.querySelector('.map-fullscreen-modal'), 'Escape');
  assert.equal(document.querySelector('.map-fullscreen-modal'), null);
  assert.equal(document.activeElement, namedButton(ui.container, '全屏显示地图'));
  map(ui).requestFullscreen = async () => { throw new Error('browser refusal'); };
  await click(namedButton(ui.container, '全屏显示地图'));
  assert.ok(document.querySelector('.map-fullscreen-modal'));
  await click(namedButton(document.body, '退出地图全屏'));
  assert.equal(document.querySelector('.map-fullscreen-modal'), null);
  map(ui).requestFullscreen = async () => {
    fullscreenElement = map(ui);
    document.dispatchEvent(new ui.dom.window.Event('fullscreenchange'));
  };
  await click(namedButton(ui.container, '全屏显示地图'));
  await act(async () => {
    fullscreenElement = null;
    document.dispatchEvent(new ui.dom.window.Event('fullscreenchange'));
  });
  assert.equal(map(ui).dataset.fullscreen, 'false');
  assert.equal(document.activeElement, namedButton(ui.container, '全屏显示地图'));
  assert.equal(controls.picked.length, 0);
  assert.equal(ui.requests.length, 0);
});

test('减弱动效、页面隐藏、离屏、禁用与卸载清理动画，不留下后台循环', async t => {
  const controls = {};
  const ui = await mount(t, mapHarness(controls));
  await click(namedButton(ui.container, '放大地图'));
  await ui.tick(40);
  await ui.reduced(true);
  assertStopped(ui);
  assert.equal(zoom(ui), 17);
  await click(namedButton(ui.container, '放大地图'));
  assertStopped(ui);
  assert.equal(zoom(ui), 18);
  await ui.reduced(false);
  await click(namedButton(ui.container, '缩小地图'));
  assert.equal(ui.frames.size, 1);
  await ui.hidden(true);
  assertStopped(ui);
  await click(namedButton(ui.container, '放大地图'));
  assertStopped(ui);
  await ui.hidden(false);
  await click(namedButton(ui.container, '缩小地图'));
  assert.equal(ui.frames.size, 1);
  await ui.visible(false);
  assertStopped(ui);
  await click(namedButton(ui.container, '放大地图'));
  assertStopped(ui);
  await ui.visible(true);
  await click(namedButton(ui.container, '缩小地图'));
  assert.equal(ui.frames.size, 1);
  await act(async () => controls.setDisabled(true));
  assertStopped(ui);
  const stoppedZoom = zoom(ui);
  assert.ok([...ui.container.querySelectorAll('button')].every(button => button.disabled));
  assert.equal(viewport(ui).getAttribute('aria-disabled'), 'true');
  assert.equal((await wheel(viewport(ui), -140)).defaultPrevented, false);
  await key(viewport(ui), '+');
  await pointer(viewport(ui), 'pointerdown', 410, 240);
  await pointer(viewport(ui), 'pointerup', 410, 240);
  assert.equal(zoom(ui), stoppedZoom);
  assert.equal(controls.picked.length, 0);
  await act(async () => controls.setDisabled(false));
  await click(namedButton(ui.container, '放大地图'));
  assert.equal(ui.frames.size, 1);
  await ui.close();
  assert.equal(ui.frames.size, 0);
  assert.ok(ui.observers.every(observer => !observer.active));
});

test('消息位置复用搜索和地图，文案跟随发送用途且不绘制区域半径', async t => {
  const controls = {};
  function Harness() {
    const [value, setValue] = useState(null);
    controls.value = value;
    return React.createElement(components.GuardPlacePicker, { value, onChange: setValue, disabled: false, purpose: 'message', radius: 300, initialCenter: initialPoint });
  }
  const ui = await mount(t, Harness, request => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url.pathname, '/api/map/search');
    return jsonResponse({ places: [{ id: 'fixture-place', name: '测试图书馆', ...initialPoint, coordinateSystem: 'gcj02', address: '测试城市' }] });
  });
  assert.match(ui.container.textContent, /尚未选择发送位置/);
  assert.match(viewport(ui).getAttribute('aria-label'), /^发送位置选择地图/);
  assert.doesNotMatch(ui.container.textContent, /区域中心|半径/);
  await click(namedButton(ui.container, '使用地图中心'));
  assert.deepEqual({ latitude: controls.value.latitude, longitude: controls.value.longitude }, initialPoint);
  assert.ok(namedButton(ui.container, '回到发送位置'));
  assert.equal(ui.container.querySelector('.location-accuracy-circle'), null);
  const query = ui.container.querySelector('.guard-place-query');
  await input(query, '测试图书馆');
  await key(query, 'Enter');
  await act(async () => { await delay(0); });
  assert.match(ui.container.querySelector('.guard-place-result-count').textContent, /选择一个作为发送位置/);
  await click(ui.container.querySelector('.guard-place-results button'));
  assert.equal(controls.value.name, '测试图书馆');
  assert.doesNotMatch(ui.container.textContent, /区域中心|半径/);
  assert.equal(ui.container.querySelector('.location-accuracy-circle'), null);
});

test('半径说明是独立非模态提示，Escape 只关闭提示并返回焦点，外部点击保留编辑弹窗', async t => {
  function Harness() {
    const watchId = 'fixture-watch';
    const context = { watchId, watch: { watchId, lastLocation: initialPoint }, navigate() {} };
    return React.createElement(components.TestAppContext.Provider, { value: context }, React.createElement(components.GuardPage));
  }
  const ui = await mount(t, Harness, request => {
    assert.equal(request.method, 'GET', '打开提示绝不能提交区域表单');
    assert.equal(request.url.pathname, '/api/watch/fixture-watch/guard');
    return jsonResponse({ status: {}, common: { commonAreaList: [] }, danger: { dangerAreaList: [] } });
  });
  await click(namedButton(ui.container, '添加区域'));
  const modal = ui.dom.window.document.querySelector('.guard-place-dialog');
  const radius = modal.querySelector('.guard-area-radius-input');
  const label = modal.querySelector('.guard-area-radius-label > label');
  const trigger = namedButton(modal, '半径说明');
  assert.equal(label.control, radius, '半径标签必须直接关联输入框');
  assert.equal(trigger.closest('label'), null, 'Info 不能成为 Field 标签的首个表单控件');
  assert.equal(trigger.type, 'button');
  const hint = ui.dom.window.document.getElementById(trigger.getAttribute('aria-controls'));
  assert.equal(hint.getAttribute('role'), 'dialog');
  assert.equal(hint.getAttribute('aria-modal'), 'false');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.ok(radius.getAttribute('aria-describedby').split(' ').includes(hint.querySelector('p').id));
  await click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(hint.dataset.fallbackOpen, 'true');
  assert.equal(ui.dom.window.document.activeElement, hint);
  assert.match(hint.textContent, /以所选地点为中心，地图圆圈显示区域范围。/);
  assert.ok(Number.parseFloat(hint.style.getPropertyValue('--radius-hint-left')) + Number.parseFloat(hint.style.getPropertyValue('--radius-hint-width')) <= ui.dom.window.innerWidth - 16);
  assert.ok(Number.parseFloat(hint.style.getPropertyValue('--radius-hint-top')) < 730, '靠近底部时说明应移到按钮上方');
  assert.equal((await key(hint, 'Escape')).defaultPrevented, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(ui.dom.window.document.activeElement, trigger);
  assert.equal(ui.dom.window.document.querySelector('.guard-place-dialog'), modal);
  await click(trigger);
  await pointer(radius, 'pointerdown', 100, 100);
  await act(async () => radius.focus());
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(ui.dom.window.document.activeElement, radius, '外部点击关闭不应抢走另一个字段的焦点');
  assert.equal(ui.dom.window.document.querySelector('.guard-place-dialog'), modal);
  await click(trigger);
  await click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(ui.dom.window.document.activeElement, trigger);
  await key(trigger, 'Escape');
  assert.equal(ui.dom.window.document.querySelector('.guard-place-dialog'), null, '提示关闭后的 Escape 继续保留原弹窗关闭行为');
  assert.equal(ui.requests.length, 1);
});
