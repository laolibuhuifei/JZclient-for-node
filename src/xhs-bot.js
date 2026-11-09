'use strict';
// 小红书点播的纯逻辑：命令解析 / 结果排版。
// 和 bili-bot.js 分开，命令带 /小红书 前缀，避免和 B 站抢同一句话。
const MAX_RESULTS = 10;
const SEARCH_TTL = 30 * 60 * 1000;

const HELP = [
  '小红书用法：',
  '/小红书 搜索 关键词 —— 找笔记，回前 10 条并标序号',
  '/小红书 播放 序号 —— 发第 N 条（视频发视频，图文发图片+正文）',
  '/小红书 历史 —— 最近点播过的',
  '/小红书 播放历史 序号 —— 重发历史里的第 N 条',
  '/小红书 收藏 —— 收藏最近一条  /小红书 收藏列表  /小红书 播放收藏 序号',
  '/小红书 私信列表 —— 看会话  /小红书 私信 发 会话名 内容',
  '/小红书 帮助 —— 看这段说明',
  'B 站仍然是 /搜索、/播放，两边互不影响。',
].join('\n');

const OUT_OF_SCOPE = '这条会话没开小红书点播。去「微聊 → 小红书点播」把本会话勾上再发。';

// 只认行首「/小红书」或「/xhs」；全角斜杠、大小写、中英文冒号都兼容。
// 不带斜杠也认「小红书 搜索 xxx」，但必须带参数，避免正常聊天被误判。
function parseCommand(text) {
  const raw = String(text || '').trim().replace(/^／/, '/');
  if (!raw) return null;
  const slash = raw.charAt(0) === '/';
  const body = slash ? raw.slice(1) : raw;
  const m = body.match(/^(?:小红书|xhs|red)(?:[\s:：]+([\s\S]*))?$/i);
  if (!m) return null;
  const rest = String(m[1] || '').trim();
  if (!rest) return { kind: 'help' };
  // 先匹配结构化的子命令，避免「播放历史」被当成「播放」
  let m2 = rest.match(/^(?:播放历史|历史播放|history\s*play)(?:[\s:：]+([\s\S]*))?$/i);
  if (m2) return { kind: 'playHistory', arg: String(m2[1] || '').trim() };
  m2 = rest.match(/^(?:播放收藏|收藏播放|fav\s*play)(?:[\s:：]+([\s\S]*))?$/i);
  if (m2) return { kind: 'playFav', arg: String(m2[1] || '').trim() };
  m2 = rest.match(/^(?:收藏列表|收藏夹|fav\s*list)$/i);
  if (m2) return { kind: 'favList' };
  m2 = rest.match(/^(?:历史|history)$/i);
  if (m2) return { kind: 'history' };
  m2 = rest.match(/^(?:收藏|fav)$/i);
  if (m2) return { kind: 'save' };
  m2 = rest.match(/^(?:私信列表|会话列表|dm\s*list)$/i);
  if (m2) return { kind: 'dmList' };
  m2 = rest.match(/^私信[\s:：]+(?:发|发送|send)[\s:：]+(\S+)[\s:：]+([\s\S]+)$/i);
  if (m2) return { kind: 'dmSend', to: m2[1], text: m2[2].trim() };

  const s = rest.match(/^(?:搜索|搜|search|s)(?:[\s:：]+([\s\S]*))?$/i);
  if (s) return { kind: 'search', arg: String(s[1] || '').trim() };
  const p = rest.match(/^(?:播放|play|p)(?:[\s:：]+([\s\S]*))?$/i);
  if (p) return { kind: 'play', arg: String(p[1] || '').trim() };
  if (/^(?:帮助|help|用法)$/i.test(rest)) return { kind: 'help' };
  return null;
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function fmtDuration(sec) {
  const n = Number(sec) || 0;
  if (!n) return '';
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function formatList(keyword, items) {
  const arr = Array.isArray(items) ? items : [];
  const head = '[小红书]「' + clip(keyword, 20) + '」找到 ' + arr.length + ' 条，回复 /小红书 播放 序号 观看';
  const lines = arr.map((x) => x.index + '. ' + clip(x.title || '无标题', 26)
    + (x.author ? ' · ' + clip(x.author, 10) : '')
    + (x.video ? '' : '（图文）'));
  return head + '\n' + lines.join('\n');
}

module.exports = { MAX_RESULTS, SEARCH_TTL, HELP, OUT_OF_SCOPE, parseCommand, clip, formatList, fmtDuration };
