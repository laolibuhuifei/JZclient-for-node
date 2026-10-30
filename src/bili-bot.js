// 微聊 B 站点播的纯逻辑：命令解析 / 结果排版 / 每日配额。
//
// 单独拆一个文件是为了能直接单测 —— 这里不碰网络、不碰 IM，
// 只做「这段文本是不是命令」「结果怎么排版」「今天还能点几条」这类判断。
// 真正的搜索和下载在 bilibili.js，收发消息在 webui.js。
'use strict';

const { fmtDuration } = require('./bilibili');

const MAX_RESULTS = 10;                  // 一次只给 10 条，序号好记
const SEARCH_TTL = 30 * 60 * 1000;       // 搜索结果保留 30 分钟，过期要重新搜

const HELP = [
  'B 站点播用法：',
  '/搜索 关键词 —— 找视频，回前 10 条并标上序号',
  '/播放 序号 —— 把上一条搜索结果里的第 N 条发过来',
  '例：先发「/搜索 小猪佩奇」，再发「/播放 2」',
].join('\n');

// 只认行首的 /命令；全角斜杠、大小写、中英文冒号都兼容。返回 null = 不是点播命令
function parseCommand(text) {
  const t = String(text || '').trim().replace(/^／/, '/');
  if (t.charAt(0) !== '/') return null;
  let m = t.match(/^\/(?:搜索|搜|search|s)(?:[\s:：]+([\s\S]*))?$/i);
  if (m) return { kind: 'search', arg: String(m[1] || '').trim() };
  m = t.match(/^\/(?:播放|点播|play|p)(?:[\s:：]+([\s\S]*))?$/i);
  if (m) return { kind: 'play', arg: String(m[1] || '').trim() };
  if (/^\/(?:b站|bili|点播帮助|help)$/i.test(t)) return { kind: 'help' };
  return null;
}

// 长标题在手表上会刷屏，统一截断
function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// 搜索结果排版：每行「序号. 标题 · UP主 · 时长」
function formatList(keyword, list) {
  const arr = Array.isArray(list) ? list : [];
  const head = '[点播]「' + clip(keyword, 20) + '」找到 ' + arr.length + ' 条，回复 /播放 序号 观看';
  const lines = arr.map((x) => x.index + '. ' + clip(x.title, 30)
    + ' · ' + (clip(x.author, 12) || '未知') + ' · ' + fmtDuration(x.duration));
  return head + '\n' + lines.join('\n');
}

// 配额按「本地日期」分桶，跨天自动归零（不用定时器，读的时候顺手判断）
function todayKey(now) {
  const d = now instanceof Date ? now : new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

// 取一次点播额度。返回 false = 今天用完了（limit 为 0 表示不限）
// store 是 Map<watchId, { day, n }>，跨天时直接把计数重置成 1
function takeQuota(store, wid, limit, now) {
  const cap = Number(limit) || 0;
  if (!cap) return true;
  const day = todayKey(now);
  const cur = store.get(String(wid));
  const n = (cur && cur.day === day) ? Number(cur.n) || 0 : 0;
  if (n >= cap) return false;
  store.set(String(wid), { day, n: n + 1 });
  return true;
}

// 退还一次额度：下载失败 / 发送失败时用，别让一次失败白占一个名额
function refundQuota(store, wid, now) {
  const day = todayKey(now);
  const cur = store.get(String(wid));
  if (!cur || cur.day !== day) return false;
  const n = Math.max(0, (Number(cur.n) || 0) - 1);
  store.set(String(wid), { day, n });
  return true;
}

module.exports = {
  MAX_RESULTS, SEARCH_TTL, HELP,
  parseCommand, clip, formatList, todayKey, takeQuota, refundQuota,
};
