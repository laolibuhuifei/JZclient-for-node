// 云存储上传(七牛): 图片/链接封面
// 流程: POST /token/pic/transfer 取凭证 -> 上传到 upload.qiniup.com
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ApiClient } = require('./api');
const site = require('./site');
const log = require('./logger');

const CHAT_HOST = site.api.chatHost;

function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

// 解析图片尺寸(JPEG/PNG/GIF)
function imageSize(buf) {
  if (!buf || buf.length < 24) return { width: 0, height: 0 };
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.slice(0, 3).toString('ascii') === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = buf.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      o += 2 + len;
    }
  }
  return { width: 0, height: 0 };
}

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.(jpe?g|png|gif|webp)$/);
  if (!m) return '.jpg';
  return '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
}

// ICO 内嵌 PNG 提取(现代 favicon 常见), 取最大的一张
function icoToPng(buf) {
  if (!buf || buf.length < 22 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1 || buf[3] !== 0) return null;
  const count = buf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > buf.length) break;
    const size = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    if (off + size > buf.length) continue;
    const data = buf.slice(off, off + size);
    if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50) {
      if (!best || data.length > best.length) best = data;
    }
  }
  return best;
}

async function fetchBuffer(url, timeout = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 根据文件头判断图片格式(无法识别返回 null)
function detectExt(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.length > 3 && buf.slice(0, 3).toString('ascii') === 'GIF') return '.gif';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}

// 支持本地路径或 http(s) URL 的图片来源
async function loadImageSource(src, timeout = 15000) {
  const s = String(src || '').trim();
  if (!s) throw new Error('图片地址为空');
  if (/^https?:\/\//i.test(s)) {
    const buf = await fetchBuffer(s, timeout);
    if (!buf || !buf.length) throw new Error('图片下载失败: ' + s);
    if (buf.length > 15 * 1024 * 1024) throw new Error('图片超过 15MB');
    const png = icoToPng(buf);
    if (png) return { buf: png, filename: 'image.png' };
    const ext = detectExt(buf);
    if (!ext) throw new Error('该地址不是有效图片: ' + s);
    return { buf, filename: 'image' + ext };
  }
  if (!fs.existsSync(s)) throw new Error('文件不存在: ' + s);
  const buf = fs.readFileSync(s);
  if (buf.length > 15 * 1024 * 1024) throw new Error('图片超过 15MB');
  const base = s.split(/[\\/]/).pop() || '';
  const ext = detectExt(buf) || (/\.(jpe?g|png|gif|webp)$/i.test(base) ? extOf(base) : null);
  if (!ext) throw new Error('不是有效图片: ' + s);
  return { buf, filename: 'image' + ext };
}

async function uploadToQiniu(token, key, buf, filename, endpoint) {
  const fd = new FormData();
  fd.append('token', token);
  fd.append('key', key);
  fd.append('file', new Blob([buf]), filename);
  const base = String(endpoint || 'https://upload.qiniup.com').replace(/^http:/, 'https:').replace(/\/+$/, '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch(base, { method: 'POST', body: fd, signal: ac.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!r.ok) {
      throw new Error('七牛上传失败: ' + ((json && (json.error || json.message)) || text.slice(0, 200)));
    }
    if (json && json.error) {
      throw new Error('七牛上传失败: ' + (json.error || text.slice(0, 200)));
    }
    // 上传凭证配置了回调时, 七牛会直接返回业务回调结果(如 {"code":"000001","desc":"success"})
    if (json && json.code && json.code !== '000001') {
      throw new Error(`上传回调失败: [${json.code}] ${json.desc || ''}`);
    }
    return json || { key };
  } finally {
    clearTimeout(timer);
  }
}

