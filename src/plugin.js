// 插件系统（零依赖）
//
// 插件就是一个文件夹：一个声明文件 plugin.json + 若干 js + 可选的外部界面。
// 安装方式有两种：WebUI 上传 zip，或者直接把文件夹丢进
//   ~/.watch-parent-cli/plugins/<id>/        （用户自己的）
//   <程序目录>/plugins/<id>/                 （随程序分发的内置插件）
//
// 执行用 Node 内置的 vm 沙箱：插件拿不到 require('fs') 这种口子，
// 只能用我们注入的 jz 对象。这样插件写崩了最多把自己搞挂，不会带着主进程一起死，
// 也不会悄悄读到 ~/.watch-parent-cli/config.json 里的登录令牌。
//
// 但要说清楚：沙箱防的是「误伤」不是「恶意」。vm 不是安全边界，
// 真要跑不可信代码得用独立进程 + 权限隔离。文档里也这么写。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const zip = require('./zip');
const log = require('./logger');

const USER_DIR = path.join(os.homedir(), '.watch-parent-cli', 'plugins');
const BUILTIN_DIR = path.join(__dirname, '..', 'plugins');

const MANIFEST_NAMES = ['plugin.json', 'manifest.json'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

// 时间闸门。插件是别人写的代码，任何一个同步死循环都会卡住整个 WebUI
// （单线程），所以加载和每次调用都得有上限。
const T = {
  load: 8000,      // 加载插件代码
  hook: 8000,      // onLoad / onUnload
  request: 20000,  // 处理一次插件 HTTP 请求
  message: 6000,   // 处理一条聊天消息
};

const PERMISSIONS = [
  'chat.send',    // 往微聊发消息
  'chat.read',    // 读会话列表 / 聊天记录
  'watch.read',   // 读手表信息、位置、健康数据
  'watch.write',  // 改手表设置（改名、加闹钟、加联系人…）
  'http',         // 访问外部网络
];

// 无论插件声不声明都不给的接口：这些一动就是不可逆的（解绑、删好友、迁移账号），
// 让第三方插件碰它们迟早出事
const API_DENY = new Set([
  'unbind', 'deleteWatchFriend', 'migrateGeniusAccount', 'createMobileWatch',
  'sendTalentTransferRandcode', 'checkTalentTransferRandcode',
]);

// 图标名 -> 前端 SVG。前端认不出的一律用插头图标
const ICONS = ['plug', 'star', 'bell', 'chart', 'gift', 'game', 'book', 'camera', 'music', 'robot'];

// ---------- 小工具 ----------

function now() { return Date.now(); }

function isInside(root, full) {
  const r = path.resolve(root) + path.sep;
  const f = path.resolve(full);
  return f === path.resolve(root) || f.indexOf(r) === 0;
}

// 超时包装。注意 unref：不然插件设的长定时器会把进程退出拖住
function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' 超时（超过 ' + ms + 'ms 没有返回）')), ms);
    if (t.unref) t.unref();
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max && s.length > max ? s.slice(0, max) : s;
}

// 版本号只做格式校验，不比较大小 —— 插件没有依赖解析，比较大小没意义
function validVersion(v) {
  return /^\d{1,4}(\.\d{1,4}){0,3}([-+][0-9A-Za-z.-]{1,20})?$/.test(v);
}

// ---------- 声明文件 ----------

// 把 plugin.json 归一化成固定结构。缺字段给默认值，错的字段直接报错 ——
// 宁可装不上，也别装上一个 id 是空的插件（后面全靠 id 找目录）
function normalizeManifest(raw, fallbackId) {
  const r = raw && typeof raw === 'object' ? raw : {};

  const id = str(r.id || fallbackId, 48).toLowerCase();
  if (!id) throw new Error('声明文件缺少 id');
  if (!ID_RE.test(id)) {
    throw new Error('id「' + id + '」不合法：只能用小写字母、数字、点、下划线、连字符，且以字母或数字开头');
  }

  const name = str(r.name, 40) || id;
  const version = str(r.version, 24) || '1.0.0';
  if (!validVersion(version)) throw new Error('version「' + version + '」不合法，应该像 1.0.0 这样');

  const perms = Array.isArray(r.permissions) ? r.permissions.map((x) => str(x, 24)).filter(Boolean) : [];
  const unknown = perms.filter((p) => PERMISSIONS.indexOf(p) < 0);
  if (unknown.length) {
    throw new Error('声明了未知权限 ' + unknown.join('、') + '，可用的是：' + PERMISSIONS.join('、'));
  }

  // 配置项：key 必须能当对象键，类型只支持这几种（前端按类型渲染控件）
  const config = [];
  if (Array.isArray(r.config)) {
    for (const c of r.config) {
      if (!c || typeof c !== 'object') continue;
      const key = str(c.key, 40);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key)) throw new Error('配置项 key「' + key + '」不合法');
      const type = ['text', 'number', 'boolean', 'select', 'password', 'textarea'].indexOf(c.type) >= 0 ? c.type : 'text';
      config.push({
        key,
        label: str(c.label, 40) || key,
        type,
        default: c.default === undefined ? (type === 'boolean' ? false : (type === 'number' ? 0 : '')) : c.default,
        hint: str(c.hint, 120),
        placeholder: str(c.placeholder, 60),
        options: Array.isArray(c.options)
          ? c.options.map((o) => (o && typeof o === 'object'
            ? { value: String(o.value), label: str(o.label, 40) || String(o.value) }
            : { value: String(o), label: String(o) }))
          : [],
      });
    }
  }

  // 外部界面：声明了才在导航栏出现
  let ui = null;
  if (r.ui && typeof r.ui === 'object') {
    const entry = str(r.ui.entry, 200);
    if (entry) {
      if (!/\.html?$/i.test(entry)) throw new Error('ui.entry 要指向一个 .html 文件');
      ui = { title: str(r.ui.title, 20) || name, entry };
    }
  }

  return {
    id,
    name,
    version,
    author: str(r.author, 40) || '匿名',
    description: str(r.description, 300),
    homepage: str(r.homepage, 300),
    main: str(r.main, 200) || 'main.js',
    cover: str(r.cover, 200),
    icon: ICONS.indexOf(str(r.icon, 20)) >= 0 ? str(r.icon, 20) : 'plug',
    permissions: perms,
    config,
    ui,
  };
}

