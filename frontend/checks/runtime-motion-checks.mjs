import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let directory;
let filename;
let RuntimeTrends;

test.before(async () => {
  const cache = path.join(frontend, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(path.join(cache, 'runtime-motion-checks-'));
  filename = path.join(directory, 'runtime.mjs');
  const result = await build({
    absWorkingDir: frontend,
    stdin: {
      contents: `export { default as RuntimeTrends } from './src/pages/HomeRuntimeTrends';`,
      loader: 'tsx', resolveDir: frontend, sourcefile: 'runtime-motion-checks-entry.tsx',
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node18', packages: 'external',
    loader: { '.css': 'empty' }, outfile: filename, write: false,
  });
  await writeFile(filename, result.outputFiles[0].contents);
  ({ RuntimeTrends } = await import(pathToFileURL(filename).href));
});

test.after(async () => {
  if (filename) await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (directory) await rmdir(directory);
});

async function mountTrends(t) {
  const dom = new JSDOM('<!doctype html><html><body><main id="fixture"></main></body></html>', {
    url: 'http://127.0.0.1/', pretendToBeVisual: true,
  });
  const originals = new Map();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: dom.window[key], writable: true, configurable: true });
  }
  for (const [key, value] of [['IS_REACT_ACT_ENVIRONMENT', true], ['fetch', () => { throw new Error('运行趋势测试不得调用网络'); }]]) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  let receivedAt = 1700000000000;
  const originalNow = Date.now;
  Date.now = () => receivedAt;
  t.after(async () => {
    await close();
    Date.now = originalNow;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  });

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

  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('fixture');
  const root = createRoot(container);
  let currentSample;
  let sampleIndex = 0;
  let closed = false;
  const render = async (sample, interrupted = false) => {
    await act(async () => { root.render(React.createElement(RuntimeTrends, { sample, interrupted })); await delay(0); });
  };
  const push = async (cpu, memory, options = {}) => {
    receivedAt += options.delta ?? 3000;
    sampleIndex++;
    currentSample = {
      system: { cpuPercent: cpu, memPercent: memory },
      process: { pid: options.pid ?? 100, uptime: options.uptime ?? sampleIndex * 3 },
    };
    await render(currentSample);
  };
  const close = async () => {
    if (!closed) { closed = true; await act(async () => root.unmount()); }
  };
  return {
    container, frames, observers, push, close,
    async tick(elapsed) {
      frameClock += elapsed;
      await act(async () => {
        const scheduled = [...frames.values()];
        frames.clear();
        for (const callback of scheduled) callback(frameClock);
      });
    },
    async interrupt() { await render(currentSample, true); },
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

function figure(ui, series = 'cpu') {
  const result = ui.container.querySelector(`.home-runtime-trend[data-series="${series}"]`);
  assert.ok(result);
  return result;
}

function lines(ui, series = 'cpu') {
  return [...figure(ui, series).querySelectorAll('polyline')].map(line => line.getAttribute('points').trim().split(/\s+/).map(point => point.split(',').map(Number)));
}

function assertStopped(ui) {
  assert.equal(ui.frames.size, 0, '停止时不得保留待执行的动画帧');
  for (const chart of ui.container.querySelectorAll('.home-runtime-trend')) assert.equal(chart.dataset.animating, 'false');
}

test('趋势刷新连续过渡，快速新采样从已显示位置接续，当前值始终保持真实且不画圆点', async t => {
  const ui = await mountTrends(t);
  await ui.push(10, 20);
  assert.equal(lines(ui).length, 0, '首次实际采样只显示数值，等待后续读数形成曲线');
  await ui.push(90, 80);
  const start = lines(ui)[0];
  assert.equal(figure(ui).querySelector('.home-runtime-trend-current').textContent, '90%');
  assert.equal(ui.container.querySelectorAll('circle').length, 0);
  assert.equal(figure(ui).dataset.animating, 'true');
  await ui.tick(80);
  const firstFrame = lines(ui)[0];
  await ui.tick(80);
  const secondFrame = lines(ui)[0];
  assert.notDeepEqual(firstFrame, start, '刷新不能一次性跳到新几何');
  assert.notDeepEqual(secondFrame, firstFrame, '多帧之间继续平滑移动');
  assert.ok(secondFrame[1][1] < firstFrame[1][1], '新增端点应向实际 CPU 新值移动');
  await ui.push(30, 40);
  assert.deepEqual(lines(ui)[0].slice(0, 2), secondFrame, '打断动效后已有曲线不得回跳');
  assert.equal(figure(ui).querySelector('.home-runtime-trend-current').textContent, '30%');
  await ui.tick(500);
  assertStopped(ui);
  const settled = lines(ui);
  await ui.tick(1000);
  assert.deepEqual(lines(ui), settled, '过渡结束后不得继续运行');
  assert.ok(settled[0].every(([x, y]) => x >= 4 && x <= 276 && y >= 8 && y <= 104));
});

test('减弱动效、页面隐藏或图表离屏会停止当前过渡，并立即展示后续采样', async t => {
  const ui = await mountTrends(t);
  await ui.push(10, 20);
  await ui.push(70, 80);
  await ui.tick(80);
  await ui.reduced(true);
  assertStopped(ui);
  await ui.push(20, 30);
  assertStopped(ui);
  await ui.reduced(false);
  await ui.push(80, 90);
  assert.ok(ui.frames.size > 0);
  await ui.hidden(true);
  assertStopped(ui);
  await ui.push(30, 40);
  assertStopped(ui);
  await ui.hidden(false);
  await ui.push(60, 70);
  assert.ok(ui.frames.size > 0);
  await ui.visible(false);
  assertStopped(ui);
  await ui.push(40, 50);
  assertStopped(ui);
  await ui.visible(true);
  await ui.push(50, 60);
  assert.ok(ui.frames.size > 0, '重新可见后新的采样恢复短暂过渡');
  await ui.tick(500);
  assertStopped(ui);
});

test('中断、缺失和长间隔仍断开曲线，进程重启清除旧线，卸载取消所有动画', async t => {
  const ui = await mountTrends(t);
  await ui.push(10, 20);
  await ui.push(50, 40);
  await ui.tick(80);
  await ui.interrupt();
  await ui.push(60, 50);
  assert.deepEqual(lines(ui).map(line => line.length), [2], '恢复首次读数不得跨中断连接旧段');
  assert.equal(figure(ui).dataset.validSamples, '3');
  assert.equal(ui.container.querySelectorAll('circle').length, 0);
  await ui.push(70, null);
  assert.deepEqual(lines(ui).map(line => line.length), [2, 2]);
  assert.deepEqual(lines(ui, 'memory').map(line => line.length), [2], '内存缺失不能借 CPU 的连续值绘制曲线');
  assert.equal(figure(ui, 'memory').querySelector('.home-runtime-trend-current').textContent, '—');
  await ui.push(20, 25, { delta: 11000 });
  assert.deepEqual(lines(ui).map(line => line.length), [2, 2], '超过十秒的间隔开始新段');
  await ui.push(30, 35);
  assert.deepEqual(lines(ui).map(line => line.length), [2, 2, 2]);
  assert.deepEqual(lines(ui, 'memory').map(line => line.length), [2, 2]);
  await ui.push(40, 45, { pid: 200, uptime: 0 });
  assert.equal(ui.container.querySelector('.home-runtime-trends').dataset.sampleCount, '1');
  assert.equal(lines(ui).length, 0, '不能把新进程连接到旧进程趋势');
  assertStopped(ui);
  await ui.push(50, 55, { pid: 200, uptime: 3 });
  assert.ok(ui.frames.size > 0);
  await ui.close();
  assert.equal(ui.frames.size, 0, '卸载后不得留下动画回调');
  assert.ok(ui.observers.every(observer => !observer.active), '卸载时清理离屏观察器');
});
