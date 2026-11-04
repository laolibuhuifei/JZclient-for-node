// 手表端 H5 白名单链接库
//
// 数据格式只有一种：每行「名称<TAB>URL」，和用户手上的 白名单链接-名称对照.txt 一模一样。
// 这样管理员在云端后台粘一份 txt、用户在 WebUI 里直接改文本，都不用碰 JSON 转义。
//
// 生效顺序（从高到低）：
//   1. ~/.watch-parent-cli/links.txt  —— 当前生效的那一份（远端拉下来的 / 用户手改的）
//   2. src/link-presets.txt           —— 程序自带的内置表，装完就有 322 条
// 远端地址来自 cfg.links.remoteUrl，没填就看环境变量 JZ_LINKS_URL（云端平台启动实例时注入的）。
// 所以：本地部署版默认只用内置表，填了地址就能跟着平台走；云端托管版由平台统一下发。
//
// ⚠ 解析刻意做得宽松：TAB、空格、全角空格、竖线、逗号当分隔符都能认出来，
// 名称里带空格（「恐龙博物馆 · 上」）也不会被切坏 —— 定位方式是从行里找第一个 http(s)://
// 的位置，前面全算名称、后面全算 URL。管理员粘一份格式不太干净的 txt 也不至于全军覆没。

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.watch-parent-cli');
const USER_FILE = path.join(CONFIG_DIR, 'links.txt');
const META_FILE = path.join(CONFIG_DIR, 'links.meta.json');
const BUILTIN_FILE = path.join(__dirname, 'link-presets.txt');

// 上限：文件 2MB（322 条约 24KB，够放几百倍）、5000 条、单条 URL 2048 字符
const LIMITS = { items: 5000, url: 2048, name: 120, bytes: 2 * 1024 * 1024 };

// 远端同步间隔：6 小时。平台的链接库一天改不了几次，没必要勤拉
const REFRESH_MS = 6 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 15000;

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
function builtinList() {
  if (builtinCache) return builtinCache;
  const text = readText(BUILTIN_FILE);
  builtinCache = parse(text || '');
  return builtinCache;
}

// ---------- 当前生效的列表 ----------

// 用 mtime + size 做缓存键：每次请求都读 24KB 文件太浪费，但用户手改完要立刻看到
let cache = null;

function currentList() {
  const st = statOrNull(USER_FILE);
  if (!st) return builtinList();
  if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.list;
  const list = parse(readText(USER_FILE) || '');
  cache = { mtimeMs: st.mtimeMs, size: st.size, list };
  return list;
}

function invalidate() { cache = null; }

// ---------- 远端地址 ----------

// 用户自己填的优先，其次平台注入的环境变量。空字符串 = 不自动同步
function remoteUrlOf(cfg) {
  const own = cfg && cfg.links ? String(cfg.links.remoteUrl || '').trim() : '';
  if (own) return own;
  return String(process.env.JZ_LINKS_URL || '').trim();
}

// 只允许 http(s)：file:// / data: 这类拿来做本地文件读取或注入就麻烦了
function checkUrl(url) {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return '地址要以 http:// 或 https:// 开头';
  return '';
}

// ---------- 对外状态 ----------

/**
 * 给界面用的一份快照。links 是完整列表（几百条，前端自己分组/搜索）
 */
function state(cfg) {
  const meta = readMeta();
  const list = currentList();
  const hasUser = !!statOrNull(USER_FILE);
  const builtin = statOrNull(BUILTIN_FILE);
  const remoteUrl = remoteUrlOf(cfg);

  let source = 'builtin';
  if (hasUser) source = meta.source === 'remote' ? 'remote' : 'user';

  return {
    links: list,
    count: list.length,
    source,                              // builtin | user | remote
    updatedAt: Number(meta.at) || (hasUser ? (statOrNull(USER_FILE) || {}).mtimeMs : (builtin ? builtin.mtimeMs : 0)) || 0,
    remoteUrl,                           // 实际生效的远端地址（可能是环境变量来的）
    remoteFromEnv: !(cfg && cfg.links && String(cfg.links.remoteUrl || '').trim()) && !!remoteUrl,
    lastSyncAt: Number(meta.at) || 0,
    lastError: String(meta.lastError || ''),
    builtinCount: builtinList().length,
  };
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

  const url = String(o.url || remoteUrlOf(cfg) || '').trim();
  if (!url) return Promise.resolve({ ok: false, reason: 'no-url', error: '还没设置远端链接地址' });
  const bad = checkUrl(url);
  if (bad) return Promise.resolve({ ok: false, reason: 'bad-url', error: bad });

  fetching = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const meta = readMeta();
    try {
      const headers = { 'User-Agent': 'JZClientForNode-links/1.0' };
      // 同一个地址才带 ETag，换了地址还带旧 ETag 会被某些服务端当成不同资源
      if (meta.etag && meta.url === url) headers['If-None-Match'] = meta.etag;

      const r = await fetch(url, { headers, signal: ctrl.signal });
      if (r.status === 304) {
        writeMeta(Object.assign({}, meta, { url, at: Date.now(), lastError: '' }));
        return { ok: true, notModified: true, count: currentList().length, at: Date.now() };
      }
      if (!r.ok) throw new Error('远端返回 HTTP ' + r.status);

      const text = await r.text();
      if (Buffer.byteLength(text, 'utf8') > LIMITS.bytes) throw new Error('远端内容超过 2MB');
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
      const friendly = e && e.name === 'AbortError' ? '拉取超时（15 秒）' : msg;
      writeMeta(Object.assign({}, meta, { lastError: friendly, lastErrorAt: Date.now() }));
      return { ok: false, reason: 'fetch-failed', error: friendly };
    } finally {
      clearTimeout(timer);
      fetching = null;
    }
  })();

  return fetching;
}

// ---------- 本地编辑 ----------

/**
 * 保存用户手改的整份文本。解析不出东西就抛错，不写盘 —— 免得一次手抖把库清空
 */
function saveText(text) {
  const raw = String(text == null ? '' : text);
  if (Buffer.byteLength(raw, 'utf8') > LIMITS.bytes) throw new Error('内容太大了（上限 2MB）');
  const list = parse(raw);
  if (raw.trim() && !list.length) {
    throw new Error('没有解析出任何链接。格式是每行「名称<TAB>链接」，例如：支付宝忘记密码<TAB>https://...');
  }
  writeAtomic(USER_FILE, format(list));
  const meta = readMeta();
  writeMeta({ source: 'local', url: meta.url || '', at: Date.now(), count: list.length, lastError: '' });
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

/** 当前生效那份的原始文本（给界面编辑框用） */
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
 * 配了远端地址才起定时器。启动后 20 秒先跑一次（等 IM / WebUI 都起来），之后每小时看一次，
 * 距离上次同步不到 6 小时就跳过 —— 一小时一跳是为了「用户刚改了地址」能尽快生效。
 */
function startAutoRefresh(cfg, logger) {
  stopAutoRefresh();
  if (!remoteUrlOf(cfg)) return;

  const tick = async () => {
    const meta = readMeta();
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
  state, currentList, currentText,
  refresh, saveText, reset,
  remoteUrlOf, checkUrl,
  startAutoRefresh, stopAutoRefresh,
  // 测试用
  _paths: { USER_FILE, META_FILE, BUILTIN_FILE },
  _limits: LIMITS,
  _refreshMs: REFRESH_MS,
};