// 申请图片上传凭证(不同数据中心的网关不同, 依次尝试)
async function getPhotoToken(cfg, opts) {
  const ext = extOf(opts.filename);
  const body = {
    format: ext,
    smallPicFormat: ext,
    md5: md5Hex(opts.buf),
    dialogType: opts.group ? 3 : 4,
    dialogIds: opts.group ? [opts.dialogId, opts.myImAccountId] : [opts.dialogId],
    reSend: 0,
    localPornCensorSwitch: false,
    businessType: 0,
  };
  const hosts = [CHAT_HOST, site.api.mainHost, site.api.contactHost];
  const errors = [];
  for (const host of hosts) {
    const api = new ApiClient(Object.assign({}, cfg, { apiHost: host }));
    let r;
    try {
      r = await api.request('POST', '/token/pic/transfer', body);
    } catch (e) {
      errors.push(`${host}: ${e.message}`);
      continue;
    }
    if (r.json && r.json.code === '000001') return r.json.data || {};
    errors.push(`${host}: ${r.status} ${r.json ? '[' + r.json.code + '] ' + (r.json.desc || '') : String(r.text).slice(0, 80)}`);
  }
  throw new Error('获取上传凭证失败: ' + errors.join(' | '));
}

// 上传图片, 返回可直接放入 PhotoMessage/RelayH5Message 的 source/smallPic
async function uploadImage(cfg, opts) {
  const bean = await getPhotoToken(cfg, opts);
  const type = String(bean.type || '');
  if (type !== '1') {
    throw new Error(`当前云存储类型(${type || '未知'})暂不支持, 目前仅实现七牛`);
  }
  const src = bean.source || {};
  if (!bean.uploadToken || !src.key) throw new Error('上传凭证缺少 uploadToken/source.key');
  await uploadToQiniu(bean.uploadToken, src.key, opts.buf, 'image' + extOf(opts.filename));
  const size = imageSize(opts.buf);
  const source = {
    key: src.key,
    downloadUrl: src.downloadUrl || '',
    urlDeadline: src.urlDeadline || 0,
    width: size.width,
    height: size.height,
  };
  return {
    type: '1',
    source,
    smallPic: { key: src.key, downloadUrl: src.downloadUrl || '', urlDeadline: src.urlDeadline || 0 },
  };
}

// ============ 语音 / 视频 / 播放 ============

