'use strict';
// 登录后的内容接口：搜索笔记、解析单条笔记的视频直链。
// 不做签名，全部靠页面自己的请求 + 已登录 Cookie。
const { withPage } = require('./browser');

const SEARCH = 'https://www.xiaohongshu.com/search_result?keyword=';

// 关掉登录弹窗：小红书会把结果压在半透明弹窗下面，关掉后 DOM 才稳定
async function dismiss(page) {
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')]
      .filter((e) => String(e.className || '').toLowerCase().includes('close'));
    for (const e of els) { try { e.click(); } catch (x) { /* ignore */ } }
  }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function search(keyword, limit) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('缺少关键词');
  const n = Math.max(1, Math.min(20, Number(limit) || 10));
  return withPage(async (page) => {
    await page.goto(SEARCH + encodeURIComponent(kw) + '&type=51', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    await dismiss(page);
    const items = await page.evaluate((max) => {
      const out = [];
      const cards = document.querySelectorAll('section.note-item, .note-item, [class*="note-item"]');
      cards.forEach((c) => {
        const a = c.querySelector('a[href*="/explore/"],a[href*="/discovery/item/"]');
        if (!a) return;
        const title = (c.querySelector('.title, [class*="title"]') || {}).innerText || '';
        const author = (c.querySelector('.author, [class*="author"]') || {}).innerText || '';
        const img = c.querySelector('img');
        const hasVideo = !!c.querySelector('[class*="play"], svg[class*="play"], [class*="video"]');
        // 详情页必须带 xsec_token，新版搜索把 token 放在卡片属性/内联数据里
        const html = c.outerHTML || '';
        const tm = html.match(/xsec_token=([A-Za-z0-9_\-=]+)/)
          || html.match(/"xsec_?[Tt]oken"\s*:\s*"([^"]+)"/);
        out.push({
          href: a.getAttribute('href'),
          token: tm ? tm[1] : '',
          title: String(title).trim().slice(0, 60),
          author: String(author).trim().slice(0, 30),
          cover: img ? (img.currentSrc || img.src) : '',
          video: hasVideo,
        });
      });
      return out;
    }, n);
    const limited = items.slice(0, n);
    if (!limited.length) {
      return { keyword: kw, items: [], needsLogin: /\/login/.test(page.url()), url: page.url() };
    }
    return { keyword: kw, items: limited, url: page.url() };
  });
}

async function note(url, xsecToken) {
  let u = String(url || '').trim();
  if (!u) throw new Error('缺少笔记链接');
  u = new URL(u, 'https://www.xiaohongshu.com').toString();
  // 详情页不带 xsec_token 会 404；搜索阶段抓到的 token 在这里补上
  if (xsecToken && !/[?&]xsec_token=/.test(u)) {
    u += (u.indexOf('?') >= 0 ? '&' : '?') + 'xsec_token=' + encodeURIComponent(xsecToken)
      + '&xsec_source=pc_search';
  }
  return withPage(async (page) => {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    await dismiss(page);
    // 权限/风控错误页：/website-login/error?error_code=300031&error_msg=...
    const errUrl = page.url();
    if (/website-login\/error/i.test(errUrl)) {
      let msg = '当前笔记暂时无法浏览';
      try {
        const u = new URL(errUrl);
        msg = u.searchParams.get('error_msg') || msg;
        const code = u.searchParams.get('error_code') || '';
        throw new Error(msg + (code ? '（' + code + '）' : ''));
      } catch (e) {
        if (e && /无法浏览/.test(e.message)) throw e;
        throw new Error(msg);
      }
    }
    const info = await page.evaluate(() => {
      const s = window.__INITIAL_STATE__ || {};
      const map = (s.note && s.note.noteDetailMap) || {};
      const key = Object.keys(map)[0] || '';
      const n = key ? (map[key].note || {}) : {};
      const v = n.video || {};
      const stream = (v.media && v.media.stream) || {};
      const pick = (stream.h264 && stream.h264[0]) || (stream.h265 && stream.h265[0]) || (stream.av1 && stream.av1[0]) || {};
      const domVideo = document.querySelector('video');
      return {
        id: key,
        title: n.title || '',
        desc: n.desc || '',
        type: n.type || '',
        author: (n.user && n.user.nickname) || '',
        cover: (n.imageList && n.imageList[0] && n.imageList[0].urlDefault) || '',
        images: (n.imageList || []).map((im) => (im && (im.urlDefault || im.urlPre || im.url)) || '').filter(Boolean),
        isVideo: !!(v.media && v.media.stream),
        duration: (v.capa && v.capa.duration) || 0,
        videoUrl: pick.masterUrl || (domVideo ? (domVideo.currentSrc || domVideo.src) : '') || '',
        url: location.href,
        domTitle: document.title || '',
        domDesc: (document.querySelector('meta[name="description"]') || {}).content || '',
        domImages: [...document.querySelectorAll('img')]
          .map((i) => i.currentSrc || i.src)
          .filter((u) => u && /xhscdn\.com/.test(u)).slice(0, 9),
      };
    });
    if (!info.images.length && info.domImages.length) {
      info.images = info.domImages;
      info.title = info.title || info.domTitle.replace(/\s*-\s*小红书.*$/, '');
      info.desc = info.desc || info.domDesc;
    }
    return Object.assign({ needsLogin: /\/login/.test(page.url()) }, info);
  });
}


