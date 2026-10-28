// SSO 客户端
// 协议说明:
//  - /app/loginV3: body = base64(AES-128-ECB(JSON)); 头 EncryptType=1
//    EncryptKey = base64(RSA/PKCS1(sessionKey, /app/rsakey 公钥))
//    JSON 内 password 为明文; sign = MD5(url + 排序的 "k=v" 用 ## 连接 + 盐).toLowerCase()
//  - 响应可能是同一 sessionKey 的 AES-128-ECB(base64) 密文,也可能直接是 JSON
const https = require('https');
const crypto = require('crypto');
const { ssoSign, aesEcbEncrypt, aesEcbDecrypt, rsaPkcs1Encrypt, derToPem, genAesKey } = require('./crypto');
const site = require('./site');
const log = require('./logger');

const SSO_HOST = site.api.ssoHost;
const APP_ID = site.app.ssoAppId;
const APP_CHECKSUM_PREFIX = site.app.checksum;

// 北京时间 yyyy-MM-dd HH:mm:ss
function bjTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

function appChecksum(tsMs) {
  return crypto.createHash('sha256').update(APP_CHECKSUM_PREFIX + tsMs).digest('hex');
}

function baseHeaders(nDeviceId) {
  const ts = Date.now();
  const h = {
    Charset: 'utf-8',
    'Device-Name': site.app.deviceName,
    'App-Brand': site.app.brand,
    'Accept-Language': 'zh-CN',
    dataCenterCode: 'CN_BJ',
    APPGlobeZoneTime: 'Asia/Shanghai',
    ApkType: site.app.apkType,
    version: site.app.version,
    'App-Checksum': appChecksum(ts),
    timestamp: String(ts),
    'User-Agent': site.app.userAgent,
  };
  if (nDeviceId) h.nDeviceId = nDeviceId;
  return h;
}

function parseResp(body) {
  try {
    return JSON.parse(body);
  } catch (e) {
    const obj = {};
    for (const p of String(body).split(/[&\n]/)) {
      const i = p.indexOf('=');
      if (i > 0) obj[p.substring(0, i)] = decodeURIComponent(p.substring(i + 1));
    }
    return Object.keys(obj).length ? obj : { raw: body };
  }
}

// 明文表单请求(用于 /app/rsakey 等)
function post(urlPath, params, deviceId, nDeviceId) {
  const t0 = Date.now();
  const url = `https://${SSO_HOST}${urlPath}`;
  const all = Object.assign({}, params, { sign: ssoSign(url, params) });
  const body = Object.entries(all)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === null || v === undefined ? '' : v)}`)
    .join('&');
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: Object.assign(baseHeaders(nDeviceId || deviceId), {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }),
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const json = parseResp(text);
        log.api('POST', SSO_HOST, urlPath, json && json.code, Date.now() - t0);
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => {
      log.error('sso', `POST ${urlPath} 网络失败: ${e && e.message ? e.message : e}`);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

// 公共参数(appId=11, mac, timestamp)
function commonParams(mac) {
  return { appId: APP_ID, mac, timestamp: bjTime() };
}

function decryptMaybe(text, sessionKey) {
  const s = String(text).trim().replace(/^"|"$/g, '');
  if (s.startsWith('{')) return s;
  try {
    return aesEcbDecrypt(s, sessionKey);
  } catch (e) {
    return text;
  }
}

// AES/RSA 加密的 JSON 请求(loginV3、changeDeviceLogin 等)
async function encryptedPost(cfg, urlPath, params) {
  const t0 = Date.now();
  const deviceId = cfg.deviceId;
  const nDeviceId = cfg.nDeviceId || cfg.deviceId;

  const rk = await post('/app/rsakey', commonParams(cfg.ssoMac), deviceId, nDeviceId);
  const rsaPub = rk.json && rk.json.data;
  if (!rsaPub) throw new Error('获取 SSO RSA 公钥失败: ' + JSON.stringify(rk.json));

  const url = `https://${SSO_HOST}${urlPath}`;
  const sessionKey = genAesKey();
  const p = Object.assign({}, params);
  p.sign = ssoSign(url, p);
  const body = aesEcbEncrypt(JSON.stringify(p), sessionKey);
  const headers = Object.assign(baseHeaders(nDeviceId), {
    'Content-Type': 'text/plain;charset=UTF-8',
    EncryptType: '1',
    EncryptKey: rsaPkcs1Encrypt(sessionKey, derToPem(rsaPub)),
    'Content-Length': Buffer.byteLength(body),
  });

  // 调试: 加密前的明文参数(密码等由 logger 统一脱敏)
  if (log.isEnabled('debug')) {
    const plain = Object.assign({}, p);
    if (plain.password) plain.password = '***';
    log.debug('sso', `${urlPath} 明文 ${JSON.stringify(plain).slice(0, 300)}`);
  }

  let resp;
  try {
    resp = await new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', headers, timeout: 20000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (e) {
    log.error('sso', `POST ${urlPath} 网络失败: ${e && e.message ? e.message : e}`);
    throw e;
  }

  const text = decryptMaybe(resp.raw, sessionKey);
  const json = parseResp(text);
  log.api('POST', SSO_HOST, urlPath, json && json.code, Date.now() - t0);
  return { status: resp.status, rsaKey: rsaPub, text, json };
}