// ---------- JSON 小存储（插件数据/配置） ----------
// 每个插件一个独立文件，写在插件自己的 data/ 里。
// 不塞进主 config.json：插件的数据量不可控，混进去以后主配置会越来越难读，
// 而且卸载插件时也不好收拾。
class JsonFile {
  constructor(file) {
    this.file = file;
    this.data = null;
  }

  read() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!this.data || typeof this.data !== 'object') this.data = {};
    } catch (e) {
      this.data = {};
    }
    return this.data;
  }

  // 先写临时文件再 rename：写一半断电也不会把原来的数据清空
  flush() {
    const tmp = this.file + '.' + process.pid + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.read(), null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      throw e;
    }
  }
}

// 插件能存的东西必须能 JSON 化，否则存进去读出来就变样了
function jsonSafe(v, depth) {
  const d = depth || 0;
  if (d > 8) throw new Error('存的值嵌套太深');
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string') return v.length > 200000 ? v.slice(0, 200000) : v;
  if (t === 'number') return Number.isFinite(v) ? v : 0;
  if (t === 'boolean') return v;
  if (t === 'function' || t === 'symbol') return null;
  if (Array.isArray(v)) return v.slice(0, 5000).map((x) => jsonSafe(x, d + 1));
  if (t === 'object') {
    const out = {};
    Object.keys(v).slice(0, 2000).forEach((k) => { out[k] = jsonSafe(v[k], d + 1); });
    return out;
  }
  return null;
}

// ---------- 插件实例 ----------

class Plugin {
  constructor(mgr, dir, manifest, builtin) {
    this.mgr = mgr;
    this.dir = dir;
    this.manifest = manifest;
    this.id = manifest.id;
    this.builtin = !!builtin;
    this.loaded = false;
    this.error = '';
    this.exports = null;
    this.api = null;
    this.sandbox = null;
    this.timers = new Set();
    this.aborts = new Set();
    this.handlers = { message: [], config: [] };
    this.loadedAt = 0;
  }

  logTag() { return 'plugin:' + this.id; }

  info(msg) { log.info(this.logTag(), msg); }
  warn(msg) { log.warn(this.logTag(), msg); }
  logError(msg) { log.error(this.logTag(), msg); }

  has(perm) { return this.manifest.permissions.indexOf(perm) >= 0; }

  need(perm, what) {
    if (!this.has(perm)) {
      throw new Error('插件没有声明 ' + perm + ' 权限，不能' + (what || '使用这个接口')
        + '（在 plugin.json 的 permissions 里加上）');
    }
  }