function tmpFile(ext) {
  return path.join(os.tmpdir(), 'watch_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + (ext || ''));
}

function extOfMedia(name) {
  const m = String(name || '').toLowerCase().match(/\.(amr|mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4|mov|m4v|3gp|mkv|avi|jpe?g|png|gif|webp)$/);
  if (!m) return '';
  return '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
}

// 读取本地文件或 http(s) 资源(任意媒体类型)
async function loadMediaSource(src, extDefault) {
  const s = String(src || '').trim();
  if (!s) throw new Error('地址为空');
  if (/^https?:\/\//i.test(s)) {
    const buf = await fetchBuffer(s, 60000);
    if (!buf || !buf.length) throw new Error('下载失败: ' + s);
    if (buf.length > 100 * 1024 * 1024) throw new Error('文件超过 100MB');
    let name = '';
    try { name = decodeURIComponent(s.split('?')[0].split('/').pop() || ''); } catch (e) { name = ''; }
    return { buf, filename: name || ('media' + (extDefault || '')) };
  }
  if (!fs.existsSync(s)) throw new Error('文件不存在: ' + s);
  const buf = fs.readFileSync(s);
  if (buf.length > 100 * 1024 * 1024) throw new Error('文件超过 100MB');
  return { buf, filename: s.split(/[\\/]/).pop() || ('media' + (extDefault || '')) };
}

// 按文件头猜媒体扩展名(图片/音频/视频), 认不出来返回 ''
// base64 里没有文件名, 但转码和上传都要靠后缀判断格式, 所以只能嗅探
function sniffMediaExt(buf) {
  if (!buf || buf.length < 12) return '';
  const a = (o, n) => buf.slice(o, o + n).toString('ascii');
  const img = detectExt(buf);
  if (img) return img;
  if (a(0, 5) === '#!AMR') return '.amr';
  if (a(0, 6) === '!Opus.') return '.opus';
  if (a(0, 4) === 'OggS') return '.ogg';
  if (a(0, 4) === 'fLaC') return '.flac';
  if (a(0, 4) === 'RIFF') {
    const t = a(8, 4);
    if (t === 'WAVE') return '.wav';
    if (t === 'AVI ') return '.avi';
  }
  if (a(0, 3) === 'ID3') return '.mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return '.mp3';
  if (a(4, 4) === 'ftyp') {
    const brand = a(8, 4).toLowerCase();
    if (brand.indexOf('m4a') === 0 || brand.indexOf('m4b') === 0) return '.m4a';
    if (brand === 'qt  ') return '.mov';
    return '.mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.webm';
  return '';
}

// 把各家框架五花八门的媒体写法统一成「http(s) 地址」或「本地文件路径」。
// OneBot 规范只约定了 http(s), 但实际上:
//   NapCat / go-cqhttp 发本地图会塞 base64://
//   AstrBot 的 aiocqhttp 适配器也用 base64://, 语音/文件还用 file:///abs/path
// 只认 http(s) 的话插件一发表情包、一放歌就整条链失败(1400), 所以这里全部解开。
// 返回 { src, tmp }: tmp=true 表示是临时文件, 调用方用完必须 cleanupMediaSrc()。
function resolveMediaSrc(raw, hint) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('媒体地址为空');
  if (/^https?:\/\//i.test(s)) return { src: s, tmp: false };

  const defExt = hint === 'image' ? '.jpg' : hint === 'video' ? '.mp4' : '.mp3';

  // base64://<data>  或  data:image/png;base64,<data>
  let b64 = '';
  if (/^base64:\/\//i.test(s)) b64 = s.slice('base64://'.length);
  else if (/^data:[^,]*;base64,/i.test(s)) b64 = s.replace(/^data:[^,]*;base64,/i, '');

  if (b64) {
    // 允许换行、URL-safe 变体
    b64 = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('base64 媒体内容为空');
    if (buf.length > 100 * 1024 * 1024) throw new Error('媒体超过 100MB');
    const ext = sniffMediaExt(buf) || defExt;
    const f = tmpFile(ext);
    fs.writeFileSync(f, buf);
    return { src: f, tmp: true };
  }

  // file:///abs/path (Windows 上是 file:///C:/x)
  let p = s;
  if (/^file:\/\//i.test(p)) {
    p = p.slice('file://'.length);
    if (/^\/[a-z]:\//i.test(p)) p = p.slice(1);
    try { p = decodeURIComponent(p); } catch (e) { /* 保持原样 */ }
  }
  if (fs.existsSync(p)) return { src: p, tmp: false };

  throw new Error('媒体地址无法识别(支持 http(s) / base64:// / file:// / 本地路径): ' + s.slice(0, 80)
    + (/^[\w.\-]+$/.test(s) ? ' —— 这看起来是 QQ 的裸文件名, 需要框架提供 url 或 path 字段' : ''));
}

function cleanupMediaSrc(r) {
  if (!r || !r.tmp || !r.src) return;
  try { fs.unlinkSync(r.src); } catch (e) { /* ignore */ }
}

function probeDurationBuf(buf, ext) {
  const f = tmpFile(ext || '.bin');
  fs.writeFileSync(f, buf);
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f], { encoding: 'utf8', timeout: 30000 });
    const d = Number(String(r.stdout || '').trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch (e) {
    return 0;
  } finally {
    try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}

function isAmr(buf) {
  return !!buf && buf.length > 6 && buf.slice(0, 5).toString('ascii') === '#!AMR';
}

function isWatchOpus(buf) {
  return !!buf && buf.length > 9 && buf.slice(0, 6).toString('ascii') === '!Opus.';
}

// 自定义 Opus: [0x21 'Opus.' 0x01 rateLE16] + 每包 [len][opus packet]
function watchOpusDuration(buf) {
  let o = 9, n = 0;
  while (o < buf.length) {
    const l = buf[o];
    if (!l) break;
    o += 1 + l;
    n++;
  }
  return n * 0.02;
}

function oggOpusToWatch(ogg, rate) {
  let off = 0;
  const packets = [];
  let cur = [];
  while (off + 27 <= ogg.length) {
    if (ogg.toString('ascii', off, off + 4) !== 'OggS') break;
    const nseg = ogg[off + 26];
    const segEnd = off + 27 + nseg;
    if (segEnd > ogg.length) break;
    let p = segEnd;
    for (let i = 0; i < nseg; i++) {
      const l = ogg[off + 27 + i];
      if (p + l > ogg.length) break;
      cur.push(ogg.slice(p, p + l));
      p += l;
      if (l < 255) { packets.push(Buffer.concat(cur)); cur = []; }
    }
    off = p;
  }
  const audio = packets.slice(2); // OpusHead / OpusTags
  if (!audio.length) throw new Error('Opus 转码结果为空');
  const parts = [Buffer.from([0x21, 0x4f, 0x70, 0x75, 0x73, 0x2e, 0x01, rate & 0xff, (rate >> 8) & 0xff])];
  for (const pk of audio) {
    if (pk.length > 255) throw new Error('Opus 包超过 255 字节');
    parts.push(Buffer.from([pk.length]), pk);
  }
  return { buf: Buffer.concat(parts), duration: audio.length * 0.02, audioType: 1 };
}

// 探测本地文件时长(秒), 拿不到就返回 0
function probeDuration(file) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { encoding: 'utf8', timeout: 30000 });
    const d = Number(String(r.stdout || '').trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch (e) {
    return 0;
  }
}

// 下载到临时文件。要探测时长、要切段的场景必须先落到本地(ffmpeg 只吃文件)。
async function downloadToTmp(url, hint) {
  const buf = await fetchBuffer(url, 60000);
  if (!buf || !buf.length) throw new Error('下载失败: ' + String(url).slice(0, 80));
  if (buf.length > 100 * 1024 * 1024) throw new Error('文件超过 100MB');
  const ext = sniffMediaExt(buf) || (hint === 'video' ? '.mp4' : hint === 'image' ? '.jpg' : '.mp3');
  const f = tmpFile(ext);
  fs.writeFileSync(f, buf);
  return f;
}

// 把超长音频切成多段 —— 微聊语音上限 60 秒, 超了发不出去。
// 先用 -c copy 直接切流(不重编码, 快且不掉音质); 容器/编码不支持时退回重编码成 16k 单声道 mp3 再切。
// 返回 { dir, files }; 用完必须调 cleanupSplit()。
function splitAudio(file, maxSec) {
  const sec = Math.max(5, Math.round(Number(maxSec) || 58));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch_seg_'));
  const ext = extOfMedia(file) || '.mp3';
  const pick = () => fs.readdirSync(dir).filter((f) => /^seg_\d+\./.test(f)).sort()
    .map((f) => path.join(dir, f));
  const run = (args) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file].concat(args), { timeout: 300000 });

  let r = run(['-f', 'segment', '-segment_time', String(sec), '-reset_timestamps', '1',
    '-c', 'copy', path.join(dir, 'seg_%03d' + ext)]);
  let files = pick();
  if (r.status !== 0 || !files.length) {
    files.forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } });
    r = run(['-ar', '16000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k',
      '-f', 'segment', '-segment_time', String(sec), '-reset_timestamps', '1',
      path.join(dir, 'seg_%03d.mp3')]);
    files = pick();
  }
  return { dir, files };
}

