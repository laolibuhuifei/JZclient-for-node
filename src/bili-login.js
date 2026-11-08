// B 站扫码登录
//
// 只做一件小事：拿到 B 站账号的登录 Cookie（SESSDATA / bili_jct / DedeUserID），
// 存进本地配置，之后搜索、取播放地址、抓评论都带上它。
//
// 为什么用扫码而不是账号密码：B 站密码登录会弹极验验证码，服务端没法过。
// 扫码走的是 passport 的 web 接口，全程不需要第三方依赖：
//   1. GET  /x/passport-login/web/qrcode/generate  拿到 qrcode_key 和二维码内容
//   2. 把内容画成 PNG 给前端展示
//   3. GET  /x/passport-login/web/qrcode/poll      轮询扫码状态
//   4. code=0 时响应头里的 Set-Cookie 就是登录态
'use strict';

const log = require('./logger');
const png = require('./png');
const device = require('./device');
const qrcode = require('./vendor/qrcode');

const PASSPORT = 'https://passport.bilibili.com';
const API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

// ---------- 本地缓存 ----------
// bilibili.js / bili-comment.js 每发一个请求都要 Cookie，不能每次都读一遍配置文件。
// 登录、退出、启动时都会调 reload()，其余时候读内存。
let cache = { loaded: false, account: null };

function reload() {
  let cfg = null;
  try { cfg = device.load(); } catch (e) { cfg = null; }
  cache.account = (cfg && cfg.biliAccount) || null;
  cache.loaded = true;
  return cache.account;
}

function account() {
  if (!cache.loaded) reload();
  return cache.account;
}

function isLoggedIn() {
  const a = account();
  return !!(a && a.sessdata);
}

// 拼成可直接放进请求头的 Cookie 串。buvid 由 bilibili.js 自己补。
function accountCookie() {
  const a = account();
  if (!a || !a.sessdata) return '';
  const parts = ['SESSDATA=' + a.sessdata];
  if (a.biliJct) parts.push('bili_jct=' + a.biliJct);
  if (a.dedeUserId) parts.push('DedeUserID=' + a.dedeUserId);
  if (a.dedeUserIdCkMd5) parts.push('DedeUserID__ckMd5=' + a.dedeUserIdCkMd5);
  if (a.sid) parts.push('sid=' + a.sid);
  return parts.join('; ');
}

// ---------- 网络 ----------

async function request(path, opts) {
  const o = opts || {};
  const r = await fetch(path, {
    method: o.method || 'GET',
    headers: Object.assign({
      'User-Agent': UA,
      Referer: REFERER,
      Origin: 'https://www.bilibili.com',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'application/json, text/plain, */*',
    }, o.headers || {}),
    signal: AbortSignal.timeout(o.timeout || 10000),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error('B 站返回的不是 JSON（HTTP ' + r.status + '）：' + text.slice(0, 120));
  }
  return { json, headers: r.headers, status: r.status };
}

// ---------- 二维码 ----------

// 把二维码内容画成 PNG。scale 是每个小方块的像素数，margin 是静区（规范要求至少 4 格）。
// 返回 data:image/png;base64,... 直接塞进 <img src> 就行。
function renderQr(text, opts) {
  const o = opts || {};
  const scale = Math.max(2, Math.min(16, Number(o.scale) || 8));
  const margin = Math.max(0, Math.min(16, o.margin == null ? 4 : Number(o.margin)));
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + margin * 2) * scale;
  const rgba = Buffer.alloc(size * size * 4, 255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin;
      const my = Math.floor(y / scale) - margin;
      const dark = mx >= 0 && my >= 0 && mx < count && my < count && qr.isDark(my, mx);
      const i = (y * size + x) * 4;
      const v = dark ? 0 : 255;
      rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
  }
  return 'data:image/png;base64,' + png.encodePNG(size, size, rgba).toString('base64');
}

// 登录中的二维码只活几分钟，顺手清掉，不然一直开着页面会攒一堆
const qrCache = new Map();
function sweepQr() {
  const now = Date.now();
  for (const [k, v] of qrCache) {
    if (now - v.at > 5 * 60e3) qrCache.delete(k);
  }
}

async function createQr() {
  sweepQr();
  const { json } = await request(PASSPORT + '/x/passport-login/web/qrcode/generate?source=main-fe-header');
  if (!json || json.code !== 0 || !json.data) {
    throw new Error('生成二维码失败：' + (json && (json.message || json.code) || '无响应'));
  }
  const key = String(json.data.qrcode_key || '');
  const url = String(json.data.url || '');
  if (!key || !url) throw new Error('B 站没有返回二维码内容');
  qrCache.set(key, { at: Date.now(), url });
  log.info('bili', '已生成登录二维码');
  return { key, url, image: renderQr(url), expiresIn: 180 };
}

// ---------- Cookie 解析 ----------

const COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

function parseSetCookie(list) {
  const out = {};
  for (const line of list || []) {
    const m = /^([^=]+)=([^;]*)/.exec(String(line));
    if (!m) continue;
    const name = m[1].trim();
    if (COOKIE_KEYS.indexOf(name) < 0) continue;
    let val = m[2];
    try { val = decodeURIComponent(val); } catch (e) { /* 原样保留 */ }
    out[name] = val;
  }
  return out;
}

async function fetchProfile(cookie) {
  try {
    const { json } = await request(API + '/x/web-interface/nav', { headers: { Cookie: cookie } });
    const d = (json && json.data) || {};
    if (json && json.code === 0 && d.isLogin) {
      return {
        uname: String(d.uname || ''),
        mid: String(d.mid || ''),
        face: String(d.face || ''),
        vip: !!(d.vipStatus || (d.vip && d.vip.status)),
        level: Number(d.level_info && d.level_info.current_level) || 0,
      };
    }
  } catch (e) {
    log.debug('bili', '读取账号信息失败: ' + e.message);
  }
  return null;
}

