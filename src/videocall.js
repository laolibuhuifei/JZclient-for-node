// 视频/语音通话 —— 信令层
//
// 逆向依据（2026-11-17，原版 com.xtc.watch 9.47.02 脱壳 + 真机抓包）：
//   · 来电是账号级推送，类型 470（视频）/ 12470（语音），body.content 是 JSON
//   · 挂断：473（主叫未接通就取消）/ 474（通话中挂断）；语音 12473 / 12474
//   · 应答/拒接：POST /videocall/callresponse  { responseType: 1=接听 2=拒接 }
//     语音走 /videocall-service/voicecall/callresponse
//   · 通话中挂断：POST /videocall/finish（带 hangupId），和上面那个 /hangup 不是一个东西
//   · RTC 凭证（appId / token / uid / channelName / providers）**在推送里**，
//     不在应答响应里（应答只回 callerClosed）
//
// 本模块只做"信令"：识别来电、上报接听/拒接、挂断。真正的音视频要另外接
// Agora Web SDK（providers=2），那是下一步。
const log = require('./logger');
const site = require('./site.config');

// 字幕（rtestt）这组接口**不在主网关**上。
// 打到 watch.okii.com 会一直回 000007 "request parameter is invalid."，
// 而这套网关里 000007 的真实含义是「路径/网关不对」（见 api.js 里设置项那段的结论）。
// 实测 api.watch.okii.com 回 000001：
//   {"data":{"taskId":"A42AT…","subScribeIdSupportFlag":true,"pubBotUid":"121725938"}}
// 通话信令（callresponse / finish / hangup）在主网关是好的，别一起改。
const RTE_HOST = site.api.contactHost;

// 类型 → 语义。数字来自手表端 VideoChatImReceiver 的十六进制常量
// （0x1d6=470、0x1d7=471、0x1d9=473、0x1da=474、0x30b6~0x30ba=12470~12474）
const TYPES = {
  470: 'in',           // 视频来电
  471: 'response',     // 对方应答/拒接（我们是主叫时才需要）
  473: 'cancel',       // 主叫未接通就取消
  474: 'hangup',       // 通话中挂断
  12470: 'in',         // 语音来电
  12471: 'response',
  12473: 'cancel',
  12474: 'hangup',
};

const VOICE = new Set([12470, 12471, 12473, 12474]);

// providers：1=网易云信 2=Agora 3=腾讯 TRTC（家长端实际用 2）
const PROVIDER_NAME = { 1: '网易云信', 2: 'Agora', 3: '腾讯 TRTC' };

let api = null;
let cfg = null;

// 字幕（ASR）任务：startRteTask 成功后拿到，作用有二：
//   1) pubBotUid —— 只处理这个 uid 发来的数据流（其它是别人的）
//   2) taskId —— 挂断时 stopRteTask 要带上
let caption = null;   // { taskId, pubBotUid, at }

const st = {
  phase: 'idle',   // idle | ringing | talking
  call: null,      // 当前通话的全部参数
  events: [],      // 最近事件（给界面显示"为什么结束了"）
  lastError: '',
  startedAt: 0,    // 接通时间
};

// 最近一次"前端在轮询状态"的时间。
// 自动接听只在前端活着的时候做 —— 媒体面（Agora 入房、B站推流、字幕）全在浏览器里，
// 页面没开就接听，手表那头是接通了但一片黑，比不接还糟。
let viewerAt = 0;

function note(text, level) {
  const item = { at: Date.now(), text: String(text) };
  st.events.push(item);
  if (st.events.length > 20) st.events.shift();
  if (level === 'error') st.lastError = item.text;
  return item;
}

// token 只在内存里存，日志一律打码：前 6 位 + 长度
function maskToken(t) {
  const s = String(t || '');
  if (!s) return '';
  return s.slice(0, 6) + '…(' + s.length + ')';
}

// 这块表有没有开「视频通话 B站 bot」（配置挂在 biliBots 下面，和点播共用一套）
function botEnabled(watchId) {
  const id = String(watchId || '');
  if (!id || !cfg || !cfg.biliBots) return false;
  const w = cfg.biliBots[id];
  return !!(w && w.callBot);
}

// 前端 20 秒内来问过状态 → 认为页面还活着（轮询是 1.5 秒一次，留足余量）
function viewerAlive() {
  return viewerAt > 0 && (Date.now() - viewerAt) < 20000;
}

