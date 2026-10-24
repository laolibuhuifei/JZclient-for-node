// 终端实时日志: 分级 + 时间戳 + ANSI 颜色(零依赖)
//
// 级别由低到高: debug < info < warn < error, silent 关闭全部输出
// 通道标签: DEBUG / INFO / HTTP / API / WARN / ERROR, 标签与状态码按级别着色
//
// 环境变量:
//   WP_LOG=debug|info|warn|error|silent  过滤级别(不设置时默认静默, 由 WebUI 启动时开启)
//   WP_LOG_COLOR=0|1                     强制关/开颜色, 默认按是否 TTY 判断
//   WP_DEBUG=1                           兼容旧开关, 等价于 WP_LOG=debug
const { maskSensitive } = require('./mask');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

// 标签颜色: 请求类固定色, 其余按严重程度
const TAG_COLOR = {
  DEBUG: C.gray,
  INFO: C.cyan,
  HTTP: C.green,
  API: C.blue,
  WARN: C.yellow,
  ERROR: C.red,
};

// 未显式配置时保持静默, 避免 CLI 菜单被日志行打断
let level = (() => {
  if (process.env.WP_DEBUG) return LEVELS.debug;
  const v = String(process.env.WP_LOG || '').toLowerCase().trim();
  return LEVELS[v] != null ? LEVELS[v] : LEVELS.silent;
})();

// 颜色: 优先环境变量, 其次看 stdout 是否 TTY(重定向到文件时自动去掉转义符)
const useColor = (() => {
  if (process.env.WP_LOG_COLOR === '0' || process.env.NO_COLOR) return false;
  if (process.env.WP_LOG_COLOR === '1' || process.env.FORCE_COLOR) return true;
  return !!process.stdout.isTTY;
})();

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// 本地时间 HH:mm:ss.SSS
function stamp() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function paint(code, s) {
  return useColor && code ? code + s + C.reset : s;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';
  if (v < 1024) return v + 'B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + 'KB';
  return (v / 1024 / 1024).toFixed(1) + 'MB';
}

// 单行输出, 超长内容截断(调试用的 JSON 体)
function oneLine(s, max) {
  const t = String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ');
  const lim = max || 400;
  return t.length > lim ? t.slice(0, lim) + '…' : t;
}

// 状态码颜色: 2xx 绿 / 3xx 青 / 4xx 黄 / 5xx 红
function statusColor(code) {
  const n = Number(code) || 0;
  if (n >= 500) return C.red;
  if (n >= 400) return C.yellow;
  if (n >= 300) return C.cyan;
  return C.green;
}

// CLI 等待输入时注入, 避免日志行把提示符和已输入内容冲掉
// 形如 { before: () => 擦掉当前行, after: () => 重绘提示符 }
let promptRedraw = null;

function setPromptRedraw(hook) {
  promptRedraw = hook || null;
}

function write(line) {
  const text = maskSensitive(line);
  if (promptRedraw && promptRedraw.before) promptRedraw.before();
  process.stdout.write(text + '\n');
  if (promptRedraw && promptRedraw.after) promptRedraw.after();
}

// 通用一行: [时间] 标签 通道 内容
function emit(sev, tag, cat, msg) {
  if (sev < level) return;
  const head = paint(C.dim, '[' + stamp() + ']') + ' ' + paint(TAG_COLOR[tag], tag.padEnd(5, ' '));
  const who = cat ? paint(C.dim, ' ' + String(cat).padEnd(7, ' ')) : '';
  write(head + who + ' ' + oneLine(msg));
}

// 入站 HTTP 请求: GET /api/watches → 200 842ms 1.2KB
// failed: 接口抛错时 HTTP 仍是 200(响应体 ok:false), 用红色 + 感叹号区分
function request(method, path, status, ms, bytes, failed) {
  if (LEVELS.info < level) return;
  const head = paint(C.dim, '[' + stamp() + ']') + ' ' + paint(TAG_COLOR.HTTP, 'HTTP ');
  const tail = paint(C.dim, ' ' + (Number(ms) || 0) + 'ms' + (fmtBytes(bytes) ? ' ' + fmtBytes(bytes) : ''));
  const st = String(status) + (failed ? '!' : '');
  write(head + ' ' + method + ' ' + path + ' ' + paint(C.dim, '→') + ' ' +
    paint(failed ? C.red : statusColor(status), st) + tail);
}

// 出站业务请求: POST watch.okii.com/xxx → 000001 120ms
// code 是业务码(000001 成功), 非成功码用黄色提示
function api(method, host, path, code, ms) {
  if (LEVELS.info < level) return;
  const c = String(code == null ? '-' : code);
  const cc = c === '000001' ? C.green : C.yellow;
  const head = paint(C.dim, '[' + stamp() + ']') + ' ' + paint(TAG_COLOR.API, 'API  ');
  const tail = paint(C.dim, ' ' + (Number(ms) || 0) + 'ms');
  write(head + ' ' + method + ' ' + host + path + ' ' + paint(C.dim, '→') + ' ' + paint(cc, c) + tail);
}

module.exports = {
  LEVELS,
  C,
  paint,
  oneLine,
  get level() { return level; },

  // WebUI 启动时调用: 未设置 WP_LOG 则用 fallback(默认 info)
  configure(opts = {}) {
    if (opts.level && LEVELS[opts.level] != null) level = LEVELS[opts.level];
  },
  setLevel(name) {
    const v = LEVELS[String(name || '').toLowerCase()];
    if (v != null) level = v;
    return level;
  },
  // 判断某级别是否会输出, 用于跳过昂贵的日志拼装
  isEnabled(name) {
    return (LEVELS[name] || 0) >= level;
  },
  levelName() {
    const hit = Object.keys(LEVELS).find((k) => LEVELS[k] === level);
    return hit || 'silent';
  },

  debug: (cat, msg) => emit(LEVELS.debug, 'DEBUG', cat, msg),
  info: (cat, msg) => emit(LEVELS.info, 'INFO', cat, msg),
  warn: (cat, msg) => emit(LEVELS.warn, 'WARN', cat, msg),
  error: (cat, msg) => emit(LEVELS.error, 'ERROR', cat, msg),
  request,
  api,
  setPromptRedraw,
};
