// B 站搜索结果 -> 一张带封面的图（微聊 /搜索 的回复）
//
// 为什么不用纯文字：手表屏幕窄，十行「序号. 标题 · UP主 · 时长」刷屏不说，
// 还完全看不出是哪个视频。一张图里带封面、标题、UP 主、播放/弹幕、时长，
// 用户扫一眼就知道要挑第几条。
//
// 封面走 image.js：向 B 站图床要 `@320w_180h_1c.png`，回来自己解 PNG。
// 拿不到封面的条目画一个灰底 + 播放三角占位，不影响整张图。
'use strict';

const bili = require('./bilibili');
const image = require('./image');
const { fmtCount } = require('./bili-comment');
const { Canvas } = require('./canvas');

// ---------- 外观 ----------

const WIDTH = 720;
const PAD = 28;
const COVER_W = 200;
const COVER_H = 112;
// 向图床要 1.6 倍尺寸：显示 200 宽，源 320 宽，缩下来足够清楚，
// 直接要 400 宽的话每张 PNG 多出七八十 KB，十条就白多传一兆
const COVER_REQ_W = 320;
const COVER_REQ_H = 180;
const BADGE = 40;             // 序号徽章边长
const ROW_H = 132;            // 一行占多高（封面 112 + 20 间距）
const GAP = 20;

const COLOR = {
  pink: '#fb7299',
  white: '#ffffff',
  text: '#18191c',
  name: '#61666d',
  mute: '#9499a0',
  faint: '#c0c4cc',
  line: '#f1f2f3',
  placeholder: '#eef0f2',
};
const FONT = { head: 22, keyword: 30, meta: 21, title: 24, small: 19, badge: 22 };

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// 按宽度截断并补省略号（比直接 slice 准，中英文混排宽度差很多）
function fitText(m, text, size, maxW, bold) {
  const s = String(text == null ? '' : text);
  if (m.measure(s, size, bold) <= maxW) return s;
  let t = s;
  while (t.length > 1 && m.measure(t + '…', size, bold) > maxW) t = t.slice(0, -1);
  return t + '…';
}

