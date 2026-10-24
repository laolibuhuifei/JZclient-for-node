// 聊天消息编解码
// 协议要点:
//  - IM 层 msgType(tag13) 对 App 发送端恒为 1; 真正类型在消息 JSON 信封里
//  - 信封为 TextMessage, 非文本类型通过 msgNewType + msgNewContent 承载
//    (表情特殊: textMsgType=1, content 直接是 EmojiMessage JSON)
//  - 语音(2)/撤回(31)/红包(43)/视频通话(45) 等直接发送各自的 JSON
const EMOJI_PRESET = require('./emoji_preset.json');
const site = require('./site');

const TYPE_NAME = {
  1: '文本', 2: '语音', 3: '表情', 4: '提示', 5: '视频', 6: '图片', 7: '位置',
  20: '转发文本', 21: '视频通话图片', 26: '转发链接', 27: '转发视频',
  31: '撤回', 33: '转发实况照片', 34: '文字提示', 37: '实况照片', 38: '视频分享',
  40: '颜文字', 41: '位置共享', 43: '红包', 44: '申请', 45: '视频通话',
  48: '语音文件', 49: '云端内容', [-51]: '删除',
};

function tryJson(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function num(v) { return v === null || v === undefined ? '' : v; }

// 解析收到的消息 -> { kind, type, text, url, body, inner, raw }
function parseMessage(msgType, raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
  const text = buf.toString('utf8');
  const body = tryJson(text);
  if (!body || typeof body !== 'object') {
    return { kind: 'raw', type: msgType, text: text.slice(0, 300), body: null, inner: null, raw: buf };
  }

  // 0) 回执/状态推送: {type:1000/1001, content:"...", timestamp:...}
  if (typeof body.type === 'number' && body.type >= 1000 && typeof body.content === 'string' && !body.msgNewType) {
    return { kind: 'status', type: body.type, text: body.content, body, inner: body, raw: buf };
  }

  // 1) 新式信封: msgNewType>=5 且 msgNewContent 为子消息 JSON
  const nt = Number(body.msgNewType);
  if (nt >= 5 && body.msgNewContent) {
    const inner = tryJson(body.msgNewContent) || {};
    return { kind: kindOf(nt), type: nt, text: body.text || body.content || '', body, inner, raw: buf };
  }

  // 2) 表情信封: textMsgType=1, content 是 EmojiMessage JSON
  if (Number(body.textMsgType) === 1) {
    const inner = tryJson(body.content);
    if (inner) return { kind: 'emoji', type: 3, text: body.text || body.content || '', body, inner, raw: buf };
  }

  // 3) 直发类型(语音/撤回/红包/视频通话等)
  if (msgType && msgType !== 1) {
    return { kind: kindOf(msgType), type: msgType, text: body.text || body.content || '', body, inner: body, raw: buf };
  }
  // 3.5) 无信封时的字段特征兜底识别
  if (body.time !== undefined && (body.key !== undefined || body.remoteUrl !== undefined)) {
    return { kind: 'voice', type: 2, text: '', body, inner: body, raw: buf };
  }
  if (body.goalLatitude !== undefined && body.goalLongitude !== undefined) {
    return { kind: 'location', type: 7, text: '', body, inner: body, raw: buf };
  }
  if (body.redPacketId !== undefined) {
    return { kind: 'red_packet', type: 43, text: '', body, inner: body, raw: buf };
  }
  if (body.action !== undefined && body.withdrawTimestamp !== undefined) {
    return { kind: 'withdraw', type: 31, text: '', body, inner: body, raw: buf };
  }

  // 4) 文本
  return { kind: 'text', type: 1, text: body.text || body.content || '', body, inner: body, raw: buf };
}

function kindOf(t) {
  switch (Number(t)) {
    case 1: return 'text';
    case 2: return 'voice';
    case 3: return 'emoji';
    case 4: return 'hint';
    case 5: return 'video';
    case 6: return 'photo';
    case 7: return 'location';
    case 20: return 'relay_text';
    case 21: return 'video_call_photo';
    case 26: return 'relay_h5';
    case 27: return 'relay_video';
    case 31: return 'withdraw';
    case 33: return 'relay_live_photo';
    case 34: return 'text_hint';
    case 37: return 'live_photo';
    case 38: return 'video_share';
    case 40: return 'kaomoji';
    case 41: return 'sharing_location';
    case 43: return 'red_packet';
    case 44: return 'apply';
    case 45: return 'video_call';
    case 48: return 'voice_file';
    case 49: return 'talent_cloud';
    case -51: return 'delete';
    default: return 'unknown';
  }
}

function mapLink(lng, lat, poi) {
  if (lng === undefined || lat === undefined) return '';
  const q = encodeURIComponent(poi || (lat + ',' + lng));
  return `https://uri.amap.com/marker?position=${lng},${lat}&name=${q}`;
}

// 生成单行展示文本
function describe(m) {
  const i = m.inner || {};
  switch (m.kind) {
    case 'text':
      return m.text || '';
    case 'voice': {
      const sec = i.vocTime || i.time || i.shareVoiceWholeDuration || 0;
      const url = i.storeAddr || i.remoteUrl || i.downloadUrl || '';
      return `[语音 ${num(sec)}秒]${url ? ' ' + url : ''}`;
    }
    case 'emoji': {
      // 表情: 仅显示描述文字, 图片地址通过 mediaUrl 传给前端渲染 <img>
      const d = i.desc || i.name || i.code || '';
      return d ? '[表情] ' + d : '[表情]';
    }
    case 'hint':
    case 'text_hint':
      return `[提示] ${i.content || m.text || ''}`;
    case 'photo': {
      const src = i.source || {};
      const size = src.width && src.height ? ` ${src.width}x${src.height}` : '';
      const url = src.downloadUrl || (i.smallPic && i.smallPic.downloadUrl) || i.downloadUrl || '';
      return `[图片${size}]${url ? ' ' + url : ''}`;
    }
    case 'video': {
      const src = i.source || {};
      const sec = i.videoLength || i.videoTime || 0;
      const url = src.downloadUrl || (i.transfer && i.transfer.downloadUrl) || i.wangSuUrl || i.downloadUrl || '';
      return `[视频${sec ? ' ' + sec + '秒' : ''}]${url ? ' ' + url : ''}`;
    }
    case 'location': {
      const url = mapLink(i.goalLongitude, i.goalLatitude, i.goalPoi);
      return `[位置] ${i.goalPoi || ''} (${num(i.goalLatitude)},${num(i.goalLongitude)})${url ? ' ' + url : ''}`;
    }
    case 'sharing_location':
      return `[位置共享] ${i.isSharing ? '进行中' : '已结束'}`;
    case 'red_packet':
      return `[红包] ${i.desc || ''}`;
    case 'withdraw':
      return '[撤回了一条消息]';
    case 'video_call':
      return `[视频通话] ${i.content || i.tips || ''}`;
    case 'video_call_photo':
      return `[视频通话照片]${i.source && i.source.downloadUrl ? ' ' + i.source.downloadUrl : ''}`;
    case 'relay_text':
      return `[转发] ${i.content || m.text || ''}`;
    case 'relay_h5':
      return `[链接] ${i.desc || i.title || ''}${i.url ? ' ' + i.url : ''}`;
    case 'relay_video':
      return '[转发视频]';
    case 'relay_live_photo':
      return '[转发实况照片]';
    case 'live_photo':
      return '[实况照片]';
    case 'video_share':
      return '[视频分享]';
    case 'kaomoji':
      return `[颜文字] ${i.content || ''}`;
    case 'apply':
      return `[申请] ${i.title || i.desc || ''}`;
    case 'voice_file':
      return `[语音文件] ${i.fileName || ''}`;
    case 'delete':
      return '[消息已删除]';
    case 'status':
      return '';
    case 'raw':
      return `[原始消息] ${m.text || ''}`;
    default:
      return `[${TYPE_NAME[m.type] || '消息 ' + m.type}] ${m.text || ''}`.trim();
  }
}

// 提取消息里的媒体地址(语音/图片/视频)
function mediaUrl(m) {
  const i = m.inner || m.body || {};
  const src = i.source || {};
  switch (m.kind) {
    case 'voice':
      return i.storeAddr || i.remoteUrl || i.downloadUrl || i.url || '';
    case 'voice_file':
      return i.remoteUrl || i.storeAddr || i.downloadUrl || i.url || '';
    case 'photo':
    case 'live_photo':
    case 'video_call_photo':
    case 'relay_live_photo':
      return src.downloadUrl || (i.smallPic && i.smallPic.downloadUrl) || i.downloadUrl || '';
    case 'video':
    case 'relay_video':
    case 'video_share':
      return src.downloadUrl || (i.transfer && i.transfer.downloadUrl) || i.wangSuUrl || i.downloadUrl || '';
    case 'relay_h5':
      return i.url || '';
    case 'emoji': {
      // 表情图片地址, 优先 wholeUrl(大图), 回退 url(预览)
      const u = i.wholeUrl || i.url || i.downloadUrl || '';
      return typeof u === 'string' ? u : '';
    }
    case 'kaomoji':
      return i.wholeUrl || i.url || '';
    default:
      return '';
  }
}

// ============ 发送构造 ============

function envelope(fields) {
  return Object.assign({
    content: '',
    hintType: -1,
    isSensitive: false,
    msgNewContent: '',
    msgNewType: 0,
    showType: 0,
    text: '',
    textMsgType: 0,
  }, fields);
}

function buildText(text) {
  return envelope({ content: text, text });
}

function buildEmoji(preset) {
  const emoji = {
    code: preset.code,
    url: EMOJI_PRESET.url || (site.assets && site.assets.emojiBaseUrl) || '',
    desc: preset.desc || '',
    packageName: EMOJI_PRESET.name,
    deviceFormat: EMOJI_PRESET.deviceFormat,
    watchFormat: EMOJI_PRESET.watchFormat,
    extendType: 0,
    emojiType: 0,
    wholeUrl: '',
    emojiSource: '',
    expressionType: 1,
    watchPath: '',
  };
  return envelope({
    content: JSON.stringify(emoji),
    text: '[表情]',
    textMsgType: 1,
  });
}

function buildLocation(lat, lng, poi) {
  const loc = {
    goalLatitude: lat,
    goalLongitude: lng,
    goalPoi: poi || '',
    locationPicUrl: '',
  };
  return envelope({
    content: '[位置]',
    text: '[位置]',
    msgNewType: 7,
    msgNewContent: JSON.stringify(loc),
    textMsgType: 2,
  });
}

// 图片消息(msgType 6)
function buildPhoto(img) {
  const photo = {
    type: img.type || '1',
    source: img.source,
    smallPic: img.smallPic || img.source,
    sourceType: 6,
  };
  return envelope({
    content: '[图片]',
    text: '[图片]',
    msgNewType: 6,
    msgNewContent: JSON.stringify(photo),
    textMsgType: 2,
  });
}

// 语音消息(msgType 2, 直发 VoiceDescEntity JSON, 不是 TextMessage 信封)
// opts: { key, downloadUrl, duration, audioType(0=AMR 1=Opus), groupId, deadline }
function buildVoice(opts) {
  const voice = {
    vocTime: Math.max(1, Math.round(Number(opts.duration) || 1)),
    storeAddr: opts.downloadUrl || '',
    resoureKey: opts.key || '',
    groupId: opts.groupId || '',
    lastIndex: 0,
    deadline: Number(opts.deadline) || 0,
    extra: JSON.stringify({
      VoiceExtraEntity: {
        voiceType: 0,
        audioType: Number(opts.audioType) || 0,
        shareType: 0,
      },
    }),
  };
  return voice;
}

// 视频消息(msgNewType 5)
// opts: { type, wangSuUrl, zone, source, icon, transfer, customParamMap, videoLength, videoType }
function buildVideo(opts) {
  const video = {
    type: opts.type || '1',
    wangSuUrl: opts.wangSuUrl || '',
    zone: opts.zone || '',
    source: opts.source || null,
    icon: opts.icon || null,
    transfer: opts.transfer || null,
    customParamMap: opts.customParamMap || {},
    videoLength: Math.max(0, Math.round(Number(opts.videoLength) || 0)),
    videoType: Number(opts.videoType) || 0,
  };
  return envelope({
    content: '[视频]',
    text: '[视频]',
    msgNewType: 5,
    msgNewContent: JSON.stringify(video),
    textMsgType: 2,
  });
}

// 颜文字(msgType 40)
function buildKaomoji(content, description) {
  const kao = { code: 0, content, description: description || '颜文字' };
  return envelope({
    content,
    text: content,
    msgNewType: 40,
    msgNewContent: JSON.stringify(kao),
    textMsgType: 2,
  });
}

// 链接卡片(H5 转发, msgType 26)
// opts: { url, desc, appName, businessType }
// 业务链接只传 businessType, 不传 extInfo/args/封面
function buildLink(opts) {
  const url = opts.url || '';
  const title = opts.desc || url;
  const h5 = {
    url,
    desc: title,
    appName: opts.appName || '家长客户端',
    type: '1',
    sourceType: 6,
  };
  if (opts.businessType) h5.businessType = opts.businessType;
  return envelope({
    content: title,
    text: title,
    msgNewType: 26,
    msgNewContent: JSON.stringify(h5),
    textMsgType: 0,
  });
}

module.exports = {
  EMOJI_PRESET,
  TYPE_NAME,
  parseMessage,
  describe,
  mediaUrl,
  buildText,
  buildEmoji,
  buildLocation,
  buildLink,
  buildPhoto,
  buildVideo,
  buildVoice,
  buildKaomoji,
};
