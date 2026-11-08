// 极简 TrueType 字体解析（零依赖）
//
// 只为「把评论渲染成长图」服务：读出字形轮廓 + 字符宽度，剩下的交给 canvas.js 栅格化。
// 不做的事（用不上，做了反而容易出错）：
//   · CFF / OTF 轮廓（Noto Sans CJK 的 .ttc 就是 CFF，这里读不了 —— 见下面 pickFont 的探测逻辑）
//   · 字体 hinting、kerning、连字
//   · 复合字形里的「点对点对齐」（极罕见，当 0 偏移处理）
//
// 支持 .ttf 与 .ttc（字体集合，取其中一个子字体）。
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- 基础读取 ----------

function tagAt(buf, o) {
  return buf.toString('ascii', o, o + 4);
}

// 从 sfnt 偏移处读表目录
function readTables(buf, base) {
  const numTables = buf.readUInt16BE(base + 4);
  const map = {};
  for (let i = 0; i < numTables; i++) {
    const p = base + 12 + i * 16;
    const tag = tagAt(buf, p);
    map[tag] = { offset: buf.readUInt32BE(p + 8), length: buf.readUInt32BE(p + 12) };
  }
  return map;
}

// .ttc 的头里记着每个子字体的 sfnt 偏移；普通 .ttf 就是 0
function sfntOffsets(buf) {
  if (buf.length < 12) return [];
  if (tagAt(buf, 0) === 'ttcf') {
    const n = buf.readUInt32BE(8);
    const out = [];
    for (let i = 0; i < n && i < 64; i++) out.push(buf.readUInt32BE(12 + i * 4));
    return out;
  }
  return [0];
}

// ---------- cmap ----------

// 格式 4：BMP 范围内的分段映射（几乎所有中文字体都有这一张）
function cmap4Lookup(buf, off, c) {
  const segX2 = buf.readUInt16BE(off + 6);
  const seg = segX2 / 2;
  const endBase = off + 14;
  const startBase = endBase + segX2 + 2;         // 中间隔了 reservedPad(2)
  const deltaBase = startBase + segX2;
  const rangeBase = deltaBase + segX2;
  if (c > 0xffff) return 0;
  // 段尾升序，二分找第一个 endCode >= c
  let lo = 0;
  let hi = seg - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = buf.readUInt16BE(endBase + mid * 2);
    if (e >= c) { hit = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (hit < 0) return 0;
  const start = buf.readUInt16BE(startBase + hit * 2);
  if (c < start) return 0;
  const delta = buf.readInt16BE(deltaBase + hit * 2);
  const ro = buf.readUInt16BE(rangeBase + hit * 2);
  if (ro === 0) return (c + delta) & 0xffff;
  const gi = rangeBase + hit * 2 + ro + (c - start) * 2;
  if (gi + 1 >= buf.length) return 0;
  const g = buf.readUInt16BE(gi);
  return g === 0 ? 0 : (g + delta) & 0xffff;
}

// 格式 12：完整 Unicode（含 emoji 等 4 字节字符），按分组二分
function cmap12Lookup(buf, off, c) {
  const n = buf.readUInt32BE(off + 12);
  let lo = 0;
  let hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = off + 16 + mid * 12;
    const s = buf.readUInt32BE(p);
    const e = buf.readUInt32BE(p + 4);
    if (c < s) hi = mid - 1;
    else if (c > e) lo = mid + 1;
    else return buf.readUInt32BE(p + 8) + (c - s);
  }
  return 0;
}

// 挑 Unicode cmap 子表。
// ⚠️ 两个子表都要留着：DroidSansFallbackFull.ttf 的格式 12 只覆盖 CJK 区段，
// 拉丁字母和数字反而在格式 4 里。只认格式 12 的话，中文正常、英文数字全变空白。
function pickCmap(buf, cmapOff) {
  const n = buf.readUInt16BE(cmapOff + 2);
  let sub4 = 0;
  let sub12 = 0;
  for (let i = 0; i < n; i++) {
    const p = cmapOff + 4 + i * 8;
    const platform = buf.readUInt16BE(p);
    const encoding = buf.readUInt16BE(p + 2);
    const sub = cmapOff + buf.readUInt32BE(p + 4);
    const format = buf.readUInt16BE(sub);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12 && !sub12) sub12 = sub;
    if (format === 4 && !sub4) sub4 = sub;
  }
  if (!sub12 && !sub4) return null;
  return { format: sub12 ? 12 : 4, off: sub12 || sub4, sub12, sub4 };
}

// ---------- 字形轮廓 ----------

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

function f2dot14(buf, o) {
  return buf.readInt16BE(o) / 16384;
}

