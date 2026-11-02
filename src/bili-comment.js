// B 站评论抓取 + 渲染成一张长图（微聊点播的「评论区」配图）
//
// 抓取：官方 web 接口 /x/v2/reply/wbi/main（要 wbi 签名），匿名也能拿到几条热门，
//       配了 SESSDATA（B 站登录 Cookie）才能翻页拿全。
// 渲染：canvas.js 自己画字，png.js 自己压 PNG —— 全程零依赖，云端 Linux 实例也能跑。
//
// 两个已知的坑：
//   1. 不登录时 B 站只回 3 条热门评论，而且 cursor.is_end 直接是 true，翻不动页。
//      所以这里必须把「只拿到 3 条」这件事如实写进图里，不能让用户以为评论就这么点。
//   2. 评论接口只认 aid（数字），bvid 得先用 /x/web-interface/view 换一次。
'use strict';

const bili = require('./bilibili');
const image = require('./image');
const { Canvas } = require('./canvas');
const log = require('./logger');

// ---------- 外观 ----------

const WIDTH = 720;            // 长图宽度：手表现在普遍 400~480 逻辑宽，720 在手机上看也清楚
const PAD = 28;
const COLOR = {
  pink: '#fb7299',
  pinkSoft: '#ffe9ef',
  title: '#ffffff',
  text: '#18191c',
  name: '#61666d',
  mute: '#9499a0',
  faint: '#c0c4cc',
  line: '#f1f2f3',
  box: '#f6f7f8',
  warn: '#ff8f1f',
};
const FONT = { name: 25, body: 26, sub: 23, meta: 22, small: 20, title: 30 };
const LINE = { body: 36, sub: 32, name: 26 };

// 头像在图上画成 44×44（半径 22），向图床要 2 倍尺寸，缩下来才不糊。
// 要 88×88 的 PNG 大约 6KB，比原图（通常是几百 KB 的 jpg）省得多。
const AVATAR_SIZE = 44;
const AVATAR_REQ = AVATAR_SIZE * 2;

// 头像底色：按用户名哈希取一个，同一个人每次都是同一个颜色
const AVATAR_COLORS = [
  '#fb7299', '#4a90d9', '#5cb85c', '#f0ad4e', '#9b6bd6',
  '#3fa9a0', '#e2694a', '#7a8fd6', '#c96fa8', '#5a9e6f',
];

// ---------- 小工具 ----------

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// 12345 -> 1.2万（评论数/播放量在图上只是点缀，别占地方）
function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(v);
}

function fmtTime(sec) {
  const t = Number(sec) || 0;
  if (!t) return '';
  const d = new Date(t * 1000);
  const p = (x) => String(x).padStart(2, '0');
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  if (diff < 30 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// 评论正文里偶尔有控制字符和零宽字符，画出来是空白方块，先清掉
function cleanMessage(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function avatarColor(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// ---------- 抓评论 ----------

function buildCookie(sessdata) {
  return (async () => {
    let cookie = '';
    try { cookie = await bili.getCookie(); } catch (e) { /* 没 buvid 也能试 */ }
    const sd = String(sessdata || '').trim();
    if (sd) cookie = (cookie ? cookie + '; ' : '') + 'SESSDATA=' + sd;
    return cookie;
  })();
}

function toQuery(params) {
  return Object.keys(params)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])))
    .join('&');
}

// 一条评论 -> 统一的内部结构
function normalizeReply(r, ownerMid) {
  const m = (r && r.member) || {};
  const c = (r && r.content) || {};
  return {
    rpid: String(r.rpid || ''),
    mid: String(m.mid || r.mid || ''),
    uname: String(m.uname || '匿名用户'),
    // 头像地址：拿不到就留空，渲染时退回「首字色块」
    avatar: String(m.avatar || m.face || ''),
    isUp: ownerMid != null && String(r.mid || '') === String(ownerMid),
    like: Number(r.like) || 0,
    ctime: Number(r.ctime) || 0,
    message: cleanMessage(c.message),
    rcount: Number(r.rcount) || 0,
    subs: Array.isArray(r.replies) ? r.replies.map((x) => ({
      uname: String((x.member && x.member.uname) || '匿名用户'),
      isUp: ownerMid != null && String(x.mid || '') === String(ownerMid),
      message: cleanMessage((x.content && x.content.message) || ''),
      like: Number(x.like) || 0,
    })) : [],
  };
}

