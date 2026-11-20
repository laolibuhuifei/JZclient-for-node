// 零依赖 SOCKS5 客户端。
//
// 云端实例可注入 JZ_PROXY_URL=socks5://host:port。这里只负责把 socket
// 接到目标（含 TLS 和 IM 长连接），业务代码继续使用原生 https / tls。
// 平台自身的后台和实例回连不带这个变量，因此不会误走实例代理。
const net = require('net');
const tls = require('tls');
const https = require('https');
const { URL } = require('url');
const { EventEmitter } = require('events');

const envUrl = String(process.env.JZ_PROXY_URL || '').trim();
let active = null;

function parseProxyUrl(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'socks5:' && u.protocol !== 'socks5h:') return null;
  const port = Number(u.port || 1080);
  if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
}

if (envUrl) {
  active = parseProxyUrl(envUrl);
  if (!active) {
    const log = require('./logger');
    log.warn('proxy', 'JZ_PROXY_URL 格式无效，实例将保持直连');
  }
}

function enabled() { return !!active; }
function info() { return active ? `socks5://${active.host}:${active.port}` : ''; }

// Platform callbacks and local resources must stay on the direct path even
// when the instance's external API traffic is routed through a public proxy.
// This is an explicit set of origins, not a pattern-match on the proxy URL.
function shouldBypass(url) {
  let target;
  try { target = new URL(String(url)); } catch (e) { return false; }
  const host = String(target.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  const ip = net.isIP(host);
  if (ip === 4) {
    const p = host.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
  }
  if (ip === 6 && (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host))) return true;
  const origins = [process.env.JZ_CONSOLE_URL, process.env.JZ_AI_BASE_URL]
    .map((value) => {
      try { return value ? new URL(String(value)).hostname.toLowerCase() : ''; } catch (e) { return ''; }
    })
    .filter(Boolean);
  return origins.includes(host);
}

function addressBytes(host, port) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  const p = Number(port);
  const portBytes = Buffer.from([(p >> 8) & 0xff, p & 0xff]);
  if (net.isIP(h) === 4) {
    return Buffer.concat([Buffer.from([1]), Buffer.from(h.split('.').map(Number)), portBytes]);
  }
  if (net.isIP(h) === 6) {
    const node = Buffer.alloc(16);
    const parts = h.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
    const full = left.concat(Array(Math.max(0, 8 - left.length - right.length)).fill('0'), right);
    full.forEach((part, i) => node.writeUInt16BE(parseInt(part || '0', 16), i * 2));
    return Buffer.concat([Buffer.from([4]), node, portBytes]);
  }
  const domain = Buffer.from(h, 'utf8');
  if (!domain.length || domain.length > 255) throw new Error('SOCKS5 目标地址无效');
  return Buffer.concat([Buffer.from([3, domain.length]), domain, portBytes]);
}

// CONNECT 成功后返回普通 TCP socket。调用方可以把它交给 tls.connect，
// 或直接用于明文 IM/HTTP 连接。
function connect(target, timeoutMs) {
  if (!active) return Promise.reject(new Error('没有配置 SOCKS5 代理'));
  const host = String(target.host || target.hostname || '');
  const port = Number(target.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new Error('SOCKS5 目标端口无效'));
  }
  const timeout = Math.max(1000, Number(timeoutMs || target.timeout) || 15000);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: active.host, port: active.port });
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    let done = false;
    const timer = setTimeout(() => fail(new Error('SOCKS5 连接超时')), timeout);

    function cleanup(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (!ok) {
        try { socket.destroy(); } catch (e) { /* ignore */ }
      }
    }
    function fail(error) {
      cleanup(false);
      reject(error);
    }
    function onError(error) { fail(error); }
    function onClose() {
      if (!done) fail(new Error('SOCKS5 代理提前关闭连接'));
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5) return fail(new Error('代理不是 SOCKS5 协议'));
        if (buffer[1] === 0xff) return fail(new Error('SOCKS5 代理不接受无认证连接'));
        if (buffer[1] !== 0) return fail(new Error('SOCKS5 代理要求认证'));
        buffer = buffer.slice(2);
        stage = 'reply';
        try {
          socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addressBytes(host, port)]));
        } catch (e) {
          fail(e);
        }
        return;
      }
      if (buffer.length < 5) return;
      const code = buffer[1];
      const atyp = buffer[3];
      let len = 0;
      if (atyp === 1) len = 10;
      else if (atyp === 4) len = 22;
      else if (atyp === 3) len = 7 + buffer[4];
      else return fail(new Error('SOCKS5 返回了未知地址类型'));
      if (buffer.length < len) return;
      const names = {
        1: '一般失败', 2: '规则拒绝', 3: '网络不可达', 4: '主机不可达',
        5: '连接被拒绝', 6: 'TTL 过期', 7: '命令不支持', 8: '地址类型不支持',
      };
      if (code !== 0) return fail(new Error('SOCKS5 ' + (names[code] || '错误 ' + code)));
      const tail = buffer.slice(len);
      cleanup(true);
      socket.pause();
      if (tail.length) socket.unshift(tail);
      resolve(socket);
    }

    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function connectTls(target, timeoutMs) {
  const host = String(target.host || target.hostname || '');
  return connect(target, timeoutMs).then((socket) => new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: target.servername || host,
      rejectUnauthorized: target.rejectUnauthorized !== false,
    }, () => {
      secure.removeListener('error', onError);
      secure.resume();
      resolve(secure);
    });
    function onError(error) {
      try { secure.destroy(); } catch (e) { /* ignore */ }
      reject(error);
    }
    secure.once('error', onError);
  }));
}