// 外部挂钩：webui 用它把"起/停无头页面"接进来（videocall 不该知道端口和 token）
let hooks = { onAutoAnswer: null, onCallEnd: null };

function configure(opts) {
  api = (opts && opts.api) || null;
  cfg = (opts && opts.cfg) || null;
  if (opts && opts.hooks) hooks = Object.assign({}, hooks, opts.hooks);
}

// 从一帧里取出通话类型号。三个位置都看：body.type / contentType / msgNewType
function typeOf(m, b) {
  const cands = [b.type, m.contentType, b.msgNewType];
  for (let i = 0; i < cands.length; i++) {
    const n = Number(cands[i]);
    if (n && TYPES[n]) return n;
  }
  return 0;
}

// 取 payload。原版是"透传"消息，可能出现两层：
//   { content: "{\"channelName\":…}" }  ← 外层 VideoChatPassThroughBean
// 所以解析失败时再往里剥一层。
function payloadOf(b) {
  let c = b.content;
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch (e) { return null; }
  }
  if (c && typeof c === 'object' && typeof c.content === 'string') {
    try {
      const inner = JSON.parse(c.content);
      if (inner && typeof inner === 'object') c = inner;
    } catch (e) { /* 保持原样 */ }
  }
  return (c && typeof c === 'object') ? c : null;
}

function buildCall(type, p) {
  const voice = VOICE.has(type);
  return {
    type,
    // callType: 1=视频 2=语音。推送里一般有，没有就按类型推断
    callType: Number(p.callType) || (voice ? 2 : 1),
    channelName: String(p.channelName || ''),
    token: String(p.token || ''),
    uid: Number(p.uid) || 0,
    appId: String(p.appId || ''),
    providers: Number(p.providers) || 0,
    callerId: String(p.callerId || ''),
    otherId: String(p.otherId || ''),
    callTime: Number(p.callTime) || 0,
    resolution: p.resolution || null,
    receivedAt: Date.now(),
  };
}

// 处理一帧。返回 true 表示"这帧是通话信令，已消费"，调用方不要再当聊天消息处理
function handleFrame(m) {
  if (!m || !m.body || typeof m.body !== 'object') return false;
  const b = m.body;
  let type = typeOf(m, b);

  // 兜底：类型号没命中，但内容一看就是来电（channelName + token/uid）。
  // 类型号是从原版常量表抄的，万一服务端换了编号，靠内容也能识别，
  // 不至于"来电静默丢失"这种最难查的现象。
  if (!type) {
    const probe = payloadOf(b);
    if (probe && probe.channelName && (probe.token || probe.uid)) {
      type = Number(probe.callType) === 2 ? 12470 : 470;
      log.warn('call', `未识别的帧但内容像来电（body.type=${b.type}`
        + ` contentType=${m.contentType}），按 ${type} 处理`);
    } else {
      return false;
    }
  }

  const kind = TYPES[type];

  if (kind === 'in') {
    const p = payloadOf(b);
    if (!p || !p.channelName) {
      // 类型对但内容解不出来：记一笔，仍然吞掉，避免被当成聊天消息入库
      note(`收到通话来电帧（${type}）但内容无法解析`, 'error');
      log.warn('call', `来电帧 ${type} 缺少 channelName，已忽略`);
      return true;
    }
    const call = buildCall(type, p);
    if (st.phase === 'ringing' && st.call && st.call.channelName === call.channelName) {
      return true;  // 同一通重复推送
    }
    // 上一通还没收尾就来了新的一通（用户连着打）：先把旧的字幕任务停掉，
    // 否则服务端会一直挂着一个没人用的 ASR 任务。
    if (st.call && st.call.channelName && st.call.channelName !== call.channelName) {
      log.info('call', '新来电覆盖未结束的旧通话，停掉旧字幕任务');
      stopCaptions().catch(() => {});
    }
    st.phase = 'ringing';
    st.call = call;
    st.startedAt = 0;
    st.lastError = '';
    note(`来电 channel=${call.channelName}`);
    // 这块表开了 B站 bot 就直接接，不用人点。
    // "有没有页面在跑"有两个来源：用户自己的浏览器，或者我们起的无头页面。
    // 后者要现起（1~2 秒），所以这里异步判断，不阻塞 IM 收帧。
    if (botEnabled(call.callerId)) {
      autoAnswer(call);
    }
    log.info('call', `来电：${call.callType === 2 ? '语音' : '视频'}`
      + ` 频道 ${call.channelName} uid=${call.uid}`
      + ` 厂商=${PROVIDER_NAME[call.providers] || call.providers}`
      + ` token=${maskToken(call.token)} appId=${call.appId || '（空，用内置回退）'}`);
    return true;
  }

  // 后面几种都可能是"当前这通"的结束信号。channelName 对不上就当别的通话，忽略
  const p = payloadOf(b);
  const ch = p && p.channelName ? String(p.channelName) : '';
  const mine = st.call ? st.call.channelName : '';
  if (mine && ch && ch !== mine) {
    log.debug('call', `忽略无关通话帧 ${type}（频道 ${ch} ≠ 当前 ${mine}）`);
    return true;
  }

  if (kind === 'cancel' || kind === 'hangup') {
    const was = st.phase;
    // 对端挂断也要把字幕任务停掉，否则服务端那台 ASR 会一直挂在频道里跑
    // （stopCaptions 同步段就读 st.call，所以必须在清空之前调）
    stopCaptions().catch(() => {});
    endHooks('对端' + (kind === 'cancel' ? '取消呼叫' : '挂断'));
    st.phase = 'idle';
    st.call = null;
    st.startedAt = 0;
    caption = null;
    note(kind === 'cancel' ? '对方取消了呼叫' : '对方挂断了通话');
    log.info('call', (kind === 'cancel' ? '主叫取消' : '对端挂断')
      + `（原状态 ${was}，频道 ${ch || mine || '-'}）`);
    return true;
  }

  if (kind === 'response') {
    note(`通话应答：responseType=${p ? p.responseType : '?'}`);
    log.debug('call', `收到应答帧 ${JSON.stringify(p || {}).slice(0, 200)}`);
    return true;
  }

  return true;
}

