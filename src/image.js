// B 站图床图片的下载 + 解码（零依赖）
//
// 为什么这么绕：评论头像和搜索封面都是网络图片，而项目不能引 canvas/sharp。
// 好在 B 站图床（i0/i1/i2.hdslb.com）支持「图片处理参数」：
//
//   https://i1.hdslb.com/bfs/archive/xxx.jpg@240w_135h_1c.png
//                                            └─┬─┘ └┬┘ └┬┘ └┬┘
//                                     宽240    高135 裁剪  要 PNG
//
// 加上 `@...png` 之后服务端直接回 PNG，于是本地只要有一个 PNG 解码器就够了，
// 不用为了 JPEG 再写几百行。封面从 480x270 缩到 240x135 也顺便省了带宽。
//
// 兜底：万一某个 URL 不吃这套参数、回的还是 JPEG/WebP，就交给 ffmpeg 转一次
// （项目本来就硬依赖 ffmpeg，下载和切段都要用），转成 PNG 再走同一个解码器。
// ffmpeg 也没有的话就当没图 —— 调用方会退回「首字色块」，不影响出图。
'use strict';

const { FFMPEG, FFPROBE } = require('./ffbin');

const { spawn } = require('child_process');
const { decodePNG } = require('./png');
const bili = require('./bilibili');
const log = require('./logger');

const MAX_BYTES = 4 * 1024 * 1024;      // 单张图上限，正常封面也就 200KB 以内

// ---------- URL 处理 ----------

// 去掉已有的 `@xxx` 处理后缀和 `?query`，留下干净的图片地址
function stripSuffix(url) {
  const s = String(url || '').trim();
  let cut = -1;
  const at = s.indexOf('@');
  const q = s.indexOf('?');
  if (at >= 0) cut = at;
  if (q >= 0 && (cut < 0 || q < cut)) cut = q;
  return cut >= 0 ? s.slice(0, cut) : s;
}

// 补协议。搜索结果里的封面是 `//i1.hdslb.com/...` 这种协议相对的写法
function normalize(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (s.slice(0, 2) === '//') return 'https:' + s;
  if (s.slice(0, 7) === 'http://') return 'https://' + s.slice(7);
  if (s.slice(0, 8) !== 'https://') return '';
  return s;
}

// 拼成「要 w×h、裁剪铺满、PNG」的地址
function sizedUrl(url, w, h) {
  const base = stripSuffix(url);
  if (!base) return '';
  return base + '@' + Math.round(w) + 'w_' + Math.round(h) + 'h_1c.png';
}

// ---------- 下载 ----------

async function fetchBuf(url, opts) {
  const o = opts || {};
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeout || 12000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': bili.UA,
        // 少了 Referer 图床会回 403
        Referer: o.referer || bili.REFERER,
        Accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
      },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const max = o.maxBytes || MAX_BYTES;
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len > max) throw new Error('图片太大（' + len + ' 字节）');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > max) throw new Error('图片太大（' + buf.length + ' 字节）');
    if (!buf.length) throw new Error('空响应');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 解码 ----------

function sniff(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return '';
}

// 任何格式 -> PNG（交给 ffmpeg），拿回来还是走 decodePNG
function viaFfmpeg(buf) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(FFMPEG, [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-frames:v', '1',
        '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }
    const out = [];
    let err = '';
    let settled = false;
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { if (err.length < 1500) err += d.toString(); });
    p.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    p.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error('ffmpeg 转 PNG 失败（code=' + code + '）：' + err.slice(0, 120)));
    });
    // ffmpeg 提前退出时往 stdin 写会 EPIPE，不吞掉会变成未捕获异常
    p.stdin.on('error', () => { /* ignore */ });
    p.stdin.end(buf);
  });
}

async function decode(buf) {
  const kind = sniff(buf);
  if (kind === 'png') return decodePNG(buf);
  if (!kind) throw new Error('不认识的图片格式');
  return decodePNG(await viaFfmpeg(buf));
}

// ---------- 缓存 ----------
//
// 同一个 UP 主在一屏评论里可能出现好几次，头像没必要重复下载。
// 按**字节数**封顶而不是条数：头像 9KB、封面 130KB，按条数算会把内存吃穿。

const cache = new Map();        // key -> { img, bytes }
let cacheBytes = 0;
const CACHE_MAX = 24 * 1024 * 1024;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  // 命中就挪到队尾（Map 保持插入顺序，队头就是最久没用的）
  cache.delete(key);
  cache.set(key, hit);
  return hit.img;
}

function cacheSet(key, img) {
  const bytes = img.width * img.height * 4;
  if (bytes > CACHE_MAX / 4) return;          // 单张就占掉 1/4 的不缓存
  const old = cache.get(key);
  if (old) { cacheBytes -= old.bytes; cache.delete(key); }
  cache.set(key, { img, bytes });
  cacheBytes += bytes;
  while (cacheBytes > CACHE_MAX) {
    const first = cache.keys().next();
    if (first.done) break;
    const v = cache.get(first.value);
    cacheBytes -= v.bytes;
    cache.delete(first.value);
  }
}

// ---------- 对外 ----------

// 取一张图并解码。**永远不抛错**：取不到就返回 null，调用方退回占位图。
// url 原始地址；w/h 是向图床要的尺寸（不是最终显示尺寸）
async function load(url, w, h, opts) {
  const base = normalize(url);
  if (!base) return null;
  const key = base + '|' + (w || 0) + 'x' + (h || 0);
  const hit = cacheGet(key);
  if (hit) return hit;
  const target = (w && h) ? sizedUrl(base, w, h) : base;
  try {
    const img = await decode(await fetchBuf(target, opts));
    cacheSet(key, img);
    return img;
  } catch (e) {
    log.debug('img', '取图失败 ' + base.slice(-42) + '：' + (e && e.message ? e.message : e));
    return null;
  }
}

// 批量取图。jobs: [{ url, w, h }]，返回同长度的数组，取不到的位置是 null
//
// 先去重再下载：同一个 UP 主在一屏评论里可能出现好几次，头像只该下一次。
// 光靠 load() 里的缓存不够 —— 并发跑起来时几份相同的请求会同时错过缓存。
//
// 并发默认 6：一屏 10 个封面并行拉比串行快 5 倍，又不至于把图床惹毛。
async function loadMany(jobs, opts) {
  const o = opts || {};
  const arr = Array.isArray(jobs) ? jobs : [];
  const out = new Array(arr.length).fill(null);
  if (!arr.length) return out;

  const keyAt = new Array(arr.length).fill('');
  const uniq = new Map();
  for (let i = 0; i < arr.length; i++) {
    const j = arr[i] || {};
    const base = normalize(j.url);
    if (!base) continue;
    const k = base + '|' + (j.w || 0) + 'x' + (j.h || 0);
    keyAt[i] = k;
    if (!uniq.has(k)) uniq.set(k, j);
  }
  const keys = Array.from(uniq.keys());
  if (!keys.length) return out;

  const limit = Math.max(1, Math.min(Number(o.concurrency) || 6, 16));
  const got = new Map();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= keys.length) return;
      const k = keys[i];
      const j = uniq.get(k);
      got.set(k, await load(j.url, j.w, j.h, o));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, keys.length) }, worker));

  for (let i = 0; i < arr.length; i++) {
    if (keyAt[i]) out[i] = got.get(keyAt[i]) || null;
  }
  return out;
}

function clearCache() {
  cache.clear();
  cacheBytes = 0;
}

module.exports = {
  load, loadMany, decode, fetchBuf, sniff, clearCache,
  normalize, sizedUrl, stripSuffix, MAX_BYTES,
};
