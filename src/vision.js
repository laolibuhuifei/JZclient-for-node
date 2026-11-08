// 图片消息 → data URL，给多模态模型看
//
// 为什么要在本地下载再转 base64，而不是把 URL 直接塞进 image_url：
//   1. 微聊的图片地址是小天才 CDN 的直链，能不能被上游抓到没有任何保证；
//   2. OpenAI 兼容协议虽然允许 image_url.url 是远程地址，但「网关替用户抓外链」
//      这件事各家实现不一致，DeepSeek 官方要的是 base64；
//   3. 直连还能顺便量一下大小 —— 超限的图在本地转码，比让上游返回 400 好排查。
//
// 手表拍的图一般是 JPEG、几百 KB，走快路径不额外花时间；只有 HEIC 或超大图
// 才会调 ffmpeg 转一次（项目本来就硬依赖 ffmpeg，切视频/语音都在用）。
'use strict';

const { spawn } = require('child_process');
const log = require('./logger');

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT = 15000;
const FFMPEG_MAX_EDGE = 1280;   // 转码时最长边，再大对识别没帮助，只是多烧 token

// 上游普遍认的四种。HEIC/HEIF 是苹果专有格式，网关一律不认，只能转码
const OK_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Content-Type 可以骗人，字节不会。只认文件头
function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  // HEIC/HEIF 的 ftyp box 里带 heic/heix/mif1 等品牌
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return 'image/heic';
  return '';
}

// ---------- 出站地址限制 ----------
//
// 图片地址来自 IM 消息体（服务端下发），本来就可信；这里拦内网是防御性的一层：
// 万一消息被伪造，不能让实例变成打内网的跳板。只看字面量 IP，不查 DNS ——
// 消息里出现域名解析到内网的概率极低，而每次识图都做一次 DNS 解析不值得。
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return h.includes(':') && (h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h));
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;          // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 运营商 NAT
  if (a >= 224) return true;                         // 组播 / 保留
  return false;
}

// opts.allowPrivate 只给测试用：测试要起一个本地 http 服务器喂图片，
// 不开这个口子就永远测不到「下载 → 校验 → 编码」这条主路径。
// 生产代码不要传它 —— 内网拦截就是为伪造消息准备的。
function checkUrl(raw, opts) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, reason: 'empty-url' };
  if (s.length > 2000) return { ok: false, reason: 'bad-url' };
  let u;
  try { u = new URL(s); } catch (e) { return { ok: false, reason: 'bad-url' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'bad-url' };
  if (u.username || u.password) return { ok: false, reason: 'bad-url' };
  if (!(opts && opts.allowPrivate) && isPrivateHost(u.hostname)) return { ok: false, reason: 'private-host' };
  return { ok: true, url: u, href: u.href };
}

// ---------- ffmpeg 转码 ----------
//
// 用 pipe 而不是临时文件：一张图一个临时文件，清理漏一次就是磁盘慢慢涨。
// 注意必须用 spawn —— spawnSync 会把整个事件循环卡住，WebUI 那几秒全无响应。
function toJpeg(buf, maxEdge) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let child;
    try {
      child = spawn('ffmpeg', [
        '-v', 'error',
        '-i', 'pipe:0',
        // 等比缩到 maxEdge×maxEdge 以内，小图不放大
        '-vf', `scale=w='min(iw,${maxEdge})':h='min(ih,${maxEdge})':force_original_aspect_ratio=decrease`,
        '-q:v', '5',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish(null);
    }

    const out = [];
    let errText = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      finish(null);
    }, 20000);

    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { if (errText.length < 600) errText += c.toString('utf8'); });
    // ffmpeg 没装时 spawn 会 emit error，别让它变成未捕获异常
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length) return finish(Buffer.concat(out));
      if (errText) log.debug('ai', 'ffmpeg 转码失败: ' + errText.slice(0, 200));
      finish(null);
    });
    child.stdin.on('error', () => { /* EPIPE：进程提前退出，close 里会收尾 */ });
    child.stdin.end(buf);
  });
}

// ---------- 下载 ----------
async function fetchBuf(url, opts) {
  const o = opts || {};
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeout || DEFAULT_TIMEOUT);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        // 小天才 CDN 对裸请求偶尔会拒，带上和网页端一致的 UA/Referer 更像正常流量
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        Referer: 'https://www.xtc.watch/',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      },
    });
    if (!resp.ok) {
      try { resp.body && resp.body.cancel(); } catch (e) { /* ignore */ }
      return { ok: false, reason: 'http-' + resp.status };
    }
    const limit = o.maxBytes || DEFAULT_MAX_BYTES;
    const len = Number(resp.headers.get('content-length') || 0);
    // 声明就超限的直接放弃，别把几十 MB 拉进内存再说不行
    if (len && len > limit * 2) {
      try { resp.body && resp.body.cancel(); } catch (e) { /* ignore */ }
      return { ok: false, reason: 'too-large' };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return { ok: true, buf, contentType: String(resp.headers.get('content-type') || '') };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'fetch-failed' };
  } finally {
    clearTimeout(timer);
  }
}

// 主入口。成功返回 { ok:true, dataUrl, mime, bytes, ms }，失败返回 { ok:false, reason }
async function toDataUrl(rawUrl, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const c = checkUrl(rawUrl, o);
  if (!c.ok) return { ok: false, reason: c.reason };

  const maxBytes = o.maxBytes || DEFAULT_MAX_BYTES;
  const got = await fetchBuf(c.href, { maxBytes, timeout: o.timeout });
  if (!got.ok) return { ok: false, reason: got.reason };

  let buf = got.buf;
  let mime = sniffMime(buf);
  if (!mime) return { ok: false, reason: 'not-image' };

  // 快路径：格式认、体积也合适，直接编码，不碰 ffmpeg
  if (OK_MIME.indexOf(mime) >= 0 && buf.length <= maxBytes) {
    return { ok: true, dataUrl: `data:${mime};base64,` + buf.toString('base64'), mime, bytes: buf.length, ms: Date.now() - t0 };
  }

  // 慢路径：HEIC 或者太大，转成 JPEG 再试
  const converted = await toJpeg(buf, FFMPEG_MAX_EDGE);
  if (!converted || !converted.length) return { ok: false, reason: 'convert-failed' };
  if (converted.length > maxBytes) return { ok: false, reason: 'too-large' };
  mime = sniffMime(converted) || 'image/jpeg';
  log.debug('ai', `图片已转码 ${buf.length} → ${converted.length} 字节`);
  return { ok: true, dataUrl: `data:${mime};base64,` + converted.toString('base64'), mime, bytes: converted.length, ms: Date.now() - t0 };
}

module.exports = {
  toDataUrl, checkUrl, sniffMime, isPrivateHost,
  DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT, FFMPEG_MAX_EDGE, OK_MIME,
};