function endHooks(reason) {
  if (typeof hooks.onCallEnd === 'function') {
    try { hooks.onCallEnd(reason); } catch (e) { /* ignore */ }
  }
}

// 自动接听：先确认"有页面能干活"再应答。
// 页面来源两种：用户自己的浏览器（在轮询）或我们现起的无头页面。
// 都没有就不接 —— 接了只有黑屏，比不接更糟。
async function autoAnswer(call) {
  let headlessOk = false;
  let why = '';
  if (typeof hooks.onAutoAnswer === 'function') {
    try {
      const r = await hooks.onAutoAnswer(call);
      headlessOk = !!(r && r.ok);
      why = (r && r.reason) || '';
    } catch (e) {
      why = e.message;
    }
  }
  const byBrowser = viewerAlive();
  if (!headlessOk && !byBrowser) {
    note('B站 bot 已开启，但没有可用的页面（浏览器没开、无头也没起来），改为正常响铃');
    log.warn('call', `手表 ${call.callerId} 开了 B站 bot，但没有页面可用（${why || '前端未轮询'}），不自动接听`);
    return { ok: false, reason: why || 'no-page' };
  }
  note(headlessOk ? '无头页面接管，自动接听' : 'B站 bot 已开启，自动接听');
  log.info('call', `手表 ${call.callerId} 开了 B站 bot，自动接听（${headlessOk ? '无头页面' : '浏览器页面'}）`);
  setTimeout(() => {
    answer().catch((e) => {
      note('自动接听失败：' + e.message, 'error');
      log.warn('call', '自动接听失败: ' + e.message);
    });
  }, 300);
  return { ok: true, headless: headlessOk };
}

function needCall() {  if (!st.call) throw new Error('当前没有正在响铃的通话');
  if (st.phase !== 'ringing') throw new Error('通话状态不对（' + st.phase + '），不能应答');
  return st.call;
}

// 应答的请求体。字段名以原版 VideoCallsResponseRequestBean 为准
function responseBody(c, responseType) {
  return {
    callerId: c.callerId,
    calleeId: String((cfg && cfg.mobileId) || ''),
    watchId: c.callerId,                 // 手表打过来时，主叫 id 就是手表 id
    channelName: c.channelName,
    responseType,
    calleeNetStatus: 1,                  // 原版取本机网络类型，这里固定 1（WLAN）
    callType: c.callType || 1,
  };
}

