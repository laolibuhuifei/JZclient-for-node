// 网页图标解析: 链接卡片没填封面时, 自动抓目标页的图标当封面
//
// 候选顺序(先命中先用):
//   1. 页面本身就是图片(少数站点直接把 icon 地址填成裸地址)
//   2. <link rel="apple-touch-icon">  —— 一般是 180x180 的方形 logo, 卡片上最好看
//   3. <link rel="icon"> / "shortcut icon", 按 sizes 从大到小
//   4. /favicon.ico 兜底
//   5. <meta property="og:image"> —— 站点连图标都没有时的最后手段
// 只收位图(PNG/JPEG/GIF/WEBP): 手表端是 Android BitmapFactory, SVG 画不出来。
// 老式 ICO(BMP 像素)在这里转成 PNG, 否则原样上传手表也显示不了。
const zlib = require('zlib');
const { fetchBuffer, icoToPng } = require('./upload');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_HTML = 512 * 1024;   // 只看前 512KB, <head> 早就在里面了
const MAX_ICON = 4 * 1024 * 1024;
const MAX_CANDIDATES = 6;

// ============ 图片格式识别 ============

function sniffExt(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return '.gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return '.ico';
  return null;
}

// ============ ICO(BMP 像素) → PNG ============

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function pngEncode(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 老式 ICO: 每条目录项指向一个 BITMAPINFOHEADER + 倒序像素 + AND 掩码
// 只处理 24/32 位真彩色(占绝大多数), 取面积最大的一张
function icoBmpToPng(buf) {
  if (!buf || buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > buf.length) break;
    const size = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    if (size < 40 || off + size > buf.length) continue;
    const area = (buf[o] || 256) * (buf[o + 1] || 256);
    if (!best || area > best.area) best = { area, off, size };
  }
  if (!best) return null;
  const d = buf.slice(best.off, best.off + best.size);
  const hdrSize = d.readUInt32LE(0);
  if (hdrSize < 40 || hdrSize > d.length) return null;
  const bpp = d.readUInt16LE(14);
  if (bpp !== 32 && bpp !== 24) return null;
  const width = d.readInt32LE(4);
  // ICO 里 biHeight 是「图像高度 + AND 掩码高度」, 所以要除以 2
  const height = Math.abs(d.readInt32LE(8)) >> 1;
  if (width <= 0 || height <= 0 || width > 512 || height > 512) return null;
  const stride = Math.ceil((width * bpp) / 8 / 4) * 4;
  if (hdrSize + stride * height > d.length) return null;
  const rgba = Buffer.alloc(width * height * 4);
  const step = bpp >> 3;
  for (let y = 0; y < height; y++) {
    const row = hdrSize + (height - 1 - y) * stride;   // 像素自下而上
    for (let x = 0; x < width; x++) {
      const p = row + x * step;
      const q = (y * width + x) * 4;
      rgba[q] = d[p + 2];
      rgba[q + 1] = d[p + 1];
      rgba[q + 2] = d[p];
      rgba[q + 3] = bpp === 32 ? d[p + 3] : 255;
    }
  }
  return pngEncode(width, height, rgba);
}

// ICO 统一入口: 先试内嵌 PNG(现代做法), 再试 BMP 像素(老做法)
function icoToRaster(buf) {
  const png = icoToPng(buf);
  if (png) return { buf: png, filename: 'favicon.png' };
  const conv = icoBmpToPng(buf);
  if (conv) return { buf: conv, filename: 'favicon.png' };
  return null;
}

// 任意图片字节 → 可直接上传的位图(ICO 转 PNG), 认不出返回 null
function toRaster(buf) {
  if (!buf || !buf.length || buf.length > MAX_ICON) return null;
  const ext = sniffExt(buf);
  if (!ext) return null;
  if (ext === '.ico') return icoToRaster(buf);
  return { buf, filename: 'favicon' + ext };
}

// ============ HTML 抓取与解析 ============

async function fetchPage(url, timeout) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!r.ok) return null;
    const finalUrl = r.url || url;
    const ct = String(r.headers.get('content-type') || '');
    // 目标本身就是一张图(有些站点的 icon 地址直接写在别的属性里)
    if (/^image\//i.test(ct)) {
      const buf = Buffer.from(await r.arrayBuffer());
      return { image: buf, finalUrl };
    }
    if (!r.body) return null;
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.length;
      chunks.push(Buffer.from(step.value));
      if (size >= MAX_HTML) {
        try { reader.cancel(); } catch (e) { /* ignore */ }
        break;
      }
    }
    return { html: Buffer.concat(chunks).toString('utf8'), finalUrl };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2f;/gi, '/');
}

