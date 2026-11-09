'use strict';
// 防风控层：限制自动化频率，给每次操作加人类化的随机间隔。
//
// 小红书的风控不只看请求头，也看行为节奏：几秒内连续开页、翻页、点发布，
// 比正常用户快一个数量级，很容易被判成脚本。这里做四件事：
//   1. 全局最小间隔 + 随机抖动（串行，永不并发）
//   2. 每日配额（搜索 / 发布 / 私信分开算）
//   3. 一键暂停（暂停后所有动作直接拒绝）
//   4. 记录今天用了多少，界面上看得见
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const FILE = path.join(DATA, 'safety.json');

const DEFAULTS = {
  paused: false,
  readOnly: false,   // 只读：禁止发布和私信，只允许搜索/看视频（风险最低）
  minIntervalMs: 8000,   // 两次动作之间至少 8 秒
  jitterMs: 5000,        // 再随机等 0-5 秒
  daily: { search: 30, note: 60, publish: 3, dm: 20 },
  used: { date: '', search: 0, note: 0, publish: 0, dm: 0 },
  lastActionAt: 0,
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function load() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { raw = {}; }
  const s = Object.assign({}, DEFAULTS, raw);
  s.daily = Object.assign({}, DEFAULTS.daily, raw.daily || {});
  s.used = Object.assign({}, DEFAULTS.used, raw.used || {});
  if (s.used.date !== today()) {
    s.used = { date: today(), search: 0, note: 0, publish: 0, dm: 0 };
  }
  return s;
}

function save(s) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
}

function clamp(n, min, max, def) {
  n = Number(n);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function state() {
  const s = load();
  const now = Date.now();
  const nextAt = s.lastActionAt ? s.lastActionAt + s.minIntervalMs + s.jitterMs : 0;
  return {
    paused: !!s.paused,
    readOnly: !!s.readOnly,
    minIntervalMs: s.minIntervalMs,
    jitterMs: s.jitterMs,
    daily: s.daily,
    used: s.used,
    lastActionAt: s.lastActionAt,
    nextAllowedInMs: Math.max(0, nextAt - now),
  };
}

function update(patch) {
  const s = load();
  const p = patch || {};
  if (p.paused != null) s.paused = !!p.paused;
  if (p.readOnly != null) s.readOnly = !!p.readOnly;
  if (p.minIntervalMs != null) s.minIntervalMs = clamp(p.minIntervalMs, 3000, 120000, s.minIntervalMs);
  if (p.jitterMs != null) s.jitterMs = clamp(p.jitterMs, 0, 60000, s.jitterMs);
  if (p.daily && typeof p.daily === 'object') {
    for (const k of ['search', 'note', 'publish', 'dm']) {
      if (p.daily[k] != null) s.daily[k] = clamp(p.daily[k], 0, 500, s.daily[k]);
    }
  }
  save(s);
  return state();
}

// 所有需要访问小红书的动作都先过这里：配额 -> 间隔 -> 计数
async function before(kind) {
  const s = load();
  const k = ['search', 'note', 'publish', 'dm'].indexOf(kind) >= 0 ? kind : 'note';
  if (s.paused) {
    const e = new Error('自动化已暂停（防风控），先到设置里恢复');
    e.status = 423;
    throw e;
  }
  if (s.readOnly && (k === 'publish' || k === 'dm')) {
    const e = new Error('只读模式已开启：发布和私信被禁用');
    e.status = 423;
    throw e;
  }
  if (s.daily[k] === 0) {
    const e = new Error('今天已关闭「' + k + '」这类操作');
    e.status = 429;
    throw e;
  }
  if (s.used[k] >= s.daily[k]) {
    const e = new Error('今天的「' + k + '」额度已用完（' + s.used[k] + '/' + s.daily[k] + '）');
    e.status = 429;
    throw e;
  }
  // 人类化间隔：不足就等，最多等 25 秒，等太久直接让调用方稍后再来
  const need = s.lastActionAt + s.minIntervalMs + Math.floor(Math.random() * (s.jitterMs + 1));
  const wait = need - Date.now();
  if (wait > 25000) {
    const e = new Error('操作太频繁，请 ' + Math.ceil(wait / 1000) + ' 秒后再试');
    e.status = 429;
    throw e;
  }
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  s.used[k] += 1;
  s.lastActionAt = Date.now();
  save(s);
  return state();
}

module.exports = { state, update, before, load };