  // ---------- 数据/配置 ----------
  dataDir() {
    // 内置插件的代码在程序目录里 —— 那里可能只读，而且会被 git 跟踪、被升级覆盖，
    // 运行数据一律放到用户目录下的 .data/<id>，升级程序不会把用户数据冲掉
    const d = this.builtin
      ? path.join(USER_DIR, '.data', this.id)
      : path.join(this.dir, 'data');
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 只读目录时交给后面的写操作报错 */ }
    return d;
  }

  store() {
    if (!this._store) this._store = new JsonFile(path.join(this.dataDir(), 'store.json'));
    return this._store;
  }

  configFile() {
    if (!this._config) this._config = new JsonFile(path.join(this.dataDir(), 'config.json'));
    return this._config;
  }

  // 配置值：存过就用存的，没存过用声明里的默认值
  configAll() {
    const saved = this.configFile().read();
    const out = {};
    for (const c of this.manifest.config) {
      out[c.key] = Object.prototype.hasOwnProperty.call(saved, c.key) ? saved[c.key] : c.default;
    }
    return out;
  }

  configSet(patch) {
    const defs = {};
    this.manifest.config.forEach((c) => { defs[c.key] = c; });
    const saved = this.configFile().read();
    Object.keys(patch || {}).forEach((k) => {
      const d = defs[k];
      if (!d) return;                       // 没声明的键直接忽略，避免插件数据里长出野字段
      let v = patch[k];
      if (d.type === 'boolean') v = !!v;
      else if (d.type === 'number') { const n = Number(v); v = Number.isFinite(n) ? n : d.default; }
      else v = str(v, 2000);
      saved[k] = v;
    });
    this.configFile().flush();
    // 通知插件自己：配置变了要重读，否则它得等到下次重启才生效
    for (const fn of this.handlers.config) {
      try { fn(this.api, this.configAll()); } catch (e) { this.warn('onConfig 出错: ' + e.message); }
    }
    return this.configAll();
  }

  // ---------- 生命周期 ----------

  async load() {
    if (this.loaded) return;
    const mainFile = path.join(this.dir, this.manifest.main);
    if (!isInside(this.dir, mainFile)) throw new Error('main 指向了插件目录之外');
    if (!fs.existsSync(mainFile)) throw new Error('找不到入口文件 ' + this.manifest.main);

    const code = fs.readFileSync(mainFile, 'utf8');
    const ctx = this.buildContext(mainFile);
    // 用函数包一层，让插件里能写 module.exports = {...}（和平时写 Node 模块一样）。
    // ⚠️ 定义和调用必须写在同一段脚本里交给 runInContext：
    // 先 runInContext 拿到函数、再 fn() 调用的话，函数体是跑在 timeout 保护之外的，
    // 插件里一个 while(true) 就能把整个 WebUI 卡死（实测过）。
    const wrapped = '(function (exports, require, module, __filename, __dirname) {\n'
      + code + '\n})(module.exports, require, module, __filename, __dirname)';
    try {
      vm.runInContext(wrapped, ctx, { timeout: T.load, filename: mainFile, displayErrors: true });
    } catch (e) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new Error('插件代码执行超过 ' + T.load + 'ms 被强制中断（八成是死循环）');
      }
      throw new Error('插件代码执行出错: ' + (e && e.message ? e.message : e));
    }

    const module = ctx.module;
    const exp = module.exports;
    if (!exp || typeof exp !== 'object') throw new Error('插件没有 module.exports 任何东西');
    this.exports = exp;

    // 把插件自己注册的消息/配置回调收好
    if (typeof exp.onMessage === 'function') this.handlers.message.push(exp.onMessage);
    if (typeof exp.onConfig === 'function') this.handlers.config.push(exp.onConfig);

    if (typeof exp.onLoad === 'function') {
      await withTimeout(Promise.resolve(exp.onLoad(this.api)), T.hook, 'onLoad');
    }
    this.loaded = true;
    this.error = '';
    this.loadedAt = now();
  }

  unload() {
    // 先跑 onUnload（插件可能要落盘自己的状态），超时也继续往下清
    if (this.loaded && this.exports && typeof this.exports.onUnload === 'function') {
      try {
        const r = this.exports.onUnload(this.api);
        if (r && typeof r.then === 'function') {
          r.catch((e) => this.warn('onUnload 出错: ' + (e && e.message ? e.message : e)));
        }
      } catch (e) {
        this.warn('onUnload 出错: ' + (e && e.message ? e.message : e));
      }
    }
    // 定时器不清会一直跑，重载几次就是几倍的任务
    for (const t of this.timers) {
      try { clearTimeout(t); } catch (e) { /* ignore */ }
      try { clearInterval(t); } catch (e) { /* ignore */ }
    }
    this.timers.clear();
    for (const c of this.aborts) {
      try { c.abort(); } catch (e) { /* ignore */ }
    }
    this.aborts.clear();
    // 落一次盘，免得插件写了数据还没来得及 flush 就被重载
    try { if (this._store) this._store.flush(); } catch (e) { /* ignore */ }
    try { if (this._config) this._config.flush(); } catch (e) { /* ignore */ }

    this.loaded = false;
    this.exports = null;
    this.api = null;
    this.sandbox = null;
    this._store = null;
    this._config = null;
    this.handlers = { message: [], config: [] };
  }

  // ---------- 沙箱 ----------
  buildContext(mainFile) {
    const self = this;
    const sandbox = {};

    // 定时器全部登记，卸载时统一清掉。unref 是为了不拖住进程退出
    const addTimer = (t) => {
      self.timers.add(t);
      if (t.unref) t.unref();
      return t;
    };
    const wrapCb = (fn) => (typeof fn === 'function' ? fn : () => {});

    sandbox.console = {
      log: (...a) => self.info(a.map(fmtArg).join(' ')),
      info: (...a) => self.info(a.map(fmtArg).join(' ')),
      warn: (...a) => self.warn(a.map(fmtArg).join(' ')),
      error: (...a) => self.logError(a.map(fmtArg).join(' ')),
      debug: (...a) => log.debug(self.logTag(), a.map(fmtArg).join(' ')),
    };

    sandbox.setTimeout = (fn, ms, ...a) => addTimer(setTimeout(wrapCb(fn), clampMs(ms), ...a));
    sandbox.setInterval = (fn, ms, ...a) => addTimer(setInterval(wrapCb(fn), clampMs(ms), ...a));
    sandbox.clearTimeout = (t) => { self.timers.delete(t); clearTimeout(t); };
    sandbox.clearInterval = (t) => { self.timers.delete(t); clearInterval(t); };
    sandbox.setImmediate = (fn, ...a) => addTimer(setImmediate(wrapCb(fn), ...a));
    sandbox.queueMicrotask = (fn) => queueMicrotask(wrapCb(fn));

    // 只给这些全局对象。故意不给 process / require('fs') / Buffer 之外的 Node 能力
    sandbox.Buffer = Buffer;
    sandbox.URL = URL;
    sandbox.URLSearchParams = URLSearchParams;
    sandbox.TextEncoder = TextEncoder;
    sandbox.TextDecoder = TextDecoder;
    sandbox.AbortController = AbortController;
    sandbox.structuredClone = typeof structuredClone === 'function' ? structuredClone : undefined;
    sandbox.performance = { now: () => now() };
    // 插件里 process.env.NODE_ENV 这类写法很常见，给个空壳让它别崩，但不暴露真环境变量
    sandbox.process = {
      env: {},
      platform: process.platform,
      version: process.version,
      nextTick: (fn, ...a) => process.nextTick(wrapCb(fn), ...a),
      uptime: () => process.uptime(),
    };

    sandbox.module = { exports: {}, filename: mainFile };
    sandbox.exports = sandbox.module.exports;
    sandbox.require = this.makeRequire();
    sandbox.__filename = mainFile;
    sandbox.__dirname = this.dir;

    // 先建上下文再指 globalThis，否则 globalThis 指的还是那个普通对象
    const ctx = vm.createContext(sandbox);
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;
    sandbox.window = sandbox;   // 有些插件是照着浏览器写法写的，给个别名
    this.sandbox = ctx;
    this.api = this.buildApi();
    return ctx;
  }

  // 插件内部的 require：只能引自己的文件 + 几个安全的 Node 内置模块
  makeRequire() {
    const self = this;
    const cache = new Map();

    function loadFile(full) {
      const hit = cache.get(full);
      if (hit) return hit.exports;
      const code = fs.readFileSync(full, 'utf8');
      const mod = { exports: {} };
      cache.set(full, mod);
      if (/\.json$/i.test(full)) {
        mod.exports = JSON.parse(code);
        return mod.exports;
      }
      // 和主入口一样：定义 + 调用写在一段脚本里，子模块里的死循环也能被 timeout 掐掉
      self.sandbox.__jz_mod__ = mod;
      self.sandbox.__jz_req__ = req;
      self.sandbox.__jz_file__ = full;
      self.sandbox.__jz_dir__ = path.dirname(full);
      const wrapped = '(function (exports, require, module, __filename, __dirname) {\n' + code
        + '\n})(__jz_mod__.exports, __jz_req__, __jz_mod__, __jz_file__, __jz_dir__)';
      try {
        vm.runInContext(wrapped, self.sandbox, { timeout: T.load, filename: full });
      } finally {
        delete self.sandbox.__jz_mod__;
        delete self.sandbox.__jz_req__;
        delete self.sandbox.__jz_file__;
        delete self.sandbox.__jz_dir__;
      }
      return mod.exports;
    }

    function req(name) {
      const n = String(name || '');
      // 这几个是纯计算/编解码，放给插件没风险
      if (n === 'crypto' || n === 'zlib' || n === 'util' || n === 'path' || n === 'url' || n === 'querystring') {
        return require(n);
      }
      if (n === 'fs' || n === 'child_process' || n === 'net' || n === 'http' || n === 'https') {
        throw new Error('插件里不能用 require("' + n + '")。要发请求用 jz.fetch()，要存数据用 jz.store');
      }
      if (n.charAt(0) === '.') {
        const base = path.resolve(self.dir, n);
        if (!isInside(self.dir, base)) throw new Error('插件不能引用自己目录之外的文件: ' + n);
        const tries = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
        for (const f of tries) {
          if (fs.existsSync(f) && fs.statSync(f).isFile()) return loadFile(f);
        }
        throw new Error('找不到插件内的文件: ' + n);
      }
      throw new Error('插件里不能 require("' + n + '")，只能引自己的文件（./xxx）或 crypto/util/path/zlib/url/querystring');
    }

    req.resolve = (n) => n;
    return req;
  }

  // ---------- 注入给插件的 jz 对象 ----------
  buildApi() {
    const self = this;
    const host = this.mgr.host;
    const dir = this.dir;

    const timers = {
      after(ms, fn) { return sandboxTimer(self, 'timeout', fn, ms); },
      every(ms, fn) { return sandboxTimer(self, 'interval', fn, ms); },
      clear(id) {
        try { clearTimeout(id); } catch (e) { /* ignore */ }
        try { clearInterval(id); } catch (e) { /* ignore */ }
        self.timers.delete(id);
      },
      // 「每天 HH:MM 跑一次」的糖。内部 30 秒扫一次，跨天只触发一次。
      // 进程在那个时刻没起来就错过当天这一次 —— 定时任务本来就是这样，文档里写清楚
      daily(hhmm, fn) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
        if (!m) throw new Error('jz.timers.daily 的时间格式要像 "08:30"');
        const h = Number(m[1]);
        const mi = Number(m[2]);
        if (h > 23 || mi > 59) throw new Error('jz.timers.daily 的时间不合法: ' + hhmm);
        let lastDay = '';
        return sandboxTimer(self, 'interval', () => {
          const d = new Date();
          const day = d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
          if (d.getHours() === h && d.getMinutes() === mi && lastDay !== day) {
            lastDay = day;
            Promise.resolve().then(fn).catch((e) => self.warn('定时任务出错: ' + (e && e.message ? e.message : e)));
          }
        }, 30000);
      },
    };

    const api = {
      id: this.id,
      name: this.manifest.name,
      version: this.manifest.version,
      dir,
      log: {
        debug: (m) => log.debug(self.logTag(), m),
        info: (m) => self.info(m),
        warn: (m) => self.warn(m),
        error: (m) => self.logError(m),
      },
      timers,
      store: {
        get(key, def) {
          const d = self.store().read();
          return Object.prototype.hasOwnProperty.call(d, String(key)) ? d[String(key)] : def;
        },
        set(key, val) {
          const d = self.store().read();
          d[String(key)] = jsonSafe(val);
          self.store().flush();
          return d[String(key)];
        },
        delete(key) {
          const d = self.store().read();
          delete d[String(key)];
          self.store().flush();
        },
        all() { return Object.assign({}, self.store().read()); },
      },
      config: {
        all: () => self.configAll(),
        get(key) {
          const all = self.configAll();
          return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : undefined;
        },
        set(key, val) {
          const patch = {};
          patch[key] = val;
          return self.configSet(patch)[key];
        },
      },
      watches: {
        async list() {
          self.need('watch.read', '读手表列表');
          return host.watches();
        },
        async get(watchId) {
          self.need('watch.read', '读手表信息');
          const list = await host.watches();
          return list.find((w) => String(w.watchId) === String(watchId)) || null;
        },
        async location(watchId) {
          self.need('watch.read', '读位置');
          return host.location(String(watchId));
        },
        async health(watchId, date) {
          self.need('watch.read', '读健康数据');
          return host.apiCall('getHealthHome', [String(watchId), date]);
        },
        async sport(watchId, date) {
          self.need('watch.read', '读运动数据');
          return host.apiCall('getSportHome', [String(watchId), date]);
        },
        async contacts(watchId) {
          self.need('watch.read', '读通讯录');
          return host.apiCall('getContacts', [String(watchId)]);
        },
        async alarms(watchId) {
          self.need('watch.read', '读闹钟');
          return host.apiCall('getAlarms', [String(watchId)]);
        },
        // 逃生舱：直接调平台接口。读写按方法名自动分类，危险接口一律拒绝
        async read(method, ...args) {
          self.need('watch.read', '调用平台接口');
          return callPlatform(self, method, args, 'read');
        },
        async write(method, ...args) {
          self.need('watch.write', '修改手表设置');
          return callPlatform(self, method, args, 'write');
        },
      },
      chat: {
        async targets() {
          self.need('chat.read', '读会话列表');
          return host.chatTargets();
        },
        async history(key, limit) {
          self.need('chat.read', '读聊天记录');
          return host.history(String(key), Math.max(1, Math.min(Number(limit) || 20, 200)));
        },
        // 通用发送：body 和 WebUI 的 /api/chats/send 完全一致
        //   { key, kind:'text', text }
        //   { key, kind:'image', src:'/本地/路径.png' }
        //   { key, kind:'voice', src }
        //   { key, kind:'location', latitude, longitude, poi }
        //   { key, kind:'link', url, desc }
        async send(body) {
          self.need('chat.send', '发消息');
          const b = Object.assign({}, body || {});
          if (!b.key) throw new Error('jz.chat.send 需要 key（会话标识，可以从 jz.chat.targets() 拿）');
          return host.sendChat(b);
        },
        async text(key, text) {
          return api.chat.send({ key, kind: 'text', text });
        },
        async image(key, src) {
          return api.chat.send({ key, kind: 'image', src });
        },
      },
      // 受控的网络请求：只放开 http(s)，带超时，卸载时能中断
      async fetch(url, opts) {
        self.need('http', '访问外部网络');
        const u = String(url || '');
        if (!/^https?:\/\//i.test(u)) throw new Error('jz.fetch 只支持 http/https');
        const o = Object.assign({}, opts || {});
        const ms = Math.max(1000, Math.min(Number(o.timeout) || 15000, 60000));
        delete o.timeout;
        const ctrl = new AbortController();
        self.aborts.add(ctrl);
        const timer = setTimeout(() => ctrl.abort(), ms);
        if (timer.unref) timer.unref();
        try {
          return await fetch(u, Object.assign({}, o, { signal: ctrl.signal }));
        } finally {
          clearTimeout(timer);
          self.aborts.delete(ctrl);
        }
      },
      // 插件自己的信息，界面上显示用
      info() {
        return {
          id: self.id,
          name: self.manifest.name,
          version: self.manifest.version,
          author: self.manifest.author,
          dir: self.dir,
        };
      },
    };

    return api;
  }
}

