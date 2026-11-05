// 手表端 H5 白名单链接库
//
// 数据格式只有一种：每行「名称<TAB>URL」，和用户手上的 白名单链接-名称对照.txt 一模一样。
//
// 这一版按「大表」重新设计过 —— 2026-11 那份已经有 25210 条 / 1.78MB，全量塞给浏览器
// 会直接把页面卡死（2.2MB JSON + 两万多个 <option>），所以：
//
//   1. 列表只从远端同步，地址写死：环境变量 JZ_LINKS_URL（云端平台注入）
//      > DEFAULT_REMOTE（官方链接库）。用户改不了，也没必要改。
//   2. 界面不再一次性拿全量列表，改成服务端搜索 GET /api/links/search?q=xxx，
//      每次只回 SEARCH_LIMIT 条。几万条里扫一遍只要 4ms，卡的是传输和 DOM。
//   3. 解析结果带 mtime + size 缓存，文件没变就不重复解析（内置表同样缓存）。
//
// 生效顺序（从高到低）：
//   1. ~/.watch-parent-cli/links.txt  —— 远端拉下来的那一份
//   2. src/link-presets.txt           —— 程序自带的内置表（首次启动 / 断网时的兜底）
//
// cfg.links.auto === false 时关掉自动同步（手动点「立即同步」仍然可用）。
//
// ⚠ 解析刻意做得宽松：TAB、空格、全角空格、竖线、逗号当分隔符都能认出来，
// 名称里带空格（「恐龙博物馆 · 上」）也不会被切坏 —— 定位方式是从行里找第一个 http(s)://
// 的位置，前面全算名称、后面全算 URL。

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.watch-parent-cli');
const USER_FILE = path.join(CONFIG_DIR, 'links.txt');
const META_FILE = path.join(CONFIG_DIR, 'links.meta.json');
const BUILTIN_FILE = path.join(__dirname, 'link-presets.txt');

// 上限按现在的量级放宽：10 万条 / 16MB / 单条 URL 2048 字符 / 名称 200 字
const LIMITS = { items: 100000, url: 2048, name: 200, bytes: 16 * 1024 * 1024 };

// 搜索一次最多回多少条。60 条够翻一屏，再多用户也不会滚
const SEARCH_LIMIT = 60;
const SEARCH_MAX = 500;

// 远端同步间隔：6 小时。平台的链接库一天改不了几次，没必要勤拉
const REFRESH_MS = 6 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 20000;   // 1.8MB 的纯文本，20 秒够慢网拉了

// 官方链接库。地址写死，用户在界面上改不了 —— 这份表由平台后台统一维护。
const DEFAULT_REMOTE = 'https://jz.laolibuhuifei.com/api/links.txt';

// 手动改过列表后，自动同步让位多久。老配置里留下的 manualAt 不该永久冻结同步
const MANUAL_HOLD_MS = 24 * 3600 * 1000;

// ---------- 解析 / 序列化 ----------

// 名称末尾的分隔符和装饰符号，去掉后更干净：「支付宝忘记密码」而不是「支付宝忘记密码 -」
const NAME_TAIL = /[\t|,，、:：;；\-–—\s]+$/;

function hostOf(url) {
  try { return new URL(url).host || url; } catch (e) { return url; }
}

// 统一去重键：小写 + 去掉末尾斜杠（https://a.com/ 和 https://a.com 当同一条）
function urlKey(url) {
  return String(url).trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * 把纯文本解析成 [{ name, url }]
 * 容忍：BOM、CRLF、空行、# 注释、各种分隔符、重复 URL（保留第一条）
 */
function parse(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const raw of lines) {
    if (out.length >= LIMITS.items) break;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // 从第一个 http(s):// 切开：前面是名称，后面是 URL
    const hit = /https?:\/\//i.exec(line);
    if (!hit) continue;

    let url = line.slice(hit.index).trim();
    let name = line.slice(0, hit.index).trim().replace(NAME_TAIL, '');

    // URL 里不可能有空白，遇到就截断（防止后面跟着备注文字）
    const sp = url.search(/\s/);
    if (sp > 0) url = url.slice(0, sp);
    if (url.length > LIMITS.url) continue;
    if (!/^https?:\/\/[^\s]+$/i.test(url)) continue;

    // 名称空了就拿域名顶上，至少界面上能区分
    if (!name) name = hostOf(url);
    if (name.length > LIMITS.name) name = name.slice(0, LIMITS.name - 1) + '…';

    const key = urlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, url });
  }
  return out;
}