// list: bilibili.search() 的返回值
// opts: { keyword, limit, concurrency }
async function renderSearch(list, opts) {
  const o = opts || {};
  const keyword = String(o.keyword || '').trim();
  const arr = (Array.isArray(list) ? list : []).slice(0, clampInt(o.limit, 1, 10, 10));

  // 封面并行拉。拿不到就是 null，后面画占位块
  const covers = await image.loadMany(
    arr.map((x) => ({ url: x.pic, w: COVER_REQ_W, h: COVER_REQ_H })),
    { concurrency: clampInt(o.concurrency, 1, 10, 6), timeout: o.timeout }
  );

  const m = new Canvas(1, 1);        // 只用来量字宽
  const ops = [];

  // ---------- 表头 ----------
  const headH = 104;
  ops.push((c) => c.fillRect(0, 0, WIDTH, headH, COLOR.pink));
  ops.push((c) => c.text('哔哩哔哩 · 搜索', PAD, 36, { size: FONT.head, color: '#ffe3ea' }));
  const kw = fitText(m, keyword || '(空)', FONT.keyword, WIDTH - PAD * 2, true);
  ops.push((c) => c.text(kw, PAD, 78, { size: FONT.keyword, color: COLOR.white, bold: true }));

  // ---------- 副标题 ----------
  let y = headH + 34;
  const subY = y;
  ops.push((c) => c.text('找到 ' + arr.length + ' 条  ·  回复 /播放 序号 观看',
    PAD, subY, { size: FONT.meta, color: COLOR.mute }));
  y += 18;
  const divY = y;
  ops.push((c) => c.fillRect(PAD, divY, WIDTH - PAD * 2, 1, COLOR.line));
  y += 20;

  // ---------- 结果行 ----------
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] || {};
    const top = y;
    const cover = covers[i];

    // 序号徽章：用户要照着这个数字回 /播放 N，所以做得显眼一点
    const badgeY = top + (COVER_H - BADGE) / 2;
    ops.push((c) => c.roundRect(PAD, badgeY, BADGE, BADGE, 10, COLOR.pink));
    const num = String(it.index || (i + 1));
    const nw = m.measure(num, FONT.badge, true);
    ops.push((c) => c.text(num, PAD + (BADGE - nw) / 2, badgeY + 27,
      { size: FONT.badge, color: COLOR.white, bold: true }));

    // 封面
    const coverX = PAD + BADGE + 12;
    if (cover) {
      ops.push((c) => c.drawImage(cover, coverX, top, COVER_W, COVER_H, { round: 8 }));
    } else {
      ops.push((c) => c.roundRect(coverX, top, COVER_W, COVER_H, 8, COLOR.placeholder));
      const cx = coverX + COVER_W / 2;
      const cy = top + COVER_H / 2;
      ops.push((c) => c.polygon([[cx - 9, cy - 13], [cx - 9, cy + 13], [cx + 13, cy]],
        COLOR.faint));
    }

    // 时长角标：压在封面右下角，半透明黑底白字
    // 时长为 0 的条目不画 —— fmtDuration(0) 会给出 "0:00"，看着像视频坏了
    const dur = Number(it.duration) > 0 ? bili.fmtDuration(it.duration) : '';
    if (dur) {
      const dw = m.measure(dur, FONT.small, false) + 12;
      const dx = coverX + COVER_W - dw - 6;
      const dy = top + COVER_H - 26;
      ops.push((c) => c.roundRect(dx, dy, dw, 20, 4, 'rgba(0,0,0,0.55)'));
      ops.push((c) => c.text(dur, dx + 6, dy + 15, { size: FONT.small, color: COLOR.white }));
    }

    // 标题（最多两行，超出加省略号）
    const textX = coverX + COVER_W + 16;
    const textW = WIDTH - PAD - textX;
    const allLines = m.wrap(String(it.title || '(无标题)'), FONT.title, textW, false);
    const titleLines = allLines.slice(0, 2);
    if (allLines.length > 2) {
      let last = titleLines[1] || '';
      while (last.length > 1 && m.measure(last + '…', FONT.title, false) > textW) last = last.slice(0, -1);
      titleLines[1] = last + '…';
    }
    // 单行标题的条目整体上移一点，让文字块在封面高度里居中，
    // 否则一行标题的条目下面会空一大块，一屏看下来像没对齐
    const blockH = titleLines.length * 34 + 26;
    const contentTop = top + Math.max(0, (COVER_H - blockH) / 2);
    titleLines.forEach((ln, k) => {
      // 闭包按引用捕获会全画到最后一行，必须先抓成常量
      const by = contentTop + 19 + k * 34;
      ops.push((c) => c.text(ln, textX, by, { size: FONT.title, color: COLOR.text }));
    });

    // 元信息：UP 主 · 播放 · 弹幕。塞不下先丢弹幕，再不行才截断
    const parts = [];
    if (it.author) parts.push(String(it.author));
    if (it.play) parts.push(fmtCount(it.play) + ' 播放');
    if (it.danmaku) parts.push(fmtCount(it.danmaku) + ' 弹幕');
    let metaText = parts.join('  ·  ');
    if (parts.length > 2 && m.measure(metaText, FONT.small, false) > textW) {
      metaText = parts.slice(0, 2).join('  ·  ');
    }
    metaText = fitText(m, metaText, FONT.small, textW, false);
    const metaY = contentTop + 19 + titleLines.length * 34 + 4;
    ops.push((c) => c.text(metaText, textX, metaY, { size: FONT.small, color: COLOR.name }));

    y += ROW_H;
    if (i < arr.length - 1) {
      const lineY = y - GAP / 2;
      ops.push((c) => c.fillRect(textX, lineY, WIDTH - PAD - textX, 1, COLOR.line));
    }
  }

  // ---------- 页脚 ----------
  y += 4;
  const footY = y + 18;
  ops.push((c) => c.text('JZClient 生成  ·  made by laolibuhuifei',
    PAD, footY, { size: FONT.small, color: COLOR.faint }));
  const height = footY + 22;

  const canvas = new Canvas(WIDTH, height, '#ffffff');
  for (const op of ops) op(canvas);
  return { canvas, png: canvas.toPNG(), width: WIDTH, height, count: arr.length };
}

module.exports = { renderSearch, WIDTH, COVER_W, COVER_H };