// 从搜索结果里真实点击第 idx 条：让站点自己带上 xsec_token 跳转。
// 直接拼 URL 的 token 会被判 404，只有点击链路的 token 有效。
async function noteByClick(keyword, idx) {
  const kw = String(keyword || '').trim();
  const n = Math.max(1, Math.min(10, Number(idx) || 1));
  if (!kw) throw new Error('缺少关键词');
  return withPage(async (page) => {
    await page.goto(SEARCH + encodeURIComponent(kw) + '&type=51', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    await dismiss(page);
    // 点卡片本体：XHS 搜索是「侧边弹层」，不会跳页，所以不能等 navigation
    const cards = page.locator('section.note-item, .note-item');
    const count = await cards.count();
    if (count < n) throw new Error('搜索结果里没有第 ' + n + ' 条');
    await cards.nth(n - 1).click({ timeout: 10000 }).catch(async () => {
      const a = page.locator('a[href*="/explore/"]').nth(n - 1);
      if (await a.count()) await a.click({ timeout: 8000 }).catch(() => {});
    });
    await page.waitForTimeout(4500);

    const errUrl = page.url();
    if (/website-login\/error/i.test(errUrl)) {
      let msg = '当前笔记暂时无法浏览';
      try {
        const u = new URL(errUrl);
        msg = u.searchParams.get('error_msg') || msg;
      } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const info = await page.evaluate(() => {
      const s = window.__INITIAL_STATE__ || {};
      const map = (s.note && s.note.noteDetailMap) || {};
      const m = location.pathname.match(/\/explore\/([0-9a-f]+)/i);
      const want = m ? m[1] : '';
      const key = (want && map[want]) ? want : (Object.keys(map)[0] || '');
      const note = key ? (map[key].note || {}) : {};
      const v = note.video || {};
      const stream = (v.media && v.media.stream) || {};
      const pick = (stream.h264 && stream.h264[0]) || (stream.h265 && stream.h265[0]) || {};
      const domVideo = document.querySelector('video');
      return {
        id: key,
        title: note.title || '',
        desc: note.desc || '',
        author: (note.user && note.user.nickname) || '',
        duration: (v.capa && v.capa.duration) || 0,
        videoUrl: pick.masterUrl || (domVideo ? (domVideo.currentSrc || domVideo.src) : '') || '',
        images: (note.imageList || []).map((im) => (im && (im.urlDefault || im.urlPre)) || '').filter(Boolean),
        url: location.href,
      };
    });
    if (!info.images.length && !info.videoUrl) {
      throw new Error('详情页没有内容（可能需要登录或笔记受限）');
    }
    return info;
  });
}

module.exports = { search, note, noteByClick };
