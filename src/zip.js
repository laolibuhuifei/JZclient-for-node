// 极简 ZIP 解压（零依赖）
//
// 只做插件安装要用的那一小部分：读中央目录 -> 按条目解 deflate -> 落到目录。
// ZIP 的容器格式本身很简单（一串带签名的记录），deflate 直接借 zlib，
// 为它引一个 adm-zip / yauzl 不值得，而且项目一直是不装依赖的。
//
// 不支持：加密（密码）、分卷、ZIP64 之外的边角情况、bzip2/lzma 压缩方式。
// 遇到就抛明确的错误，别让用户对着一个空目录猜。
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

// 解压上限。插件就是几个 js + 一张封面，超过这个数八成是压错了包（或者恶意构造）
const LIMITS = {
  entries: 600,                 // 条目数
  fileBytes: 16 * 1024 * 1024,  // 单个文件解压后
  totalBytes: 64 * 1024 * 1024, // 全部加起来
};

// ---------- CRC32 ----------
// 用来校验解出来的内容和中央目录里记的 crc 是否一致，能提前发现坏包
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- 文件名编码 ----------
// ZIP 规范里「是否 UTF-8」只由通用标志的第 11 位决定。国内 Windows 上打的包
// 这一位经常是 0，文件名其实是 GBK —— 直接按 utf8 解会得到一串问号，
// 中文名的封面图就找不到了。
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
let gbkDecoder = null;
function decodeName(raw, utf8Flag) {
  if (utf8Flag) return raw.toString('utf8');
  try {
    return utf8Strict.decode(raw);
  } catch (e) {
    if (gbkDecoder === null) {
      try { gbkDecoder = new TextDecoder('gbk'); } catch (e2) { gbkDecoder = false; }
    }
    if (gbkDecoder) {
      try { return gbkDecoder.decode(raw); } catch (e3) { /* 落到 latin1 */ }
    }
    return raw.toString('latin1');
  }
}

// ---------- 找 EOCD ----------
// 从文件尾往前扫（注释最长 65535，所以最多扫这么多），找到第一条记录的偏移
function findEocd(buf) {
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function readZip64(buf, eocdOff) {
  // ZIP64 的定位器固定 20 字节，紧挨在 EOCD 前面
  const loc = eocdOff - 20;
  if (loc < 0 || buf.readUInt32LE(loc) !== SIG_EOCD64_LOC) return null;
  const eocd64Off = Number(buf.readBigUInt64LE(loc + 8));
  if (eocd64Off < 0 || eocd64Off + 56 > buf.length) return null;
  if (buf.readUInt32LE(eocd64Off) !== SIG_EOCD64) return null;
  return {
    total: Number(buf.readBigUInt64LE(eocd64Off + 32)),
    cdSize: Number(buf.readBigUInt64LE(eocd64Off + 40)),
    cdOffset: Number(buf.readBigUInt64LE(eocd64Off + 48)),
  };
}

// ---------- 读中央目录 ----------
// 返回 [{ name, method, crc, compressedSize, size, offset, isDir }]
function readEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip 文件（太短）');
  const eocdOff = findEocd(buf);
  if (eocdOff < 0) throw new Error('不是有效的 zip 文件（找不到目录结束标记）');

  let total = buf.readUInt16LE(eocdOff + 10);
  let cdSize = buf.readUInt32LE(eocdOff + 12);
  let cdOffset = buf.readUInt32LE(eocdOff + 16);
  // 条目数/偏移溢出到 0xFFFF/0xFFFFFFFF 说明要用 ZIP64 记录里的真值
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const z64 = readZip64(buf, eocdOff);
    if (z64) { total = z64.total; cdSize = z64.cdSize; cdOffset = z64.cdOffset; }
  }
  if (cdOffset + cdSize > buf.length) throw new Error('zip 目录区越界，文件可能被截断了');

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length) throw new Error('zip 目录区损坏（第 ' + (i + 1) + ' 条）');
    if (buf.readUInt32LE(p) !== SIG_CD) throw new Error('zip 目录区签名不对（第 ' + (i + 1) + ' 条）');

    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);

    if (p + 46 + nameLen > buf.length) throw new Error('zip 目录区损坏（文件名越界）');
    const rawName = buf.slice(p + 46, p + 46 + nameLen);
    const name = decodeName(rawName, (flags & 0x800) !== 0);
    out.push({
      name,
      flags,
      method,
      crc,
      compressedSize,
      size,
      offset,
      isDir: /\/$/.test(name) || /\\$/.test(name),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (out.length > LIMITS.entries) {
    throw new Error('压缩包里条目太多（' + out.length + ' 个），插件包不该这样');
  }
  return out;
}

// ---------- 取单个条目的内容 ----------
function readEntry(buf, e) {
  if (e.flags & 0x1) throw new Error('压缩包里的 ' + e.name + ' 是加密的，请去掉密码重新打包');
  if (e.size > LIMITS.fileBytes) {
    throw new Error(e.name + ' 解压后 ' + Math.round(e.size / 1024) + 'KB，超过单文件上限');
  }
  const p = e.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) {
    throw new Error('本地文件头损坏: ' + e.name);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + e.compressedSize;
  if (end > buf.length) throw new Error('压缩数据越界: ' + e.name);

  const raw = buf.slice(start, end);
  let data;
  if (e.method === 0) {
    data = Buffer.from(raw);          // stored，没压缩
  } else if (e.method === 8) {
    data = zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.fileBytes });
  } else {
    throw new Error(e.name + ' 用了不支持的压缩方式（method=' + e.method + '），请用普通 zip 重新打包');
  }
  if (data.length !== e.size) {
    throw new Error(e.name + ' 解压后大小不符（期望 ' + e.size + '，实际 ' + data.length + '），压缩包可能损坏');
  }
  if (e.crc && crc32(data) !== e.crc) {
    throw new Error(e.name + ' CRC 校验失败，压缩包可能损坏');
  }
  return data;
}