class Font {
  constructor(buf, sfnt) {
    this.buf = buf;
    this.tables = readTables(buf, sfnt);
    const need = ['head', 'maxp', 'hhea', 'hmtx', 'loca', 'glyf', 'cmap'];
    for (const t of need) {
      if (!this.tables[t]) {
        const err = new Error('字体缺少 ' + t + ' 表（可能是 CFF/OTF 轮廓，暂不支持）');
        err.code = 'NO_GLYF';
        throw err;
      }
    }
    const head = this.tables.head.offset;
    this.unitsPerEm = buf.readUInt16BE(head + 18) || 1000;
    this.locaLong = buf.readInt16BE(head + 50) === 1;
    this.numGlyphs = buf.readUInt16BE(this.tables.maxp.offset + 4);

    const hhea = this.tables.hhea.offset;
    this.ascender = buf.readInt16BE(hhea + 4);
    this.descender = buf.readInt16BE(hhea + 6);
    this.lineGap = buf.readInt16BE(hhea + 8);
    this.numHMetrics = buf.readUInt16BE(hhea + 34);

    const cm = pickCmap(buf, this.tables.cmap.offset);
    this.cmap = cm;

    // 每个字形的轮廓缓存（同一字符可能反复出现，长图里这点缓存很值）
    this._contours = new Map();
  }

  // 字符 -> 字形编号；0 = 没有这个字（.notdef）
  gidOf(cp) {
    if (!this.cmap) return 0;
    const cm = this.cmap;
    let g = 0;
    if (cm.sub12) g = cmap12Lookup(this.buf, cm.sub12, cp);
    if (!g && cm.sub4) g = cmap4Lookup(this.buf, cm.sub4, cp);
    return g >= 0 && g < this.numGlyphs ? g : 0;
  }

  // 字形宽度（字体单位，未缩放）
  advance(gid) {
    const n = this.numHMetrics;
    const off = this.tables.hmtx.offset;
    const i = gid < n ? gid : n - 1;
    if (i < 0) return 0;
    return this.buf.readUInt16BE(off + i * 4);
  }

  _loca(gid) {
    const off = this.tables.loca.offset;
    if (this.locaLong) return this.buf.readUInt32BE(off + gid * 4);
    return this.buf.readUInt16BE(off + gid * 2) * 2;
  }

  // 返回轮廓数组：[[{x,y,on}...], ...]，坐标是字体单位、y 向上
  contours(gid) {
    if (this._contours.has(gid)) return this._contours.get(gid);
    let out = [];
    try {
      out = this._contoursOf(gid, 0);
    } catch (e) {
      out = [];
    }
    if (this._contours.size > 4000) this._contours.clear();
    this._contours.set(gid, out);
    return out;
  }

  _contoursOf(gid, depth) {
    if (depth > 4 || gid < 0 || gid >= this.numGlyphs) return [];
    const glyf = this.tables.glyf.offset;
    const start = glyf + this._loca(gid);
    const end = glyf + this._loca(gid + 1);
    if (end <= start || end > this.buf.length) return [];   // 空字形（比如空格）
    const buf = this.buf;
    const nContours = buf.readInt16BE(start);

    if (nContours >= 0) return this._simpleGlyph(start, nContours);
    // 复合字形
    return this._compositeGlyph(start, depth);
  }

  _simpleGlyph(start, nContours) {
    const buf = this.buf;
    const out = [];
    if (!nContours) return out;
    let p = start + 10;
    const endPts = [];
    for (let i = 0; i < nContours; i++) { endPts.push(buf.readUInt16BE(p)); p += 2; }
    const nPoints = endPts[nContours - 1] + 1;
    const insLen = buf.readUInt16BE(p);
    p += 2 + insLen;

    // flags（带重复位）
    const flags = new Uint8Array(nPoints);
    for (let i = 0; i < nPoints;) {
      const f = buf[p++];
      flags[i++] = f;
      if (f & 0x08) {                       // REPEAT：后面跟一个重复次数
        const rep = buf[p++];
        for (let k = 0; k < rep && i < nPoints; k++) flags[i++] = f;
      }
    }

    // x 坐标
    const xs = new Int32Array(nPoints);
    let x = 0;
    for (let i = 0; i < nPoints; i++) {
      const f = flags[i];
      if (f & 0x02) {                       // X_SHORT：1 字节增量
        const d = buf[p++];
        x += (f & 0x10) ? d : -d;
      } else if (!(f & 0x10)) {             // 否则 2 字节有符号增量（X_SAME 时不变）
        x += buf.readInt16BE(p);
        p += 2;
      }
      xs[i] = x;
    }

    // y 坐标
    const ys = new Int32Array(nPoints);
    let y = 0;
    for (let i = 0; i < nPoints; i++) {
      const f = flags[i];
      if (f & 0x04) {
        const d = buf[p++];
        y += (f & 0x20) ? d : -d;
      } else if (!(f & 0x20)) {
        y += buf.readInt16BE(p);
        p += 2;
      }
      ys[i] = y;
    }

    let first = 0;
    for (let c = 0; c < nContours; c++) {
      const last = endPts[c];
      const contour = [];
      for (let i = first; i <= last && i < nPoints; i++) {
        contour.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 0x01) });
      }
      first = last + 1;
      if (contour.length) out.push(contour);
    }
    return out;
  }

  _compositeGlyph(start, depth) {
    const buf = this.buf;
    let p = start + 10;
    const out = [];
    for (let guard = 0; guard < 32; guard++) {
      const flags = buf.readUInt16BE(p);
      const gid = buf.readUInt16BE(p + 2);
      p += 4;
      let dx = 0;
      let dy = 0;
      if (flags & ARG_1_AND_2_ARE_WORDS) {
        if (flags & ARGS_ARE_XY_VALUES) {
          dx = buf.readInt16BE(p);
          dy = buf.readInt16BE(p + 2);
        }
        p += 4;
      } else {
        if (flags & ARGS_ARE_XY_VALUES) {
          dx = buf.readInt8(p);
          dy = buf.readInt8(p + 1);
        }
        p += 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flags & WE_HAVE_A_SCALE) {
        a = d = f2dot14(buf, p);
        p += 2;
      } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
        a = f2dot14(buf, p);
        d = f2dot14(buf, p + 2);
        p += 4;
      } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
        a = f2dot14(buf, p);
        b = f2dot14(buf, p + 2);
        c = f2dot14(buf, p + 4);
        d = f2dot14(buf, p + 6);
        p += 8;
      }
      const sub = this._contoursOf(gid, depth + 1);
      for (const contour of sub) {
        out.push(contour.map((pt) => ({
          x: pt.x * a + pt.y * c + dx,
          y: pt.x * b + pt.y * d + dy,
          on: pt.on,
        })));
      }
      if (!(flags & MORE_COMPONENTS)) break;
    }
    return out;
  }
}

