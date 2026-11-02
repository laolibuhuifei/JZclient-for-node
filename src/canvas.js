// 极简画布（零依赖）：RGBA 像素缓冲 + 文字/矩形/圆角/圆形绘制
//
// 为什么自己写：评论长图要在服务端画中文，而项目不能引 canvas/sharp 这类原生依赖
// （云端实例是几十个进程共用一台机器，装原生模块太重）。所以这里自己做三件事：
//   1. 把 TrueType 字形轮廓（ttf.js 读出来的）铺平成折线
//   2. 扫描线填充 + 4 倍纵向超采样，得到抗锯齿的字形灰度图
//   3. 按字形灰度把颜色混进画布
//
// 字形栅格化结果按「字号 + 字形编号」缓存 —— 长图里「的」「了」这种字会出现上千次，
// 不缓存的话每张图要多花好几秒。
'use strict';

const { encodePNG } = require('./png');
const ttf = require('./ttf');

// ---------- 颜色 ----------

function parseColor(c) {
  if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0];
  const s = String(c || '#000').trim();
  if (s.charAt(0) === '#') {
    let h = s.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h.slice(0, 6), 16);
    if (Number.isFinite(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return [0, 0, 0];
}

// ---------- 字形轮廓 -> 折线 ----------

function quadTo(out, x0, y0, cx, cy, x1, y1) {
  // 按控制多边形的弯曲程度决定细分段数，最多 10 段（字号 60 以内足够平）
  const d = Math.abs(x0 - 2 * cx + x1) + Math.abs(y0 - 2 * cy + y1);
  let steps = Math.ceil(Math.sqrt(d * 2));
  if (!(steps >= 1)) steps = 1;
  if (steps > 10) steps = 10;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const u = 1 - t;
    out.push(u * u * x0 + 2 * u * t * cx + t * t * x1,
      u * u * y0 + 2 * u * t * cy + t * t * y1);
  }
}

// 一条轮廓（点数组，含 on/off 标记）-> 折线（[x0,y0,x1,y1,...] 设备坐标）
function flattenContour(pts, scale, out) {
  const n = pts.length;
  if (!n) return;
  const X = (p) => p.x * scale;
  const Y = (p) => -p.y * scale;      // 字体 y 向上，画布 y 向下
  let s = -1;
  for (let i = 0; i < n; i++) if (pts[i].on) { s = i; break; }

  if (s < 0) {
    // 整条轮廓全是控制点（少见）：起点取首尾两点中点，逐段画二次曲线
    const ax = (X(pts[n - 1]) + X(pts[0])) / 2;
    const ay = (Y(pts[n - 1]) + Y(pts[0])) / 2;
    out.push(ax, ay);
    let cx = ax;
    let cy = ay;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      const mx = (X(p) + X(q)) / 2;
      const my = (Y(p) + Y(q)) / 2;
      quadTo(out, cx, cy, X(p), Y(p), mx, my);
      cx = mx;
      cy = my;
    }
    return;
  }

  const startX = X(pts[s]);
  const startY = Y(pts[s]);
  out.push(startX, startY);
  let cx = startX;
  let cy = startY;
  let i = (s + 1) % n;
  let guard = 0;
  while (i !== s && guard++ <= n + 2) {
    const p = pts[i];
    if (p.on) {
      out.push(X(p), Y(p));
      cx = X(p);
      cy = Y(p);
      i = (i + 1) % n;
      continue;
    }
    const ni = (i + 1) % n;
    const nx = pts[ni];
    if (nx.on) {
      quadTo(out, cx, cy, X(p), Y(p), X(nx), Y(nx));
      cx = X(nx);
      cy = Y(nx);
      // 吃掉 next 点后前进；next 正好是起点就说明这一圈画完了（不这样判会绕第二圈，
      // 笔画被重复覆盖两遍，细笔画看着凭空变粗一倍）
      i = ni === s ? s : (ni + 1) % n;
    } else {
      // 两个连续控制点之间隐含一个曲线上的点（中点）
      const mx = (X(p) + X(nx)) / 2;
      const my = (Y(p) + Y(nx)) / 2;
      quadTo(out, cx, cy, X(p), Y(p), mx, my);
      cx = mx;
      cy = my;
      i = (i + 1) % n;
    }
  }
  if (Math.abs(cx - startX) > 1e-6 || Math.abs(cy - startY) > 1e-6) out.push(startX, startY);
}

// ---------- 栅格化 ----------

const SUB = 4;   // 每个像素行切 4 条子扫描线（纵向抗锯齿）