// 沙箱里的定时器要登记到插件的 timers 里，卸载时才能清干净
function sandboxTimer(plugin, kind, fn, ms) {
  const cb = typeof fn === 'function' ? fn : () => {};
  const delay = clampMs(ms);
  const wrapped = () => {
    try { Promise.resolve(cb()).catch((e) => plugin.warn('定时任务出错: ' + (e && e.message ? e.message : e))); } catch (e) {
      plugin.warn('定时任务出错: ' + (e && e.message ? e.message : e));
    }
  };
  const t = kind === 'interval' ? setInterval(wrapped, delay) : setTimeout(wrapped, delay);
  plugin.timers.add(t);
  if (t.unref) t.unref();
  return t;
}

function clampMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  // 上限一天，下限 50ms（0 会让 setInterval 疯狂空转）
  return Math.max(50, Math.min(n, 24 * 3600 * 1000));
}

// 平台接口分类：get* 当读，其余当写。危险方法在黑名单里，读写都不给
//
// 方法名先过一道白名单正则：`typeof api[method] === 'function'` 挡不住
// api.constructor / api.toString / api.__proto__ 这些从 Object.prototype 继承来的东西，
// 插件写个 jz.watches.write('constructor', ...) 就能摸到不该摸的地方。
const METHOD_RE = /^(get|update|add|delete|set|create|change|agree|migrate|send|check|need|verify|switch|play|nfc|unbind|remove|enable|disable|move|reset)[A-Z][A-Za-z0-9]*$/;