function respPath(c) {
  return (c.callType === 2)
    ? '/videocall-service/voicecall/callresponse'
    : '/videocall/callresponse';
}

function ensure(rs) {
  // 网关统一返回 { code: '000001', data: ... }；code 不是 000001 就是失败
  const code = rs && rs.json ? String(rs.json.code || '') : '';
  if (!rs || rs.status !== 200 || (code && code !== '000001')) {
    const msg = (rs && rs.json && (rs.json.desc || rs.json.message)) || code || ('HTTP ' + (rs ? rs.status : '?'));
    throw new Error('接口失败：' + msg);
  }
  return rs.json ? rs.json.data : null;
}

async function answer() {
  const c = needCall();
  if (!api) throw new Error('api 尚未注入');
  const body = responseBody(c, 1);
  const data = ensure(await api.request('POST', respPath(c), body));
  // 原版应答响应只有 callerClosed：为 true 说明主叫已经不等了
  if (data && data.callerClosed) {
    st.phase = 'idle';
    st.call = null;
    note('接听时主叫已挂断');
    throw new Error('主叫已经挂断了');
  }
  st.phase = 'talking';
  st.startedAt = Date.now();
  note('已接听');
  log.info('call', `已接听 频道 ${c.channelName}（providers=${c.providers}）`);
  // 必须回完整状态：前端靠 bot.enabled 决定要不要起待机画面和语音识别。
  // 只回 {ok, phase} 的话，手动点「接听」这一路会把 bot 整个跳过。
  return Object.assign({ ok: true }, status());
}

async function reject(reason) {
  const c = needCall();
  if (!api) throw new Error('api 尚未注入');
  const rt = Number(reason) || 2;   // 2=拒接 3=忙线 …（3~16 是原版的各种自动拒接原因）
  ensure(await api.request('POST', respPath(c), responseBody(c, rt)));
  st.phase = 'idle';
  st.call = null;
  note('已拒接');
  endHooks('本端拒接');
  log.info('call', `已拒接 频道 ${c.channelName} responseType=${rt}`);
  return { ok: true, phase: st.phase };
}

async function hangup() {
  const c = st.call;
  if (!c) throw new Error('当前没有通话');
  if (!api) throw new Error('api 尚未注入');
  await stopCaptions().catch(() => {});
  const mobileId = String((cfg && cfg.mobileId) || '');
  // 通话中挂断走 /finish（带 hangupId），和"取消呼叫"的 /hangup 不是一个接口
  const body = {
    watchId: c.callerId,
    callerId: c.callerId,
    calleeId: mobileId,
    channelName: c.channelName,
    hangupId: mobileId,
    type: 1,
    callType: c.callType || 1,
  };
  const path = (c.callType === 2) ? '/videocall-service/voicecall/finish' : '/videocall/finish';
  ensure(await api.request('POST', path, body));
  st.phase = 'idle';
  st.call = null;
  st.startedAt = 0;
  note('已挂断');
  endHooks('本端挂断');
  log.info('call', `已挂断 频道 ${c.channelName}`);
  return { ok: true, phase: st.phase };
}