/** 反向：列表 → 纯文本，永远是「名称<TAB>URL」 */
function format(list) {
  const rows = (list || []).map((x) => String(x.name || hostOf(x.url)) + '\t' + String(x.url || ''));
  return rows.length ? rows.join('\n') + '\n' : '';
}

// 搜索用的预处理：名称 + 网址拼一起转小写。建一次 3ms，之后每次搜索都是纯 indexOf
function lowerOf(list) {
  const low = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    low[i] = (list[i].name + ' ' + list[i].url).toLowerCase();
  }
  return low;
}

// ---------- 文件读写 ----------

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function statOrNull(file) {
  try { return fs.statSync(file); } catch (e) { return null; }
}

// 先写临时文件再 rename：进程被 kill 或断电时不会留下半截 JSON/半截链接表
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readMeta() {
  const raw = readText(META_FILE);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch (e) { return {}; }
}

function writeMeta(obj) {
  try { writeAtomic(META_FILE, JSON.stringify(obj, null, 2) + '\n'); } catch (e) { /* 记不上就记不上 */ }
}

// ---------- 内置表 ----------

let builtinCache = null;
function builtinIndex() {
  if (builtinCache) return builtinCache;
  const list = parse(readText(BUILTIN_FILE) || '');
  builtinCache = { list, low: lowerOf(list) };
  return builtinCache;
}

function builtinList() { return builtinIndex().list; }

// ---------- 当前生效的列表 ----------

// 用 mtime + size 做缓存键：几万条解析一次 14ms，不能每个请求都来一遍，
// 但远端同步 / 用户手改完要立刻看到新内容
let cache = null;

function currentIndex() {
  const st = statOrNull(USER_FILE);
  if (!st) return builtinIndex();
  if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache;
  const list = parse(readText(USER_FILE) || '');
  cache = { mtimeMs: st.mtimeMs, size: st.size, list, low: lowerOf(list) };
  return cache;
}

function currentList() { return currentIndex().list; }

function invalidate() { cache = null; }

// ---------- 搜索 ----------

/**
 * 服务端搜索。前端每敲一次字就调一次，所以必须便宜：
 * 只在预建的小写索引上做 indexOf，不构造对象、不排序。
 *
 * 多个关键词用空格分开，要求全部命中（「口袋 故事」能搜到「口袋故事」）。
 * q 为空时返回最前面 limit 条 —— 界面上会提示「输入关键词搜索」，这里只是兜底。
 *
 * @returns {{items:Array, matched:number, total:number, limit:number, offset:number, hasMore:boolean}}
 */
function search(q, opts) {
  const o = opts || {};
  let limit = Number(o.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = SEARCH_LIMIT;
  limit = Math.min(Math.floor(limit), SEARCH_MAX);
  let offset = Number(o.offset);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  offset = Math.floor(offset);

  const idx = currentIndex();
  const list = idx.list;
  const kw = String(q == null ? '' : q).trim().toLowerCase();
  const items = [];

  if (!kw) {
    const end = Math.min(list.length, offset + limit);
    for (let i = offset; i < end; i++) items.push(list[i]);
    return { items, matched: list.length, total: list.length, limit, offset, hasMore: end < list.length };
  }

  const terms = kw.split(/\s+/).filter(Boolean);
  const n = terms.length;
  const low = idx.low;
  let matched = 0;

  for (let i = 0; i < list.length; i++) {
    const s = low[i];
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (s.indexOf(terms[k]) < 0) { ok = false; break; }
    }
    if (!ok) continue;
    matched++;
    if (matched > offset && items.length < limit) items.push(list[i]);
  }

  return { items, matched, total: list.length, limit, offset, hasMore: offset + items.length < matched };
}

// ---------- 远端地址 ----------

/**
 * 远端地址：平台注入的 JZ_LINKS_URL 优先，否则官方链接库。
 * 参数留着只是为了不改调用点 —— 配置里的 remoteUrl 已经不再参与（用户改不了地址）。
 */