function apiKind(method) {
  if (API_DENY.has(method)) return null;
  if (!METHOD_RE.test(method)) return null;
  if (/^get[A-Z]/.test(method)) return 'read';
  return 'write';
}

async function callPlatform(plugin, method, args, want) {
  const m = String(method || '');
  const kind = apiKind(m);
  if (!kind) throw new Error('接口 ' + m + ' 不允许插件调用（不在可用列表里，或者涉及解绑/删除这类不可逆操作）');
  if (kind !== want) {
    throw new Error('接口 ' + m + ' 属于「' + (kind === 'read' ? '读' : '写') + '」类，请用 jz.watches.'
      + (kind === 'read' ? 'read' : 'write') + '()');
  }
  return plugin.mgr.host.apiCall(m, args || []);
}

function fmtArg(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

// ---------- 插件管理器 ----------

class PluginManager {
  constructor(opts) {
    const o = opts || {};
    this.host = o.host || {};
    this.cfg = o.cfg || {};
    this.plugins = new Map();   // id -> Plugin
    this.lastError = new Map(); // id -> 加载失败原因
    this.started = false;
  }

  // 配置里的禁用名单。放主配置而不是插件目录：卸载插件时不会连带丢掉「我禁过它」这件事
  disabledSet() {
    const p = (this.cfg.plugins && this.cfg.plugins.disabled) || [];
    return new Set(Array.isArray(p) ? p.map(String) : []);
  }

  isDisabled(id) { return this.disabledSet().has(String(id)); }

  setDisabled(id, off) {
    const p = this.cfg.plugins || (this.cfg.plugins = {});
    const list = Array.isArray(p.disabled) ? p.disabled.map(String) : [];
    const i = list.indexOf(String(id));
    if (off && i < 0) list.push(String(id));
    if (!off && i >= 0) list.splice(i, 1);
    p.disabled = list;
  }

  // 扫描两个目录。同名 id 时用户目录优先（用户装的版本覆盖内置的）
  scan() {
    const found = new Map();
    for (const [dir, builtin] of [[BUILTIN_DIR, true], [USER_DIR, false]]) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const nm of names) {
        if (nm.charAt(0) === '.' || nm === 'node_modules') continue;
        const full = path.join(dir, nm);
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (!st.isDirectory()) continue;

        let manifest = null;
        let manifestFile = '';
        for (const mf of MANIFEST_NAMES) {
          const f = path.join(full, mf);
          if (fs.existsSync(f)) { manifestFile = f; break; }
        }
        if (!manifestFile) continue;   // 不是插件目录，静默跳过（用户可能在里面放别的东西）
        try {
          const raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
          manifest = normalizeManifest(raw, nm);
        } catch (e) {
          this.lastError.set(nm, '声明文件有问题: ' + (e && e.message ? e.message : e));
          continue;
        }
        // 用户目录优先：先扫内置再扫用户，后扫到的覆盖前面的
        found.set(manifest.id, { dir: full, manifest, builtin });
      }
    }
    return found;
  }

  // 启动时调用：扫描 + 加载所有启用且没被禁用的插件
  async init() {
    const found = this.scan();
    for (const [id, info] of found) {
      const p = new Plugin(this, info.dir, info.manifest, info.builtin);
      this.plugins.set(id, p);
      if (this.isDisabled(id)) {
        p.error = '';
        continue;
      }
      try {
        await p.load();
        p.info('已加载 v' + p.manifest.version + (info.builtin ? '（内置）' : ''));
      } catch (e) {
        p.error = e && e.message ? e.message : String(e);
        this.lastError.set(id, p.error);
        p.logError('加载失败: ' + p.error);
      }
    }
    this.started = true;
    log.info('plugin', `插件目录 ${USER_DIR}`);
    log.info('plugin', `已加载 ${this.activeCount()}/${this.plugins.size} 个插件`);
    return this.list();
  }

  activeCount() {
    let n = 0;
    for (const p of this.plugins.values()) if (p.loaded) n++;
    return n;
  }

  get(id) { return this.plugins.get(String(id)) || null; }

  // 给 WebUI 的列表。绝不返回沙箱/导出对象，那些东西不该序列化出去
  list() {
    const out = [];
    for (const p of this.plugins.values()) {
      out.push({
        id: p.id,
        name: p.manifest.name,
        version: p.manifest.version,
        author: p.manifest.author,
        description: p.manifest.description,
        homepage: p.manifest.homepage,
        icon: p.manifest.icon,
        builtin: p.builtin,
        hasCover: !!p.manifest.cover,
        hasUi: !!p.manifest.ui,
        uiTitle: p.manifest.ui ? p.manifest.ui.title : '',
        permissions: p.manifest.permissions,
        config: p.manifest.config,
        configValues: p.manifest.config.length ? p.configAll(p) : {},
        loaded: p.loaded,
        disabled: this.isDisabled(p.id),
        error: p.error || this.lastError.get(p.id) || '',
        loadedAt: p.loadedAt || 0,
      });
    }
    out.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : (a.builtin ? 1 : -1)));
    return out;
  }

  configAll(p) {
    try { return p.configAll(); } catch (e) { return {}; }
  }

  async enable(id) {
    const p = this.get(id);
    if (!p) throw new Error('插件不存在');
    this.setDisabled(p.id, false);
    this.saveCfg();
    if (!p.loaded) await this.reload(p.id);
    return this.list();
  }

  async disable(id) {
    const p = this.get(id);
    if (!p) throw new Error('插件不存在');
    this.setDisabled(p.id, true);
    this.saveCfg();
    p.unload();
    return this.list();
  }

  async reload(id) {
    const p = this.get(id);
    if (!p) throw new Error('插件不存在');
    p.unload();
    p.error = '';
    this.lastError.delete(p.id);
    try {
      await p.load();
      p.info('已重新加载 v' + p.manifest.version);
    } catch (e) {
      p.error = e && e.message ? e.message : String(e);
      this.lastError.set(p.id, p.error);
      p.logError('重新加载失败: ' + p.error);
      throw e;
    }
    return this.list();
  }

  saveCfg() {
    if (typeof this.host.saveConfig === 'function') {
      try { this.host.saveConfig(); } catch (e) { log.warn('plugin', '保存配置失败: ' + (e && e.message ? e.message : e)); }
    }
  }

  // ---------- 安装 / 卸载 ----------

  // 从 zip 安装。整包解到临时目录，校验通过才换到正式目录，
  // 装坏了不会把原来那个版本弄没
  async install(buf, filename) {
    if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('没收到文件内容');
    if (buf.length > 16 * 1024 * 1024) throw new Error('压缩包太大了（超过 16MB）');

    fs.mkdirSync(USER_DIR, { recursive: true });
    const tmp = path.join(USER_DIR, '.staging-' + crypto.randomBytes(6).toString('hex'));
    try {
      // macOS 打的包会带 __MACOSX/ 和 ._xxx，装进去纯属垃圾
      zip.extract(buf, tmp, {
        skip: (rel) => /^__MACOSX\//i.test(rel) || /(^|\/)\._/.test(rel) || /(^|\/)\.DS_Store$/i.test(rel),
      });

      // 包根目录直接是插件，或者外面多套了一层（很多人压缩时是「右键压缩文件夹」）
      let root = tmp;
      let manifestFile = findManifest(root);
      if (!manifestFile) {
        const subs = fs.readdirSync(tmp).filter((n) => {
          try { return fs.statSync(path.join(tmp, n)).isDirectory(); } catch (e) { return false; }
        });
        if (subs.length === 1) {
          const inner = path.join(tmp, subs[0]);
          if (findManifest(inner)) { root = inner; manifestFile = findManifest(inner); }
        }
      }
      if (!manifestFile) {
        throw new Error('压缩包里找不到 plugin.json（声明文件要和入口 js 放在一起）');
      }

      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      } catch (e) {
        throw new Error('plugin.json 不是合法 JSON: ' + (e && e.message ? e.message : e));
      }
      const manifest = normalizeManifest(raw, path.basename(root));

      const mainFile = path.join(root, manifest.main);
      if (!fs.existsSync(mainFile)) throw new Error('压缩包里找不到入口文件 ' + manifest.main);

      const target = path.join(USER_DIR, manifest.id);
      const backup = target + '.bak-' + now();

      // 覆盖安装：先把旧的挪开，新的到位后再删。中途出错还能挪回来
      const had = fs.existsSync(target);
      if (had) fs.renameSync(target, backup);
      try {
        fs.renameSync(root, target);
      } catch (e) {
        if (had) { try { fs.renameSync(backup, target); } catch (e2) { /* ignore */ } }
        throw e;
      }

      // 旧版本的插件实例要先卸掉，不然它还在跑旧代码
      const old = this.plugins.get(manifest.id);
      if (old) { old.unload(); this.plugins.delete(manifest.id); }

      // 覆盖安装时把旧插件的运行数据（配置 + 存储）搬到新目录。
      // 不搬的话每次升级都会把用户改过的配置和攒下来的数据一起删掉 —— 数据就在 data/ 里，
      // 而旧目录整个会被 rmSync 掉。
      if (had) {
        const moved = moveData(path.join(backup, 'data'), path.join(target, 'data'));
        if (moved) log.info('plugin', `升级 ${manifest.id} 时保留了 ${moved} 个数据文件`);
      }

      const p = new Plugin(this, target, manifest, false);
      this.plugins.set(manifest.id, p);
      // 覆盖安装默认当成「用户想用它」，把禁用标记清掉
      this.setDisabled(manifest.id, false);
      this.saveCfg();

      if (had) {
        try { fs.rmSync(backup, { recursive: true, force: true }); } catch (e) { /* 删不掉就留着，不影响使用 */ }
      }

      try {
        await p.load();
        p.info('已安装 v' + manifest.version + '（来自 ' + str(filename, 80) + '）');
      } catch (e) {
        // 装上了但跑不起来：保留文件，把错误摊在界面上，用户能看到哪一行坏了
        p.error = e && e.message ? e.message : String(e);
        this.lastError.set(manifest.id, p.error);
        p.logError('安装成功但加载失败: ' + p.error);
      }

      // 装的是跟内置插件同名的包：内置那份会被盖住，界面上得说一声
      const shadowed = !!this.builtinOf(manifest.id);
      if (shadowed) log.warn('plugin', `插件 ${manifest.id} 盖住了内置的同名插件（卸载后内置版会自动接回来）`);

      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        loaded: p.loaded,
        error: p.error,
        shadowed,
      };
    } finally {
      // 临时目录里可能还剩东西（比如插件包多套了一层），装完一律清掉
      try {
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
      } catch (e) { /* ignore */ }
    }
  }

  async uninstall(id) {
    const p = this.get(id);
    if (!p) throw new Error('插件不存在');
    if (p.builtin) throw new Error('内置插件不能卸载，只能禁用');
    p.unload();
    this.plugins.delete(p.id);
    this.lastError.delete(p.id);
    // 数据目录跟着插件目录一起删。要留档的话用户得自己先备份
    fs.rmSync(p.dir, { recursive: true, force: true });
    this.setDisabled(p.id, false);
    this.saveCfg();
    log.info('plugin', `已卸载插件 ${p.id}`);

    // 卸载的如果是个「盖住内置版」的同名插件，内置那份要立刻接回来，
    // 不然列表里这个插件就直接消失了，得重启程序才看得到内置版
    const back = this.builtinOf(p.id);
    if (back) {
      this.plugins.set(back.manifest.id, back);
      try {
        await back.load();
        back.info('已接回内置版 v' + back.manifest.version);
      } catch (e) {
        back.error = e && e.message ? e.message : String(e);
        this.lastError.set(back.id, back.error);
        back.logError('接回内置版失败: ' + back.error);
      }
    }
    return this.list();
  }

  // 内置目录里有没有这个 id 的插件（卸载用户版后要接回来）
  builtinOf(id) {
    for (const nm of fs.existsSync(BUILTIN_DIR) ? fs.readdirSync(BUILTIN_DIR) : []) {
      const dir = path.join(BUILTIN_DIR, nm);
      let manifestFile = '';
      for (const mf of MANIFEST_NAMES) {
        const f = path.join(dir, mf);
        if (fs.existsSync(f)) { manifestFile = f; break; }
      }
      if (!manifestFile) continue;
      try {
        const manifest = normalizeManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), nm);
        if (manifest.id === String(id)) return new Plugin(this, dir, manifest, true);
      } catch (e) { /* 内置那份自己坏了就跳过，不影响卸载流程 */ }
    }
    return null;
  }

  // ---------- 运行时 ----------

  // 消息广播。插件之间互不影响：一个抛错、一个卡住，都不耽误别的收消息
  async dispatchMessage(msg) {
    const jobs = [];
    for (const p of this.plugins.values()) {
      if (!p.loaded || !p.handlers.message.length) continue;
      for (const fn of p.handlers.message) {
        jobs.push(withTimeout(Promise.resolve().then(() => fn(p.api, msg)), T.message, 'onMessage')
          .catch((e) => p.warn('onMessage 出错: ' + (e && e.message ? e.message : e))));
      }
    }
    if (jobs.length) await Promise.allSettled(jobs);
  }

  // 插件自己的 HTTP 接口：/api/plugin/<id>/api/*
  async handleRequest(id, req) {
    const p = this.get(id);
    if (!p) throw new Error('插件不存在');
    if (!p.loaded) throw new Error('插件没有正常运行' + (p.error ? '：' + p.error : ''));
    if (!p.exports || typeof p.exports.onRequest !== 'function') {
      throw new Error('这个插件没有提供 HTTP 接口（没导出 onRequest）');
    }
    const ret = await withTimeout(
      Promise.resolve().then(() => p.exports.onRequest(p.api, req)),
      T.request,
      '插件接口',
    );
    return normalizeHttpResponse(ret);
  }

  // 外部界面的静态文件。只能读插件目录里 ui.entry 那一层以内的东西，
  // 免得插件页写个 ../../config.json 就把主配置读走了
  uiFile(id, relPath) {
    const p = this.get(id);
    if (!p) throw new Error('插件不存在');
    if (!p.manifest.ui) throw new Error('这个插件没有外部界面');
    const root = path.dirname(path.join(p.dir, p.manifest.ui.entry));
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '') || path.basename(p.manifest.ui.entry);
    const full = path.join(root, rel);
    if (!isInside(root, full)) throw new Error('路径越界');
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error('文件不存在: ' + rel);
    return { file: full, root };
  }

  coverFile(id) {
    const p = this.get(id);
    if (!p) throw new Error('插件不存在');
    const c = p.manifest.cover;
    if (!c) throw new Error('没有封面');
    // 远程封面直接让前端用 URL，不走这里
    if (/^https?:\/\//i.test(c)) return { url: c };
    const full = path.join(p.dir, c);
    if (!isInside(p.dir, full) || !fs.existsSync(full)) throw new Error('封面文件不存在');
    return { file: full };
  }

  closeAll() {
    for (const p of this.plugins.values()) {
      try { p.unload(); } catch (e) { /* ignore */ }
    }
  }
}