// ---------- 路径安全 ----------
// zip slip: 包里塞 ../../.ssh/authorized_keys 这种路径，解压时就能写到目录外面去。
// 绝对路径、盘符、.. 一律拒绝，不做「清洗后放行」—— 清洗容易被绕，直接报错最省心。
function safeRel(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n) return null;
  if (n.charAt(0) === '/' || /^[a-zA-Z]:/.test(n)) {
    throw new Error('压缩包里有绝对路径: ' + name);
  }
  const segs = n.split('/').filter((x) => x && x !== '.');
  if (segs.some((x) => x === '..')) throw new Error('压缩包里有上级目录路径: ' + name);
  if (!segs.length) return null;
  return segs.join('/');
}

function isInside(root, full) {
  const r = path.resolve(root) + path.sep;
  const f = path.resolve(full);
  return f === path.resolve(root) || f.indexOf(r) === 0;
}

// 只列目录，不落盘。安装前先看看包里有什么、声明文件在哪
function list(buf) {
  return readEntries(buf).map((e) => ({ name: e.name, size: e.size, isDir: e.isDir }));
}

// 解压到 destDir，返回写出的相对路径数组
function extract(buf, destDir, opts) {
  const o = opts || {};
  const entries = readEntries(buf);
  fs.mkdirSync(destDir, { recursive: true });

  let total = 0;
  const written = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const rel = safeRel(e.name);
    if (!rel) continue;
    // 有些包会塞 __MACOSX/ 和 ._xxx 这种 macOS 附属文件，装插件时直接跳过
    if (o.skip && o.skip(rel)) continue;

    total += e.size;
    if (total > LIMITS.totalBytes) throw new Error('压缩包解压后总大小超过上限，已中止');

    const full = path.join(destDir, rel);
    if (!isInside(destDir, full)) throw new Error('解压路径越界: ' + e.name);

    const data = readEntry(buf, e);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    written.push(rel);
  }
  return written;
}

module.exports = { list, extract, readEntries, crc32, LIMITS };