function cleanupSplit(res) {
  if (!res || !res.dir) return;
  try { fs.rmSync(res.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// 异步跑 ffmpeg。视频重编码可能要几分钟, 用 spawnSync 会把整个事件循环卡住
// (实例里 IM 心跳/HTTP 全停), 所以这里一律异步等。
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let err = '';
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, err });
    };
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error'].concat(args), { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } }, timeoutMs || 900000);
    p.on('error', (e) => { err = e.message; finish(-1); });
    p.on('close', (code) => finish(code));
  });
}

// 把超长视频切成多段 —— 微聊单条视频上限 30 秒, 超了手表端放不出来。
//
// 切视频比切音频麻烦: `-c copy` 只能在关键帧处断开, 所以每段实际时长会
// **大于等于** 目标值(取决于原片的 GOP)。所以分两步:
//   1. 先按 maxSec-2 秒用 `-c copy` 快切(几秒完事, 不掉画质), 切完逐段 ffprobe;
//   2. 只要有一段还超过 maxSec, 就整体重编码, 并用 `-force_key_frames` 把关键帧
//      精确钉在切点上 —— 慢, 但保证每段都不超。
// 返回 { dir, files, reencoded }; 用完必须调 cleanupSplit()。
async function splitVideo(file, maxSec) {
  const limit = Math.max(5, Math.round(Number(maxSec) || 30));
  // 留 2 秒余量给关键帧造成的溢出
  const cut = Math.max(4, limit - 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch_vseg_'));
  const ext = extOfMedia(file) || '.mp4';
  const pick = () => fs.readdirSync(dir).filter((f) => /^seg_\d+\./.test(f)).sort()
    .map((f) => path.join(dir, f));
  const wipe = () => {
    for (const f of pick()) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
  };
  const segOut = path.join(dir, 'seg_%03d' + ext);
  const segArgs = (extra) => ['-i', file].concat(extra, [
    '-f', 'segment', '-segment_time', String(cut), '-reset_timestamps', '1', segOut,
  ]);
  // 每段都必须在 limit 以内, 超一条就得重来
  const allFit = () => pick().every((f) => {
    const d = probeDuration(f);
    return d > 0 && d <= limit;
  });

  let r = await runFfmpeg(segArgs(['-c', 'copy']), 300000);
  let files = pick();
  let reencoded = false;
  if (r.code !== 0 || !files.length || !allFit()) {
    wipe();
    log.debug('upload', '视频快切不可用/切完仍超长, 改为重编码切分: ' + (r.err || '').slice(0, 120));
    r = await runFfmpeg(segArgs([
      // 把关键帧精确钉在 cut 的整数倍上, 这样 -f segment 就会正好在这里断开
      '-force_key_frames', 'expr:gte(t,n_forced*' + cut + ')',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
      '-c:a', 'aac', '-b:a', '96k',
    ]), 1800000);
    files = pick();
    reencoded = true;
  }
  if (r.code !== 0 && !files.length) {
    log.warn('upload', '视频切分失败: ' + String(r.err || '').slice(0, 200));
  }
  return { dir, files, reencoded };
}


// mp3/wav/webm/m4a -> 自定义 Opus
function toWatchOpus(buf, ext) {
  const inPath = tmpFile(ext || '.bin');
  const outPath = tmpFile('.ogg');
  fs.writeFileSync(inPath, buf);
  try {
    const r = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', inPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'libopus', '-b:a', '16k',
      '-vbr', 'off', '-frame_duration', '20', '-f', 'ogg', outPath,
    ], { timeout: 120000 });
    if (r.status !== 0 || !fs.existsSync(outPath)) {
      const msg = r.error ? r.error.message : String(r.stderr || '').slice(0, 200);
      throw new Error('音频转码失败(需要 ffmpeg + libopus): ' + (msg || '未知错误'));
    }
    return oggOpusToWatch(fs.readFileSync(outPath), 16000);
  } finally {
    try { fs.unlinkSync(inPath); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(outPath); } catch (e) { /* ignore */ }
  }
}