function saveAccount(data) {
  const cfg = device.load();
  cfg.biliAccount = data;
  device.save(cfg);
  cache.account = data;
  cache.loaded = true;
}

// ---------- 轮询 ----------

async function pollQr(key) {
  const k = String(key || '').trim();
  if (!k) throw new Error('缺少 qrcode_key');
  const { json, headers } = await request(
    PASSPORT + '/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(k)
    + '&source=main-fe-header',
  );
  const d = (json && json.data) || {};
  const code = Number(d.code);

  if (json && json.code === 0 && code === 0) {
    const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    const c = parseSetCookie(setCookies);
    if (!c.SESSDATA) {
      // 少数节点会把 Cookie 放在 data.url 的 query 里
      try {
        const u = new URL(String(d.url || ''));
        COOKIE_KEYS.forEach((name) => {
          const v = u.searchParams.get(name);
          if (v && !c[name]) c[name] = v;
        });
      } catch (e) { /* ignore */ }
    }
    if (!c.SESSDATA) throw new Error('扫码成功但没拿到 SESSDATA，请重试');

    const cookie = accountCookieFrom(c);
    const profile = await fetchProfile(cookie);
    const acc = {
      sessdata: c.SESSDATA,
      biliJct: c.bili_jct || '',
      dedeUserId: c.DedeUserID || '',
      dedeUserIdCkMd5: c.DedeUserID__ckMd5 || '',
      sid: c.sid || '',
      refreshToken: String(d.refresh_token || ''),
      uname: (profile && profile.uname) || '',
      mid: (profile && profile.mid) || '',
      face: (profile && profile.face) || '',
      vip: !!(profile && profile.vip),
      level: (profile && profile.level) || 0,
      at: Date.now(),
    };
    saveAccount(acc);
    qrCache.delete(k);
    log.info('bili', 'B 站账号已登录' + (acc.uname ? '：' + acc.uname : ''));
    return { state: 'ok', account: publicAccount(acc) };
  }

  if (code === 86090) return { state: 'scanned', message: '已扫码，请在手机上确认' };
  if (code === 86038) {
    qrCache.delete(k);
    return { state: 'expired', message: '二维码已失效，请重新生成' };
  }
  if (json && json.code !== 0) {
    return { state: 'error', message: String(json.message || ('接口返回 ' + json.code)) };
  }
  return { state: 'pending', message: '等待扫码' };
}

function accountCookieFrom(c) {
  const parts = ['SESSDATA=' + c.SESSDATA];
  if (c.bili_jct) parts.push('bili_jct=' + c.bili_jct);
  if (c.DedeUserID) parts.push('DedeUserID=' + c.DedeUserID);
  if (c.DedeUserID__ckMd5) parts.push('DedeUserID__ckMd5=' + c.DedeUserID__ckMd5);
  if (c.sid) parts.push('sid=' + c.sid);
  return parts.join('; ');
}

// ---------- 状态 / 退出 ----------

function publicAccount(a) {
  if (!a) return null;
  return {
    uname: a.uname || '',
    mid: a.mid || '',
    face: a.face || '',
    vip: !!a.vip,
    level: a.level || 0,
    at: a.at || 0,
  };
}

// 校验本地 Cookie 还有没有效。B 站不会主动通知失效，只能问 nav。
async function status() {
  const a = account();
  if (!a || !a.sessdata) return { loggedIn: false, account: null };
  const cookie = accountCookie();
  const profile = await fetchProfile(cookie);
  if (!profile) {
    return { loggedIn: false, account: publicAccount(a), expired: true };
  }
  // 昵称/头像可能改过，顺手更新
  if (profile.uname !== a.uname || profile.face !== a.face) {
    const next = Object.assign({}, a, {
      uname: profile.uname || a.uname,
      face: profile.face || a.face,
      mid: profile.mid || a.mid,
      level: profile.level || a.level,
      vip: profile.vip,
    });
    try { saveAccount(next); } catch (e) { /* 存不下也不影响这次返回 */ }
  }
  return { loggedIn: true, account: publicAccount(Object.assign({}, a, profile)) };
}

function logout() {
  const cfg = device.load();
  delete cfg.biliAccount;
  device.save(cfg);
  cache.account = null;
  cache.loaded = true;
  log.info('bili', 'B 站账号已退出');
  return { loggedIn: false, account: null };
}

// 手动填入 SESSDATA 的兜底口子（扫码坏掉时还能用）
async function loginWithSessdata(sessdata) {
  const sd = String(sessdata || '').trim();
  if (!sd) throw new Error('SESSDATA 不能为空');
  const cookie = 'SESSDATA=' + sd;
  const profile = await fetchProfile(cookie);
  if (!profile) throw new Error('这个 SESSDATA 无效或已过期');
  const acc = {
    sessdata: sd,
    biliJct: '',
    dedeUserId: profile.mid || '',
    dedeUserIdCkMd5: '',
    sid: '',
    refreshToken: '',
    uname: profile.uname || '',
    mid: profile.mid || '',
    face: profile.face || '',
    vip: !!profile.vip,
    level: profile.level || 0,
    at: Date.now(),
  };
  saveAccount(acc);
  log.info('bili', 'B 站账号已登录（手动 SESSDATA）' + (acc.uname ? '：' + acc.uname : ''));
  return { state: 'ok', account: publicAccount(acc) };
}

module.exports = {
  reload,
  isLoggedIn,
  account,
  accountCookie,
  publicAccount,
  createQr,
  pollQr,
  status,
  logout,
  loginWithSessdata,
  renderQr,
};