// 拉一页主楼评论。返回 { list, nextOffset, next, isEnd, allCount }
async function fetchPage(aid, cookie, state) {
  const params = {
    oid: aid,
    type: 1,
    mode: 3,              // 3 = 热门评论；翻页靠 offset，不需要 sort 参数
    plat: 1,
    web_location: 1315875,
  };
  let useNext = !!state.useNext;
  if (useNext) params.next = state.next == null ? 0 : state.next;
  else params.pagination_str = JSON.stringify({ offset: state.offset || '' });

  const headers = { Cookie: cookie };
  let r = null;
  const mixin = await bili.getMixinKey();
  if (mixin) {
    r = await bili.httpJson(bili.API + '/x/v2/reply/wbi/main?' + bili.wbiSign(params, mixin), { headers });
  } else {
    r = await bili.httpJson(bili.API + '/x/v2/reply/main?' + toQuery(params), { headers });
  }
  if (!r) throw new Error('评论接口无响应');
  if (r.code !== 0) throw new Error('评论接口返回 ' + (r.message || ('code=' + r.code)));

  const d = r.data || {};
  const cur = d.cursor || {};
  const pr = cur.pagination_reply || {};
  return {
    list: Array.isArray(d.replies) ? d.replies : [],
    nextOffset: pr.next_offset || '',
    next: cur.next,
    isEnd: cur.is_end !== false,
    allCount: Number(cur.all_count) || 0,
  };
}

// 楼中楼：主楼里自带的 replies 只有 3 条，想多看就得单独拉
async function fetchSubs(aid, root, cookie, want) {
  const qs = toQuery({ type: 1, oid: aid, root, ps: Math.max(10, want), pn: 1 });
  const r = await bili.httpJson(bili.API + '/x/v2/reply/reply?' + qs, { headers: { Cookie: cookie } });
  if (!r || r.code !== 0) return [];
  const arr = (r.data && r.data.replies) || [];
  return arr.map((x) => ({
    uname: String((x.member && x.member.uname) || '匿名用户'),
    isUp: false,
    message: cleanMessage((x.content && x.content.message) || ''),
    like: Number(x.like) || 0,
  }));
}

