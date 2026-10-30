// B 站视频搜索 + 下载（微聊点播机器人的底层）
//
// 为什么自己实现而不用 yt-dlp：本项目零第三方依赖，只用 node 内置模块 + ffmpeg。
//
// 用到这几个 B 站接口：
//   /x/frontend/finger/spi            拿 buvid3/buvid4。没有它搜索会 -412 风控
//   /x/web-interface/search/type      搜视频（老接口，一般够用）
//   /x/web-interface/wbi/search/type  老接口被风控时回退到这个，要 wbi 签名
//   /x/web-interface/nav              拿 wbi 签名用的 img_key / sub_key
//   /x/player/pagelist                拿 cid（播放地址要用）
//   /x/player/playurl?fnval=1         拿 durl（单文件 mp4，不用再合并音视频轨）
//
// 两个坑：
//   1. 下载直链必须带 Referer: https://www.bilibili.com/，否则 403
//   2. 直链带签名和过期时间，拿到就要马上用，不能缓存
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const log = require('./logger');

const API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

// 清晰度代号 → 给人看的名字（未登录一般只能拿到 360P/480P）
const QN_NAME = {
  16: '360P', 32: '480P', 64: '720P', 74: '720P60', 80: '1080P',
  112: '1080P+', 116: '1080P60', 120: '4K', 125: 'HDR', 127: '8K',
};

// ---------- HTTP ----------

function abortAfter(ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

async function httpJson(url, opts) {
  const o = opts || {};
  const a = abortAfter(o.timeout || 15000);
  try {
    const r = await fetch(url, {
      signal: a.signal,
      redirect: 'follow',
      headers: Object.assign({
        'User-Agent': UA,
        Referer: REFERER,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      }, o.headers || {}),
    });
    const text = await r.text();
    if (!text) throw new Error('B 站返回空响应（HTTP ' + r.status + '）');
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('B 站返回的不是 JSON（HTTP ' + r.status + '）：' + text.slice(0, 100));
    }
  } finally {
    a.done();
  }
}

// ---------- buvid（防风控） ----------

let cookieCache = { at: 0, cookie: '' };

// buvid3/buvid4 是 B 站给匿名访客发的设备指纹，不带的话搜索接口直接 -412
async function getCookie(force) {
  if (!force && cookieCache.cookie && Date.now() - cookieCache.at < 3600e3) return cookieCache.cookie;
  try {
    const r = await httpJson(API + '/x/frontend/finger/spi');
    const d = (r && r.data) || {};
    if (d.b_3) {
      cookieCache = {
        at: Date.now(),
        cookie: 'buvid3=' + d.b_3 + (d.b_4 ? '; buvid4=' + d.b_4 : ''),
      };
      log.debug('bili', '已获取 buvid');
    }
  } catch (e) {
    log.debug('bili', '取 buvid 失败: ' + e.message);
  }
  return cookieCache.cookie || '';
}

// ---------- wbi 签名 ----------
// B 站把 img_key 和 sub_key 按固定表打乱后取前 32 位当密钥，
// 参数按 key 排序拼成 query，再接密钥算 md5，结果作为 w_rid 回传。

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

let wbiCache = { at: 0, key: '' };

async function getMixinKey(force) {
  if (!force && wbiCache.key && Date.now() - wbiCache.at < 3600e3) return wbiCache.key;
  const r = await httpJson(API + '/x/web-interface/nav', { headers: { Cookie: await getCookie() } });
  const w = (r && r.data && r.data.wbi_img) || {};
  const pick = (u) => String(u || '').split('/').pop().split('.')[0];
  const raw = pick(w.img_url) + pick(w.sub_url);
  if (raw.length < 64) return '';
  const key = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
  wbiCache = { at: Date.now(), key };
  return key;
}

