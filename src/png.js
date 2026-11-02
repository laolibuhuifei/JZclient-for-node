// 极简 PNG 编解码器（零依赖）
//
// 编码：把一块 RGBA 像素（Buffer，行优先，每像素 4 字节）压成 PNG。
// 解码：把 B 站图床返回的 PNG 解成 RGBA，评论头像和搜索封面要用。
//
// 为什么自己写而不是引 canvas/sharp：云端几十个实例共用一台机器，装原生模块太重。
// PNG 的容器格式本身很简单，压缩解压直接借 zlib。
//
// 编码只写 8 位真彩色、无隔行、不带调色板的那一种；
// 解码要兼容图床实际返回的几种（8/16 位、灰度/RGB/调色板/RGBA）。
'use strict';

const zlib = require('zlib');

// ---------- CRC32（PNG 每个 chunk 尾部都要） ----------

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- chunk ----------

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------- 行过滤 ----------
//
// PNG 每行开头要写一个「过滤器编号」。Sub(1) 是「减去左边像素」，
// 对白底黑字这种大片同色的图压缩率明显好于不过滤(None)。
// 只在 RGBA8 上用，bpp 固定 4。

function filterSub(rgba, width, height) {
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    out[dst] = 1;                       // filter type = Sub
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? rgba[src + i - bpp] : 0;
      out[dst + 1 + i] = (rgba[src + i] - left) & 0xff;
    }
  }
  return out;
}

