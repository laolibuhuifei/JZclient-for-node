// 服务端地址与客户端参数
// 这些值用于构造协议请求头与网关地址，请勿随意修改
module.exports = {
  api: {
    mainHost: 'watch.okii.com',
    contactHost: 'api.watch.okii.com',
    locationHost: 'location.watch.okii.com',
    sportHost: 'sport.watch.okii.com',
    storeHost: 'store.watch.okii.com',
    chatHost: 'chat.watch.okii.com',
    ssoHost: 'account.okii.com',
  },
  app: {
    // 请求头中的完整版本字符串
    version: 'A_9.47.02',
    versionCode: 94702,
    versionName: '9.47.02',
    deviceName: 'google-sdk_gphone64_arm64',
    userAgent: 'Dalvik/2.1.0 (Linux; U; Android 15; sdk_gphone64_arm64 Build/AE3A.240806.043)',
    // 客户端校验值与 SSO 签名盐
    checksum: '5BC0663605A0B96538FC952544BBB7EF',
    ssoSalt: 'LKyF8jThHbZfUeTP',
    ssoAppId: '11',
    // 品牌与包名相关参数
    brand: 'xtc',
    apkType: 'xtc',
    packageName: 'com.xtc.watch',
    brandVersion: 'A',
    // 业务请求的签名头与密钥头名称
    signHeader: 'Eebbk-Sign',
    keyHeader: 'Eebbk-Key',
  },
  im: {
    host: 'im3.okii.com',
    port: 8002,
    appKey: '7be64b5953d6417490f9609154cc22fd',
  },
  assets: {
    // 表情资源 CDN 前缀
    emojiBaseUrl: 'http://smartwatch.qiniucdn.com/emoji%2F',
  },
};