// 只替代发起连接这一层；返回真实 ClientRequest，所以业务代码的
// write/end/on/timeout/destroy 完全沿用 Node 原生语义。
function request(url, options, handler) {
  const target = typeof url === 'string' ? new URL(url) : url;
  const protocol = String(target && target.protocol || '').toLowerCase();
  if (!active || shouldBypass(target) || protocol !== 'https:') {
    const direct = protocol === 'http:' ? require('http') : https;
    return direct.request(url, options, handler);
  }
  const opts = Object.assign({}, options || {});
  const timeout = Math.max(1000, Number(opts.timeout) || 15000);
  const pending = new EventEmitter();
  let real = null;
  let destroyed = false;
  const queue = [];

  function fail(error) {
    if (destroyed) return;
    destroyed = true;
    pending.emit('error', error);
  }

  connectTls({
    host: target.hostname,
    port: Number(target.port) || 443,
    servername: target.hostname,
    rejectUnauthorized: opts.rejectUnauthorized,
  }, timeout).then((socket) => {
    if (destroyed) { socket.destroy(); return; }
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (agentOpts, cb) => {
      if (typeof cb === 'function') cb(null, socket);
      return socket;
    };
    real = https.request(target, Object.assign({}, opts, { agent }), handler);
    real.on('error', (e) => pending.emit('error', e));
    real.on('timeout', () => pending.emit('timeout'));
    real.on('close', () => pending.emit('close'));
    for (const item of queue) real.write(item.chunk, item.encoding, item.cb);
    queue.length = 0;
    pending.emit('_ready');
  }).catch(fail);

  pending.write = (chunk, encoding, cb) => {
    if (destroyed) return false;
    if (real) return real.write(chunk, encoding, cb);
    queue.push({ chunk, encoding, cb });
    return true;
  };
  pending.end = (chunk, encoding, cb) => {
    if (destroyed) return pending;
    if (chunk) {
      if (real) real.write(chunk, encoding, cb);
      else queue.push({ chunk, encoding, cb });
    }
    if (real) real.end();
    else pending.once('_ready', () => real.end());
    return pending;
  };
  pending.destroy = (error) => {
    destroyed = true;
    if (real) real.destroy(error);
    else if (error) pending.emit('error', error);
  };
  pending.setTimeout = (ms, cb) => {
    if (real) real.setTimeout(ms, cb);
    return pending;
  };
  pending.setHeader = (name, value) => {
    if (real) real.setHeader(name, value);
    else opts.headers = Object.assign({}, opts.headers || {}, { [name]: value });
  };
  pending.getHeader = (name) => {
    if (real) return real.getHeader(name);
    const h = opts.headers || {};
    const hit = Object.keys(h).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return hit ? h[hit] : undefined;
  };
  pending.abort = () => pending.destroy();
  return pending;
}

module.exports = {
  enabled, info, parseProxyUrl, shouldBypass, connect, connectTls, request,
  _setProxyForTests(value) {
    active = value ? parseProxyUrl(value) : null;
  },
};