// 七牛上传凭证(spaceType 1 = 聊天媒体桶)
async function getQiniuUploadToken(cfg, spaceType) {
  const hosts = [site.api.mainHost, site.api.contactHost, site.api.chatHost];
  const errors = [];
  for (const host of hosts) {
    const api = new ApiClient(Object.assign({}, cfg, { apiHost: host }));
    let r;
    try {
      r = await api.request('GET', `/token/uploadNew/${spaceType}`);
    } catch (e) {
      errors.push(host + ': ' + e.message);
      continue;
    }
    if (r.json && r.json.code === '000001' && r.json.data && r.json.data.uploadToken) {
      return r.json.data.uploadToken;
    }
    errors.push(host + ': ' + (r.json ? '[' + r.json.code + '] ' + (r.json.desc || '') : String(r.text).slice(0, 80)));
  }
  throw new Error('获取上传凭证失败: ' + errors.join(' | '));
}

// 用 key 换取带签名的下载地址
async function getDownloadUrl(cfg, key, fileType) {
  const hosts = [site.api.mainHost, site.api.contactHost];
  const errors = [];
  for (const host of hosts) {
    const api = new ApiClient(Object.assign({}, cfg, { apiHost: host }));
    let r;
    try {
      r = await api.request('POST', '/token/download', {
        fileType: fileType || 2,
        keys: [key],
        longEdge: 0,
        shortEdge: 0,
      });
    } catch (e) {
      errors.push(host + ': ' + e.message);
      continue;
    }
    if (r.json && r.json.code === '000001' && Array.isArray(r.json.data) && r.json.data[0]) {
      return r.json.data[0];
    }
    errors.push(host + ': ' + (r.json ? '[' + r.json.code + '] ' + (r.json.desc || '') : String(r.text).slice(0, 80)));
  }
  throw new Error('获取下载地址失败: ' + errors.join(' | '));
}

