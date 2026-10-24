// 业务 API 客户端
// 协议说明:
//   Base-Request-Param = base64(AES-128-ECB(baseParamJson, key))
//   密钥头            = base64(RSA/PKCS1(key, /rsa 公钥))
//   签名头            = MD5(url(不含 query) + baseParamJson明文 + body明文 + key) 大写
//   请求 body          = base64(AES-128-ECB(gzip(body明文)))
//   响应 encrypted 头存在时: 去掉外层引号 -> base64 -> AES-128-ECB -> 可能再 gzip
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { md5, aesEcbEncrypt, rsaPkcs1Encrypt, derToPem, genAesKey } = require('./crypto');
const site = require('./site');
const log = require('./logger');

const API_HOST = site.api.mainHost;
// 部分业务走独立网关
const CONTACT_HOST = site.api.contactHost;
const LOCATION_HOST = site.api.locationHost;
const SPORT_HOST = site.api.sportHost;
const STORE_HOST = site.api.storeHost;
const APP_VERSION = site.app.version;
const DEVICE_NAME = site.app.deviceName;
const APP_CHECKSUM = site.app.checksum;

// 型号能力模块 ID(官方 ModuleSwitchConstant): display 0=支持 1=不支持 2=可见但不可用
const MODULES = {
  nfc: 2410,
  wifi: 2513,
  wifi5g: 3789,
  videoCall: 73,
  voiceCall: 2499,
  findWatch: 2592,
  dataFlow: 61,
  health: 2642,
  appMall: 72,
  appManager: 3171,
  watchLanguage: 240,
  timeZone: 241,
  timeZoneNew: 2699,
  multiClassMode: 2872,
  classModeCall: 25,
  sleepMode: 2757,
  autoCall: 13,
  aiAssistant: 3886,
};

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
// Flutter 端每个请求都带 ?uuid=<32位hex>
function requestUuid() { return crypto.randomBytes(16).toString('hex'); }
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

class ApiClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.host = cfg.apiHost || API_HOST;
  }

  get authId() {
    if (this.cfg.authId) return String(this.cfg.authId);
    try { return String(JSON.parse(this.cfg.token).accountId); } catch (e) { return ''; }
  }

  buildBaseParam(accountId) {
    return JSON.stringify({
      accountId: accountId || this.cfg.mobileId,
      appId: '0',
      deviceId: this.cfg.bizDeviceId || this.cfg.deviceId,
      imFlag: '1',
      mac: this.cfg.bizMac || this.cfg.deviceId,
      machineId: this.cfg.bizMachineId || this.cfg.machineId,
      nDeviceId: this.cfg.nDeviceId || this.cfg.deviceId,
      program: 'android',
      registId: this.cfg.registId || 0,
      timestamp: timestamp(),
      token: this.cfg.token || '',
    });
  }

  // 拉取业务 RSA 公钥(部分网关没有 /rsa, 回退到主网关)
  async fetchRsaKey() {
    let resp = await this.send('GET', '/rsa', '', null, true);
    let key = resp.json && resp.json.data && resp.json.data.publicKey;
    if (!key && this.host !== API_HOST) {
      resp = await this.send('GET', '/rsa', '', null, true, API_HOST);
      key = resp.json && resp.json.data && resp.json.data.publicKey;
    }
    if (key) this.cfg.bizRsaKey = key;
    return key;
  }

  async ensureRsaKey() {
    if (this.cfg.bizRsaKey) return this.cfg.bizRsaKey;
    const key = await this.fetchRsaKey();
    if (!key) throw new Error('获取业务 RSA 公钥失败');
    return key;
  }

  async request(method, urlPath, bodyObj, opts = {}) {
    const bodyPlain = bodyObj ? JSON.stringify(bodyObj) : '';
    let resp = await this.send(method, urlPath, bodyPlain, opts.accountId, false, opts.host);
    // RSA 公钥轮换时自动刷新并重试一次
    if (resp.json && resp.json.code === '000003' && /rsaKey/i.test(resp.json.desc || '')) {
      this.cfg.bizRsaKey = null;
      await this.ensureRsaKey();
      resp = await this.send(method, urlPath, bodyPlain, opts.accountId, false, opts.host);
    }
    return resp;
  }

  async send(method, urlPath, bodyPlain, accountId, skipCrypto, hostOverride) {
    const t0 = Date.now();
    const host = hostOverride || this.host;
    const pathOnly = String(urlPath).split('?')[0];
    const rsaKey = skipCrypto ? null : await this.ensureRsaKey();
    const aesKey = genAesKey();
    const baseJson = this.buildBaseParam(accountId);
    const url = `https://${host}${urlPath}`;
    // 带 query 的请求, 签名只覆盖不含 query 的 URL
    const sign = md5(url.split('?')[0] + baseJson + bodyPlain + aesKey).toUpperCase();

    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      'Base-Request-Param': skipCrypto ? baseJson : aesEcbEncrypt(baseJson, aesKey),
      [site.app.signHeader]: sign,
      [site.app.keyHeader]: skipCrypto ? aesKey : rsaPkcs1Encrypt(aesKey, derToPem(rsaKey)),
      program: 'android',
      'Device-Name': DEVICE_NAME,
      Version: APP_VERSION,
      'Accept-Language': 'zh-CN',
      'App-Brand': site.app.brand,
      ApkType: site.app.apkType,
      dataCenterCode: 'CN_BJ',
      APPGlobeZoneTime: 'Asia/Shanghai',
      'Content-Encoding': 'gzip',
      'App-Checksum': APP_CHECKSUM,
      authId: this.authId,
      Grey: '0',
    };
    if (!skipCrypto) headers.encrypted = 'encrypted';

    // 实测: 请求体 = base64(AES-128-ECB(gzip(明文JSON)))，直接以 base64 文本发送
    const body = bodyPlain ? aesEcbEncrypt(zlib.gzipSync(Buffer.from(bodyPlain, 'utf8')), aesKey) : '';
    headers['Content-Length'] = Buffer.byteLength(body);

    // 调试: 记录请求明文(截断), 便于核对参数
    if (bodyPlain && log.isEnabled('debug')) {
      log.debug('api', `${method} ${pathOnly} body ${bodyPlain.slice(0, 300)}`);
    }

    let resp;
    try {
      resp = await new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers, timeout: 15000 }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
        });
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    } catch (e) {
      log.error('api', `${method} ${host}${pathOnly} 网络失败: ${e && e.message ? e.message : e}`);
      throw e;
    }

    let text = resp.raw.toString('utf8');
    if (!skipCrypto && !text.trim().startsWith('{')) {
      try {
        let buf = Buffer.from(text.trim().replace(/^"|"$/g, ''), 'base64');
        const d = crypto.createDecipheriv('aes-128-ecb', Buffer.from(aesKey, 'utf8'), null);
        buf = Buffer.concat([d.update(buf), d.final()]);
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
        text = buf.toString('utf8');
      } catch (e) { /* 保留原文 */ }
    }

    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    log.api(method, host, pathOnly, json ? json.code : 'HTTP' + resp.status, Date.now() - t0);
    return { status: resp.status, headers: resp.headers, text, json, raw: resp.raw };
  }

  // ============ 手表管理端点 ============
  // 登录后初始化: 返回 mobileAccount + mobileWatchs
  getMobileInit() {
    return this.request('GET', '/mobileinit/authid', null, { accountId: this.authId });
  }

  getMobileAccount(mobileId) {
    return this.request('GET', `/mobileaccount/id/${mobileId}`);
  }

  getWatchMembers(watchId) {
    return this.request('GET', `/mobilewatch/watch/${watchId}`);
  }

  getWatchAccount(watchId) {
    return this.request('GET', `/watchaccount/id/${watchId}`);
  }

  // 修改宝贝昵称
  updateBabyName(watchId, name) {
    return this.request('POST', '/watchaccount/updateBabyName', { id: watchId, name });
  }

  // 修改真实姓名
  updateBabyRealName(watchId, realName) {
    return this.request('POST', '/smartwatch/watchaccount/updateRealName', { id: watchId, realName });
  }

  // 局部更新宝贝资料(生日/身高/体重/性别/年级/班级等)
  updateWatchAttributes(watchId, attrs) {
    return this.request('PUT', '/watchaccount/update/watchAttribute', Object.assign({ watchId }, attrs));
  }

  // 整对象更新手表资料(脱壳 WatchAccountHttpService: PUT /watchaccount)
  // 喝水提醒/低电量保护/位置上报提醒/互动通话这些开关只能走整对象提交,
  // 用 /watchaccount/update/watchAttribute 单独传会返回 000007
  async updateWatchAccount(watchId, patch) {
    const resp = await this.getWatchAccount(watchId);
    const data = resp.json && resp.json.data;
    if (!data) return { json: { code: '000002', desc: '未获取到手表资料' } };
    return this.request('PUT', '/watchaccount', Object.assign({}, data, { id: data.id || watchId }, patch));
  }

  // 自动接听授权: 传 AutoCallParam 列表, 只需包含被修改的联系人
  updateAutoCallList(watchId, items) {
    const list = (items || []).map((x) => ({
      id: x.id,
      watchId,
      mobileNumber: x.mobileNumber,
      shortNumber: x.shortNumber,
      type: x.type,
      autoCall: Number(x.autoCall) ? 1 : 0,
    }));
    return this.request('PUT', `/contact/up/types?uuid=${requestUuid()}`, list);
  }

  // 同意好友申请: type 见 AgreeParams(remote/recommend/recommendAudit/interphone/classGroup/blueToothAudit/geniusNumber)
  agreeFriendApply(watchId, friendId, type, verification) {
    return this.request('POST', '/watchfriend', { watchId, friendId, type, verification: verification || '' });
  }

  // 手表好友关系列表
  getWatchFriends(watchId) {
    return this.request('GET', `/watchfriend/watchid/${watchId}`);
  }

  // 删除好友(参数为好友关系 id)
  deleteWatchFriend(id) {
    return this.request('DELETE', `/watchfriend/id/${id}`);
  }

  // 获取加好友口令: 必须同时传 watchId + geniusNumber, 走 contact-service 网关
  getGeniusCommand(watchId, geniusNumber) {
    return this.request(
      'POST',
      `/contact-service/watchfriend/command/getCommand?uuid=${requestUuid()}`,
      { watchId, geniusNumber },
      { host: CONTACT_HOST },
    );
  }

  // 口令配置(长度/模板/有效期说明)
  getGeniusConfig() {
    return this.request(
      'GET',
      `/contact-service/watchfriend/command/getConfig?uuid=${requestUuid()}`,
      null,
      { host: CONTACT_HOST },
    );
  }

  // 手表账号信息(geniusNumber 从这里取)
  getGeniusAccount(watchId) {
    return this.request('GET', `/geniusAccount/getGeniusAccount/${watchId}`);
  }

  // ============ 绑定手表 ============
  // 绑定号查询: 返回 WatchAccount; 新手表可能需要手表上显示的验证码(randcode)
  getWatchByBindNumber(bindNumber, randcode) {
    const body = { bindNumber };
    if (randcode) body.randcode = randcode;
    return this.request('POST', '/smartwatch/watchaccount/bindnumber', body);
  }

  // 手表的全部绑定关系(含管理员/成员/申请), 用于判断是否已有管理员
  getWatchRelations(watchId) {
    return this.request('GET', `/mobilewatch/watch/${watchId}`);
  }

  // 申请加入时是否需要校验管理员手机号(contact 网关)
  needMobileCheck(watchId) {
    return this.request(
      'POST',
      '/watchaccount-service/mobilewatch/needMobileCheck',
      { watchId },
      { host: CONTACT_HOST },
    );
  }

  // 校验管理员手机号中间几位 -> { pass, remainingCount }
  verifyAdminMobile(watchId, number) {
    return this.request(
      'POST',
      '/watchaccount-service/mobilewatch/mobileCheck',
      { watchId, number },
      { host: CONTACT_HOST },
    );
  }

  // 建立绑定关系: type 0=管理员(新手表) 3=申请(已有管理员)
  createMobileWatch({ mobileId, watchId, salutation, type, randcode }) {
    const body = { mobileId, watchId, salutation, type };
    if (randcode) body.randcode = randcode;
    return this.request('POST', '/smartwatch/mobilewatch', body);
  }

  // 绑表时可选择的天才号: 当前账号名下的全部天才号详情
  getAllDetailGeniusAccounts(mobileId, bindNumber) {
    return this.request('POST', '/smartwatch/geniusAccount/getAllDetailGeniusAccount', { mobileId, bindNumber });
  }

  // 绑表时可选择的天才号: 还没有绑定手表的天才号
  getNoBindGeniusAccounts(mobileId, bindNumber) {
    return this.request('POST', '/smartwatch/geniusAccount/getNoBindGeniusAccount', { mobileId, bindNumber });
  }

  // 天才号数量上限(绑定新手表前官方用来判断还能不能新建)
  getGeniusAccountNumberInfo(bindNumber) {
    return this.request(
      'POST',
      '/watchaccount-service/geniusAccount/getGeniusAccountNumberInfo',
      { bindNumber },
      { host: CONTACT_HOST },
    );
  }

  // 把旧手表的天才号迁移到新表
  // recovery: 0=保留旧表数据 1=不保留; tipsShow: 是否已展示过迁移提示(0/1)
  migrateGeniusAccount({ destBindNumber, destWatchId, origBindNumber, origGeniusId, origWatchId, recovery, tipsShow, randcode }) {
    const body = {
      destBindNumber, destWatchId, origBindNumber, origGeniusId, origWatchId,
      recovery: Number(recovery || 0),
      tipsShow: Number(tipsShow || 0),
    };
    if (randcode) body.randcode = randcode;
    return this.request('POST', '/datamigration/geniusAccount', body);
  }

  // 非旧表管理员做迁移: 先给旧表管理员发验证码, 返回 randCodeKey
  sendTalentTransferRandcode({ mobileId, watchId, adminMobileId, adminPhoneNumber, noAdminPhoneNumber }) {
    const body = { mobileId, watchId };
    if (adminMobileId) body.adminMobileId = adminMobileId;
    if (adminPhoneNumber) body.adminPhoneNumber = adminPhoneNumber;
    if (noAdminPhoneNumber) body.noAdminPhoneNumber = noAdminPhoneNumber;
    return this.request('POST', '/smartwatch/datamigration/sendRandCodeByNoAdmin', body);
  }

  // 校验旧表管理员收到的验证码 -> true/false
  checkTalentTransferRandcode({ mobileId, destWatchId, orinWatchId, randCode, randCodeKey }) {
    return this.request('POST', '/smartwatch/datamigration/checkRandCodeByNoAdmin', {
      mobileId, destWatchId, orinWatchId, randCode, randCodeKey,
    });
  }

  // ============ 定位 ============
  // 单表最后位置
  getWatchLocation(watchId) {
    return this.request('GET', `/location/${watchId}`, null, { host: LOCATION_HOST });
  }

  // 全部手表最后位置
  getAllWatchLocations() {
    return this.request('GET', '/location/multilocation', null, { host: LOCATION_HOST });
  }

  // 历史轨迹: locationTime 为要查询的那一天(毫秒时间戳)
  getLocationTrack(watchId, locationTime) {
    return this.request('POST', '/contrail/queryData', { watchId, locationTime }, { host: LOCATION_HOST });
  }

  // 安全区域/守护
  getGuardStatus(watchId) {
    return this.request('POST', '/allDayGuard/queryGuardStatus', { watchId }, { host: LOCATION_HOST });
  }

  getCommonAreas(watchId) {
    return this.request('POST', '/allDayGuard/queryCommonArea', { watchId }, { host: LOCATION_HOST });
  }

  getDangerAreas(watchId) {
    return this.request('POST', '/allDayGuard/queryDangerArea', { watchId }, { host: LOCATION_HOST });
  }

  // 添加危险区域(圆形: 一个中心点 + 半径)
  addDangerArea({ watchId, latitude, longitude, radius }) {
    return this.request('POST', '/allDayGuard/addDangerArea', {
      watchId,
      mapType: 0,
      areaPic: '',
      areaDetail: [{ x: latitude, y: longitude, r: radius }],
    }, { host: LOCATION_HOST });
  }

  deleteDangerArea(watchId, areaId) {
    return this.request('POST', '/allDayGuard/delDangerArea', { watchId, areaId }, { host: LOCATION_HOST });
  }

  // ============ 通讯录 ============
  getContacts(watchId) {
    return this.request('GET', `/contact/${watchId}`);
  }

  getContactMaxNum(watchId) {
    return this.request('GET', `/contact/getMaxContactNum/${watchId}`);
  }

  // 新增联系人(普通号码 type=3)
  addContact(body) {
    return this.request('POST', '/contact', body);
  }

  // 修改联系人
  updateContact(body) {
    return this.request('PUT', '/contact/update/info', body);
  }

  deleteContact(id) {
    return this.request('DELETE', `/contact/del/${id}`);
  }

  // ============ 手表设置(watch-func, Flutter 网关, 必须带 ?uuid=) ============
  getVolume(watchId, type = 0) {
    return this.request('POST', `/watch-func/volume/getVolume?uuid=${requestUuid()}`, { watchId, type }, { host: CONTACT_HOST });
  }

  updateVolume(watchId, data) {
    return this.request('POST', `/watch-func/volume/update?uuid=${requestUuid()}`, Object.assign({ watchId }, data), { host: CONTACT_HOST });
  }

  getSmsSync(watchId) {
    return this.request('POST', `/watch-func/watchNotes/getSmsSync?uuid=${requestUuid()}`, { watchId }, { host: CONTACT_HOST });
  }

  getTimeManageList(watchId, type) {
    return this.request('POST', `/watch-func/timeManagement/list?uuid=${requestUuid()}`, { watchId, type }, { host: CONTACT_HOST });
  }

  // 时间管理写接口(脱壳 TimeManageHttpService 实证): type 1=睡眠模式 0=定时开关机
  // startTime/endTime 格式必须是 HH:mm:ss; classWeek 为 7 位星期掩码(31=周一至周五, 127=每天)
  addTimeManage(watchId, data) {
    return this.request('POST', `/watch-func/timeManagement/add?uuid=${requestUuid()}`,
      Object.assign({ watchId, canDelete: 1, switchStatus: 1 }, data), { host: CONTACT_HOST });
  }

  updateTimeManage(data) {
    return this.request('PUT', `/watch-func/timeManagement/update?uuid=${requestUuid()}`, data, { host: CONTACT_HOST });
  }

  deleteTimeManage(watchId, id, type) {
    return this.request('POST', `/watch-func/timeManagement/delete?uuid=${requestUuid()}`,
      { watchId, id, type }, { host: CONTACT_HOST });
  }

  getEndurance(watchId) {
    return this.request('POST', `/watch-func/endurance/getSetting?uuid=${requestUuid()}`, { watchId }, { host: CONTACT_HOST });
  }

  // 续航模式切换(脱壳 LongLifeModeHttpService 实证): enduranceType 由服务端定义
  changeEndurance(watchId, enduranceType) {
    return this.request('POST', `/watch-func/endurance/onOrOff?uuid=${requestUuid()}`,
      { watchId, mobileId: this.cfg.mobileId, enduranceType: Number(enduranceType) }, { host: CONTACT_HOST });
  }

  // 续航自动设置: autoSwitch 1=开, threshold 电量阈值, smartPowerSaveSwitch 1=开
  updateEnduranceSetting(watchId, data) {
    return this.request('POST', `/watch-func/endurance/updateSetting?uuid=${requestUuid()}`,
      Object.assign({ watchId }, data), { host: CONTACT_HOST });
  }

  getWatchCharges(watchId) {
    return this.request('POST', `/watch-func/watchCharges/getWatchCharges?uuid=${requestUuid()}`, { watchId }, { host: CONTACT_HOST });
  }

  // ============ 健康数据(sport 网关, 必须带 ?uuid=) ============
  getHealthHome(watchId, date) {
    return this.request('POST', `/sport-service/health/flutter/home?uuid=${requestUuid()}`, { watchId, date }, { host: SPORT_HOST });
  }

  getSportHome(watchId, date) {
    return this.request('POST', `/sport-service/sport/i32/homeForApp?uuid=${requestUuid()}`, { watchId, date }, { host: SPORT_HOST });
  }

  getSleepDetail(watchId, startTime, endTime) {
    return this.request('POST', `/sport-service/health/nd03/getSleepNightDetailV2?uuid=${requestUuid()}`,
      { watchId, startTime, endTime }, { host: SPORT_HOST });
  }

  getTemperature(watchId, startTime, endTime) {
    return this.request('POST', `/sport-service/temperature/queryTemperatureRecordV4?uuid=${requestUuid()}`,
      { watchId, startTime, endTime }, { host: SPORT_HOST });
  }

  // 心率记录(按天, date 格式 yyyy-MM-dd)
  getHeartRate(watchId, date) {
    return this.request('POST', '/sport-service/heartRate/queryHeartRateRecord',
      { watchId, date }, { host: SPORT_HOST });
  }

  // ============ 免打扰 / 提醒 / 白名单 ============
  // 上课、睡眠、续航模式下是否允许聊天与通话
  getDisableModeSetting(watchId) {
    return this.request('POST', `/watch-func/disableModeSetting/getSetting?uuid=${requestUuid()}`, { watchId }, { host: CONTACT_HOST });
  }

  updateDisableModeSetting(watchId, data) {
    return this.request('POST', `/watch-func/disableModeSetting/update?uuid=${requestUuid()}`,
      Object.assign({ watchId }, data), { host: CONTACT_HOST });
  }

  // 通知栏内容(例如"手表当前未联网")
  getNoticeContent(watchId) {
    return this.request('POST', `/watch-func/notifications/getNoticeContent?uuid=${requestUuid()}`, { watchId }, { host: CONTACT_HOST });
  }

  // 功能白名单
  getFuncWhiteApp(watchId) {
    return this.request('POST', `/watch-func/func/getAllFuncWhiteApp?uuid=${requestUuid()}`, { watchId }, { host: CONTACT_HOST });
  }

  // 上学前提醒
  getBeforeSchool(watchId) {
    return this.request('GET', `/watch-func/beforeSchool/findByWatchId/${watchId}?uuid=${requestUuid()}`, null, { host: CONTACT_HOST });
  }

  // 上学前模式开关: status 1=开 0=关
  updateBeforeSchool(watchId, status) {
    return this.request('POST', `/watch-func/beforeSchool/onOrOff?uuid=${requestUuid()}`,
      { watchId, mobileId: this.cfg.mobileId, status: Number(status) }, { host: CONTACT_HOST });
  }

  // 百度网盘
  getBaiduNetdisk(watchId) {
    return this.request('POST', `/watch-func/baiduNetdisk/getBaiduNetdisk?uuid=${requestUuid()}`, { watchId }, { host: CONTACT_HOST });
  }

  // 自动接听开关(主网关, 必须带 uuid)
  getAutoCallSwitch(watchId) {
    return this.request('POST', `/contact/autocall/getDualSwitch?uuid=${requestUuid()}`, { watchId });
  }

  // 用户协议确认记录: 参数是 mobileId 不是 watchId(实测传 watchId 返回 000007)
  getUserAgreement() {
    return this.request('POST', `/watch-func/userAgreement/getAgreement?uuid=${requestUuid()}`,
      { mobileId: this.cfg.mobileId }, { host: CONTACT_HOST });
  }

  // ============ 系统模式 / 自动接听写 / 短信设置 / NFC 删卡退款 ============
  // (2026-10-23 脱壳 dex 实证, 见 project_memory)
  // 系统模式读取: model 必须传 innerModel(如 I25D), 传 Z7S 这类对外型号也能成功
  async getSystemMode(watchId, model) {
    const m = model || await this.getInnerModel(watchId);
    return this.request('POST', `/watch-func/systemMode/getMode?uuid=${requestUuid()}`,
      { watchId, mobileId: this.cfg.mobileId, model: m }, { host: CONTACT_HOST });
  }

  // 系统模式切换(写): status 0=标准 1=超长待机(实测回写当前值返回 000001)
  async switchSystemMode(watchId, status, model) {
    const m = model || await this.getInnerModel(watchId);
    return this.request('POST', `/watch-func/systemMode/switch?uuid=${requestUuid()}`,
      { watchId, mobileId: this.cfg.mobileId, model: m, status }, { host: CONTACT_HOST });
  }

  async getInnerModel(watchId) {
    const r = await this.getWatchAccount(watchId);
    const d = r.json && r.json.data;
    return (d && (d.innerModel || d.model)) || 'Z7S';
  }

  // 自动接听-手机端开关(写): state 0=关 1=开; accountId 实为 mobileId; 走主网关
  updateAutoCallMobileSwitch(watchId, state) {
    return this.request('POST', `/contact/autocall/updateMobileSwitch?uuid=${requestUuid()}`,
      { accountId: this.cfg.mobileId, watchId, state });
  }

  // 短信接收设置(读): 返回 {receiveType, smsSync, isDisplayAll, ...}
  getReceiveType(watchId) {
    return this.request('POST', `/watch-func/watchNotes/getReceiveType?uuid=${requestUuid()}`,
      { watchId }, { host: CONTACT_HOST });
  }

  // 短信接收设置(写): 注意回写与当前相同的值会返回 000008 illegal operation
  updateReceiveType(watchId, receiveType, isDisplayAll) {
    return this.request('POST', `/watch-func/watchNotes/updateReceiveType?uuid=${requestUuid()}`,
      { watchId, receiveType, isDisplayAll }, { host: CONTACT_HOST });
  }

  // NFC 丢表/换表待处理卡片(删卡退款入口): 返回 {shiftOrDelCardVoList: []}
  getNfcPendingCards(watchId, bindNumber) {
    return this.request('POST', `/nfc-service/userCard/getShiftAndDelCardList?uuid=${requestUuid()}`,
      { watchId, bindNumber, mobileId: this.cfg.mobileId }, { host: CONTACT_HOST });
  }

  // NFC 用户卡片列表
  getNfcCards(watchId, bindNumber) {
    return this.request('POST', `/nfc-service/userCard/getUserCardAndOpening?uuid=${requestUuid()}`,
      { watchId, bindNumber, mobileId: this.cfg.mobileId }, { host: CONTACT_HOST });
  }

  // NFC 通知手表执行动作: actionType = unbindDeal(删卡解绑) | migrationDeal(迁移)
  nfcNotifyWatchAction(watchId, actionType) {
    return this.request('POST', `/nfc-service/notify/notifyWatchAction?uuid=${requestUuid()}`,
      { watchId, mobileId: this.cfg.mobileId, actionType }, { host: CONTACT_HOST });
  }

  // 退款页信息(删卡后查退款进度): 需要 orderId
  getRefundPage(orderId) {
    return this.request('POST', `/pay-service/order/getRefundPage?uuid=${requestUuid()}`,
      { orderId, mobileId: this.cfg.mobileId }, { host: CONTACT_HOST });
  }

  // ============ 应用管理(store 网关) ============
  getStoreSwitch(watchId) {
    return this.request('GET', `/appstore/switch/getStoreSwitch/${watchId}`, null, { host: STORE_HOST });
  }

  // 云文件下载地址(好友头像/图标等), keys 顺序与返回一致
  getFileUrls(keys, fileType) {
    return this.request('POST', '/token/download', {
      fileType: fileType || 1,
      keys: Array.isArray(keys) ? keys : [keys],
      longEdge: 0,
      shortEdge: 0,
    });
  }

  // 应用商店全部应用(含名称/图标/版本)
  getStoreApps(watchId, model, firmware) {
    return this.request(
      'POST',
      `/appstore/app/listAll?uuid=${requestUuid()}`,
      { watchId, model, firmware },
      { host: STORE_HOST }
    );
  }

  getUserApps(watchId) {
    return this.request('POST', `/appstore/userapp/getUserApps?uuid=${requestUuid()}`, { watchId }, { host: STORE_HOST });
  }

  // ============ 手表 WiFi ============
  getWatchWifiList(watchId) {
    return this.request('GET', `/watchWifi/v2/list/${watchId}`);
  }

  getWatchWifiMax() {
    return this.request('GET', '/watchWifi/v2/maxWifiCount');
  }

  // ============ 闹钟/定时提醒 ============
  getAlarms(watchId) {
    return this.request('GET', `/watchalarm/watchid/${watchId}`);
  }

  addAlarm(body) {
    return this.request('POST', '/watchalarm', body);
  }

  updateAlarm(body) {
    return this.request('PUT', '/watchalarm', body);
  }

  deleteAlarm(id) {
    return this.request('DELETE', `/watchalarm/id/${id}`);
  }

  // ============ 隐藏/进阶接口 ============
  // 手表基础状态(在线/关机/欠费/低流量等)
  getBaseState(watchId) {
    return this.request('POST', `/watch-base-state-service/baseState/baseStateGet?uuid=${requestUuid()}`, { watchId }, { host: CONTACT_HOST });
  }

  // 关机定位
  getShutdownStatus(watchId) {
    return this.request('POST', '/watchOffLocation/getCurrentStatus', { watchId }, { host: LOCATION_HOST });
  }

  getShutdownLocations(watchId) {
    return this.request('POST', '/watchOffLocation/getLocations', { watchId }, { host: LOCATION_HOST });
  }

  // 标记地点(家/学校等)
  getMarkAreas(watchId) {
    return this.request('GET', `/markLocation/forApp/area/${watchId}`, null, { host: LOCATION_HOST });
  }

  // 应用权限(需要 watchId + model + firmware)
  getAppAuthorities({ watchId, model, firmware }) {
    return this.request('POST', `/appstore/userAppAuthority/getUserAppAuthorities?uuid=${requestUuid()}`,
      { watchId, model, firmware }, { host: STORE_HOST });
  }

  // ============ 应用商店设置 / 应用管控 ============
  // (2026-10-23 脱壳 AppMallHttpService / AppManagerHttpService 实证)
  // 商店设置写: 传整对象, 未指定字段沿用当前值
  async updateStoreSwitch(watchId, patch = {}) {
    const cur = (await this.getStoreSwitch(watchId)).json;
    const d = (cur && cur.data) || {};
    const num = (k) => {
      if (patch[k] !== undefined && patch[k] !== null && patch[k] !== '') return Number(patch[k]);
      return d[k] != null ? Number(d[k]) : 0;
    };
    return this.request('POST', '/appstore/switch/updateStoreSwitch', {
      watchId,
      accountId: this.cfg.mobileId,
      model: patch.model || d.model || '',
      autoUpdateSwitch: num('autoUpdateSwitch'),
      downChannelSwitch: num('downChannelSwitch'),
      watchAllowSwitch: num('watchAllowSwitch'),
      allowDownloadSwitch: num('allowDownloadSwitch'),
      watchAuthoriseSwitch: num('watchAuthoriseSwitch'),
      userAppLevel: num('userAppLevel'),
      personalRecommend: num('personalRecommend'),
    }, { host: STORE_HOST });
  }

  // 应用等级候选
  getAllAppLevels() {
    return this.request('GET', '/appstore/switch/getAllAppLevels', null, { host: STORE_HOST });
  }

  // 使用时长管控: isOpen/totalDuration/remindSwitch/remindDuration/watchVersionType(秒)
  getDurationSetting(watchId, model) {
    return this.request('POST', `/appstore/durationSwitch/getDurationDetailAndSetting?uuid=${requestUuid()}`,
      { watchId, model: model || '', notifyWatchType: 0 }, { host: STORE_HOST });
  }

  updateDurationSetting(watchId, data) {
    return this.request('POST', `/appstore/durationSwitch/updateDurationSwitch?uuid=${requestUuid()}`,
      Object.assign({ watchId }, data), { host: STORE_HOST });
  }

  // 今日已用时长(returnType 固定 2, 不传日期)
  getTodayUse(watchId, model) {
    return this.request('POST', `/appstore/appDuration/getDurationAlready?uuid=${requestUuid()}`,
      { watchId, model: model || '', returnType: 2 }, { host: STORE_HOST });
  }

  // 单应用时长设置(未验证, 暂未接入 UI)
  // 应用白名单 / 聊天图片审核 / 设置项写入 三个接口线上均返回 000007, 暂不实现

  // ============ 聊天管控 ============
  // 加好友家长审核(陌生人加好友需家长确认): 已实测读写通过
  getParentAuditSwitch(watchId) {
    return this.request('GET', `/watchfriend/getSwitchLocalFriendAudit/${watchId}`);
  }

  setParentAuditSwitch(watchId, v) {
    return this.request('POST', '/watchfriend/doSwitchLocalFriendAudit', { watchId, v: Number(v) ? 1 : 0 });
  }

  // 使用报告(周报)开关
  getReportSwitch(watchId) {
    return this.request('POST', `/appstore/reportSwitch/getReportSwitch?uuid=${requestUuid()}`,
      { watchId }, { host: STORE_HOST });
  }

  updateReportSwitch(watchId, reportSwitch, nickname) {
    return this.request('POST', `/appstore/reportSwitch/updateReportSwitch?uuid=${requestUuid()}`,
      { watchId, reportSwitch: Number(reportSwitch) ? 1 : 0, nickname: nickname || '' }, { host: STORE_HOST });
  }

  // 手表功能开关(子开关列表): 返回 switchName/switchStatus/subSwitch 等
  getSubSwitches(watchId) {
    return this.request('POST', `/watchswitch/getSubSwitch?uuid=${requestUuid()}`, { watchId });
  }

  // 手表设置项读取: 服务端返回每项的 name/description, 可直接用于展示
  // 写入接口(/settingSwitch/update) 线上返回 000007, 暂只读
  getPrivacyItems(watchId, switchIds) {
    return this.request('POST', `/watchswitch-service/settingSwitch/appGetSetting?uuid=${requestUuid()}`,
      { watchId, switchIdList: switchIds || [] }, { host: CONTACT_HOST });
  }

  // ============ 手表设置补全: 流量/语言/时区/话费提醒 ============
  // (脱壳 watchsetting 包 DataFlowLimitHttpService / CommonSettingHttpService)
  getDataFlowLimit(watchId) {
    return this.request('GET', `/watch/stream/${watchId}`);
  }

  setDataFlowLimit(watchId, stream) {
    return this.request('POST', '/watch/stream', { watchId, stream: Number(stream) });
  }

  // 手表可选语言: 参数是型号与固件版本
  getWatchLanguages(model, watchVersion) {
    return this.request('POST', `/base-service/watchLanguage/getConfig?uuid=${requestUuid()}`,
      { model: model || '', watchVersion: watchVersion || '' }, { host: CONTACT_HOST });
  }

  // 设置手表语言
  setWatchLanguage(watchId, language) {
    return this.request('POST', '/watchaccount/update/watchLanguage', { watchId, language });
  }

  // 时区总表(406 个时区, 含中英文名与支持机型)
  getGlobalTimeZones() {
    return this.request('GET', '/smartwatch/globalTimeZone/getAll');
  }

  // 设置手表时区(读取走 getWatchAccount 的 globalTimeZone / globalTimeZoneV2 字段)
  setWatchTimeZone(watchId, globalTimeZone, globalTimeZoneV2) {
    return this.request('PUT', '/watchaccount/update/watchAttribute',
      { watchId, globalTimeZone, globalTimeZoneV2 });
  }

  // 话费提醒开关(参数是 mobileId, 不是 watchId)
  getChargeAlertSwitch() {
    return this.request('GET', `/watch-func/chargeAlertSwitch/get/${this.cfg.mobileId}?uuid=${requestUuid()}`,
      null, { host: CONTACT_HOST });
  }

  updateChargeAlertSwitch(chargeSwitch) {
    return this.request('POST', `/watch-func/chargeAlertSwitch/update?uuid=${requestUuid()}`,
      { mobileId: this.cfg.mobileId, chargeSwitch: Number(chargeSwitch) ? 1 : 0 }, { host: CONTACT_HOST });
  }

  // ============ 型号能力(模块开关) ============
  // 官方 ModuleSwitchHttpService: POST /server/moduleswitch/getForAppByParam(主网关)
  // 返回 [{ watchId, moduleSwitchs: [{ module, display, tips, watchModel, watchVersion, ... }] }]
  // display: 0=支持, 1=不支持, 2=可见但不可用; 没有记录时按官方型号默认策略处理
  getModuleSwitches(watchId, modules) {
    const body = {
      mobileId: this.cfg.mobileId,
      appVersion: site.app.versionName || APP_VERSION.replace(/^A_/, ''),
      program: site.app.brandVersion || 'A',
      watchIds: [watchId],
    };
    if (Array.isArray(modules) && modules.length) body.modules = modules;
    return this.request('POST', '/server/moduleswitch/getForAppByParam', body);
  }

  // 未读通知
  getNoticeNew() {
    return this.request('GET', '/smartwatch/notice/hasnew');
  }

  // 无障碍设置
  getAccessibility(watchId) {
    return this.request('POST', `/watch-func/accessibility/info?uuid=${requestUuid()}`, { watchId }, { host: CONTACT_HOST });
  }

  // 成员权限(1-10 类)
  getAuthorizes(watchId) {
    return this.request('POST', '/smartwatch/authorize/getAuthorizesByWatchId', {
      watchId,
      authorizeTypes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
  }

  // 会话列表: 返回每个会话的 imDialogId / imAccountId 等
  getDialogAccounts() {
    return this.request('GET', '/dialogaccount/merge/accounts');
  }

  getClassModes(watchId) {
    return this.request('GET', `/smartwatch/classmode/v2/${watchId}`);
  }

  // App: ClassModeNewPresenter.o(mode, classSwitch, tempSwitch) -> PUT /smartwatch/classmode/v2/update
  async setClassDisabled(watchId, disabled) {
    const listResp = await this.getClassModes(watchId);
    const json = listResp.json || {};
    if (json.code !== '000001') return listResp;
    const list = Array.isArray(json.data) ? json.data : [];
    if (!list.length) return { json: { code: '000002', desc: '该手表没有上课禁用配置' } };
    const src = list[0];
    // 只回传 NewClassMode 声明的字段，避免服务端拒绝多余字段
    const mode = {};
    ['classId', 'classWeek', 'createTime', 'holidaySwitch', 'id', 'timePeriod', 'title', 'type', 'watchId']
      .forEach((k) => { if (src[k] !== undefined && src[k] !== null) mode[k] = src[k]; });
    mode.classSwitch = disabled ? 1 : 0;
    mode.tempSwitch = 0;
    return this.request('PUT', '/smartwatch/classmode/v2/update', mode);
  }

  // 上课禁用时段(脱壳 NewClassModeHttpService 实证)
  // timePeriod 是 JSON 字符串: [{"startTime":"08:00:00","endTime":"11:30:00"}]
  // type 固定 1, classWeek 31=周一至周五, holidaySwitch 1=法定节假日不生效
  addClassMode(watchId, { title, classWeek, periods, holidaySwitch }) {
    return this.request('POST', '/smartwatch/classmode/v2/add', {
      watchId,
      title: title || '上课禁用',
      classWeek: classWeek == null ? 31 : Number(classWeek),
      timePeriod: JSON.stringify(periods || []),
      classSwitch: 1,
      holidaySwitch: holidaySwitch ? 1 : 0,
      type: 1,
    });
  }

  // 编辑时段: 传完整 NewClassMode 对象(先 getClassModes 取原值再合并)
  updateClassMode(mode) {
    return this.request('PUT', '/smartwatch/classmode/v2/update', mode);
  }

  deleteClassMode(classId) {
    return this.request('DELETE', `/classmode/${classId}`);
  }

  // 丢表模式: 这组接口在定位网关, 用主网关会返回 000007
  // 响铃只能在开启丢表模式后调用, 不提供独立的找手表响铃入口
  setLossSwitch(watchId, on) {
    return this.updateWatchAttributes(watchId, { lossSwitch: on ? 1 : 0 });
  }

  // 丢表模式: 周围照片 / 附近 WiFi / 给拾到者留言 / 响铃
  getLostPhotos(watchId) {
    return this.request('POST', '/findWatch/getPhotos', { watchId }, { host: LOCATION_HOST });
  }

  // 实测(2026-10-23): 必须同时传手表绑定号 bindNumber, 只传 watchId 返回 000007
  async getLostWifi(watchId) {
    const acc = await this.getWatchAccount(watchId);
    const bindNumber = acc.json && acc.json.data && acc.json.data.bindNumber;
    if (!bindNumber) return { json: { code: '000002', desc: '未获取到手表绑定号' } };
    return this.request('POST', '/findWatch/getWifiList', { watchId, bindNumber }, { host: LOCATION_HOST });
  }

  getLostMessage(watchId) {
    return this.request('POST', '/findWatch/getLeaveMessage', { watchId }, { host: LOCATION_HOST });
  }

  setLostMessage(watchId, message) {
    return this.request('POST', '/findWatch/setLeaveMessage', { watchId, message }, { host: LOCATION_HOST });
  }

  // 真实参数是 command(脱壳 dex_08 NetLostVoiceParam 实证): 1=开始响铃 0=停止
  // 传 voiceType 会被服务端忽略, 但仍返回 000001, 表现为"发送成功但手表不响"
  playLostSound(watchId, stop) {
    return this.request('POST', '/findWatch/playSound', { watchId, command: stop ? 0 : 1 }, { host: LOCATION_HOST });
  }

  unbind(relationId) {
    return this.request('DELETE', `/mobilewatch/${relationId}`);
  }
}

module.exports = { ApiClient, API_HOST, MODULES };
