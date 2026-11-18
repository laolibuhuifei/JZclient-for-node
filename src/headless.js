// 无头页面：让"通话里的媒体面"不再依赖用户开着浏览器。
//
// 为什么必须有这么一个东西：Agora 的 Web SDK 只能在浏览器环境里跑（Node 没有
// 官方 SDK），入房、canvas 合成推流、接收字幕数据流这些事必须"有一个页面"在做。
// 以前那个页面是用户自己的浏览器标签；现在由我们自己起一个 chrome-headless-shell。
//
// 实测（chrome-headless-shell 157，2026-11-18）：
//   document.hidden === false   → 没有后台节流，也没有"静音媒体省电暂停"
//   canvas.captureStream(20)    → 240x320 live track，VP8 3.5 秒编出 71 帧
//   AudioContext.state          → 直接 running，不需要用户手势
// 也就是说浏览器上折腾过的 autoplay / rAF 节流 / video-only 省电暂停，无头环境里全没有。
//
// 代价是内存：一个无头 Chrome 跑起我们的页面要 250~400MB。所以这里有两道闸：
//   1) 单进程：同一时间只允许一个
//   2) 内存闸：可用内存不够就不启动，退回"等用户开浏览器"，并记日志说明原因
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, execFile, execFileSync } = require('child_process');
const log = require('./logger');
const device = require('./device');

// 单测里 device 可能被替身（只有 load/save），所以给个兜底，
// 别让 path.dirname(undefined) 把整个模块炸掉（安全类测试会 require 全部模块）。
const CONFIG_FILE = device.CONFIG_FILE
  || path.join(os.homedir(), '.watch-parent-cli', 'config.json');
const DATA_DIR = path.dirname(CONFIG_FILE);             // ~/.watch-parent-cli
const CHROME_DIR = path.join(DATA_DIR, 'chrome');
// 钉一个具体版本：镜像上要有，且和平台上 pcshot 用的同一版，行为已经验证过
const CHROME_VER = '157.0.8103.78';

const state = {
  proc: null,
  pid: 0,
  startedAt: 0,
  url: '',
  logging: 0,        // 下载进度 0~100
  preparing: false,
  maxTimer: 0,
  err: '',
};

function platformTag() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin') return a === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (p === 'win32') return a === 'x64' ? 'win64' : 'win32';
  if (p === 'linux') {
    if (a === 'arm64') return 'linux-arm64';
    return 'linux64';
  }
  return '';
}

function exeName() {
  return process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
}

function dlUrl() {
  const tag = platformTag();
  if (!tag) return '';
  const file = 'chrome-headless-shell-' + tag + '.zip';
  return {
    mirror: 'https://cdn.npmmirror.com/binaries/chrome-for-testing/' + CHROME_VER + '/' + tag + '/' + file,
    official: 'https://storage.googleapis.com/chrome-for-testing-public/' + CHROME_VER + '/' + tag + '/' + file,
  };
}

// 本目录下下载的那份
function localChrome() {
  const tag = platformTag();
  if (!tag) return '';
  const p = path.join(CHROME_DIR, 'chrome-headless-shell-' + tag, exeName());
  return fs.existsSync(p) ? p : '';
}

// 依次找：环境变量 → 我们下载的 → 系统装好的
function findChrome() {
  const env = String(process.env.JZ_CHROME || '').trim();
  if (env && fs.existsSync(env)) return env;
  const local = localChrome();
  if (local) return local;

  const cands = [];
  if (process.platform === 'darwin') {
    cands.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    );
  } else if (process.platform === 'linux') {
    cands.push(
      '/opt/jz-pcshot/chrome-headless-shell-linux64/chrome-headless-shell',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    );
  } else if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    cands.push(
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    );
  }
  for (const c of cands) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