// ---------- 找字体文件 ----------
//
// 这台机器上装了什么中文字体没法预设，只能按常见路径一个个试。
// 关键点：**必须真的能解析出 glyf 表**才算数 —— Noto Sans CJK 的 .ttc 是 CFF 轮廓，
// 文件名看着像 TrueType，读进去却画不出字。
const CJK_CANDIDATES = [
  // 项目自带的字体（打包了就优先用它，不用猜系统装了什么）。
  // 修复：anjianhe —— 以前这里只有 Linux/macOS 路径，Windows 上永远「找不到字体」，
  // B 站搜索结果图 / 评论长图会直接报「这台机器上找不到可用的中文 TrueType 字体」
  path.join(__dirname, 'assets', 'fonts', 'cat-book.ttf'),
  // Windows
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\msyhbd.ttc',
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\simsun.ttc',
  // Linux（云端实例）
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  // macOS
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/Library/Fonts/Arial Unicode.ttf',
];

// 拉丁/数字兜底字体。
// ⚠️ 必须有这一层：DroidSansFallbackFull 是「后备字体」，只有中日韩，
// cmap 里根本没有 A-Z 和 0-9。只用一个中文字体的话，标题里的英文和所有数字会画成空白。
const LATIN_CANDIDATES = [
  path.join(__dirname, 'assets', 'fonts', 'cat-book.ttf'),
  'C:\\Windows\\Fonts\\arial.ttf',
  'C:\\Windows\\Fonts\\segoeui.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
];

// 试着打开一个字体文件（只看能不能解析，不管覆盖了哪些字）
function tryOpen(file, index) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return null; }
  const offs = sfntOffsets(buf);
  const want = index == null ? -1 : index;
  for (let i = 0; i < offs.length; i++) {
    if (want >= 0 && i !== want) continue;
    let font;
    try { font = new Font(buf, offs[i]); } catch (e) { continue; }
    return { file, index: i, font };
  }
  return null;
}

let fontChain = null;

// 返回字体链：[主字体, 兜底字体...]。主字体一定有中文，兜底字体负责补拉丁/数字。
// 找不到任何中文字体返回 null（调用方要能接受「这个功能不可用」）。
function loadFonts(opts) {
  const o = opts || {};
  const explicit = o.file || process.env.JZ_COMMENT_FONT || '';
  if (fontChain && !explicit) return fontChain;

  const out = [];
  const seen = new Set();
  const add = (hit) => {
    const key = hit.file + '#' + hit.index;
    if (!hit || seen.has(key)) return;
    seen.add(key);
    out.push(hit);
  };

  if (explicit) {
    const hit = tryOpen(explicit, o.index);
    if (!hit) throw new Error('指定的字体不可用：' + explicit);
    if (!hit.font.gidOf(0x4e2d)) throw new Error('指定的字体里没有汉字：' + explicit);
    add(hit);
  } else {
    for (const f of CJK_CANDIDATES) {
      const hit = tryOpen(f);
      if (hit && hit.font.gidOf(0x4e2d)) { add(hit); break; }
    }
  }
  if (!out.length) return null;

  // 主字体画不出英文/数字就再补一个（Droid 这种「后备字体」很常见）
  if (!out[0].font.gidOf(0x41) || !out[0].font.gidOf(0x30)) {
    for (const f of LATIN_CANDIDATES) {
      const hit = tryOpen(f);
      if (hit && hit.font.gidOf(0x41) && hit.font.gidOf(0x30)) { add(hit); break; }
    }
  }

  if (!explicit) fontChain = out;
  return out;
}

// 老接口：只要主字体
function pickFont(opts) {
  const list = loadFonts(opts);
  return list && list.length ? list[0] : null;
}

module.exports = { Font, pickFont, loadFonts, sfntOffsets, CJK_CANDIDATES, LATIN_CANDIDATES };