// ===== 实时字幕（ASR）=====
// 服务端会派一个「字幕机器人」进房间，把我们指定那一路的语音转成文字，
// 通过 RTC 数据流（protobuf）推给所有客户端。这里是任务的生命周期管理，
// 真正的接收/解析在前端（只有浏览器才拿得到 stream-message）。
//
// ⚠️ subScribeId 是**手表的 watchId**，不是 Agora 的 uid。
// 反编译 CallingPresenter.coM2() 里是 s5(Iceland(), India())，而
// Georgia.Iceland() 的日志写的是 "getWatchId()"。传 uid 会被服务端
// 判成 "request parameter is invalid."（2026-11-18 踩过）
async function startCaptions() {
  const c = st.call;
  if (!c) throw new Error('当前没有通话');
  if (!api) throw new Error('api 尚未注入');
  // 同一通电话只建一次任务。
  // 多开一个标签页（或页面刷新后旧实例还在轮询）会各建一个，服务端那边就一直累加——
  // 实测一晚上堆了 4 个 task、pubBotUid 从 121725930 一路涨到 934，旧的还活着。
  if (caption && caption.pubBotUid && caption.channelName === c.channelName) {
    log.info('call', '字幕任务已存在，复用 taskId=' + caption.taskId);
    return { ok: true, taskId: caption.taskId, pubBotUid: caption.pubBotUid, reused: true };
  }
  const body = { channelName: c.channelName, subScribeId: String(c.callerId || '') };
  if (!body.subScribeId) throw new Error('不知道手表的 watchId，无法指定转写哪一路');
  const resp = await api.request('POST', '/videocall-service/rtestt/startRteTask', body, { host: RTE_HOST });
  if (resp && resp.json && resp.json.code !== '000001') {
    log.warn('call', 'startRteTask 失败 ' + JSON.stringify(resp.json).slice(0, 240));
  }
  const data = ensure(resp);
  // 原版要求 pubBotUid 非空且 subScribeIdSupportFlag 为 true 才算成功
  if (!data || !data.pubBotUid) {
    log.warn('call', '启动字幕失败：' + JSON.stringify(data || {}).slice(0, 200));
    return { ok: false, data: data || null };
  }
  if (data.subScribeIdSupportFlag === false) {
    log.warn('call', '字幕任务是起来了，但服务端说这块表的 subScribeId 不支持：'
      + JSON.stringify(data).slice(0, 160));
  }
  caption = {
    taskId: String(data.taskId || ''),
    pubBotUid: String(data.pubBotUid),
    channelName: c.channelName,      // 复用时要确认是同一条通话
    at: Date.now(),
  };
  note('语音识别已就绪，说话就能下指令');
  log.info('call', `字幕任务已启动 taskId=${caption.taskId} pubBotUid=${caption.pubBotUid}`
    + ` subScribeId=${body.subScribeId.slice(0, 12)}…`);
  return { ok: true, taskId: caption.taskId, pubBotUid: caption.pubBotUid };
}

async function stopCaptions() {
  const task = caption;
  caption = null;
  if (!task || !st.call || !api) return { ok: true };
  try {
    ensure(await api.request('POST', '/videocall-service/rtestt/stopRteTask', {
      channelName: st.call.channelName,
      subScribeId: String(st.call.callerId || ''),
      taskId: task.taskId,
    }, { host: RTE_HOST }));
    log.info('call', '字幕任务已停止 ' + (task.taskId || ''));
  } catch (e) {
    log.warn('call', '停止字幕失败（不影响挂断）: ' + e.message);
  }
  return { ok: true };
}

function publicCall() {
  if (!st.call) return null;
  const c = st.call;
  return {
    callType: c.callType,
    channelName: c.channelName,
    // token 要给前端做 Agora 入房用，所以这里返回完整值；
    // 但**日志里必须打码**（见 maskToken 的用法）
    token: c.token,
    uid: c.uid,
    appId: c.appId,
    providers: c.providers,
    providerName: PROVIDER_NAME[c.providers] || String(c.providers || ''),
    callerId: c.callerId,
    receivedAt: c.receivedAt,
  };
}

function status() {
  viewerAt = Date.now();   // 顺带当心跳：只有真在轮询的前端才算"活着"
  return {
    phase: st.phase,
    call: publicCall(),
    startedAt: st.startedAt,
    duration: st.startedAt ? Date.now() - st.startedAt : 0,
    lastError: st.lastError,
    // 前端据此决定要不要开语音指令：enabled=这块表开了 bot；pubBotUid=只认这个 uid 的数据流
    bot: {
      enabled: st.call ? botEnabled(st.call.callerId) : false,
      pubBotUid: caption ? caption.pubBotUid : '',
      taskId: caption ? caption.taskId : '',
    },
    events: st.events.slice(-8),
    // 外部状态（目前只有"无头页面在不在跑"）。前端靠它决定自己要不要入房：
    // 无头页面在跑时浏览器页必须让位，否则同 uid 两路会互踢。
    ...((typeof hooks.statusExtra === 'function' ? hooks.statusExtra() : null) || {}),
  };
}

// 进程启动时可能还挂着上一次的通话状态，重置一下
function reset() {
  st.phase = 'idle';
  st.call = null;
  st.startedAt = 0;
  st.lastError = '';
}

module.exports = {
  configure, handleFrame, status, answer, reject, hangup, reset,
  startCaptions, stopCaptions, botEnabled,
  TYPES, PROVIDER_NAME,
};
