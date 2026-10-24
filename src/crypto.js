// 加密与签名模块
// 1. SSO 签名: sign = MD5(url + 排序参数串(## 连接) + 盐).toLowerCase()
// 2. 业务 API 签名: MD5(url + BaseRequestParam明文JSON + body + AES_KEY)
//    body = base64(AES-128/ECB/PKCS5(gzip(明文JSON))), 密钥通过 RSA 加密后放入请求头
const crypto = require('crypto');
const site = require('./site');

// SSO 签名盐，从 site.config.js 读取
const SSO_SALT = site.app.ssoSalt;

function md5(data) {
  return crypto.createHash('md5').update(data, 'utf8').digest('hex');
}

// SSO 请求签名
// url: 请求 URL; params: 对象(空值剔除); 返回小写 md5
function ssoSign(url, params) {
  const items = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    items.push(`${k}=${v}`);
  }
  items.sort(); // ASCII 排序(对 "k=v" 整体排序,与 Java Arrays.sort 一致)
  const sb = url + items.join('##') + SSO_SALT;
  return md5(sb).toLowerCase();
}

// AES-128/ECB/PKCS5Padding 加密,输出 base64
// plainText 可为字符串或 Buffer(业务请求体是先 gzip 再加密的二进制)
function aesEcbEncrypt(plainText, keyHex16) {
  const key = Buffer.from(keyHex16, 'utf8'); // 16 字节
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  const input = Buffer.isBuffer(plainText) ? plainText : Buffer.from(plainText, 'utf8');
  return Buffer.concat([cipher.update(input), cipher.final()]).toString('base64');
}

// AES-128/ECB 解密(base64 输入)
function aesEcbDecrypt(b64, keyHex16) {
  const key = Buffer.from(keyHex16, 'utf8');
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]).toString('utf8');
}

// RSA/ECB/PKCS1Padding 公钥加密(PEM 或 base64 DER 公钥),输出 base64
function rsaPkcs1Encrypt(data, publicKeyPem) {
  const enc = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(data, 'utf8')
  );
  return enc.toString('base64');
}

// 业务 API 签名: MD5(url + baseRequestParam明文JSON + body明文 + aesKey)
// 与官方客户端一致，输出大写 hex
function bizSign(url, baseParamJson, body, aesKey) {
  return md5(url + baseParamJson + (body || '') + aesKey).toUpperCase();
}

// 生成 16 字符 AES key(UUID 去横线取前16)
function genAesKey() {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

// 把 base64 DER 公钥包装成 PEM
function derToPem(b64) {
  if (b64.includes('BEGIN')) return b64;
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

module.exports = {
  SSO_SALT,
  md5,
  ssoSign,
  aesEcbEncrypt,
  aesEcbDecrypt,
  rsaPkcs1Encrypt,
  bizSign,
  genAesKey,
  derToPem,
};