// polys: 折线数组；返回 { w, h, alpha(Uint8ClampedArray), left, top }
// left/top 是相对「画笔原点（基线）」的偏移，blit 时加上去
function rasterize(polys) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i += 2) {
      const x = poly[i];
      const y = poly[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  const left = Math.floor(minX) - 1;
  const top = Math.floor(minY) - 1;
  const w = Math.ceil(maxX) + 1 - left;
  const h = Math.ceil(maxY) + 1 - top;
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return null;

  // 边表（平移到缓冲区坐标系）
  const edges = [];
  for (const poly of polys) {
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = poly[i * 2] - left;
      const y0 = poly[i * 2 + 1] - top;
      const x1 = poly[j * 2] - left;
      const y1 = poly[j * 2 + 1] - top;
      if (y0 === y1) continue;
      edges.push([x0, y0, x1, y1]);
    }
  }
  const alpha = new Uint8ClampedArray(w * h);
  if (!edges.length) return null;

  const cov = new Float32Array(w);
  for (let row = 0; row < h; row++) {
    let any = false;
    cov.fill(0);
    for (let s = 0; s < SUB; s++) {
      const sy = row + (s + 0.5) / SUB;
      const cross = [];
      for (let e = 0; e < edges.length; e++) {
        const ed = edges[e];
        const y0 = ed[1];
        const y1 = ed[3];
        if ((y0 <= sy && y1 > sy) || (y1 <= sy && y0 > sy)) {
          const t = (sy - y0) / (y1 - y0);
          cross.push([ed[0] + t * (ed[2] - ed[0]), y1 > y0 ? 1 : -1]);
        }
      }
      if (cross.length < 2) continue;
      cross.sort((a, b) => a[0] - b[0]);
      // nonzero 绕数：绕数非 0 的区间算在字形内部
      let wind = 0;
      let spanStart = 0;
      for (let k = 0; k < cross.length; k++) {
        const x = cross[k][0];
        if (wind === 0) spanStart = x;
        wind += cross[k][1];
        if (wind === 0) {
          let xa = spanStart < 0 ? 0 : spanStart;
          let xb = x > w ? w : x;
          if (xb <= xa) continue;
          any = true;
          const i0 = Math.floor(xa);
          const i1 = Math.floor(xb);
          if (i0 === i1) {
            if (i0 >= 0 && i0 < w) cov[i0] += xb - xa;
          } else {
            if (i0 >= 0 && i0 < w) cov[i0] += i0 + 1 - xa;
            const stop = Math.min(i1, w);
            for (let i = i0 + 1; i < stop; i++) cov[i] += 1;
            if (i1 < w) cov[i1] += xb - i1;
          }
        }
      }
    }
    if (!any) continue;
    const base = row * w;
    for (let i = 0; i < w; i++) {
      const c = cov[i];
      if (c > 0) alpha[base + i] = Math.round((c * 255) / SUB);
    }
  }
  return { w, h, left, top, alpha };
}

// 字形灰度图缓存：`字号|字体序号|字形编号` -> mask
const maskCache = new Map();
const MASK_CACHE_MAX = 6000;

function glyphMask(font, fontId, gid, size) {
  const key = size + '|' + fontId + '|' + gid;
  const hit = maskCache.get(key);
  if (hit !== undefined) return hit;
  let mask = null;
  try {
    const contours = font.contours(gid);
    if (contours.length) {
      const scale = size / font.unitsPerEm;
      const polys = [];
      for (const c of contours) {
        const poly = [];
        flattenContour(c, scale, poly);
        if (poly.length >= 6) polys.push(poly);
      }
      if (polys.length) mask = rasterize(polys);
    }
  } catch (e) {
    mask = null;
  }
  if (maskCache.size > MASK_CACHE_MAX) maskCache.clear();
  maskCache.set(key, mask);
  return mask;
}

// ---------- 画布 ----------

