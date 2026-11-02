// 极简 PNG 编码器（零依赖）
//
// 只做一件事：把一块 RGBA 像素（Buffer，行优先，每像素 4 字节）压成 PNG。
// B 站评论长图是本项目里唯一需要「服务端自己画图」的地方，为了它引一个
// canvas/sharp 依赖不值得 —— PNG 的容器格式本身很简单，压缩直接借 zlib。
//
// 注意：这里只写 8 位真彩色、无隔行、不带调色板的那一种（PNG 里最常用的）。
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

module.exports = { encodePNG, crc32 };