// 主入口：拿一个视频的全部（能拿到的）评论
// opts: { maxComments, maxPages, subLimit, sessdata, avatars }
// avatars=false 时跳过头像下载（只要文字的场景能省一两秒）
async function fetchComments(bvid, opts) {
  const o = opts || {};
  const maxComments = clampInt(o.maxComments, 1, 300, 60);
  const maxPages = clampInt(o.maxPages, 1, 30, 10);
  const subLimit = clampInt(o.subLimit, 0, 10, 3);

  const info = await bili.getVideoInfo(bvid);
  const aid = info.aid;
  if (!aid) throw new Error('拿不到这个视频的 aid，评论接口用不了');
  const cookie = await buildCookie(o.sessdata);
  // 注意这只是「填没填 SESSDATA」，不代表 B 站认了这个 Cookie —— 失效的 Cookie
  // 一样能拿到前 3 条热门评论，所以图里要不要提示「评论不全」得看实际抓到的条数
  const hasSessdata = !!String(o.sessdata || '').trim();

  const state = { offset: '', next: null, useNext: false };
  const seen = new Set();
  const list = [];
  let allCount = Number(info.stat && info.stat.reply) || 0;
  let pages = 0;
  let stopped = '';        // 为什么停：'end' 正常到底 / 'cap' 到上限 / 'stuck' 翻不动了

  while (pages < maxPages && list.length < maxComments) {
    pages++;
    let page;
    try {
      page = await fetchPage(aid, cookie, state);
    } catch (e) {
      if (!list.length) throw e;
      log.warn('bili', '第 ' + pages + ' 页评论失败（保留已拿到的 ' + list.length + ' 条）：' + e.message);
      stopped = 'error';
      break;
    }
    if (page.allCount) allCount = page.allCount;

    let added = 0;
    for (const r of page.list) {
      const one = normalizeReply(r, info.owner && info.owner.mid);
      if (!one.rpid || seen.has(one.rpid)) continue;
      seen.add(one.rpid);
      list.push(one);
      added++;
      if (list.length >= maxComments) break;
    }

    if (list.length >= maxComments) { stopped = 'cap'; break; }
    if (page.isEnd) { stopped = 'end'; break; }
    if (!added) { stopped = 'stuck'; break; }

    // 优先用 pagination_str 的 offset，拿不到就退回 cursor.next
    if (page.nextOffset) {
      state.offset = page.nextOffset;
    } else if (page.next != null && page.next !== state.next) {
      state.useNext = true;
      state.next = page.next;
    } else {
      stopped = 'stuck';
      break;
    }
  }

  // 楼中楼：主楼自带的够用就不再多打接口；不够才补，且给个总次数上限
  if (subLimit > 0) {
    let budget = 12;
    for (const c of list) {
      if (budget <= 0) break;
      if (c.rcount <= c.subs.length) continue;
      if (c.subs.length >= subLimit) continue;
      budget--;
      try {
        const more = await fetchSubs(aid, c.rpid, cookie, subLimit);
        if (more.length) c.subs = more.slice(0, subLimit);
      } catch (e) {
        log.debug('bili', '拉楼中楼失败 ' + c.rpid + ': ' + e.message);
      }
    }
  }
  for (const c of list) {
    if (c.subs.length > subLimit) c.subs = c.subs.slice(0, subLimit);
  }

  // 头像：一次并行拉完，拿不到的那几条保持「首字色块」。
  // 放在这里而不是 renderComments 里，是为了让渲染保持同步（纯排版），
  // 也方便「只要文字不要图」的调用方传 avatars:false 直接跳过。
  if (o.avatars !== false && list.length) {
    const imgs = await image.loadMany(
      list.map((c) => ({ url: c.avatar, w: AVATAR_REQ, h: AVATAR_REQ })),
      { concurrency: 6 }
    );
    let got = 0;
    for (let i = 0; i < list.length; i++) {
      if (imgs[i]) { list[i].avatarImg = imgs[i]; got++; }
    }
    log.debug('bili', '评论头像 ' + got + '/' + list.length + ' 张取到');
  }

  return {
    bvid,
    aid,
    title: String(info.title || ''),
    owner: String((info.owner && info.owner.name) || ''),
    ownerMid: String((info.owner && info.owner.mid) || ''),
    view: Number(info.stat && info.stat.view) || 0,
    danmaku: Number(info.stat && info.stat.danmaku) || 0,
    total: allCount,
    list,
    hasSessdata,
    stopped,
    // 到底有没有抓全：条数够不上总数就不算全，别在图上假装抓全了
    complete: allCount > 0 ? list.length >= allCount : stopped === 'end',
  };
}

// ---------- 渲染 ----------

// 量字宽用的小画布：只要字体，不要像素
function makeMeasurer() {
  return new Canvas(1, 1);
}

// 画一个小心心（两个圆 + 一个三角），比去字库里找 ♥ 稳
function drawHeart(c, cx, cy, r, color) {
  c.circle(cx - r * 0.45, cy - r * 0.3, r * 0.52, color);
  c.circle(cx + r * 0.45, cy - r * 0.3, r * 0.52, color);
  c.polygon([
    [cx - r * 0.94, cy - r * 0.12],
    [cx + r * 0.94, cy - r * 0.12],
    [cx, cy + r],
  ], color);
}

