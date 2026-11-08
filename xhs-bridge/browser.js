'use strict';
// 浏览器单例：常驻一个持久化上下文，登录态存在 data/profile 里。
// 所有页面操作都在这里排队，避免同一个 context 被并发写坏。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const DATA = path.join(__dirname, 'data');
const PROFILE = path.join(DATA, 'profile');

let ctx = null;
let launching = null;
let queue = Promise.resolve();

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function getContext() {
  if (ctx) return ctx;
  if (launching) return launching;
  launching = (async () => {
    fs.mkdirSync(PROFILE, { recursive: true });
    ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        // 这台机器内存不宽裕：限制渲染进程和 V8 堆，别把现有服务挤掉
        '--renderer-process-limit=1', '--disable-extensions',
        '--js-flags=--max-old-space-size=256',
      ],
    });
    ctx.on('close', () => { ctx = null; });
    return ctx;
  })();
  try { return await launching; } finally { launching = null; }
}

// 拿一个可用的页面（复用第一个空白页，别每次开新的）
async function getPage() {
  const c = await getContext();
  const pages = c.pages();
  const page = pages.find((p) => !p.isClosed()) || await c.newPage();
  return page;
}

// 所有需要操作页面的动作都走这里：串行执行
function withPage(fn) {
  return enqueue(async () => {
    const page = await getPage();
    return fn(page);
  });
}

async function close() {
  if (ctx) { const c = ctx; ctx = null; await c.close().catch(() => {}); }
}

function isRunning() { return !!ctx; }

module.exports = { getContext, getPage, withPage, close, isRunning, DATA, PROFILE };