// rgba: Buffer(width*height*4)；返回完整 PNG 文件内容
// opts.level: zlib 压缩级别，默认 6（9 更小但慢一倍，长图不值得）
function encodePNG(width, height, rgba, opts) {
  const o = opts || {};
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (!rgba || rgba.length < w * h * 4) {
    throw new Error('像素数据长度不足：需要 ' + (w * h * 4) + ' 字节');
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type: truecolor + alpha
  ihdr[10] = 0;     // compression
  ihdr[11] = 0;     // filter
  ihdr[12] = 0;     // interlace

  const raw = filterSub(rgba, w, h);
  const idat = zlib.deflateSync(raw, { level: o.level == null ? 6 : o.level });

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { encodePNG, decodePNG, crc32 };

// ---------- 解码 ----------
//
// B 站图床的 `@WxH_1c.png` 参数会返回真 PNG，实测两种：
//   colorType 2（RGB，8 位）—— 封面图
//   colorType 3（调色板）  —— 部分头像
// 所以调色板必须支持，不然头像会整片黑。
//
// 隔行（Adam7）不支持：图床从不输出，真碰上就抛错，让调用方退回「首字色块」，
// 总比画出一张错位的图强。

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// 行过滤还原。PNG 的 5 种过滤器都是「预测值 + 残差」，这里逐字节算回去。
// 必须在**已还原**的字节上算（左侧 a / 上方 b / 左上 c 都取自 out），
// 拿原始数据算会得到一张花屏。
function unfilter(raw, w, h, bpp, stride) {
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    const hasUp = y > 0;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = hasUp ? out[up + i] : 0;
      const c = (hasUp && i >= bpp) ? out[up + i - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = x; break;                                  // None
        case 1: v = x + a; break;                              // Sub
        case 2: v = x + b; break;                              // Up
        case 3: v = x + ((a + b) >> 1); break;                 // Average
        case 4: {                                              // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
          break;
        }
        default: throw new Error('PNG 行过滤类型不认识：' + ft);
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

// 把还原后的像素按颜色类型摊成 RGBA8
function expandRGBA(px, w, h, colorType, bitDepth, palette, trns) {
  const ch = CHANNELS[colorType];
  const n = w * h;
  const rgba = Buffer.alloc(n * 4);
  const bytesPer = bitDepth >> 3;          // 8->1, 16->2, 1/2/4->0（位打包）
  const maxV = (1 << bitDepth) - 1;

  // 取第 i 个像素的第 c 个通道的**原始**值（不缩放）
  const rawAt = (i, c) => {
    const k = i * ch + c;
    if (bytesPer === 1) return px[k];
    if (bytesPer === 2) return (px[k * 2] << 8) | px[k * 2 + 1];
    const bitPos = k * bitDepth;
    const shift = 8 - bitDepth - (bitPos & 7);
    return (px[bitPos >> 3] >> shift) & maxV;
  };
  const to8 = bitDepth === 8 ? (v) => v
    : bitDepth === 16 ? (v) => v >> 8
      : (v) => Math.round((v * 255) / maxV);

  // tRNS 里的「透明色」也要用原始值比，不能先缩放再比
  const grayTrns = (colorType === 0 && trns && trns.length >= 2)
    ? ((trns[0] << 8) | trns[1]) : -1;
  const rgbTrns = (colorType === 2 && trns && trns.length >= 6)
    ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : null;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 0) {
      const v = rawAt(i, 0);
      r = g = b = to8(v);
      if (v === grayTrns) a = 0;
    } else if (colorType === 2) {
      const vr = rawAt(i, 0);
      const vg = rawAt(i, 1);
      const vb = rawAt(i, 2);
      r = to8(vr); g = to8(vg); b = to8(vb);
      if (rgbTrns && vr === rgbTrns[0] && vg === rgbTrns[1] && vb === rgbTrns[2]) a = 0;
    } else if (colorType === 3) {
      const idx = rawAt(i, 0);
      if (!palette || idx * 3 + 2 >= palette.length) { r = g = b = 0; }
      else { r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2]; }
      if (trns && idx < trns.length) a = trns[idx];
    } else if (colorType === 4) {
      r = g = b = to8(rawAt(i, 0));
      a = to8(rawAt(i, 1));
    } else {
      r = to8(rawAt(i, 0)); g = to8(rawAt(i, 1)); b = to8(rawAt(i, 2)); a = to8(rawAt(i, 3));
    }
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
  }
  return rgba;
}

// buf: 完整 PNG 文件；返回 { width, height, rgba }
function decodePNG(buf) {
  if (!buf || buf.length < 33) throw new Error('PNG 数据太短');
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error('不是 PNG（文件头不对）');
  }

  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idats = [];

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const s = off + 8;
    const e = s + len;
    if (e > buf.length) throw new Error('PNG 数据被截断（' + type + '）');
    if (type === 'IHDR') {
      w = buf.readUInt32BE(s);
      h = buf.readUInt32BE(s + 4);
      bitDepth = buf[s + 8];
      colorType = buf[s + 9];
      interlace = buf[s + 12];
    } else if (type === 'PLTE') {
      palette = buf.subarray(s, e);
    } else if (type === 'tRNS') {
      trns = buf.subarray(s, e);
    } else if (type === 'IDAT') {
      idats.push(buf.subarray(s, e));
    } else if (type === 'IEND') break;
    off = e + 4;                       // 跳过 chunk 尾部的 CRC
  }

  if (!w || !h) throw new Error('PNG 缺 IHDR');
  if (w * h > 40e6) throw new Error('PNG 太大了（' + w + 'x' + h + '）');
  if (!CHANNELS[colorType]) throw new Error('PNG 颜色类型不支持：' + colorType);
  if (interlace) throw new Error('PNG 是隔行的（Adam7），暂不支持');
  if (!idats.length) throw new Error('PNG 没有 IDAT');

  const raw = zlib.inflateSync(Buffer.concat(idats));
  const bitsPerPixel = CHANNELS[colorType] * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);      // 过滤用的「左邻字节距离」
  const stride = Math.ceil((w * bitsPerPixel) / 8);
  if (raw.length < (stride + 1) * h) {
    throw new Error('PNG 像素数据不完整（' + raw.length + ' < ' + ((stride + 1) * h) + '）');
  }

  const px = unfilter(raw, w, h, bpp, stride);
  return { width: w, height: h, rgba: expandRGBA(px, w, h, colorType, bitDepth, palette, trns) };
}