// 可用内存（MB）。macOS 的 os.freemem() 只算 free 页，会把一堆可回收的 inactive
// 当成"没内存"，误伤；所以自己读 vm_stat 把 free + inactive + speculative 加起来。
let memCache = { at: 0, mb: 0 };
function memFreeMB() {
  if (Date.now() - memCache.at < 5000) return memCache.mb;
  let mb = 0;
  try {
    if (process.platform === 'linux') {
      const txt = fs.readFileSync('/proc/meminfo', 'utf8');
      const m = /MemAvailable:\s+(\d+)\s*kB/.exec(txt);
      if (m) mb = Math.round(Number(m[1]) / 1024);
    } else if (process.platform === 'darwin') {
      const txt = execFileSync('vm_stat', [], { encoding: 'utf8', timeout: 4000 });
      const pg = Number((/page size of (\d+)/.exec(txt) || [])[1] || 4096);
      const get = (k) => Number((new RegExp(k + ':\\s+(\\d+)').exec(txt) || [])[1] || 0);
      const pages = get('Pages free') + get('Pages inactive') + get('Pages speculative');
      if (pages) mb = Math.round((pages * pg) / 1024 / 1024);
    }
  } catch (e) { /* 取不到就不拦 */ }
  if (!mb) mb = Math.round(os.freemem() / 1024 / 1024);
  memCache = { at: Date.now(), mb };
  return mb;
}

function minMemMB() {
  const n = Number(process.env.JZ_HEADLESS_MIN_MEM || 0);
  return Number.isFinite(n) && n > 0 ? n : 350;
}

function status() {
  return {
    platform: platformTag(),
    supported: !!platformTag(),
    path: findChrome(),
    ready: !!findChrome(),
    running: !!(state.proc && state.pid),
    pid: state.pid,
    uptime: state.startedAt ? Date.now() - state.startedAt : 0,
    // 地址里带访问令牌，回给前端/日志前一律打码
    url: state.url ? state.url.replace(/(token=)[^&]+/i, '$1***') : '',
    preparing: state.preparing,
    progress: state.logging,
    memFreeMB: memFreeMB(),
    minMemMB: minMemMB(),
    err: state.err,
    chromeDir: CHROME_DIR,
  };
}

// 下载 zip（镜像优先，失败退官方），带进度回调
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const go = (u, redirects) => {
      const req = https.get(u, { timeout: 30000 }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return go(res.headers.location, redirects - 1);
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + code));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (total && onProgress) onProgress(Math.round((got / total) * 100));
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        out.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', reject);
    };
    go(url, 5);
  });
}

// 准备好一个可用的 Chromium。已经有时直接返回；没有就下载。
async function prepare() {
  if (state.preparing) return { ok: false, busy: true, ...status() };
  const hit = findChrome();
  if (hit) return { ok: true, path: hit, ...status() };

  const urls = dlUrl();
  if (!urls) return { ok: false, err: '当前平台不支持（' + process.platform + '/' + process.arch + '）', ...status() };

  state.preparing = true;
  state.err = '';
  state.logging = 0;
  const tag = platformTag();
  const zip = path.join(os.tmpdir(), 'jz-chrome-' + Date.now() + '.zip');
  try {
    fs.mkdirSync(CHROME_DIR, { recursive: true });
    log.info('headless', '开始下载 Chromium（' + CHROME_VER + ' ' + tag + '），约 120MB');
    let downloaded = false;
    for (const u of [urls.mirror, urls.official]) {
      try {
        await download(u, zip, (p) => { state.logging = p; });
        downloaded = true;
        break;
      } catch (e) {
        log.warn('headless', '下载源失败 ' + u + '：' + e.message);
      }
    }
    if (!downloaded) throw new Error('两个下载源都失败');
    state.logging = 100;
    log.info('headless', '下载完成，开始解压');
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', '-q', zip, '-d', CHROME_DIR], { timeout: 120000 }, (e) => {
        if (e) return reject(new Error('解压失败：' + e.message));
        resolve();
      });
    });
    const exe = localChrome();
    if (!exe) throw new Error('解压后没找到可执行文件');
    try { fs.chmodSync(exe, 0o755); } catch (e) { /* ignore */ }
    log.info('headless', 'Chromium 就绪 ' + exe);
    return { ok: true, path: exe, ...status() };
  } catch (e) {
    state.err = e.message;
    log.error('headless', '准备 Chromium 失败：' + e.message);
    return { ok: false, err: e.message, ...status() };
  } finally {
    state.preparing = false;
    try { fs.unlinkSync(zip); } catch (e) { /* ignore */ }
  }
}