// 一条评论排版。topY 是这条评论的起始 y，返回 { ops, height }
// ops 是一组闭包，最后统一在真画布上跑 —— 这样「先量后画」不用写两套排版逻辑
function layoutComment(m, item, topY) {
  const ops = [];
  const textX = PAD + 56;
  const textW = WIDTH - textX - PAD;
  const avatarCx = PAD + 22;
  const avatarR = 22;

  // 头像：有真头像就画图（裁成圆），没有就退回「首字色块」
  // 色块照画 —— 图床的头像可能带透明通道，底下垫一层同色圆边不会露白
  const avatarCy = topY + 26;
  ops.push((c) => c.circle(avatarCx, avatarCy, avatarR, avatarColor(item.uname)));
  if (item.avatarImg) {
    const img = item.avatarImg;
    ops.push((c) => c.drawImage(img, avatarCx - avatarR, avatarCy - avatarR,
      avatarR * 2, avatarR * 2, { circle: true }));
  } else {
    const initial = Array.from(item.uname)[0] || '?';
    const iw = m.measure(initial, 26, false);
    ops.push((c) => c.text(initial, avatarCx - iw / 2, topY + 36, { size: 26, color: '#ffffff' }));
  }

  // 昵称（太长就按实际字宽截断，别压到右边的点赞数上）
  const nameBase = topY + 26;
  const nameMax = textW - 130;      // 右边要给点赞数留位置
  let nameText = String(item.uname || '匿名用户');
  if (m.measure(nameText, FONT.name, false) > nameMax) {
    while (nameText.length > 1 && m.measure(nameText + '…', FONT.name, false) > nameMax) {
      nameText = nameText.slice(0, -1);
    }
    nameText += '…';
  }
  ops.push((c) => c.text(nameText, textX, nameBase, {
    size: FONT.name,
    color: item.isUp ? COLOR.pink : COLOR.name,
  }));
  let badgeX = textX + m.measure(nameText, FONT.name, false) + 10;

  // UP 主标记
  if (item.isUp) {
    const bw = m.measure('UP', 17, true) + 14;
    // 和正文一样：闭包按引用捕获 badgeX，不抓成常量的话徽章会画到「加完之后」的位置上，
    // 正好压住后面的时间
    const bx = badgeX;
    ops.push((c) => c.roundRect(bx, nameBase - 16, bw, 22, 6, COLOR.pink));
    ops.push((c) => c.text('UP', bx + 7, nameBase + 1, { size: 17, color: '#ffffff', bold: true }));
    badgeX += bw + 8;
  }
  // 时间
  const timeText = fmtTime(item.ctime);
  if (timeText) {
    const tW = m.measure(timeText, FONT.small, false);
    const tx = badgeX;
    if (tx + tW < textX + nameMax) {
      ops.push((c) => c.text(timeText, tx, nameBase - 1, { size: FONT.small, color: COLOR.faint }));
    }
  }

  // 点赞数（右对齐，带小心心）
  if (item.like > 0) {
    const likeText = fmtCount(item.like);
    const lw = m.measure(likeText, FONT.small, false);
    const lx = WIDTH - PAD - lw;
    ops.push((c) => c.text(likeText, lx, nameBase - 1, { size: FONT.small, color: COLOR.mute }));
    ops.push((c) => drawHeart(c, lx - 13, nameBase - 8, 7, COLOR.mute));
  }

  // 正文
  const bodyText = clip(item.message, 1200);
  const bodyLines = bodyText ? m.wrap(bodyText, FONT.body, textW, false) : ['（这条评论没有文字）'];
  let y = nameBase + 42;
  for (const ln of bodyLines) {
    // ⚠️ 必须把当次的行位置抓成常量：闭包按引用捕获 y，直接写 y 会让所有行都画在最后一行
    const by = y;
    ops.push((c) => c.text(ln, textX, by, { size: FONT.body, color: COLOR.text }));
    y += LINE.body;
  }

  // 楼中楼
  if (item.subs && item.subs.length) {
    const boxTop = y - 8;
    const boxW = textW;
    const innerX = textX + 14;
    const innerW = boxW - 28;
    let sy = boxTop + 14 + 24;          // 第一行基线
    const subOps = [];
    for (const s of item.subs) {
      const head = s.uname + '：';
      const full = head + clip(s.message, 300);
      const lines = m.wrap(full, FONT.sub, innerW, false);
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const lineY = sy;
        if (i === 0) {
          const cut = Math.min(head.length, ln.length);
          const h = ln.slice(0, cut);
          const rest = ln.slice(cut);
          subOps.push((c) => {
            const hw = c.text(h, innerX, lineY, { size: FONT.sub, color: s.isUp ? COLOR.pink : COLOR.name });
            if (rest) c.text(rest, innerX + hw, lineY, { size: FONT.sub, color: COLOR.text });
          });
        } else {
          subOps.push((c) => c.text(ln, innerX, lineY, { size: FONT.sub, color: COLOR.text }));
        }
        sy += LINE.sub;
      }
      sy += 4;
    }
    // 「还有 N 条回复」
    if (item.rcount > item.subs.length) {
      const more = '共 ' + item.rcount + ' 条回复';
      const moreY = sy + 2;
      subOps.push((c) => c.text(more, innerX, moreY, { size: FONT.small, color: COLOR.mute }));
      sy += 26;
    }
    const boxH = sy - boxTop + 6;
    ops.push((c) => c.roundRect(textX, boxTop, boxW, boxH, 10, COLOR.box));
    ops.push(...subOps);
    y = boxTop + boxH;
  }

  // 底部留白 + 分隔线（最后一条不画，交给调用方决定）
  const height = Math.max(y + 18, topY + 26 + avatarR + 18) - topY;
  return { ops, height };
}