function urlDeadline(url) {
  const m = /[?&]e=(\d+)/.exec(String(url || ''));
  return m ? Number(m[1]) * 1000 : 0;
}


async function getVideoToken(cfg, body) {
  const hosts = [site.api.chatHost, site.api.mainHost, site.api.contactHost];
  const errors = [];
  for (const host of hosts) {
    const api = new ApiClient(Object.assign({}, cfg, { apiHost: host }));
    let r;
    try {
      r = await api.request('POST', '/token/video/transfer', body);
    } catch (e) {
      errors.push(host + ': ' + e.message);
      continue;
    }
    if (r.json && r.json.code === '000001') return r.json.data || {};
    errors.push(host + ': ' + (r.json ? '[' + r.json.code + '] ' + (r.json.desc || '') : String(r.text).slice(0, 80)));
  }
  throw new Error('获取视频上传凭证失败: ' + errors.join(' | '));
}

// 上传语音(AMR 原样上传; 其他格式先转自定义 Opus)
async function uploadVoice(cfg, opts = {}) {
  let buf = opts.buf;
  let name = opts.filename || '';
  if (!buf) {
    const loaded = await loadMediaSource(opts.src, '.amr');
    buf = loaded.buf;
    name = loaded.filename;
  }
  if (!buf || !buf.length) throw new Error('音频为空');
  if (buf.length > 30 * 1024 * 1024) throw new Error('音频超过 30MB');

  let audioType = 0;
  let duration = 0;
  if (isWatchOpus(buf)) {
    audioType = 1;
    duration = watchOpusDuration(buf);
  } else if (isAmr(buf)) {
    audioType = 0;
    duration = probeDurationBuf(buf, '.amr') || Math.max(1, Math.round((buf.length - 6) / 32 * 0.02));
  } else {
    const converted = toWatchOpus(buf, extOfMedia(name) || '.mp3');
    buf = converted.buf;
    audioType = converted.audioType;
    duration = converted.duration;
  }

  const uploadToken = await getQiniuUploadToken(cfg, 1);
  const key = crypto.randomUUID().replace(/-/g, '');
  await uploadToQiniu(uploadToken, key, buf, 'voice.amr');
  const downloadUrl = await getDownloadUrl(cfg, key, 2);
  return {
    key,
    downloadUrl,
    duration: Math.max(1, Math.round(duration || 1)),
    audioType,
    deadline: urlDeadline(downloadUrl),
  };
}

