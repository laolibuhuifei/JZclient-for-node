'use strict';
// 小红书搜索结果 -> 一张带封面的图
// 布局对齐 bili-search：序号徽章 + 封面 + 两行标题 + 作者，底部提示回复命令。
const image = require('./image');
const { Canvas } = require('./canvas');

const WIDTH = 720;
const PAD = 28;
const COVER_W = 200;
const COVER_H = 150;          // 小红书封面 3:4，比 B 站高
const COVER_REQ_W = 240;
const COVER_REQ_H = 180;
const BADGE = 40;
const ROW_H = 170;
const GAP = 20;

const COLOR = {
  red: '#ff2442',
  white: '#ffffff',
  text: '#1a1a1a',
  name: '#666666',
  mute: '#999999',
  faint: '#c8c8c8',
  line: '#f0f0f0',
  placeholder: '#efeff1',
};
const FONT = { head: 22, keyword: 30, meta: 21, title: 23, small: 19, badge: 22 };

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min > 0 ? min : def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function fitText(m, text, size, maxW, bold) {
  const s = String(text == null ? '' : text);
  if (m.measure(s, size, bold) <= maxW) return s;
  let t = s;
  while (t.length > 1 && m.measure(t + '…', size, bold) > maxW) t = t.slice(0, -1);
  return t + '…';
}

async function renderSearch(list, opts) {
  const o = opts || {};
  const keyword = String(o.keyword || '').trim();
  const arr = (Array.isArray(list) ? list : []).slice(0, clampInt(o.limit, 1, 10, 10));

  const covers = await image.loadMany(
    arr.map((x) => ({ url: x.cover, w: COVER_REQ_W, h: COVER_REQ_H })),
    { concurrency: 5, timeout: o.timeout || 8000 }
  );

  const m = new Canvas(1, 1);
  const ops = [];
  const headH = 104;
  ops.push((c) => c.fillRect(0, 0, WIDTH, headH, COLOR.red));
  ops.push((c) => c.text('小红书 · 搜索', PAD, 36, { size: FONT.head, color: '#ffd9de' }));
  const kw = fitText(m, keyword || '(空)', FONT.keyword, WIDTH - PAD * 2, true);
  ops.push((c) => c.text(kw, PAD, 78, { size: FONT.keyword, color: COLOR.white, bold: true }));

  let y = headH + 34;
  ops.push((c) => c.text('找到 ' + arr.length + ' 条  ·  回复 /小红书 播放 序号',
    PAD, y, { size: FONT.meta, color: COLOR.mute }));
  y += 18;
  ops.push((c) => c.fillRect(PAD, y, WIDTH - PAD * 2, 1, COLOR.line));
  y += 20;

  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] || {};
    const top = y;
    const cover = covers[i];

    const badgeY = top + (COVER_H - BADGE) / 2;
    ops.push((c) => c.roundRect(PAD, badgeY, BADGE, BADGE, 10, COLOR.red));
    const num = String(it.index || (i + 1));
    const nw = m.measure(num, FONT.badge, true);
    ops.push((c) => c.text(num, PAD + (BADGE - nw) / 2, badgeY + 27,
      { size: FONT.badge, color: COLOR.white, bold: true }));

    const coverX = PAD + BADGE + 12;
    if (cover) {
      ops.push((c) => c.drawImage(cover, coverX, top, COVER_W, COVER_H, { round: 8 }));
    } else {
      ops.push((c) => c.roundRect(coverX, top, COVER_W, COVER_H, 8, COLOR.placeholder));
    }

    // 视频/图文角标
    const tag = it.video ? '视频' : '图文';
    const tw = m.measure(tag, FONT.small, false) + 12;
    const tx = coverX + COVER_W - tw - 6;
    const ty = top + COVER_H - 26;
    ops.push((c) => c.roundRect(tx, ty, tw, 20, 4, 'rgba(0,0,0,0.55)'));
    ops.push((c) => c.text(tag, tx + 6, ty + 15, { size: FONT.small, color: COLOR.white }));

    const textX = coverX + COVER_W + 16;
    const textW = WIDTH - PAD - textX;
    const allLines = m.wrap(String(it.title || '(无标题)'), FONT.title, textW, false);
    const titleLines = allLines.slice(0, 2);
    if (allLines.length > 2) {
      let last = titleLines[1] || '';
      while (last.length > 1 && m.measure(last + '…', FONT.title, false) > textW) last = last.slice(0, -1);
      titleLines[1] = last + '…';
    }
    const blockH = titleLines.length * 32 + 26;
    const contentTop = top + Math.max(0, (COVER_H - blockH) / 2);
    titleLines.forEach((ln, k) => {
      const by = contentTop + 19 + k * 32;
      ops.push((c) => c.text(ln, textX, by, { size: FONT.title, color: COLOR.text }));
    });
    const meta = fitText(m, it.author ? '@' + it.author : '', FONT.small, textW, false);
    ops.push((c) => c.text(meta, textX, contentTop + 19 + titleLines.length * 32 + 4,
      { size: FONT.small, color: COLOR.name }));

    y += ROW_H;
    if (i < arr.length - 1) ops.push((c) => c.fillRect(textX, y - GAP / 2, WIDTH - PAD - textX, 1, COLOR.line));
  }

  y += 4;
  const footY = y + 18;
  ops.push((c) => c.text('JZClient 生成  ·  made by laolibuhuifei', PAD, footY, { size: FONT.small, color: COLOR.faint }));
  const height = footY + 22;

  const canvas = new Canvas(WIDTH, height, '#ffffff');
  for (const op of ops) op(canvas);
  return { canvas, png: canvas.toPNG(), width: WIDTH, height, count: arr.length };
}

module.exports = { renderSearch };