// 把抓到的评论渲染成 PNG
// opts: { maxHeight, maxComments }
function renderComments(data, opts) {
  const o = opts || {};
  const maxHeight = clampInt(o.maxHeight, 1200, 30000, 12000);
  const m = makeMeasurer();

  const titleLines = m.wrap(String(data.title || '(无标题)'), FONT.title, WIDTH - PAD * 2, true);
  let titles = titleLines.slice(0, 2);
  if (titleLines.length > 2) {
    let last = titles[1];
    while (last.length > 1 && m.measure(last + '…', FONT.title, true) > WIDTH - PAD * 2) last = last.slice(0, -1);
    titles = [titles[0], last + '…'];
  }

  const ops = [];
  // 表头
  const titleBase = 82;
  const headH = titleBase + (titles.length - 1) * 40 + 30;
  ops.push((c) => c.fillRect(0, 0, WIDTH, headH, COLOR.pink));
  ops.push((c) => c.text('哔哩哔哩 · 评论区', PAD, 36, { size: FONT.meta, color: '#ffe3ea' }));
  titles.forEach((ln, i) => {
    const by = titleBase + i * 40;
    ops.push((c) => c.text(ln, PAD, by, { size: FONT.title, color: COLOR.title, bold: true }));
  });

  // 元信息条
  // ⚠️ 所有闭包都先把 y 抓成常量再进 push：按引用捕获会全部画到最后一个 y 上
  let y = headH + 34;
  const meta = [];
  if (data.owner) meta.push('UP主 ' + data.owner);
  if (data.view) meta.push('播放 ' + fmtCount(data.view));
  if (data.total) meta.push('评论 ' + fmtCount(data.total));
  meta.push('按热度');
  if (meta.length) {
    const metaText = meta.join('  ·  ');
    const metaY = y;
    ops.push((c) => c.text(metaText, PAD, metaY, { size: FONT.meta, color: COLOR.mute }));
  }
  y += 18;
  // 评论明显没抓全时说清楚原因，别让人以为这个视频就这几条评论
  const shortOf = (data.total || 0) - data.list.length;
  let warnText = '';
  if (!data.hasSessdata && !data.complete) {
    warnText = '未登录 B 站账号，只能取到热门评论';
  } else if (shortOf > 0 && data.stopped === 'end') {
    warnText = '只取到 ' + data.list.length + ' 条（SESSDATA 可能已失效，或评论被折叠）';
  }
  if (warnText) {
    y += 30;
    const warnY = y;
    ops.push((c) => c.text(warnText, PAD, warnY, { size: FONT.small, color: COLOR.warn }));
  }
  y += 22;
  const divY = y;
  ops.push((c) => c.fillRect(PAD, divY, WIDTH - PAD * 2, 1, COLOR.line));
  y += 24;

  // 评论列表
  let shown = 0;
  for (const item of data.list) {
    const { ops: itemOps, height } = layoutComment(m, item, y);
    // 底部还要留出页脚，塞不下就到此为止
    if (y + height > maxHeight - 120) break;
    ops.push(...itemOps);
    y += height;
    shown++;
    const lineY = y - 9;
    ops.push((c) => c.fillRect(PAD, lineY, WIDTH - PAD * 2, 1, COLOR.line));
  }

  if (!shown) {
    const emptyY = y + 30;
    ops.push((c) => c.text('这个视频还没有评论', PAD, emptyY, { size: FONT.body, color: COLOR.mute }));
    y += 70;
  }

  // 页脚：说清楚「只画了一部分」比含糊的「还有 N 条」好懂
  const hidden = Math.max(0, (data.total || data.list.length) - shown);
  const footParts = [];
  if (hidden > 0) footParts.push('本图只画了 ' + shown + ' 条，共 ' + data.total + ' 条');
  footParts.push('JZClient 生成');
  footParts.push('made by laolibuhuifei');
  const footText = footParts.join('  ·  ');
  y += 26;
  const footY = y;
  ops.push((c) => c.text(footText, PAD, footY, { size: FONT.small, color: COLOR.faint }));
  const height = Math.min(maxHeight, y + 28);

  // 真画布
  const c = new Canvas(WIDTH, height, '#ffffff');
  for (const op of ops) op(c);
  return { canvas: c, png: c.toPNG(), width: WIDTH, height, shown };
}

module.exports = {
  WIDTH, COLOR, FONT,
  fetchComments, renderComments, layoutComment,
  fmtCount, fmtTime, clip, cleanMessage, avatarColor,
};