function remoteUrlOf() {
  const env = String(process.env.JZ_LINKS_URL || '').trim();
  if (env) return env;
  return DEFAULT_REMOTE;
}

// 自动同步开关：只有显式写 false 才算关（老配置里没有这个字段，按「开」处理）
function autoOn(cfg) {
  return !(cfg && cfg.links && cfg.links.auto === false);
}

// 只允许 http(s)：file:// / data: 这类拿来做本地文件读取或注入就麻烦了
function checkUrl(url) {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return '地址要以 http:// 或 https:// 开头';
  return '';
}

// ---------- 对外状态 ----------

/**
 * 给界面用的一份快照。默认**不带**链接列表 —— 几万条就是 2MB JSON，
 * 界面要用列表请走 search()。真需要全量（导出、测试）时传 { full: true }。
 */
function state(cfg, opts) {
  const meta = readMeta();
  const idx = currentIndex();
  const list = idx.list;
  const hasUser = !!statOrNull(USER_FILE);
  const builtin = statOrNull(BUILTIN_FILE);
  const envUrl = String(process.env.JZ_LINKS_URL || '').trim();

  let source = 'builtin';
  if (hasUser) source = meta.source === 'remote' ? 'remote' : 'user';

  const manualAt = Number(meta.manualAt) || 0;
  const out = {
    count: list.length,
    source,                              // builtin | user | remote
    updatedAt: Number(meta.at) || (hasUser ? (statOrNull(USER_FILE) || {}).mtimeMs : (builtin ? builtin.mtimeMs : 0)) || 0,
    remoteUrl: remoteUrlOf(),            // 实际生效的远端地址（平台注入 / 官方默认），只读
    remoteFromEnv: !!envUrl,             // 来自云端平台注入
    remoteDefault: !envUrl,              // 用的是官方默认地址
    auto: autoOn(cfg),                   // 自动同步开没开
    manualHold: source === 'user' && !!manualAt && Date.now() - manualAt < MANUAL_HOLD_MS,
    lastSyncAt: Number(meta.at) || 0,
    lastError: String(meta.lastError || ''),
    builtinCount: builtinList().length,
    searchLimit: SEARCH_LIMIT,
  };
  if (opts && opts.full) out.links = list;
  return out;
}

// ---------- 远端拉取 ----------

let fetching = null;   // 并发去重：定时器和用户点「立即同步」撞上时只发一次请求

/**
 * 从远端拉一份覆盖本地。失败不动现有数据，只把错误记进 meta。
 * @returns {Promise<{ok:boolean, count?:number, at?:number, notModified?:boolean, reason?:string, error?:string}>}
 */
function refresh(cfg, opts) {
  const o = opts || {};
  if (fetching && !o.force) return fetching;

  const url = String(o.url || remoteUrlOf() || '').trim();
  if (!url) return Promise.resolve({ ok: false, reason: 'no-url', error: '链接地址为空' });
  const bad = checkUrl(url);
  if (bad) return Promise.resolve({ ok: false, reason: 'bad-url', error: bad });

  fetching = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const meta = readMeta();
    try {
      const headers = { 'User-Agent': 'JZClientForNode-links/1.1' };
      // 同一个地址才带 ETag，换了地址还带旧 ETag 会被某些服务端当成不同资源
      if (meta.etag && meta.url === url) headers['If-None-Match'] = meta.etag;

      const r = await fetch(url, { headers, signal: ctrl.signal });
      if (r.status === 304) {
        writeMeta(Object.assign({}, meta, { url, at: Date.now(), lastError: '' }));
        return { ok: true, notModified: true, count: currentList().length, at: Date.now() };
      }
      if (!r.ok) throw new Error('远端返回 HTTP ' + r.status);

      const text = await r.text();
      if (Buffer.byteLength(text, 'utf8') > LIMITS.bytes) {
        throw new Error('远端内容超过 ' + Math.round(LIMITS.bytes / 1024 / 1024) + 'MB');
      }
      const list = parse(text);
      if (!list.length) throw new Error('远端内容里没有解析出任何链接');

      writeAtomic(USER_FILE, format(list));
      writeMeta({
        source: 'remote',
        url,
        at: Date.now(),
        etag: String(r.headers.get('etag') || ''),
        count: list.length,
        lastError: '',
      });
      invalidate();
      return { ok: true, count: list.length, at: Date.now() };
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      const friendly = e && e.name === 'AbortError' ? '拉取超时（20 秒）' : msg;
      writeMeta(Object.assign({}, meta, { lastError: friendly, lastErrorAt: Date.now() }));
      return { ok: false, reason: 'fetch-failed', error: friendly };
    } finally {
      clearTimeout(timer);
      fetching = null;
    }
  })();

  return fetching;
}

