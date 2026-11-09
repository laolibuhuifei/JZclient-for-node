'use strict';
// 小红书登录：打开站点 -> 取登录二维码 -> 轮询登录态
//
// 这个服务不破解签名，只做「有头有脸的浏览器自动化」：
// 站点自己会签名，我们只负责把二维码递出去、把登录态存下来。
const fs = require('fs');
const path = require('path');
const { withPage, getContext, DATA } = require('./browser');

const HOME = 'https://www.xiaohongshu.com/explore';
const COOKIE_NAMES = ['web_session', 'webId', 'a1', 'gid', 'customerClientId'];

function qrFile() { return path.join(DATA, 'last-qr.png'); }

function readCookies(cookies) {
  const out = {};
  for (const c of cookies || []) {
    if (COOKIE_NAMES.indexOf(c.name) >= 0 && !out[c.name]) out[c.name] = c.value;
  }
  return out;
}

async function pageState(page) {
  return page.evaluate(() => {
    const st = window.__INITIAL_STATE__ || {};
    const u = (st.user && (st.user.userPageData || st.user)) || {};
    const info = u.basicInfo || u.userInfo || {};
    return {
      url: location.href,
      title: document.title,
      loggedIn: !!(u.loggedIn || info.userId || (st.user && st.user.loggedIn)),
      nickname: info.nickname || info.nickName || '',
      userId: info.userId || '',
      avatar: info.image || info.avatar || '',
      loginPage: /\/login/.test(location.pathname),
    };
  }).catch(() => ({ url: page.url(), loggedIn: false, loginPage: /\/login/.test(page.url()) }));
}

// 打开站点。未登录会被重定向到 /login，已登录则停在 /explore。
async function open() {
  return withPage(async (page) => {
    if (!page.url().startsWith('http')) {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await page.waitForTimeout(1500);
    const st = await pageState(page);
    const loginPage = /\/login/.test(page.url());
    return Object.assign({ domain: new URL(page.url()).host }, st, {
      loggedIn: !loginPage && !!st.userId, loginPage,
    });
  });
}

// 取二维码。force=true 时强制重新打开登录页，拿一张新的（否则会读回同一张，已过期也不变）
async function qr(force) {
  return withPage(async (page) => {
    if (force) {
      await page.goto('https://www.xiaohongshu.com/login?t=' + Date.now(), {
        waitUntil: 'domcontentloaded', timeout: 45000,
      });
      await page.waitForTimeout(2500);
    }
    if (!/\/login/.test(page.url())) {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
    }
    if (!/\/login/.test(page.url())) {
      const st = await pageState(page);
      if (st.loggedIn) return { loggedIn: true, image: '', at: Date.now() };
      // 不是登录页也没登录态：强制去登录页
      await page.goto('https://www.xiaohongshu.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
    }
    const img = page.locator('img.qrcode-img').first();
    await img.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    let src = '';
    try { src = await img.getAttribute('src', { timeout: 5000 }) || ''; } catch (e) { src = ''; }
    if (src.startsWith('data:image/')) {
      const b64 = src.split(',')[1] || '';
      try { fs.writeFileSync(qrFile(), Buffer.from(b64, 'base64')); } catch (e) { /* ignore */ }
      return { loggedIn: false, image: src, at: Date.now() };
    }
    // 不是 data URL（可能是 <canvas> 或懒加载失败），退化成元素截图
    try {
      const buf = await img.screenshot({ type: 'png' });
      fs.writeFileSync(qrFile(), buf);
      return { loggedIn: false, image: 'data:image/png;base64,' + buf.toString('base64'), at: Date.now() };
    } catch (e) {
      throw new Error('页面上没找到登录二维码，可能是网络慢或风控页');
    }
  });
}

// 登录态：Cookie + 页面状态双判定
async function status() {
  const ctx = await getContext();
  const page = await withPage(async (p) => p);
  const cookies = readCookies(await ctx.cookies());
  const st = await pageState(page);
  // 登录页上的 web_session 是游客态，不能当成已登录；以「离开 /login」为准
  const loginPage = /\/login/.test(page.url());
  const loggedIn = !loginPage && !!(cookies.web_session && cookies.web_session.length > 8);
  return {
    loggedIn,
    domain: (() => { try { return new URL(page.url()).host; } catch (e) { return ''; } })(),
    url: page.url(),
    hasSession: !!cookies.web_session,
    user: { nickname: st.nickname || '', userId: st.userId || '', avatar: st.avatar || '' },
    at: Date.now(),
  };
}

async function logout() {
  const ctx = await getContext();
  await ctx.clearCookies();
  return { loggedIn: false };
}

module.exports = { open, qr, status, logout, pageState, HOME };