class Canvas {
  constructor(width, height, bg) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.data = Buffer.alloc(this.width * this.height * 4);
    const c = parseColor(bg || '#ffffff');
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = c[0];
      this.data[i + 1] = c[1];
      this.data[i + 2] = c[2];
      this.data[i + 3] = 255;
    }
    this.font = null;      // 懒加载，构造画布本身不该因为没字体就失败
    this.fontFile = '';
  }

  // 字体链：主字体（中文）+ 兜底字体（拉丁/数字）。见 ttf.loadFonts 的注释
  _fonts() {
    if (this.fonts) return this.fonts;
    const list = ttf.loadFonts({});
    if (!list || !list.length) {
      const err = new Error('这台机器上找不到可用的中文 TrueType 字体，评论长图功能不可用'
        + '（可设环境变量 JZ_COMMENT_FONT 指定 .ttf/.ttc 路径）');
      err.code = 'NO_FONT';
      throw err;
    }
    this.fonts = list;
    this.font = list[0].font;
    this.fontFile = list[0].file;
    return this.fonts;
  }

  // 这个字符该用哪个字体画：从主字体开始挨个试，谁有这个字就用谁
  _resolve(cp) {
    const list = this._fonts();
    for (let i = 0; i < list.length; i++) {
      const gid = list[i].font.gidOf(cp);
      if (gid) return { font: list[i].font, id: i, gid };
    }
    return null;
  }

  // 单像素混色（内部用）
  _blend(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    if (a >= 1) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      return;
    }
    const ia = 1 - a;
    d[i] = d[i] * ia + r * a;
    d[i + 1] = d[i + 1] * ia + g * a;
    d[i + 2] = d[i + 2] * ia + b * a;
  }

  fillRect(x, y, w, h, color) {
    const c = parseColor(color);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    const d = this.data;
    for (let yy = y0; yy < y1; yy++) {
      let i = (yy * this.width + x0) * 4;
      for (let xx = x0; xx < x1; xx++) {
        d[i] = c[0];
        d[i + 1] = c[1];
        d[i + 2] = c[2];
        i += 4;
      }
    }
  }

  // 圆角矩形：用「到内缩矩形的距离」当覆盖率，边缘自带抗锯齿
  roundRect(x, y, w, h, radius, color) {
    const c = parseColor(color);
    const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
    // 半径为 0 时直接填方块：下面那套距离公式在 r=0 时会把整块画成半透明
    if (r < 0.5) { this.fillRect(x, y, w, h, color); return; }
    const x0 = Math.max(0, Math.floor(x - 1));
    const y0 = Math.max(0, Math.floor(y - 1));
    const x1 = Math.min(this.width, Math.ceil(x + w + 1));
    const y1 = Math.min(this.height, Math.ceil(y + h + 1));
    const ix0 = x + r;
    const iy0 = y + r;
    const ix1 = x + w - r;
    const iy1 = y + h - r;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const px = xx + 0.5;
        const py = yy + 0.5;
        const nx = px < ix0 ? ix0 : (px > ix1 ? ix1 : px);
        const ny = py < iy0 ? iy0 : (py > iy1 ? iy1 : py);
        const dx = px - nx;
        const dy = py - ny;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const a = r + 0.5 - dist;
        if (a <= 0) continue;
        this._blend(xx, yy, c[0], c[1], c[2], a > 1 ? 1 : a);
      }
    }
  }

  circle(cx, cy, radius, color) {
    const c = parseColor(color);
    const x0 = Math.max(0, Math.floor(cx - radius - 1));
    const y0 = Math.max(0, Math.floor(cy - radius - 1));
    const x1 = Math.min(this.width, Math.ceil(cx + radius + 1));
    const y1 = Math.min(this.height, Math.ceil(cy + radius + 1));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const dx = xx + 0.5 - cx;
        const dy = yy + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const a = radius + 0.5 - d;
        if (a <= 0) continue;
        this._blend(xx, yy, c[0], c[1], c[2], a > 1 ? 1 : a);
      }
    }
  }

  // 横线/竖线（1px 的细分隔线用得最多，这里给一个专门的方法，比通用画线快）
  hline(x, y, w, color) {
    this.fillRect(x, y, w, 1, color);
  }

  // 任意多边形（用同一套扫描线栅格化，边缘自带抗锯齿）
  polygon(points, color) {
    const poly = [];
    for (const p of points) poly.push(p[0], p[1]);
    if (poly.length < 6) return;
    const mask = rasterize([poly]);
    if (!mask) return;
    this._blit(mask, mask.left, mask.top, parseColor(color));
  }

  // 把一张字形灰度图按颜色刷上去
  _blit(mask, x, y, c) {
    const { w, h, alpha } = mask;
    const d = this.data;
    for (let yy = 0; yy < h; yy++) {
      const ty = y + yy;
      if (ty < 0 || ty >= this.height) continue;
      const srow = yy * w;
      let i = (ty * this.width + x) * 4;
      for (let xx = 0; xx < w; xx++) {
        const tx = x + xx;
        if (tx >= 0 && tx < this.width) {
          const a = alpha[srow + xx];
          if (a) {
            if (a >= 255) {
              d[i] = c[0];
              d[i + 1] = c[1];
              d[i + 2] = c[2];
            } else {
              const f = a / 255;
              const ia = 1 - f;
              d[i] = d[i] * ia + c[0] * f;
              d[i + 1] = d[i + 1] * ia + c[1] * f;
              d[i + 2] = d[i + 2] * ia + c[2] * f;
            }
          }
        }
        i += 4;
      }
    }
  }

  // 一个字符的宽度（像素）
  // 字库里没有这个字：emoji 直接不留位置（留了会变成名字中间的一个空格），
  // 其它缺字（比如字体没覆盖到的生僻字）给半个字宽的空位，免得后面的字叠上去
  charWidth(ch, size, bold) {
    const cp = ch.codePointAt(0);
    const hit = this._resolve(cp);
    const w = hit ? hit.font.advance(hit.gid) * (size / hit.font.unitsPerEm) : (cp >= 0x1f000 ? 0 : size * 0.5);
    return w + (bold ? 1 : 0);
  }

  measure(text, size, bold) {
    let w = 0;
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      const hit = this._resolve(cp);
      w += hit ? hit.font.advance(hit.gid) * (size / hit.font.unitsPerEm) : (cp >= 0x1f000 ? 0 : size * 0.5);
    }
    if (bold) w += String(text).length;
    return w;
  }

  // 画一行字；y 是**基线**。返回实际宽度
  text(text, x, y, opt) {
    const o = opt || {};
    const size = o.size || 26;
    const bold = !!o.bold;
    const c = parseColor(o.color || '#222222');
    let pen = x;
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      const hit = this._resolve(cp);
      const adv = hit
        ? hit.font.advance(hit.gid) * (size / hit.font.unitsPerEm)
        : (cp >= 0x1f000 ? 0 : size * 0.5);
      if (hit) {
        const mask = glyphMask(hit.font, hit.id, hit.gid, size);
        if (mask) {
          const gx = Math.round(pen + mask.left);
          const gy = Math.round(y + mask.top);
          this._blit(mask, gx, gy, c);
          // 假粗体：往右再刷一遍，比真去读 Bold 字体省事，小字上效果够看
          if (bold) this._blit(mask, gx + 1, gy, c);
        }
      }
      pen += adv;
    }
    return pen - x + (bold ? 1 : 0);
  }

  // 按宽度折行（中文逐字断，英文按单词断，行首不落标点）
  wrap(text, size, maxWidth, bold) {
    const out = [];
    const src = String(text == null ? '' : text);
    for (const para of src.split('\n')) {
      if (!para) { out.push(''); continue; }
      const tokens = tokenize(para);
      let line = '';
      let lineW = 0;
      for (const tk of tokens) {
        const w = this.measure(tk, size, bold);
        if (line && lineW + w > maxWidth) {
          // 行首禁则：标点不能出现在行首，宁可让它挤在上一行末尾
          if (NO_LINE_START.test(tk)) {
            line += tk;
            lineW += w;
            continue;
          }
          out.push(line);
          line = tk === ' ' ? '' : tk;
          lineW = line === tk ? w : 0;
          continue;
        }
        if (!line && w > maxWidth) {
          // 单个超长单词（网址之类）：硬切
          let buf = '';
          for (const ch of tk) {
            const cw = this.measure(ch, size, bold);
            if (buf && this.measure(buf + ch, size, bold) > maxWidth) {
              out.push(buf);
              buf = ch;
            } else buf += ch;
          }
          line = buf;
          lineW = this.measure(buf, size, bold);
          continue;
        }
        line += tk;
        lineW += w;
      }
      out.push(line);
    }
    return out;
  }

  toPNG(level) {
    return encodePNG(this.width, this.height, this.data, { level });
  }
}

// 行首禁则标点
const NO_LINE_START = /^[，。！？；：、）】》」』”’%…—,.!?;:)\]}>]$/;

// 把一段文字切成「可断行的最小单位」
function tokenize(s) {
  const out = [];
  let word = '';
  const isCJK = (cp) => (cp >= 0x2e80 && cp <= 0x9fff)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xff00 && cp <= 0xffef)
    || (cp >= 0x3000 && cp <= 0x303f);
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === ' ') {
      if (word) { out.push(word); word = ''; }
      out.push(' ');
      continue;
    }
    if (isCJK(cp) || cp === 0x200b) {
      if (word) { out.push(word); word = ''; }
      out.push(ch);
      continue;
    }
    word += ch;
  }
  if (word) out.push(word);
  return out;
}

module.exports = { Canvas, parseColor, glyphMask, tokenize, NO_LINE_START };