function spawnArgs(url, profileDir) {
  const exe = findChrome();
  const isShell = /headless-shell/i.test(exe);
  const args = [];
  if (!isShell) args.push('--headless=new');
  args.push(
    '--autoplay-policy=no-user-gesture-required',   // 无头下本来就不需要手势，写上更保险
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--user-data-dir=' + profileDir,
    '--window-size=480,900',
  );
  // 无头 Chrome 自己的沙箱在很多受限环境里初始化不了
  // （实测 macOS 沙箱内：sandbox initialization failed → GPU 进程崩 → FATAL: GPU process isn't usable），
  // 加上这两条才能起。页面是我们自己的本地 WebUI，不接受外部输入，关沙箱可以接受。
  args.push('--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox');
  if (process.platform === 'linux') {
    args.push('--disable-dev-shm-usage');   // 容器里 /dev/shm 常常只有 64MB
  }
  args.push(url);
  return args;
}

// 起一个无头页面去承载媒体面。返回 { ok, pid } / { ok:false, reason }
async function start(url, opts) {
  const o = opts || {};
  if (state.proc && state.pid) {
    return { ok: true, pid: state.pid, reused: true };
  }
  const exe = findChrome();
  if (!exe) return { ok: false, reason: '没找到 Chromium（先在设置页点"准备无头浏览器"）' };

  const need = o.force ? 0 : minMemMB();
  const free = memFreeMB();
  if (need && free < need) {
    log.warn('headless', `可用内存 ${free}MB < ${need}MB，不启动无头页面（退回等浏览器页面）`);
    return { ok: false, reason: `内存不足（可用 ${free}MB，需要 ${need}MB）` };
  }

  const profile = path.join(os.tmpdir(), 'jz-hb-' + process.pid + '-' + Date.now());
  try { fs.mkdirSync(profile, { recursive: true }); } catch (e) { /* ignore */ }
  const logFile = path.join(os.tmpdir(), 'jz-headless.log');
  let out = 'ignore';
  let fd = null;
  try {
    fd = fs.openSync(logFile, 'a');
    out = fd;
  } catch (e) { out = 'ignore'; }

  try {
    const p = spawn(exe, spawnArgs(url, profile), {
      detached: false,
      stdio: ['ignore', out, out],
    });
    p.on('error', (e) => {
      state.err = e.message;
      log.error('headless', '启动失败：' + e.message);
      state.proc = null;
      state.pid = 0;
    });
    p.on('exit', (code, signal) => {
      log.info('headless', '无头页面退出 code=' + code + ' signal=' + (signal || '-'));
      if (state.proc === p) { state.proc = null; state.pid = 0; }
    });
    clearTimeout(state.maxTimer);
    state.maxTimer = setTimeout(() => {
      if (state.pid) stop('超过最长存活时间');
    }, 30 * 60 * 1000);
    state.maxTimer.unref && state.maxTimer.unref();
    state.proc = p;
    state.pid = p.pid;
    state.startedAt = Date.now();
    state.url = url;
    state.err = '';
    log.info('headless', '已启动无头页面 pid=' + p.pid + ' 可用内存 ' + free + 'MB');
    return { ok: true, pid: p.pid };
  } catch (e) {
    state.err = e.message;
    log.error('headless', '启动异常：' + e.message);
    return { ok: false, reason: e.message };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
}

function stop(why) {
  const p = state.proc;
  if (!p || !state.pid) return { ok: true, stopped: false };
  const pid = state.pid;
  clearTimeout(state.maxTimer);
  state.maxTimer = 0;
  state.proc = null;
  state.pid = 0;
  state.startedAt = 0;
  state.url = '';
  try { p.kill('SIGTERM'); } catch (e) { /* ignore */ }
  // 3 秒还不退就硬杀（Chrome 有时会留下 renderer 子进程）
  setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 3000);
  log.info('headless', '已停止无头页面 pid=' + pid + (why ? '（' + why + '）' : ''));
  return { ok: true, stopped: true };
}

// 轻量查询：只回答"在不在跑"，别每次去 stat 一堆路径（status() 每 1.5 秒会被调）
function isRunning() { return !!(state.proc && state.pid); }

module.exports = { status, findChrome, prepare, start, stop, isRunning, memFreeMB, minMemMB, CHROME_VER };