// ---------- 本地覆盖（界面不再暴露，留给脚本/排障用） ----------

/**
 * 保存一份本地文本。解析不出东西就抛错，不写盘 —— 免得一次手抖把库清空
 */
function saveText(text) {
  const raw = String(text == null ? '' : text);
  if (Buffer.byteLength(raw, 'utf8') > LIMITS.bytes) {
    throw new Error('内容太大了（上限 ' + Math.round(LIMITS.bytes / 1024 / 1024) + 'MB）');
  }
  const list = parse(raw);
  if (raw.trim() && !list.length) {
    throw new Error('没有解析出任何链接。格式是每行「名称<TAB>链接」，例如：支付宝忘记密码<TAB>https://...');
  }
  writeAtomic(USER_FILE, format(list));
  const meta = readMeta();
  // manualAt 是「手动改过」的记号：自动同步看到它就暂停（24 小时内），免得把人的改动冲掉。
  writeMeta({ source: 'local', url: meta.url || '', at: Date.now(), manualAt: Date.now(), count: list.length, lastError: '' });
  invalidate();
  return { count: list.length };
}

/** 丢掉本地覆盖，回到程序自带的内置表 */
function reset() {
  try { fs.unlinkSync(USER_FILE); } catch (e) { /* 本来就没有 */ }
  try { fs.unlinkSync(META_FILE); } catch (e) { /* 本来就没有 */ }
  invalidate();
  return { count: builtinList().length };
}

/** 当前生效那份的原始文本（导出 / 排障用） */
function currentText() {
  const raw = readText(USER_FILE);
  if (raw != null) return raw;
  return readText(BUILTIN_FILE) || '';
}

// ---------- 后台自动同步 ----------

let autoTimer = null;
let autoBoot = null;

function stopAutoRefresh() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (autoBoot) { clearTimeout(autoBoot); autoBoot = null; }
}

/**
 * 没关自动同步才起定时器。启动后 20 秒先跑一次（等 IM / WebUI 都起来），
 * 之后每小时看一次，距离上次同步不到 6 小时就跳过 —— 一小时一跳是为了「刚改了地址」能尽快生效。
 */
function startAutoRefresh(cfg, logger) {
  stopAutoRefresh();
  if (!autoOn(cfg)) return;
  if (!remoteUrlOf()) return;

  const tick = async () => {
    const meta = readMeta();
    // 手动改过就先别动，等他点「立即同步」恢复跟随远端；但只认 24 小时内
    const held = meta.source === 'local' && Number(meta.manualAt) &&
      Date.now() - Number(meta.manualAt) < MANUAL_HOLD_MS;
    if (held) return;
    const fresh = meta.source === 'remote' && Date.now() - Number(meta.at || 0) < REFRESH_MS;
    if (fresh) return;
    const r = await refresh(cfg, {});
    if (!logger) return;
    if (r.ok) {
      logger.info('links', `链接库已同步 ${r.count} 条` + (r.notModified ? '（远端未变）' : ''));
    } else if (r.reason !== 'no-url') {
      logger.warn('links', '链接库同步失败: ' + r.error);
    }
  };

  autoBoot = setTimeout(tick, 20000);
  if (autoBoot.unref) autoBoot.unref();
  autoTimer = setInterval(tick, 3600 * 1000);
  if (autoTimer.unref) autoTimer.unref();
}

module.exports = {
  parse, format,
  state, currentList, currentText, search,
  refresh, saveText, reset,
  remoteUrlOf, autoOn, checkUrl,
  startAutoRefresh, stopAutoRefresh,
  DEFAULT_REMOTE, SEARCH_LIMIT, SEARCH_MAX,
  // 测试用
  _paths: { USER_FILE, META_FILE, BUILTIN_FILE },
  _limits: LIMITS,
  _refreshMs: REFRESH_MS,
};