function findManifest(dir) {
  for (const mf of MANIFEST_NAMES) {
    const f = path.join(dir, mf);
    if (fs.existsSync(f)) return f;
  }
  return '';
}

// 升级安装时把旧的 data/ 搬到新目录里。同名文件以新包自带的为准
// （新包要是自己带了一份 data/ 种子，尊重它；用户的 config.json / store.json 正常不会撞）
function moveData(from, to) {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  try {
    fs.mkdirSync(to, { recursive: true });
    for (const nm of fs.readdirSync(from)) {
      const src = path.join(from, nm);
      const dst = path.join(to, nm);
      if (fs.existsSync(dst)) continue;
      try { fs.renameSync(src, dst); n += 1; } catch (e) {
        log.warn('plugin', '升级时搬数据失败 ' + nm + ': ' + (e && e.message ? e.message : e));
      }
    }
  } catch (e) {
    log.warn('plugin', '升级时搬数据目录失败: ' + (e && e.message ? e.message : e));
  }
  return n;
}

// 插件 onRequest 的返回值放宽一点：字符串当文本、对象当 JSON、Buffer 原样发
function normalizeHttpResponse(ret) {
  if (ret === undefined || ret === null) return { status: 200, type: 'application/json', body: { ok: true } };
  if (Buffer.isBuffer(ret)) return { status: 200, type: 'application/octet-stream', body: ret };
  if (typeof ret === 'string') return { status: 200, type: 'text/plain; charset=utf-8', body: ret };
  if (typeof ret === 'object') {
    if (ret.body !== undefined && (ret.status || ret.type)) {
      return {
        status: Number(ret.status) || 200,
        type: ret.type || (typeof ret.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json'),
        body: ret.body,
      };
    }
    return { status: 200, type: 'application/json', body: ret };
  }
  return { status: 200, type: 'text/plain; charset=utf-8', body: String(ret) };
}

module.exports = {
  PluginManager, normalizeManifest, USER_DIR, BUILTIN_DIR, PERMISSIONS, ICONS,
};