function wbiSign(params, mixinKey) {
  const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const q = Object.keys(p).sort().map((k) => {
    // B 站要求先去掉 !'()* 再 urlencode
    const v = String(p[k]).replace(/[!'()*]/g, '');
    return encodeURIComponent(k) + '=' + encodeURIComponent(v);
  }).join('&');
  const rid = crypto.createHash('md5').update(q + mixinKey).digest('hex');
  return q + '&w_rid=' + rid;
}

// ---------- 搜索 ----------

// 搜索结果的标题带 <em class="keyword">高亮标签和 HTML 实体，得洗干净
function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// "12:34" / "1:02:03" / 754 都转成秒
function parseDuration(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((a, b) => a * 60 + b, 0);
}

function fmtDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
}

async function search(keyword, opts) {
  const o = opts || {};
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('搜索关键词为空');
  if (kw.length > 50) throw new Error('搜索关键词太长（最多 50 个字）');
  const limit = Math.max(1, Math.min(Number(o.limit) || 10, 10));
  const cookie = await getCookie();

  // 先走老接口（简单、稳），被风控再走 wbi 签名版
  let data = null;
  try {
    const r = await httpJson(
      API + '/x/web-interface/search/type?search_type=video&page=1&keyword=' + encodeURIComponent(kw),
      { headers: { Cookie: cookie } }
    );
    if (r && r.code === 0) data = r.data;
    else if (r) log.debug('bili', `老搜索接口返回 code=${r.code} ${r.message || ''}`);
  } catch (e) {
    log.debug('bili', '老搜索接口异常: ' + e.message);
  }

  if (!data) {
    const mk = await getMixinKey();
    if (!mk) throw new Error('B 站风控了（拿不到签名密钥），过一会儿再试');
    const qs = wbiSign({ search_type: 'video', keyword: kw, page: 1 }, mk);
    const r = await httpJson(API + '/x/web-interface/wbi/search/type?' + qs, { headers: { Cookie: cookie } });
    if (!r || r.code !== 0) {
      const why = r ? (r.message || ('code=' + r.code)) : '无响应';
      throw new Error('B 站搜索失败：' + why);
    }
    data = r.data;
  }

  const list = (data && data.result) || [];
  const out = [];
  for (const it of list) {
    if (out.length >= limit) break;
    if (!it || !it.bvid) continue;          // 有些条目是番剧/课程，没有 bvid
    out.push({
      index: out.length + 1,
      bvid: String(it.bvid),
      title: cleanText(it.title) || '(无标题)',
      author: cleanText(it.author),
      duration: parseDuration(it.duration),
      play: Number(it.play) || 0,
      pubdate: Number(it.pubdate) || 0,
    });
  }
  if (!out.length) throw new Error('没搜到视频：' + kw);
  return out;
}

// ---------- 播放地址 ----------

async function getPages(bvid) {
  const cookie = await getCookie();
  const r = await httpJson(API + '/x/player/pagelist?bvid=' + encodeURIComponent(bvid), {
    headers: { Cookie: cookie },
  });
  if (!r || r.code !== 0) {
    throw new Error('取分 P 失败：' + (r ? (r.message || ('code=' + r.code)) : '无响应'));
  }
  const d = r.data || [];
  if (!d.length) throw new Error('这个视频没有可播放的分 P');
  return d;
}

// fnval=1 → 返回 durl（已经是音视频合一的 mp4），不需要 ffmpeg 再拼
// qn=32 是 480P，未登录通常能拿到；拿不到会自动降级
async function getPlayUrl(bvid, cid) {
  const cookie = await getCookie();
  const qs = 'bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid)
    + '&qn=32&fnval=1&fnver=0&fourk=0&platform=html5&high_quality=1';
  const r = await httpJson(API + '/x/player/playurl?' + qs, { headers: { Cookie: cookie } });
  if (!r || r.code !== 0) {
    throw new Error('取播放地址失败：' + (r ? (r.message || ('code=' + r.code)) : '无响应'));
  }
  const d = r.data || {};
  const parts = Array.isArray(d.durl) ? d.durl.filter((x) => x && x.url) : [];
  if (!parts.length) {
    throw new Error('这个视频拿不到直链（可能是大会员 / 付费 / 地区限制内容）');
  }
  return {
    parts: parts.map((x) => ({ url: String(x.url), size: Number(x.size) || 0 })),
    quality: QN_NAME[d.quality] || ('qn' + d.quality),
  };
}

// ---------- 下载 ----------

function tmpPath(ext) {
  return path.join(os.tmpdir(), 'bili_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + (ext || '.mp4'));
}

function mb(n) {
  return Math.round((Number(n) || 0) / 1024 / 1024 * 10) / 10;
}

async function fetchToFile(url, file, opts) {
  const o = opts || {};
  const a = abortAfter(o.timeout || 240000);
  try {
    const r = await fetch(url, {
      signal: a.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        // 少了这个 B 站 CDN 直接 403
        Referer: o.referer || REFERER,
        Origin: 'https://www.bilibili.com',
      },
    });
    if (!r.ok) throw new Error('下载失败（HTTP ' + r.status + '）');
    const total = Number(r.headers.get('content-length') || 0);
    if (o.maxBytes && total > o.maxBytes) {
      throw new Error('视频 ' + mb(total) + 'MB，超过上限 ' + mb(o.maxBytes) + 'MB');
    }
    const fd = fs.openSync(file, 'w');
    let got = 0;
    try {
      // 边下边计数：Content-Length 有时是空的，不能只靠它判断大小
      for await (const chunk of r.body) {
        got += chunk.length;
        if (o.maxBytes && got > o.maxBytes) {
          throw new Error('视频超过上限 ' + mb(o.maxBytes) + 'MB，已中止下载');
        }
        fs.writeSync(fd, chunk);
      }
    } finally {
      fs.closeSync(fd);
    }
    if (!got) throw new Error('下载到的文件是空的');
    return got;
  } finally {
    a.done();
  }
}

// 多分片（长视频会被切成几段 mp4）用 ffmpeg 拼起来
function concatParts(files, out) {
  const list = out + '.txt';
  fs.writeFileSync(list, files.map((f) => "file '" + String(f).replace(/'/g, "'\\''") + "'").join('\n'));
  try {
    const r = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out,
    ], { timeout: 300000 });
    if (r.status !== 0 || !fs.existsSync(out)) {
      throw new Error('合并分片失败（需要 ffmpeg）：' + String(r.stderr || '').slice(0, 120));
    }
  } finally {
    try { fs.unlinkSync(list); } catch (e) { /* ignore */ }
  }
}

// 下载一个视频，返回 { file, size, duration, quality, title, page }
// 调用方负责删 file
async function downloadVideo(item, opts) {
  const o = opts || {};
  const bvid = String((item && item.bvid) || '');
  if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) throw new Error('视频编号不对：' + bvid);
  const maxDuration = Math.max(0, Number(o.maxDuration) || 0);
  const maxBytes = Math.max(0, Number(o.maxBytes) || 0);

  const pages = await getPages(bvid);
  const page = pages[0];
  const duration = Number(page.duration) || Number(item.duration) || 0;
  if (maxDuration && duration > maxDuration) {
    throw new Error('视频 ' + fmtDuration(duration) + '，超过时长上限 ' + fmtDuration(maxDuration));
  }

  const play = await getPlayUrl(bvid, page.cid);
  const totalSize = play.parts.reduce((a, x) => a + x.size, 0);
  if (maxBytes && totalSize && totalSize > maxBytes) {
    throw new Error('视频 ' + mb(totalSize) + 'MB，超过大小上限 ' + mb(maxBytes) + 'MB');
  }

  const referer = 'https://www.bilibili.com/video/' + bvid;
  const files = [];
  const outs = [];
  try {
    for (let i = 0; i < play.parts.length; i++) {
      const f = tmpPath('.mp4');
      outs.push(f);
      await fetchToFile(play.parts[i].url, f, { maxBytes, referer });
      files.push(f);
    }
    let file = files[0];
    let size = fs.statSync(file).size;
    if (files.length > 1) {
      file = tmpPath('.mp4');
      outs.push(file);
      concatParts(files, file);
      // 分片已经拼进成片了, 原始分片必须删掉: cleanup() 只认最终那个文件,
      // 长视频会在临时目录里留下几份等大的残片, 攒几次就把磁盘塞满
      for (const f of files) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
      size = fs.statSync(file).size;
      if (maxBytes && size > maxBytes) {
        throw new Error('合并后 ' + mb(size) + 'MB，超过大小上限 ' + mb(maxBytes) + 'MB');
      }
    }
    return {
      file,
      size,
      duration,
      quality: play.quality,
      title: cleanText(page.part && pages.length > 1 ? item.title + ' - ' + page.part : (item.title || '')),
      page: pages.length,
      parts: play.parts.length,
    };
  } catch (e) {
    // 失败时把中间文件清掉，别把磁盘塞满
    for (const f of outs) { try { fs.unlinkSync(f); } catch (e2) { /* ignore */ } }
    throw e;
  }
}

function cleanup(v) {
  if (!v || !v.file) return;
  try { fs.unlinkSync(v.file); } catch (e) { /* ignore */ }
}

module.exports = {
  search, getPages, getPlayUrl, downloadVideo, cleanup,
  parseDuration, fmtDuration, cleanText, wbiSign,
  QN_NAME, REFERER,
};
