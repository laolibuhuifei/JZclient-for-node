// 云存储上传(七牛): 图片/链接封面
// 流程: POST /token/pic/transfer 取凭证 -> 上传到 upload.qiniup.com
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ApiClient } = require('./api');
const site = require('./site');

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
  const m = String(name || '').toLowerCase().match(/\.(amr|mp3|m4a|aac|wav|ogg|oga|opus|webm|mp4|mov|m4v|3gp|mkv|avi|jpe?g|png|gif|webp)$/);
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