// 账密登录: 与 APP /app/loginV3 请求完全一致
async function loginByPassword(cfg, userName, password) {
  return encryptedPost(cfg, '/app/loginV3', {
    nDeviceId: cfg.nDeviceId || cfg.deviceId,
    password,
    areaCode: cfg.areaCode || '86',
    appId: APP_ID,
    days: '-1',
    userName,
    deviceId: cfg.deviceId,
    mac: cfg.deviceId,
    timestamp: bjTime(),
  });
}

// 新设备登录 - 密保问题: 获取问题列表
// 返回 data = { endTime, tip, securityQuestions: [{ questionId, question, content, answerFormat, ... }] }
function getSecurityQuestions(cfg, opts) {
  const p = Object.assign(commonParams(cfg.ssoMac), {
    areaCode: opts.areaCode || '86',
    userName: opts.userName,
    checkCode: opts.checkCode,
    changeDeviceType: String(opts.changeDeviceType == null ? 0 : opts.changeDeviceType),
  });
  return post('/app/question/getQuestion', p, cfg.deviceId, cfg.nDeviceId || cfg.deviceId);
}

// 密保问题提示(多块手表时用于选择具体手表)
function getQuestionHint(cfg, opts) {
  const p = Object.assign(commonParams(cfg.ssoMac), {
    areaCode: opts.areaCode || '86',
    userName: opts.userName,
    checkCode: opts.checkCode,
    questionId: opts.questionId,
    changeDeviceType: String(opts.changeDeviceType == null ? 0 : opts.changeDeviceType),
  });
  return post('/app/question/hint', p, cfg.deviceId, cfg.nDeviceId || cfg.deviceId);
}

// 提交密保答案, 成功后继续调用 changeDeviceLogin
function validateSecurityQuestion(cfg, opts) {
  const p = Object.assign(commonParams(cfg.ssoMac), {
    areaCode: opts.areaCode || '86',
    userName: opts.userName,
    checkCode: opts.checkCode,
    questionId: opts.questionId,
    answer: String(opts.answer),
    changeDeviceType: String(opts.changeDeviceType == null ? 0 : opts.changeDeviceType),
  });
  return post('/app/question/validate', p, cfg.deviceId, cfg.nDeviceId || cfg.deviceId);
}

// 新设备登录验证通过后换取登录票据
// mobilePhone 为登录手机号, randCode 在密保问题方式下传空串
//
// 参数对照原版 APP: SSONetServiceImpl.z0() 调的是
//   sdk.Ghana(..., mobilePhone, checkCode, randCode, areaCode, checkType, changeDeviceType,
//             "-1", deviceId, 10000, 10000, 11, nDeviceId)
// 其中 "-1" 是 days(票据有效期), 之前漏了 —— 缺了它服务端会走异常分支回 000002。
// mac 与 loginV3 保持一致用 deviceId, 不要用 ssoMac(那个只用于明文表单的签名公共参数)。
function changeDeviceLogin(cfg, opts) {
  return encryptedPost(cfg, '/app/changeDeviceLogin', {
    appId: APP_ID,
    areaCode: opts.areaCode || '86',
    mobilePhone: opts.mobilePhone,
    randCode: opts.randCode || '',
    checkCode: opts.checkCode,
    checkType: String(opts.checkType),
    changeDeviceType: String(opts.changeDeviceType == null ? 0 : opts.changeDeviceType),
    days: '-1',
    deviceId: cfg.deviceId,
    nDeviceId: cfg.nDeviceId || cfg.deviceId,
    mac: cfg.deviceId,
    timestamp: bjTime(),
  });
}

// 换取票据 + 重试
//
// 为什么需要重试: 密保答案校验通过后, 服务端把「这台设备已通过验证」的状态落库是异步的,
// 立刻换票会拿到 000002(出现未知异常)。原版 APP 的 H5 验证页
// (static.watch.okii.com/watch/account-verify) 里 validate() 就是:
//   "000002" === code ? (isFirst && (isFirst = false, validate())) : router.go(-1)
// 即遇到 000002 自动重试一次。APP 原生侧在 H5 回调后还要弹一次「继续验证」确认框,
// 那一下点击的停顿正好让状态落完, 所以 APP 上几乎看不到这个问题。
// 这里用「间隔递增重试」把那段停顿补上。
async function changeDeviceLoginRetry(cfg, opts, tries) {
  const max = tries || 3;
  let last = null;
  for (let i = 0; i < max; i++) {
    if (i) await new Promise((r) => setTimeout(r, 900 * i));
    last = await changeDeviceLogin(cfg, opts);
    const code = last && last.json && last.json.code;
    if (code === '000001') return last;
    // 只有 000002 值得重试: 其它码(010304 校验码失效 / 010215 答案错 / 010216 次数用完)重试也没用
    if (code !== '000002') return last;
    log.warn('sso', `换取登录票据返回 000002, 第 ${i + 1}/${max} 次重试`);
  }
  return last;
}

module.exports = {
  SSO_HOST,
  APP_ID,
  bjTime,
  appChecksum,
  post,
  parseResp,
  commonParams,
  encryptedPost,
  loginByPassword,
  getSecurityQuestions,
  getQuestionHint,
  validateSecurityQuestion,
  changeDeviceLogin,
  changeDeviceLoginRetry,
};