// 从标签串里取属性(属性值可能带引号, 也可能不带)
function attrOf(tag, name) {
  const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = tag.match(re);
  if (!m) return '';
  return decodeEntities(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || '').trim();
}

function absUrl(href, base) {
  if (!href) return '';
  if (/^data:/i.test(href)) return '';
  try {
    const u = new URL(href, base);
    return /^https?:$/i.test(u.protocol) ? u.href : '';
  } catch (e) {
    return '';
  }
}

// "32x32" → 32; "any"(svg) → 0 排到最后, 因为手表端不认 svg
function sizeScore(sizes) {
  const s = String(sizes || '').toLowerCase();
  if (!s || /any/.test(s)) return 0;
  let best = 0;
  s.replace(/(\d+)\s*x\s*(\d+)/g, (all, w, h) => {
    best = Math.max(best, Math.min(Number(w) || 0, Number(h) || 0));
    return all;
  });
  return best;
}

function isSvg(u) {
  return /\.svg(?:[?#]|$)/i.test(u);
}

// 收集候选图标, 已按优先级排好序
function collectIcons(html, baseUrl) {
  const icons = [];
  const og = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const rel = attrOf(tag, 'rel').toLowerCase();
    if (!/\bicon\b/.test(rel)) continue;
    const href = absUrl(attrOf(tag, 'href'), baseUrl);
    if (!href) continue;
    const touch = /apple-touch-icon|apple-touch-icon-precomposed/.test(rel);
    icons.push({
      url: href,
      touch: touch ? 1 : 0,
      size: sizeScore(attrOf(tag, 'sizes')),
      svg: isSvg(href) ? 1 : 0,
    });
  }
  // apple-touch-icon 优先, 然后按尺寸大→小, svg 垫底
  icons.sort((a, b) => (b.touch - a.touch) || (a.svg - b.svg) || (b.size - a.size));

  const metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(html))) {
    const tag = m[0];
    const key = (attrOf(tag, 'property') || attrOf(tag, 'name')).toLowerCase();
    if (key !== 'og:image' && key !== 'twitter:image') continue;
    const u = absUrl(attrOf(tag, 'content'), baseUrl);
    if (u && !isSvg(u)) og.push(u);
  }

  const out = icons.map((i) => i.url);
  // 兜底: 站点根目录的 /favicon.ico
  try {
    const root = new URL('/', baseUrl).href;
    if (!out.includes(root + 'favicon.ico')) out.push(root + 'favicon.ico');
  } catch (e) { /* ignore */ }
  og.forEach((u) => { if (!out.includes(u)) out.push(u); });
  return out.filter((u) => !isSvg(u)).slice(0, MAX_CANDIDATES);
}

// ============ 对外入口 ============

// 抓一个网页的图标, 返回 { buf, filename, from } 或 null(拿不到不算错误)
// 整件事有总时间预算: 页面本身 + 最多 6 个候选图, 每个都要联网, 不设上限的话
// 慢站能把「发送链接」拖过前端 30 秒超时, 表现成「点了没反应但消息其实发出去了」。
async function fetchFavicon(pageUrl, opts = {}) {
  const per = Number(opts.timeout) || 6000;
  const budget = Number(opts.budget) || 10000;
  const deadline = Date.now() + budget;
  const left = () => deadline - Date.now();
  const page = await fetchPage(pageUrl, Math.min(per, Math.max(1500, left())));
  if (!page) return null;
  if (page.image) {
    const r = toRaster(page.image);
    return r ? Object.assign(r, { from: pageUrl }) : null;
  }
  const cands = collectIcons(page.html || '', page.finalUrl);
  for (const u of cands) {
    const rest = left();
    if (rest < 500) break;
    const buf = await fetchBuffer(u, Math.min(per, rest));
    const r = toRaster(buf);
    if (r) return Object.assign(r, { from: u });
  }
  return null;
}

module.exports = {
  fetchFavicon,
  // 下面几个导出给单测用
  sniffExt,
  toRaster,
  icoBmpToPng,
  icoToRaster,
  pngEncode,
  collectIcons,
  sizeScore,
  attrOf,
  absUrl,
};