function extractThumbJpeg(buf, ext) {
  const inPath = tmpFile(ext || '.mp4');
  const outPath = tmpFile('.jpg');
  fs.writeFileSync(inPath, buf);
  try {
    const r = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', inPath, '-vframes', '1',
      '-vf', 'scale=480:-2', '-q:v', '4', outPath,
    ], { timeout: 60000 });
    if (r.status === 0 && fs.existsSync(outPath)) return fs.readFileSync(outPath);
    return null;
  } finally {
    try { fs.unlinkSync(inPath); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(outPath); } catch (e) { /* ignore */ }
  }
}

// 上传视频, 返回可放入 VideoMessage 的字段
async function uploadVideo(cfg, opts = {}) {
  let buf = opts.buf;
  let name = opts.filename || '';
  if (!buf) {
    const loaded = await loadMediaSource(opts.src, '.mp4');
    buf = loaded.buf;
    name = loaded.filename;
  }
  if (!buf || !buf.length) throw new Error('视频为空');
  if (buf.length > 100 * 1024 * 1024) throw new Error('视频超过 100MB');

  const ext = extOfMedia(name) || '.mp4';
  const duration = probeDurationBuf(buf, ext);
  const thumb = extractThumbJpeg(buf, ext);
  const token = await getVideoToken(cfg, {
    format: ext,
    iconFormat: '.jpg',
    md5: md5Hex(buf),
    dialogType: opts.group ? 3 : 4,
    dialogIds: opts.group ? [opts.dialogId, opts.myImAccountId] : [opts.dialogId],
    reSend: 0,
    localPornCensorSwitch: false,
    businessType: 0,
  });
  if (!token.uploadToken || !token.source || !token.source.key) throw new Error('视频上传凭证缺少字段');
  await uploadToQiniu(token.uploadToken, token.source.key, buf, 'video' + ext, token.regionDomain);
  if (thumb && token.iconUploadToken && token.icon && token.icon.key) {
    await uploadToQiniu(token.iconUploadToken, token.icon.key, thumb, 'thumb.jpg', token.regionDomain);
  }
  return {
    type: token.type || '1',
    zone: token.zone || '',
    wangSuUrl: token.wangSuUrl || '',
    source: token.source,
    icon: token.icon || null,
    transfer: token.transfer || null,
    customParamMap: token.customParamMap || {},
    videoLength: Math.max(1, Math.round(duration || 1)),
    videoType: 0,
  };
}

// 直接使用外链视频
function directVideo(url, duration) {
  return {
    type: '1', zone: '', wangSuUrl: '',
    source: { key: '', downloadUrl: url, urlDeadline: 0, width: 0, height: 0 },
    icon: null, transfer: null, customParamMap: {},
    videoLength: Math.max(0, Math.round(Number(duration) || 0)), videoType: 0,
  };
}

function playAudioFile(file) {
  return new Promise((resolve, reject) => {
    let cmd = 'afplay';
    let args = [file];
    if (process.platform !== 'darwin') {
      cmd = 'ffplay';
      args = ['-nodisp', '-autoexit', '-loglevel', 'quiet', file];
    }
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', (e) => reject(new Error('没有可用的音频播放器: ' + e.message)));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('播放器退出码 ' + code))));
  });
}

// 下载并播放语音
async function playMediaUrl(url) {
  const buf = await fetchBuffer(url, 30000);
  if (!buf || !buf.length) throw new Error('语音下载失败');
  const f = tmpFile(extOfMedia(url.split('?')[0]) || '.mp3');
  fs.writeFileSync(f, buf);
  try {
    await playAudioFile(f);
  } finally {
    try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}

// 用系统默认程序打开(视频/图片)
function openMediaUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'cmd' : 'xdg-open');
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.unref();
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  fetchBuffer,
  uploadImage,
  uploadVoice,
  uploadVideo,
  directVideo,
  loadMediaSource,
  sniffMediaExt,
  resolveMediaSrc,
  cleanupMediaSrc,
  probeDuration,
  downloadToTmp,
  splitAudio,
  splitVideo,
  cleanupSplit,
  imageSize,
  md5Hex,
  extOf,
  icoToPng,
  loadImageSource,
  playAudioFile,
  playMediaUrl,
  openMediaUrl,
  CHAT_HOST,
};
