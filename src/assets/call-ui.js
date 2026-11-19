/* 视频通话界面：来电浮层 / 接听 / 挂断 / 通话内 B站推送 / 语音指令
 *
 * 这个文件是从 1.4.0 的 webui.html 里整段抽出来的。
 * 起因是 PR #9 把整个界面换成了 React（单文件 bundle，见 src/webui.html 开头的注释），
 * 而通话是**覆盖在 App 之上的全屏浮层**，跟 React 的页面树没有交集 ——
 * 做成独立脚本挂进来的成本，远低于把它重写成一堆 React 组件（那部分是命令式的
 * canvas 合成 + Agora 轨道管理，套进 React 只会更绕）。
 *
 * 依赖：/assets/agora-rtc.js 提供的全局 AgoraRTC
 * 挂载：页面里放 <div id="jzCallRoot"></div>，再引用本文件即可；样式和 DOM 由它自己注入。
 */
(function () {
  'use strict';

  var CSS = `
/* ===== 通话浮层（来电 / 通话中）=====
   只做信令层：来电时弹「接听/拒接」，接通后显示计时和挂断。
   音视频（Agora）还没接，所以接通后暂时只有状态，没有画面。 */
.call-mask{
  position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.45);backdrop-filter:blur(3px);padding:20px;
}
.call-mask[hidden]{display:none}
/* 静默模式的小状态条：右下角一小条，不挡视线，点开才是完整通话界面 */
.call-mini{
  position:fixed;right:14px;bottom:14px;z-index:9000;display:flex;align-items:center;gap:7px;
  padding:7px 12px;border-radius:999px;cursor:pointer;user-select:none;
  background:var(--card);color:var(--on-card);border:1px solid var(--outline-variant);
  box-shadow:0 4px 16px rgba(0,0,0,.28);font-size:12.5px;
}
.call-mini[hidden]{display:none}
.call-mini-dot{width:8px;height:8px;border-radius:50%;background:#fb7299;
  box-shadow:0 0 7px #fb7299;animation:callMiniPulse 1.6s ease-in-out infinite}
@keyframes callMiniPulse{0%,100%{opacity:1}50%{opacity:.35}}
.call-mini-time{font-variant-numeric:tabular-nums;opacity:.75}
.call-card{
  width:100%;max-width:340px;background:var(--card);color:var(--on-card);
  border-radius:var(--radius-lg);padding:26px 22px 20px;text-align:center;
  box-shadow:0 18px 48px rgba(0,0,0,.28);
}
.call-icon{font-size:34px;line-height:1;margin-bottom:10px}
.call-title{font-size:19px;font-weight:600;margin-bottom:6px}
.call-sub{font-size:12.5px;color:var(--on-surface-variant);line-height:1.6;word-break:break-all}
/* 视频区：远端铺满，本地小窗右上角。Agora 会往这两个 div 里塞 <video> */
.call-videos{
  position:relative;width:100%;aspect-ratio:3/4;max-height:46vh;
  background:#000;border-radius:12px;overflow:hidden;margin:10px 0
}
.call-video{position:absolute;inset:0}
.call-video video{width:100%;height:100%;object-fit:cover;display:block}
.call-video.local{
  inset:auto;top:8px;right:8px;width:84px;height:112px;
  border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,.28);z-index:2
}
.call-timer{font-size:26px;font-weight:600;margin:10px 0 2px;font-variant-numeric:tabular-nums}
.call-actions{display:flex;gap:12px;margin-top:20px}
.call-btn{
  flex:1;height:44px;border-radius:999px;border:0;font-size:15px;font-weight:600;
  cursor:pointer;color:#fff;
}
.call-btn.reject{background:#d33b3b}
.call-btn.accept{background:#1aa05a}
.call-btn.hang{background:#d33b3b}
.call-btn.ghost{background:transparent;border:1px solid var(--outline);color:var(--on-card)}
.call-build{margin-top:10px;font-size:10.5px;color:var(--on-surface-variant);opacity:.7}
/* 通话内 B站面板：搜索 + 结果 + 控制 */
.call-bot{margin-top:14px;text-align:left}
.call-bot-row{display:flex;gap:6px}
.call-bot-row input{
  flex:1;height:32px;padding:0 10px;border-radius:8px;font-size:13px;
  border:1px solid var(--outline);background:var(--bg-elevated);color:var(--on-card)
}
.mini{
  height:32px;padding:0 10px;border-radius:8px;font-size:12.5px;cursor:pointer;
  border:1px solid var(--outline);background:transparent;color:var(--on-card);white-space:nowrap
}
.mini:disabled{opacity:.5;cursor:default}
.call-bot-list{
  margin-top:8px;max-height:132px;overflow:auto;
  border:1px solid var(--outline-variant);border-radius:8px
}
.call-bot-item{
  display:block;width:100%;text-align:left;padding:7px 9px;font-size:12.5px;
  background:transparent;border:0;border-bottom:1px solid var(--outline-variant);
  color:var(--on-card);cursor:pointer;line-height:1.45
}
.call-bot-item:last-child{border-bottom:0}
.call-bot-item:hover{background:color-mix(in srgb, var(--primary) 10%, transparent)}
.call-bot-item b{color:var(--primary);font-weight:600;margin-right:4px}
.call-bot-item span{opacity:.65;font-size:11px}
.call-bot-ctl{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.call-bot-now{margin-top:8px;font-size:11.5px;color:var(--on-surface-variant);line-height:1.5;word-break:break-all}
.call-bot-tip{margin-bottom:8px;padding:7px 9px;border-radius:8px;font-size:11.5px;line-height:1.55;
  background:color-mix(in srgb,var(--primary) 12%,transparent);
  color:var(--on-surface-variant)}
.call-btn:disabled{opacity:.6;cursor:default}
.call-events{
  margin-top:14px;font-size:11.5px;color:var(--on-surface-variant);
  text-align:left;max-height:66px;overflow:auto;line-height:1.5;white-space:pre-line
}
`;
  var HTML = `
<!-- 通话浮层：来电 / 通话中。信令层，视频画面等 Agora 接入后再挂这里 -->
<!-- B站视频元素：只用来解码，画面由 canvas 合成后再推流。
     ⚠️ 不能用 display:none —— 页面切到后台时，Chrome 会把"不可见 + 静音/无音轨"
     的媒体当作 video-only background media 直接暂停掉（省电），
     play() 抛 AbortError，captureStream 随之断帧，手表就黑屏。
     所以做成 2x2、移到屏幕外、透明但仍在渲染树里。 -->
<video id="botVideo" playsinline style="position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none"></video>
<!-- 静默模式下不弹整块浮层，只在右下角留一条小状态条，点它才展开 -->
<div class="call-mini" id="callMini" hidden>
  <span class="call-mini-dot"></span>
  <span id="callMiniText">通话中</span>
  <span class="call-mini-time" id="callMiniTime">00:00</span>
</div>
<div class="call-mask" id="callMask" hidden data-phase="idle">
  <div class="call-card">
    <div class="call-icon" id="callIcon">📹</div>
    <div class="call-title" id="callTitle">来电</div>
    <div class="call-timer" id="callTimer" hidden>00:00</div>
    <div class="call-videos" id="callVideos" hidden>
      <div class="call-video remote" id="remoteVideo"></div>
      <div class="call-video local" id="localVideo"></div>
    </div>
    <div class="call-sub" id="callSub"></div>
    <div class="call-actions" id="callRinging">
      <button class="call-btn reject" id="callReject" type="button">拒接</button>
      <button class="call-btn accept" id="callAccept" type="button">接听</button>
    </div>
    <div class="call-actions" id="callTalking" hidden>
      <button class="call-btn ghost" id="callLocal" type="button">开我的摄像头</button>
      <button class="call-btn hang" id="callHang" type="button">挂断</button>
    </div>
    <div class="call-events" id="callEvents"></div>
    <!-- 通话内 B站推流面板（照搬 Xposed 版的控制方式） -->
    <div class="call-bot" id="callBot" hidden>
      <div class="call-bot-tip" id="callBotTip" hidden>
        手表上是语音操作：说「搜索 关键词」出列表，说「播放 1」点播，
        「暂停 / 继续」「弹幕」「原比例」「返回」「翻页」，挂断要说两遍
      </div>
      <div class="call-bot-row">
        <input id="botKw" placeholder="搜索 B站 或填 BV 号" autocomplete="off" spellcheck="false">
        <button class="mini" id="botSearch" type="button">搜</button>
      </div>
      <div class="call-bot-list" id="botList" hidden></div>
      <div class="call-bot-ctl">
        <button class="mini" id="botPause" type="button">暂停</button>
        <button class="mini" id="botPage" type="button">下一页</button>
        <button class="mini" id="botHelp" type="button">帮助</button>
        <button class="mini" id="botDm" type="button">弹幕 开</button>
        <button class="mini" id="botMute" type="button">声音 开</button>
      </div>
      <div class="call-bot-now" id="botNow"></div>
    </div>
    <div class="call-build" id="callBuild"></div>
  </div>
</div>
`;
  // ---------- 被抽出来之后需要自带的小工具 ----------
  // 原来这些都定义在页面主脚本里，现在模块要独立，就地补一份。

  function $(sel) { return document.querySelector(sel); }

  // 静默模式 = 这块表开了「自动接听」。用户人不在电脑前，弹气泡只会在回来时看到一堆残影。
  // 通话模块会改写这个变量（show() 里按 bot.enabled 赋值）。
  var quietMode = false;

  function toast(msg, isError) {
    if (quietMode) {
      // 错误类仍然留痕，否则真出问题就彻底看不见了
      if (isError) { try { console.warn('[静默] ' + msg); } catch (e) { /* ignore */ } }
      return;
    }
    var t = document.getElementById('jzCallToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'jzCallToast';
      t.className = 'jz-call-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'jz-call-toast show' + (isError ? ' error' : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.className = 'jz-call-toast'; }, 2600);
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 只做「发请求 + 拆信封」。令牌失效时原来会弹登录遮罩，这里退化成一条错误提示 ——
  // 通话中弹登录框本来也没意义（用户多半不在电脑前）。
  async function api(path, opts) {
    opts = opts || {};
    var ms = opts.timeout === undefined ? 30000 : Number(opts.timeout);
    var ac = null, timer = null, o = opts;
    if (ms > 0 && typeof AbortController !== 'undefined' && !opts.signal) {
      ac = new AbortController();
      o = Object.assign({}, opts, { signal: ac.signal });
      timer = setTimeout(function () { try { ac.abort(); } catch (e) { /* ignore */ } }, ms);
    }
    var r, j;
    try {
      r = await fetch(path, o);
      j = await r.json();
    } catch (e) {
      if (ac && ac.signal.aborted) throw new Error('请求超时（' + Math.round(ms / 1000) + ' 秒没响应）');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (r.status === 401 || j.unauthorized) throw new Error('访问令牌已失效，请刷新页面重新登录');
    if (!j.ok) throw new Error(j.error || '请求失败');
    return j.data;
  }

  // 小状态条和提示泡的样式放在这里，不依赖页面主题变量（React 那套变量名和我们不一样）
  var EXTRA_CSS = `
.jz-call-toast{position:fixed;left:50%;bottom:36px;transform:translate(-50%,12px);z-index:9600;
  max-width:min(92vw,420px);padding:10px 16px;border-radius:12px;background:rgba(28,30,38,.96);
  color:#fff;font-size:13px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.35);
  opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}
.jz-call-toast.show{opacity:1;transform:translate(-50%,0)}
.jz-call-toast.error{background:rgba(150,32,44,.96)}
`;

  // ===== 通话信令（视频/语音）=====
  // 后端 /api/videocall/status 轮询；phase 变了才切界面。
  // 只做信令：接听/拒接/挂断。音视频（Agora）还没接，所以接通后只有计时没有画面。
  function startCallUI(){
    var mask = $('#callMask');
    if (!mask) return;
    var elIcon = $('#callIcon'), elTitle = $('#callTitle'), elSub = $('#callSub');
    var elTimer = $('#callTimer'), elEvents = $('#callEvents');
    var boxRinging = $('#callRinging'), boxTalking = $('#callTalking');
    var btnAccept = $('#callAccept'), btnReject = $('#callReject'), btnHang = $('#callHang');
    var phase = '';
    var lastCallKey = '';
    var startedAt = 0;
    var busy = false;
    var wasVisible = false;
    var ringed = false;

    function two(n){ return (n < 10 ? '0' : '') + n; }
    function fmtDur(ms){
      var s = Math.max(0, Math.floor(ms / 1000));
      var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      return (h ? two(h) + ':' : '') + two(m) + ':' + two(sec);
    }
    function paintTimer(){
      if (!startedAt) return;
      var txt = fmtDur(Date.now() - startedAt);
      elTimer.textContent = txt;
      elTimer.hidden = false;
      var mt = $('#callMiniTime');
      if (mt) mt.textContent = txt;
    }

    function show(st){
      var c = st.call || {};
      // 这块表开了「自动接听」→ 完全静默：整块浮层不弹（只留右下角一条小状态），
      // 不弹提示泡，远端声音也不外放。见下面 quietMode 的几处判断。
      botWant = !!(st.bot && st.bot.enabled);
      mask.setAttribute('data-phase', st.phase);
      elIcon.textContent = (c.callType === 2) ? '📞' : '📹';
      elTitle.textContent = (st.phase === 'talking'
        ? '通话中'
        : (c.callType === 2 ? '语音来电' : '视频来电'));
      elSub.textContent = [
        c.channelName ? '频道 ' + c.channelName : '',
        c.providerName ? '厂商 ' + c.providerName : '',
        c.uid ? 'uid ' + c.uid : ''
      ].filter(Boolean).join(' · ');
      var ringing = st.phase === 'ringing';
      boxRinging.hidden = !ringing;
      boxTalking.hidden = ringing;
      elTimer.hidden = ringing;
      if (elVideos) elVideos.hidden = ringing;
      // 通话中才显示 B站面板（来电时不显示，避免误触）
      var botBox = $('#callBot');
      if (botBox) botBox.hidden = ringing;
      startedAt = ringing ? 0 : (st.startedAt || Date.now());
      // 服务端已经起了无头页面 → 本页只当监视器，**绝不入房**。
      // 同一个 Agora uid 开两路连接，后进的会把先进的踢掉，手表看到的就是
      // "接通两秒又断了"（2026-11-18 实测）。autorun 页面本身就是那个无头页。
      var passive = !!(st.headless && !AUTORUN);
      if (passive) botWant = false;

      // 接了以后自动起帮助画面 + 语音识别，全程不用人点
      if (botWant && !isLeader()) {
        // 另一个标签页正在开车，这个页面只当"监视器"，别跟着一起入房
        botWant = false;
        toast('另一个页面在接管这通电话，请关掉多余的标签页', true);
        rtcReport('本页不是主控（另一个标签页在跑），不驱动推流');
      }
      // 面板上显示出来，用户才知道"现在说话就能点播"
      var elBotTip = $('#callBotTip');
      if (elBotTip) elBotTip.hidden = !botWant;

      // 静默 = 这块表开了自动接听。passive（无头页面在跑、本页只是旁观）时也必须静默，
      // 否则用户浏览器会弹出整块通话浮层 + 一堆提示泡，等于没有"静默"。
      quietMode = !!botWant || passive;
      var mini = $('#callMini');
      if (mini) {
        mini.hidden = !quietMode || AUTORUN;   // 无头页面不显示任何 UI
        var mtxt = $('#callMiniText');
        if (mtxt) {
          if (passive) mtxt.textContent = ringing ? '手表来电 · 后台接听中' : '后台页面处理中';
          else mtxt.textContent = ringing ? '手表来电 · 自动接听' : 'B站语音点播中';
        }
      }
      mask.hidden = quietMode;      // 静默模式下浮层不出现，点小状态条才展开

      if (!ringing) {
        paintTimer();
        // 不 await：入房失败会弹 toast，不能卡住界面。
        // passive 时一定不要入房（见上面的注释）。
        if (!passive) joinRtc(c);
      }
      elEvents.textContent = (st.events || []).slice(-3).map(function(e){
        var d = new Date(e.at);
        return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()) + '  ' + e.text;
      }).join('\n');
    }

    function hide(){
      mask.hidden = true;
      mask.setAttribute('data-phase', 'idle');
      startedAt = 0;
      botWant = false;
      quietMode = false;
      var miniEl = $('#callMini');
      if (miniEl) miniEl.hidden = true;
      dropLeader();          // 通话结束把主控名额让出去，别让下一个标签页等 8 秒
      if (voice.timer) { clearTimeout(voice.timer); voice.timer = 0; }
      voice.on = false;
      voice.buf = '';
      leaveRtc();
      // 通话结束要把 B站推流一起收掉，否则 <video> 会在后台一直下载
      try { botStop(); } catch (e) { /* ignore */ }
    }

    async function post(action, body){
      if (busy) return;
      busy = true;
      btnAccept.disabled = btnReject.disabled = btnHang.disabled = true;
      try {
        var r = await api('/api/videocall/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {})
        });
        if (!r || r.phase === 'idle') { hide(); phase = 'idle'; }
        else { phase = r.phase || 'talking'; show(r); }
      } catch (e) {
        toast(e.message || '通话操作失败', true);
      } finally {
        busy = false;
        btnAccept.disabled = btnReject.disabled = btnHang.disabled = false;
      }
    }

    btnAccept.onclick = function(){ post('answer'); };
    btnReject.onclick = function(){ post('reject', { reason: 2 }); };
    btnHang.onclick = function(){ post('hangup'); };
    var btnLocal = $('#callLocal');
    if (btnLocal) btnLocal.onclick = enableLocal;

    // 右下角小状态条：静默模式下点它才展开完整通话界面（否则连挂断按钮都找不到）
    var miniBox = $('#callMini');
    if (miniBox) miniBox.onclick = function(){
      mask.hidden = false;
      miniBox.hidden = true;
      rtcReport('用户点开静默状态条，展开通话界面');
    };

    // B站面板的按钮（函数声明会提升，这里先绑没问题）
    (function bindBot(){
      var e = botEls();
      if (!e.box) return;
      if (e.btnSearch) e.btnSearch.onclick = function () { botSearch(); };
      if (e.kw) e.kw.onkeydown = function (ev) { if (ev.key === 'Enter') botSearch(); };
      if (e.btnPause) e.btnPause.onclick = function () {
        if (!bot.video) return;
        if (bot.video.paused) {
          bot.userPaused = false;
          bot.video.play();
          e.btnPause.textContent = '暂停';
        } else {
          bot.userPaused = true;
          bot.video.pause();
          e.btnPause.textContent = '继续';
        }
      };
      if (e.btnNext) e.btnNext.onclick = function () {
        // 面板上的「下一页」和说「翻页」等价：列表里翻结果，其它时候翻帮助
        if (bot.mode === 'list') { botNextPage(); toast('第 ' + (bot.listPage + 1) + ' 页'); }
        else { botNextHelp(); toast(HELP_PAGES[bot.helpPage].title); }
      };
      if (e.btnHelp) e.btnHelp.onclick = function () { botShowHelp(); };
      if (e.btnDm) e.btnDm.onclick = function () {
        bot.dmOn = !bot.dmOn;
        e.btnDm.textContent = '弹幕 ' + (bot.dmOn ? '开' : '关');
      };
      if (e.btnMute) e.btnMute.onclick = function () {
        setBotMuted(!bot.muted);
        e.btnMute.textContent = '声音 ' + (bot.muted ? '关' : '开');
      };
    })();

    // 两声提示音，用 WebAudio 合成，不依赖外部音频文件
    function ring(){
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      [0, 0.45].forEach(function(t0){
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + t0);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t0 + 0.3);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + t0);
        o.stop(ctx.currentTime + t0 + 0.32);
      });
      setTimeout(function(){ try { ctx.close(); } catch (e) { /* ignore */ } }, 1200);
    }

    // ===== Agora 媒体层 =====
    // 用后端给的 appId / channelName / token / uid 入房。
    // mode:'live' + role:'host' 对应原版的 channelProfile=1 + clientRoleType=1（主播）；
    // codec 用 vp8 —— 抓包确认原版 setVideoEncoderConfiguration codecType=0(VP8)。
    var BUILD = 'call-v18';
    // 服务端注入的构建号（webui.js 在吐页面时把 __HTML_BUILD__ 换成「大小-mtime」）。
    // 轮询时带上它，服务端一比对不一致就让本页 reload ——
    // 「改完前端忘了刷新，测的还是旧 JS」是这个项目最容易浪费时间的坑。
    var PAGE_BUILD = '__HTML_BUILD__';
    var elVideos = $('#callVideos');
    var elBuild = $('#callBuild');
    if (elBuild) elBuild.textContent = '前端版本 ' + BUILD;
    var rtc = { client: null, audio: null, video: null, joined: false, channel: '', uid: null };

    // 浏览器里的 Agora 报错只能在控制台看到；回传一份到服务端日志，
    // 否则"入房失败"永远只有一个 toast，查不下去。
    function rtcReport(text){
      try {
        api('/api/videocall/rtclog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: String(text).slice(0, 380) }),
          timeout: 5000
        }).catch(function(){ /* 日志失败不影响通话 */ });
      } catch (e) { /* ignore */ }
    }

    async function joinRtc(c){
      if (!c || !c.channelName) return;
      if (rtc.joined && rtc.channel === c.channelName) return;
      if (!window.AgoraRTC) { toast('Agora SDK 未加载，只有信令', true); return; }
      if (!c.appId) { toast('推送里没有 appId，无法入房', true); return; }
      await leaveRtc();          // 上一通没收干净
      try {
        rtcReport('入房参数 appId=' + c.appId + ' channel=' + c.channelName
          + ' uid=' + c.uid + ' tokenLen=' + (c.token || '').length
          + ' tokenHead=' + String(c.token || '').slice(0, 3));
        var client = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' });
        rtc.client = client;
        client.on('exception', function(ev){
          rtcReport('exception code=' + (ev && ev.code) + ' msg=' + (ev && (ev.msg || ev.message)));
        });
        client.on('connection-state-changed', function(cur, prev){
          rtcReport('conn ' + prev + ' → ' + cur);
        });
        client.on('user-published', async function(user, mediaType){
          try {
            // 发媒体的只能是手表（字幕机器人只发数据流），用它认 remoteUid 最可靠
            pickRemote(user);
            await client.subscribe(user, mediaType);
            if (mediaType === 'video' && user.videoTrack) user.videoTrack.play('remoteVideo');
            if (mediaType === 'audio' && user.audioTrack) {
              // 静默模式下不播远端声音：这台电脑可能正在书房/卧室开着，
              // 手表那边的环境声不该外放。语音识别是服务端机器人在转写，
              // 不依赖本地播放，所以静默不影响下指令。
              if (quietMode) { rtcReport('静默模式：不播放远端音频'); }
              else {
                try { user.audioTrack.play(); }
                catch (e) { rtcReport('远端音频播放被拦截 ' + (e && e.message)); }
              }
            }
          } catch (e) { /* 单路订阅失败不影响其他 */ }
        });
        // 远端加入：正常情况下手表先入房，这里拿不到就靠 user-published / remoteUsers 兜
        client.on('user-joined', function(user){
          rtcReport('远端加入 uid=' + (user && user.uid));
          pickRemote(user);
        });
        // 字幕机器人推来的数据流（protobuf）。只认 pubBotUid 那一路，
        // 别把别人发的东西当指令执行了。
        client.on('stream-message', function(uid, data){
          if (!voice.pubBotUid || String(uid) !== voice.pubBotUid) return;
          try { onCaptionFrame(data instanceof Uint8Array ? data : new Uint8Array(data)); }
          catch (e) { /* 单帧坏掉不影响后面 */ }
        });
        await client.setClientRole('host');
        rtc.uid = c.uid;
        await client.join(c.appId, c.channelName, c.token, c.uid);
        rtc.joined = true;
        rtc.channel = c.channelName;
        rtcReport('join 成功 channel=' + c.channelName + ' uid=' + c.uid + ' botWant=' + botWant);
        if (elVideos) elVideos.hidden = false;
        toast('已入房（Agora）');
        // 手表是主叫，通常比我们先进房。SDK 对"已在房间的人"不一定补发 user-joined，
        // 所以这里主动扫一遍，免得字幕任务一直等不到 uid。
        (client.remoteUsers || []).forEach(pickRemote);
        if (botWant) {
          rtcReport('本表已开 B站 bot：待机画面 + 等待手表 uid 后启动语音识别');
          botStandby();
          voiceTryStart();
        }
        // 默认**不采集**本地音视频：先保证能看到手表画面。
        // 采集会触发 getUserMedia，在没摄像头/权限被拒的环境里直接抛错，
        // 把「入房」这个动作本身也带崩了。要推流点「开我的摄像头」。
      } catch (e) {
        var msg = (e && (e.message || e.reason || e.code)) || e;
        rtcReport('入房失败 code=' + (e && e.code) + ' name=' + (e && e.name)
          + ' reason=' + (e && e.reason) + ' message=' + (e && e.message));
        toast('入房失败：' + msg, true);
        try { await leaveRtc(); } catch (x) { /* ignore */ }
      }
    }

    async function leaveRtc(){
      try { if (rtc.audio) rtc.audio.close(); } catch (e) { /* ignore */ }
      try { if (rtc.video) rtc.video.close(); } catch (e) { /* ignore */ }
      rtc.audio = null;
      rtc.video = null;
      try { if (rtc.client) await rtc.client.leave(); } catch (e) { /* ignore */ }
      rtc.client = null;
      rtc.joined = false;
      rtc.channel = '';
      rtc.uid = null;
      // 换了频道要能重新 publish：轨道还在（复用），但"已推上去"的标记必须清掉，
      // 否则 botPublish 会以为已经发布过而跳过，手表那边一片黑。
      bot.pubV = false;
      bot.pubA = false;
      // 语音状态一律清空：留着 uid/pubBotUid 会让下一通电话认错人
      if (voice.timer) { clearTimeout(voice.timer); voice.timer = 0; }
      voice.pubBotUid = '';
      voice.remoteUid = 0;
      voice.buf = '';
      voice.req = false;
      voice.on = false;
      voice.hangAt = 0;
      voice.tries = 0;
      voice.gotFrame = false;
      voice.awaitKw = 0;
      ['remoteVideo', 'localVideo'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.innerHTML = '';
      });
      if (elVideos) elVideos.hidden = true;
    }

    // 手动开启本地音视频推流（点「开我的摄像头」）。
    // 失败只提示，不影响已经建立的观看链路。
    // 一个客户端同时只能推一路视频（Agora 会报 CAN_NOT_PUBLISH_MULTIPLE_VIDEO_TRACKS），
    // 所以摄像头和 B站画面必须互斥：推 B站前先撤摄像头，反之亦然。
    // 注意只 unpublish、不 close 轨道，这样切回来时不用重新申请摄像头权限。
    async function rtcSingleVideo(want){
      if (!rtc.client) return;
      var cam = [rtc.audio, rtc.video].filter(Boolean);
      var botT = [bot.vTrack, bot.aTrack].filter(Boolean);
      var drop = (want === 'bot') ? cam : botT;
      if (!drop.length) return;
      try {
        await rtc.client.unpublish(drop);
        // 撤下来的要么是摄像头，要么是 B站那两路，按实际清标记
        if (want === 'bot') {
          if (bot.vTrack) bot.pubV = false;
          if (bot.aTrack) bot.pubA = false;
        }
        rtcReport('已撤下另一路推流（切到 ' + want + '）');
      } catch (e) {
        rtcReport('撤下推流失败 ' + (e && e.message));
      }
    }

    async function enableLocal(){
      if (!rtc.client || !rtc.joined) { toast('还没入房', true); return; }
      if (rtc.audio || rtc.video) { toast('已经在推流了'); return; }
      var btn = $('#callLocal');
      if (btn) btn.disabled = true;
      try {
        rtcReport('手动开启本地采集 build=' + BUILD);
        var tracks = await AgoraRTC.createMicrophoneAndCameraTracks();
        rtc.audio = tracks[0];
        rtc.video = tracks[1];
        rtc.video.play('localVideo');
        await rtcSingleVideo('camera');
        await rtc.client.publish([rtc.audio, rtc.video]);
        rtcReport('手动采集并推流成功');
        toast('已开始推流');
      } catch (e) {
        rtcReport('手动采集失败 name=' + (e && e.name) + ' msg=' + (e && e.message));
        toast('采集失败：' + ((e && e.message) || e), true);
        // 回滚半成品，避免留下一个不完整的轨道
        try { if (rtc.audio) rtc.audio.close(); } catch (x) {}
        try { if (rtc.video) rtc.video.close(); } catch (x) {}
        rtc.audio = null;
        rtc.video = null;
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    // ===== 通话内 B站推流 =====
    // 画面与操作方式照搬桌面上的 XTCVideoSpy（Xposed 版）：
    //   240x320 @ 20fps（手表视频通话的原始采集分辨率，别改，会影响所有比例），
    //   B站粉 #FB7299 主题，三块屏：
    //     1) 帮助菜单（待机，分页，说"翻页"切）
    //     2) 搜索结果列表（每页 3 条，带封面 + 序号角标，说"播放 N"点播）
    //     3) 播放 HUD（顶部百分比条 + 底部进度条/时间/标题 + 弹幕 + 实时字幕）
    var BOT_W = 240, BOT_H = 320, BOT_FPS = 20;
    var PER_PAGE = 3;                       // 搜索结果每页条数，和原版一致
    var BILI_PINK = '#fb7299';              // B站粉：色条、标题、序号角标、进度条
    var C_SUB = '#b4b4c8';                  // rgb(180,180,200) 次要文字
    var C_BAR_BG = '#323237';               // 进度条底色
    var C_INK = '#000';                     // 原版背景就是纯黑
    var bot = {
      video: null, canvas: null, ctx: null,
      bvid: '', cid: '', title: '', duration: 0, owner: '',
      danmaku: [], dmIdx: 0, actives: [], dmOn: true, muted: false,
      list: [], idx: -1, kw: '',
      listPage: 0, helpPage: 0, searchStatus: '',
      subtitle: '', subAt: 0,                 // 实时字幕（说的每句话回显在画面底部）
      raf: 0, started: false, hiddenTimer: 0,
      userPaused: false,                       // true = 用户主动暂停（看门狗别去拉起）
      reviveAt: 0,                             // 上次尝试"被浏览器暂停后拉起"的时间
      mode: 'idle',                            // idle | help | list | video
      aspect: false,                           // false=拉伸铺满（原版默认），true=等比留黑
      vTrack: null, aTrack: null, ac: null, gain: null,
      pubV: false, pubA: false                // 轨道是不是已经在频道里（Agora 不允许重复 publish）
    };

    function botInit(){
      if (bot.video) return;
      bot.video = $('#botVideo');
      bot.canvas = document.createElement('canvas');
      bot.canvas.width = BOT_W;
      bot.canvas.height = BOT_H;
      bot.ctx = bot.canvas.getContext('2d', { alpha: false });
    }

    function botRoundRect(ctx, x, y, w, h, r){
      var rr = Math.min(r, h / 2, Math.max(0.5, w / 2));
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.lineTo(x + w - rr, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
      ctx.lineTo(x + w, y + h - rr);
      ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
      ctx.lineTo(x + rr, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
      ctx.lineTo(x, y + rr);
      ctx.quadraticCurveTo(x, y, x + rr, y);
      ctx.closePath();
    }

    // 00:00 / 1:23:27（超过一小时才带小时，别把 7407 秒显示成"123:27"）
    function fmtClock(sec){
      var s = Math.max(0, Math.floor(Number(sec) || 0));
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var r = s % 60;
      var mm = (m < 10 && h > 0 ? '0' : '') + m;
      var ss = (r < 10 ? '0' : '') + r;
      return h > 0 ? (h + ':' + mm + ':' + ss) : (mm + ':' + ss);
    }

    // 按可用宽度截断（中文按字符估算不够准，直接用 measure 量）
    function clipText(ctx, text, maxW){
      var t = String(text || '');
      if (maxW <= 0) return '';
      if (ctx.measureText(t).width <= maxW) return t;
      while (t.length > 1 && ctx.measureText(t + '...').width > maxW) t = t.slice(0, -1);
      return t + '...';
    }

    // 播放 HUD —— 尺寸/字号/配色逐项照抄 VideoHudOverlay.java：
    //   顶部 20px 黑条，中间 13px 粗体粉字百分比
    //   底部 48px 黑底：圆角进度条（左右各让 10px、高 10px、圆角 3），
    //   下面一行左边 11px 白字时间，右边 10px 灰字标题（放不下就截断加 …）
    function botDrawHud(ctx, cur){
      var total = bot.duration || (bot.video && bot.video.duration) || 0;
      var p = total > 0 ? Math.min(1, cur / total) : 0;

      // 顶部：只有百分比，没有标题（标题在底部右侧）
      ctx.fillStyle = C_INK;
      ctx.fillRect(0, 0, BOT_W, 20);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = 'bold 13px -apple-system,sans-serif';
      ctx.fillStyle = BILI_PINK;
      ctx.fillText(Math.round(p * 100) + '%', BOT_W / 2, 15);

      // 底部
      ctx.fillStyle = C_INK;
      ctx.fillRect(0, BOT_H - 48, BOT_W, 48);
      var barL = 10, barR = BOT_W - 10, barT = BOT_H - 44, barB = barT + 10;
      ctx.fillStyle = C_BAR_BG;
      botRoundRect(ctx, barL, barT, barR - barL, 10, 3);
      ctx.fill();
      var fillW = (barR - barL) * p;
      if (fillW > 0.5) {
        ctx.fillStyle = BILI_PINK;
        botRoundRect(ctx, barL, barT, fillW, 10, 3);
        ctx.fill();
      }
      ctx.font = '11px -apple-system,sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff';
      var timeText = fmtClock(cur) + ' / ' + fmtClock(total);
      var timeW = ctx.measureText(timeText).width;
      ctx.fillText(timeText, barL, barB + 14);
      if (bot.title) {
        ctx.textAlign = 'right';
        ctx.font = '10px -apple-system,sans-serif';
        ctx.fillStyle = C_SUB;
        // 标题只吃"时间右边剩下的宽度"，否则两个文字会压在一起（列表页同理）
        ctx.fillText(clipText(ctx, bot.title, (barR - barL) - timeW - 10), barR, barB + 14);
      }
      ctx.textAlign = 'left';
    }

    // 实时字幕：说过的每句话回显在画面底部（照原版 overlaySubtitle，黑底白字 30px 高）。
    // 它同时是"ASR 到底听没听清"的反馈，比在电脑上看日志直观。
    // 播放时 HUD 占着底部 48px，字幕就往上让一层，别把时间和标题盖掉。
    function botDrawSubtitle(ctx){
      if (!bot.subtitle) return;
      if (Date.now() - bot.subAt > 6000) { bot.subtitle = ''; return; }
      var h = 30;
      var top = BOT_H - h - (bot.mode === 'video' ? 48 : 0);
      ctx.fillStyle = 'rgba(0,0,0,.9)';
      ctx.fillRect(0, top, BOT_W, h);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '13px -apple-system,sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(clipText(ctx, bot.subtitle, BOT_W - 16), 8, top + h - 9);
    }

    function botDrawDanmaku(ctx, cur){
      if (!bot.dmOn || !bot.danmaku.length) return;
      // 指针推进：把进入时间窗的弹幕放进活跃队列（数组按 t 排好序了）
      while (bot.dmIdx < bot.danmaku.length && bot.danmaku[bot.dmIdx].t <= cur + 0.1) {
        var d = bot.danmaku[bot.dmIdx++];
        if (cur - d.t > 8) continue;         // 拖进度条跳过的不要补
        bot.actives.push({ t: d.t, text: d.text, lane: bot.actives.length % 6 });
      }
      bot.actives = bot.actives.filter(function (a) { return cur - a.t < 8; });
      ctx.save();
      ctx.font = '12px -apple-system,sans-serif';
      ctx.textBaseline = 'top';
      for (var i = 0; i < bot.actives.length; i++) {
        var a = bot.actives[i];
        var prog = (cur - a.t) / 8;                       // 8 秒走完全程
        var x = BOT_W - prog * (BOT_W + ctx.measureText(a.text).width);
        var y = 26 + a.lane * 17;
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.fillText(a.text, x + 1, y + 1);
        ctx.fillStyle = '#fff';
        ctx.fillText(a.text, x, y);
      }
      ctx.restore();
    }

    // 合成循环的驱动方式：页面可见时用 rAF（顺滑、不耗 CPU），
    // 页面在后台时 rAF 会被浏览器停掉 —— 画面就冻在最后一帧，
    // 而"全自动接听"恰恰是没人在看页面的场景，所以后台必须换 setTimeout 兜着。
    function botSchedule(){
      if (bot.raf) { cancelAnimationFrame(bot.raf); bot.raf = 0; }
      if (bot.hiddenTimer) { clearTimeout(bot.hiddenTimer); bot.hiddenTimer = 0; }
      if (!bot.canvas) return;
      // 待机/菜单/列表都是静态画面，10fps 够了；但要"持续出帧"，一帧都不发会被当成没画面
      var slow = (bot.mode !== 'video');
      if (document.hidden || slow) {
        bot.hiddenTimer = setTimeout(function () { bot.hiddenTimer = 0; botRender(); }, 100);
      } else {
        bot.raf = requestAnimationFrame(botRender);
      }
    }

    // ===== 帮助菜单（待机屏）=====
    // 照 renderHelpFrame：顶部 8px 粉条、19px 粉标题、分隔线、编号指令、底部灰字提示。
    // 原版有三页（基础 / 播放 / 直播），我们没有直播接口，所以只做两页 ——
    // 把不能用的指令写上去等于骗用户，不如少一页。
    var HELP_PAGES = [
      {
        title: '语音控制 · 基础',
        cmds: ['搜索 + 关键词', '播放 + 序号', '暂停 / 继续', '返回帮助', '翻页'],
        hint: '说"翻页"看下一页'
      },
      {
        title: '语音控制 · 播放',
        cmds: ['显示原比例', '恢复拉伸', '关闭弹幕', '打开弹幕', '挂断（说两遍）'],
        hint: '说"翻页"回第一页'
      }
    ];

    function botDrawHelp(ctx){
      var n = HELP_PAGES.length;
      if (bot.helpPage >= n) bot.helpPage = 0;
      if (bot.helpPage < 0) bot.helpPage = n - 1;
      var pg = HELP_PAGES[bot.helpPage];

      ctx.fillStyle = C_INK;
      ctx.fillRect(0, 0, BOT_W, BOT_H);
      ctx.fillStyle = BILI_PINK;
      ctx.fillRect(0, 0, BOT_W, 8);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = 'bold 19px -apple-system,sans-serif';
      ctx.fillStyle = BILI_PINK;
      ctx.fillText(pg.title, BOT_W / 2, 105);

      ctx.fillStyle = C_BAR_BG;
      ctx.fillRect(15, 133, BOT_W - 30, 2);

      var y = 153;
      ctx.textAlign = 'left';
      for (var i = 0; i < pg.cmds.length; i++) {
        var idx = (i + 1) + '. ';
        ctx.font = 'bold 14px -apple-system,sans-serif';
        ctx.fillStyle = BILI_PINK;
        ctx.fillText(idx, 22, y);
        var w = ctx.measureText(idx).width;
        ctx.font = '14px -apple-system,sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(pg.cmds[i], 22 + w, y);
        y += 18;
      }

      ctx.textAlign = 'center';
      ctx.font = '11px -apple-system,sans-serif';
      ctx.fillStyle = C_SUB;
      ctx.fillText(pg.hint, BOT_W / 2, BOT_H - 40);
      ctx.fillText((bot.helpPage + 1) + '/' + n, BOT_W / 2, BOT_H - 22);
    }

    // ===== 搜索结果列表 =====
    // 照 renderSearchListFrame：每页 3 条、封面 80x45、序号角标、标题截 8 字、UP 截 8 字、
    // 时长右对齐，底部提示操作方式。
    var botCovers = {};     // pic 地址 → Image（加载完自动重绘一帧）

    function botCover(url){
      if (!url) return null;
      var key = String(url);
      var img = botCovers[key];
      if (img) return img;
      img = new Image();
      // 走服务端代理：B站图床没 Referer 直接 403，<img> 又带不了 Referer
      img.src = '/api/bili/cover?u=' + encodeURIComponent(key);
      img.onload = function () { if (bot.mode === 'list') botKick(); };
      img.onerror = function () { /* 封面挂了就一直是占位块，不影响播放 */ };
      botCovers[key] = img;
      return img;
    }

    function botDrawList(ctx){
      ctx.fillStyle = C_INK;
      ctx.fillRect(0, 0, BOT_W, BOT_H);
      ctx.fillStyle = BILI_PINK;
      ctx.fillRect(0, 0, BOT_W, 8);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = 'bold 17px -apple-system,sans-serif';
      ctx.fillStyle = BILI_PINK;
      ctx.fillText('搜索结果', BOT_W / 2, 42);

      var total = bot.list.length;
      var pages = Math.max(1, Math.ceil(total / PER_PAGE));
      if (bot.listPage >= pages) bot.listPage = pages - 1;
      if (bot.listPage < 0) bot.listPage = 0;

      ctx.font = '12px -apple-system,sans-serif';
      ctx.fillStyle = C_SUB;
      var info = total
        ? ((bot.listPage + 1) + '/' + pages + ' 页 · 共' + total + '条')
        : (bot.searchStatus || '未找到相关视频');
      ctx.fillText(info, BOT_W / 2, 60);

      if (!total) {
        ctx.font = '15px -apple-system,sans-serif';
        ctx.fillStyle = C_SUB;
        ctx.fillText(bot.searchStatus || '未找到相关视频', BOT_W / 2, 170);
        ctx.font = '11px -apple-system,sans-serif';
        ctx.fillText('说"搜索 + 关键词"重搜', BOT_W / 2, BOT_H - 40);
        return;
      }

      var rowH = 56, rowY = 76, coverW = 80, coverH = 45;
      var start = bot.listPage * PER_PAGE;
      for (var i = 0; i < PER_PAGE; i++) {
        var gi = start + i;
        if (gi >= total) break;
        var it = bot.list[gi] || {};
        var top = rowY + i * rowH;
        var coverTop = top + (rowH - coverH) / 2;

        var img = botCover(it.pic);
        if (img && img.complete && img.naturalWidth) {
          try { ctx.drawImage(img, 8, coverTop, coverW, coverH); } catch (e) { /* 解码失败就当没有 */ }
        } else {
          ctx.fillStyle = '#28282e';
          ctx.fillRect(8, coverTop, coverW, coverH);
        }

        // 序号角标（说"播放 N"就是这个 N，按当前页算）
        ctx.beginPath();
        ctx.arc(20, coverTop + 11, 9, 0, Math.PI * 2);
        ctx.fillStyle = BILI_PINK;
        ctx.fill();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.font = 'bold 12px -apple-system,sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(String(i + 1), 20, coverTop + 15);

        // 标题 / UP主 / 时长
        ctx.textAlign = 'left';
        ctx.font = '13px -apple-system,sans-serif';
        ctx.fillStyle = '#fff';
        var durText = it.duration > 0 ? fmtClock(it.duration) : '';
        var durW = 0;
        if (durText) {
          ctx.font = '11px -apple-system,sans-serif';
          durW = ctx.measureText(durText).width + 8;
        }
        // 标题和 UP 都要给右边的时长让位，否则长名字会压到时长上（实测重叠过）
        ctx.font = '13px -apple-system,sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(clipText(ctx, it.title || '', BOT_W - 96 - 8 - durW), 96, top + 22);

        ctx.font = '11px -apple-system,sans-serif';
        ctx.fillStyle = C_SUB;
        ctx.fillText(clipText(ctx, 'UP: ' + (it.author || ''), BOT_W - 96 - 8 - durW), 96, top + 40);

        if (durText) {
          ctx.textAlign = 'right';
          ctx.fillText(durText, BOT_W - 8, top + 40);
          ctx.textAlign = 'left';
        }
      }

      ctx.textAlign = 'center';
      ctx.font = '11px -apple-system,sans-serif';
      ctx.fillStyle = C_SUB;
      ctx.fillText('说"播放" + 序号 · "下一页"翻页', BOT_W / 2, BOT_H - 40);
    }

    // 起一帧并保证只有**一条**合成循环在跑。
    // 直接调 botRender() 会再起一条链（封面 onload、搜索、回帮助都会调），
    // 多条循环叠在一起 = 帧率翻倍 + 越跑越多，最后编码器直接顶不住。
    function botKick(){
      if (bot.raf || bot.hiddenTimer) return;
      botRender();
    }

    function botRender(){
      var ctx = bot.ctx;
      if (!ctx) return;
      if (bot.mode === 'help') {
        botDrawHelp(ctx);
        botSchedule();
        return;
      }
      if (bot.mode === 'list') {
        botDrawList(ctx);
        botDrawSubtitle(ctx);
        botSchedule();
        return;
      }
      var v = bot.video;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, BOT_W, BOT_H);
      if (v && v.videoWidth) {
        if (bot.aspect) {
          // 等比居中（说"显示原比例"时）
          var scale = Math.min(BOT_W / v.videoWidth, BOT_H / v.videoHeight);
          var dw = Math.round(v.videoWidth * scale), dh = Math.round(v.videoHeight * scale);
          try {
            ctx.drawImage(v, (BOT_W - dw) >> 1, (BOT_H - dh) >> 1, dw, dh);
          } catch (e) { /* 还没解出首帧 */ }
        } else {
          // 拉伸铺满（原版默认）。手表屏就这么大，铺满比留黑条耐看
          try { ctx.drawImage(v, 0, 0, BOT_W, BOT_H); } catch (e) { /* 同上 */ }
        }
      }
      // 看门狗：Chrome 可能在后台把媒体暂停（省电），这里最多 3 秒拉一次。
      // 用户自己按的暂停不算（userPaused），否则「暂停」永远停不下来。
      if (v && v.paused && !bot.userPaused && Date.now() - bot.reviveAt > 3000) {
        bot.reviveAt = Date.now();
        try {
          v.play().catch(function (e) {
            rtcReport('视频被浏览器暂停，拉起失败 ' + (e && e.name));
          });
        } catch (e) { /* ignore */ }
      }
      var cur = (v && v.currentTime) || 0;
      botDrawHud(ctx, cur);
      botDrawDanmaku(ctx, cur);
      botDrawSubtitle(ctx);
      botSchedule();
    }

    // 切回前台/切到后台时把循环换一种驱动方式
    document.addEventListener('visibilitychange', function () {
      if (!bot.canvas) return;
      if (bot.mode === 'help' || bot.mode === 'list' || (bot.video && !bot.video.paused)) botSchedule();
    });

    function botAudioTrack(){
      if (bot.aTrack) return bot.aTrack;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !bot.video) return null;
      try {
        bot.ac = new AC();
        var src = bot.ac.createMediaElementSource(bot.video);
        var dest = bot.ac.createMediaStreamDestination();
        // 中间串一个 gain：用户说「静音」时把增益打到 0，
        // 而**元素本身保持 muted=false** —— 元素一静音，Chrome 就把它当成
        // "无声媒体"，页面切后台立刻省电暂停（实测 AbortError，手表黑屏）。
        bot.gain = bot.ac.createGain();
        bot.gain.gain.value = bot.muted ? 0 : 1;
        src.connect(bot.gain);
        bot.gain.connect(dest);
        // 故意不接 ac.destination：本地不播放，避免通话里回声
        // 没有用户手势时 AudioContext 会是 suspended（音频全是静音），
        // 尽量 resume 一次并把状态回报上去，方便判断"手表没声音"是这条链路的事
        resumeAudio();
        var track = dest.stream.getAudioTracks()[0];
        if (!track) return null;
        bot.aTrack = AgoraRTC.createCustomAudioTrack({ mediaStreamTrack: track });
        return bot.aTrack;
      } catch (e) {
        rtcReport('B站音频轨道创建失败 ' + (e && e.message));
        return null;
      }
    }

    // 静音只动 gain，不动元素的 muted（原因见上）
    function setBotMuted(on){
      bot.muted = !!on;
      if (bot.gain) {
        try { bot.gain.gain.value = on ? 0 : 1; } catch (e) { /* ignore */ }
      }
    }

    function resumeAudio(){
      if (!bot.ac) return;
      var st = bot.ac.state;
      if (st === 'running') return;
      Promise.resolve(bot.ac.resume()).then(function () {
        rtcReport('AudioContext ' + st + ' → ' + bot.ac.state);
      }).catch(function (e) {
        rtcReport('AudioContext 恢复失败 ' + st + ' ' + (e && e.message));
      });
    }

    // 用户第一次碰页面时把 AudioContext 解开（浏览器只认手势）
    ['click', 'keydown', 'touchstart'].forEach(function (ev) {
      document.addEventListener(ev, function once() {
        resumeAudio();
        ['click', 'keydown', 'touchstart'].forEach(function (e2) {
          document.removeEventListener(e2, once);
        });
      }, { passive: true });
    });

    // 进通话就先把「帮助菜单」推给手表 —— 原版接通后也是这个画面，
    // 既是"自动接听成功"的视觉确认，也是给手表那边看的指令说明。
    // 复用 B站那套 canvas / 轨道，开始播时只换画面内容，不用重新抢视频位。
    //
    // ⚠️ 顺序很关键：`canvas.captureStream()` 只捕获**创建之后**的绘制。
    // 先画再建轨道 = 编码器一帧都收不到 = 手表黑屏（2026-11-18 踩过）。
    // 所以必须 botTrack() 先建、之后才由 botRender 持续画。
    function botStandby(){
      botInit();
      bot.mode = 'help';
      bot.helpPage = 0;
      bot.title = '';
      bot.subtitle = '';
      botTrack();
      botKick();            // 画第一帧并把它挂进循环（菜单页也持续出帧）
      botPublish();
    }

    // canvas → Agora 自定义视频轨道。只建一次，播放/待机共用同一个视频位。
    function botTrack(){
      botInit();
      if (bot.vTrack) return bot.vTrack;
      // 优先 canvas 合成（能画 HUD/弹幕）；老浏览器不支持就退化成裸视频
      var stream = bot.canvas.captureStream
        ? bot.canvas.captureStream(BOT_FPS)
        : bot.video.captureStream();
      bot.vTrack = AgoraRTC.createCustomVideoTrack({ mediaStreamTrack: stream.getVideoTracks()[0] });
      // 不配编码参数的话走 SDK 默认（640×360/大码率），我们喂的是 240×320 的小画布，
      // 编码器会一直报 SEND_VIDEO_BITRATE_TOO_LOW（1003），手表那头也可能收不到有效帧
      try {
        if (bot.vTrack.setEncoderConfiguration) {
          bot.vTrack.setEncoderConfiguration({
            width: BOT_W, height: BOT_H, frameRate: 15,
            bitrateMin: 150, bitrateMax: 600
          });
        }
      } catch (e) { rtcReport('设置编码参数失败 ' + (e && e.message)); }
      return bot.vTrack;
    }

    async function botPublish(){
      if (!rtc.client || !rtc.joined) { toast('还没入房', true); return; }
      try {
        botTrack();
        await rtcSingleVideo('bot');
        // 已经推上去的就别再 publish 一次，Agora 会报 TRACK_IS_PUBLISHING
        var list = [];
        if (!bot.pubV) list.push(bot.vTrack);
        // 还没播视频时不带音频：那时建出来的是一条永远静音的轨道
        if (!bot.pubA && bot.video && bot.video.getAttribute('src')) {
          var a = botAudioTrack();
          if (a) list.push(a);
        }
        if (!list.length) { bot.started = true; return; }
        await rtc.client.publish(list);
        for (var i = 0; i < list.length; i++) {
          if (list[i] === bot.vTrack) bot.pubV = true;
          else bot.pubA = true;
        }
        bot.started = true;
        rtcReport('推流已发布 ' + (bot.mode === 'video' ? (bot.bvid || '?') : bot.mode)
          + ' 轨道数=' + list.length);
        // 一次性自检：3 秒后回报轨道状态。手表黑屏时靠这条区分
        // "编码器没出帧" 还是 "手表没订阅"。
        if (!bot.selfCheck) {
          bot.selfCheck = true;
          setTimeout(function () {
            var t = bot.vTrack && bot.vTrack.getMediaStreamTrack
              ? bot.vTrack.getMediaStreamTrack() : null;
            rtcReport('画面自检 画布=' + BOT_W + 'x' + BOT_H
              + ' 轨道=' + (t ? t.readyState : '无')
              + ' 模式=' + bot.mode + ' 已推视频=' + bot.pubV);
          }, 3000);
        }
      } catch (e) {
        rtcReport('推流发布失败 ' + (e && e.message));
        toast('推流失败：' + ((e && e.message) || e), true);
      }
    }

    async function botPlay(bvid){
      if (!rtc.joined) { toast('先接通再播', true); return; }
      botInit();
      var els = botEls();
      if (els.btnSearch) els.btnSearch.disabled = true;
      try {
        var info = await api('/api/bili/info?bvid=' + encodeURIComponent(bvid));
        bot.bvid = info.bvid;
        bot.cid = info.cid;
        bot.title = info.title || bvid;
        bot.owner = info.owner || '';
        bot.duration = Number(info.duration) || 0;
        bot.dmIdx = 0;
        bot.actives = [];
        bot.danmaku = [];
        bot.subtitle = '';
        if (els.now) els.now.textContent = '正在缓冲：' + bot.title;
        // 弹幕异步拉，拉不到不影响播放
        api('/api/bili/danmaku?cid=' + encodeURIComponent(info.cid)).then(function (r) {
          bot.danmaku = (r && r.list) || [];
          bot.dmIdx = 0;
          rtcReport('弹幕已加载 ' + bot.danmaku.length + ' 条');
        }).catch(function () { /* 没弹幕也能看 */ });

        // —— 起播策略 ——
        // Chrome 的省电规则：页面不可见 + 媒体"只有画面没有声音" → 直接暂停
        // （AbortError: video-only background media was paused to save power）。
        // 我们恰恰长期在后台跑，所以不能用 muted 起播：
        //   1) 先把 WebAudio 图建起来（声音只进 WebRTC，不接扬声器，本地还是静默）
        //   2) 让元素保持 muted=false 起播 —— 对 Chrome 这是"有音频的媒体"，不会被省电暂停
        //   3) 用户说「静音」时把 gain 打到 0，元素仍然不算静音
        var audioOk = !!botAudioTrack();
        bot.video.loop = true;          // 原版放完会 seekTo(0) 循环，手表那头别停在最后一帧
        bot.video.muted = !audioOk;     // 音频图建不出来才退回静音，避免真外放
        bot.video.src = '/api/bili/stream?bvid=' + encodeURIComponent(info.bvid)
          + '&cid=' + encodeURIComponent(info.cid);
        try {
          await bot.video.play();
        } catch (e) {
          // 没有用户手势时带声音的 play 会被拒（NotAllowedError）→ 退回静音再来一次。
          // 静音起播在后台会被省电暂停，但前台还能看；起播成功后再靠看门狗拉回来。
          rtcReport('带声音起播被拒 name=' + (e && e.name) + '，退回静音重试');
          bot.video.muted = true;
          await bot.video.play();
        }
        if (audioOk) setBotMuted(bot.muted);   // 应用用户的静音设置（改 gain）
        bot.userPaused = false;
        bot.mode = 'video';
        botKick();
        await botPublish();
        rtcReport('开始播放 ' + bot.bvid + ' 画面=' + bot.video.videoWidth + 'x' + bot.video.videoHeight
          + ' 已推视频=' + bot.pubV);
        if (els.now) {
          els.now.textContent = '正在播放：' + bot.title + (info.owner ? ' · ' + info.owner : '');
        }
        if (els.btnPause) els.btnPause.textContent = '暂停';
      } catch (e) {
        rtcReport('播放失败 ' + (e && e.message));
        toast('播放失败：' + ((e && e.message) || e), true);
      } finally {
        if (els.btnSearch) els.btnSearch.disabled = false;
      }
    }

    function botEls(){
      return {
        box: $('#callBot'), kw: $('#botKw'), list: $('#botList'), now: $('#botNow'),
        btnSearch: $('#botSearch'), btnPause: $('#botPause'), btnNext: $('#botPage'),
        btnHelp: $('#botHelp'),
        btnDm: $('#botDm'), btnMute: $('#botMute')
      };
    }

    function botRenderList(){
      var els = botEls();
      if (!els.list) return;
      if (!bot.list.length) { els.list.hidden = true; els.list.innerHTML = ''; return; }
      els.list.hidden = false;
      els.list.innerHTML = bot.list.map(function (it, i) {
        var t = String(it.title || it.bvid || '');
        if (t.length > 34) t = t.slice(0, 34) + '…';
        var sub = [it.author, it.duration ? fmtDur(Number(it.duration) * 1000) : '']
          .filter(Boolean).join(' · ');
        return '<button class="call-bot-item" data-i="' + i + '" type="button">'
          + '<b>' + (i + 1) + '.</b>' + esc(t)
          + (sub ? '<br><span>' + esc(sub) + '</span>' : '') + '</button>';
      }).join('');
      Array.prototype.forEach.call(els.list.querySelectorAll('.call-bot-item'), function (b) {
        b.onclick = function () {
          var i = Number(b.getAttribute('data-i'));
          bot.idx = i;
          var it = bot.list[i];
          if (it) botPlay(it.bvid);
        };
      });
    }

    // 搜索：照原版的流程 —— **只出列表，不自动播**，等用户说「播放 1」。
    // 直接填 BV 号是网页面板上的快捷方式，那种才跳搜索。
    async function botSearch(){
      var els = botEls();
      var kw = ((els.kw && els.kw.value) || '').trim();
      if (!kw) return;
      bot.kw = kw;
      if (/^BV[0-9A-Za-z]{8,12}$/.test(kw)) {
        bot.list = [{ bvid: kw, title: kw }];
        bot.idx = 0;
        bot.listPage = 0;
        botRenderList();
        return botPlay(kw);
      }
      // 先把"正在搜索"这一屏推上去，别让手表停在上一个画面
      bot.mode = 'list';
      bot.list = [];
      bot.listPage = 0;
      bot.searchStatus = '正在搜索「' + kw + '」…';
      botKick();
      if (els.btnSearch) els.btnSearch.disabled = true;
      try {
        var r = await api('/api/bili/search?kw=' + encodeURIComponent(kw));
        bot.list = (r && r.list) || [];
        bot.idx = -1;
        bot.listPage = 0;
        bot.searchStatus = '';
        botRenderList();
        if (els.now) els.now.textContent = '搜到 ' + bot.list.length + ' 个，说「播放 1」或点一个';
        rtcReport('搜索「' + kw + '」→ ' + bot.list.length + ' 条');
      } catch (e) {
        bot.searchStatus = '搜索失败：' + ((e && e.message) || e);
        toast('搜索失败：' + ((e && e.message) || e), true);
      } finally {
        if (els.btnSearch) els.btnSearch.disabled = false;
      }
    }

    // 说「播放 N」时 N 是**当前页内**的 1..3，映射到总列表（和原版 playByIndex 一致）
    async function botPlayIndex(n){
      var gi = bot.listPage * PER_PAGE + (Number(n) - 1);
      if (!bot.list.length) { toast('先搜一个', true); return; }
      var it = bot.list[gi];
      if (!it) { toast('这一页没有第 ' + n + ' 个', true); return; }
      bot.idx = gi;
      await botPlay(it.bvid);
    }

    // 翻搜索结果页（到头回到第一页，别让手表卡在最后一页）
    function botNextPage(){
      var pages = Math.max(1, Math.ceil(bot.list.length / PER_PAGE));
      bot.listPage = (bot.listPage + 1) % pages;
      rtcReport('结果翻页 → 第 ' + (bot.listPage + 1) + '/' + pages + ' 页');
    }

    // 翻帮助菜单页
    function botNextHelp(){
      bot.helpPage = (bot.helpPage + 1) % HELP_PAGES.length;
    }

    // 回到帮助菜单（原版说"返回"就是回这里）。
    // 顺手把视频暂停：画面都切走了，声音还在放会让人以为坏了。
    // 再说「播放 / 继续」会切回视频接着放（见 runVoiceCommand 最后一条）。
    function botShowHelp(){
      bot.mode = 'help';
      bot.subtitle = '';
      bot.userPaused = true;      // 主动暂停，别让看门狗又拉起来
      try { if (bot.video && !bot.video.paused) bot.video.pause(); } catch (e) {}
      refreshMiniBtns();
      botKick();
    }

    async function botStop(){
      if (bot.raf) { cancelAnimationFrame(bot.raf); bot.raf = 0; }
      if (bot.hiddenTimer) { clearTimeout(bot.hiddenTimer); bot.hiddenTimer = 0; }
      // 必须先从频道里撤掉，再 close：不然视频位一直被占着，
      // 下次想推摄像头会继续报 CAN_NOT_PUBLISH_MULTIPLE_VIDEO_TRACKS
      if (rtc.client && (bot.vTrack || bot.aTrack)) {
        try { await rtc.client.unpublish([bot.vTrack, bot.aTrack].filter(Boolean)); } catch (e) { /* ignore */ }
      }
      try { if (bot.video) { bot.video.pause(); bot.video.removeAttribute('src'); bot.video.load(); } } catch (e) {}
      try { if (bot.vTrack) bot.vTrack.close(); } catch (e) {}
      try { if (bot.aTrack) bot.aTrack.close(); } catch (e) {}
      try { if (bot.ac) bot.ac.close(); } catch (e) {}
      bot.vTrack = null;
      bot.aTrack = null;
      bot.ac = null;
      bot.pubV = false;
      bot.pubA = false;
      bot.started = false;
      bot.mode = 'idle';
      bot.userPaused = false;
      bot.gain = null;
      bot.selfCheck = false;      // 下一通还要再自检一次
      bot.actives = [];
      bot.dmIdx = 0;
      var els = botEls();
      if (els.now) els.now.textContent = '';
      if (els.list) { els.list.hidden = true; els.list.innerHTML = ''; }
    }


    // ===== 语音指令（ASR → 指令）=====
    // 语音识别是服务端字幕机器人做的，结果通过 Agora 数据流推过来：
    //   client.on('stream-message', (uid, data)) → protobuf.Text
    // Text: data_type=13("transcribe")、words=10(重复)；Word: text=1、is_final=4
    var voice = { pubBotUid: '', remoteUid: 0, buf: '', req: false, hangAt: 0, on: false,
      timer: 0, tries: 0, last: '', lastAt: 0, gotFrame: false, awaitKw: 0 };
    // 当前这通电话对应的那块表是否开了「视频通话 B站 bot」。
    // 由 show() 从 status().bot.enabled 写入，hide() 清掉。
    var botWant = false;

    // ===== 单页面保护 =====
    // 两个标签页同时开着时，两边都会去入 Agora（同一个 uid 互相踢）、
    // 各自叫一个字幕任务，日志里每条都出现两遍。实测过一轮：4 个 task、pubBotUid 一路涨。
    // 用 localStorage 抢一个带 8 秒有效期的"主控"名额，抢不到的那个页面只显示通话界面，
    // 不驱动推流和语音。标签页关掉后 8 秒自动释放。
    var LEADER_KEY = 'jzBotLeader';
    var myId = Math.random().toString(36).slice(2, 8);
    // 服务端起的无头页面带 autorun=1：它是"官方"那个页面，用户浏览器要给它让位
    var AUTORUN = /[?&]autorun=1/.test(location.search);
    // 让服务端日志能确认"无头页面确实是以 autorun 身份起来的"
    if (AUTORUN) setTimeout(function () {
      try { rtcReport('autorun 页面已加载，将强制接管媒体面'); } catch (e) { /* ignore */ }
    }, 800);

    function isLeader(){
      if (AUTORUN) {
        try { localStorage.setItem(LEADER_KEY, myId + '|' + Date.now()); } catch (e) { /* ignore */ }
        return true;
      }
      try {
        var raw = String(localStorage.getItem(LEADER_KEY) || '');
        var parts = raw.split('|');
        var id = parts[0];
        var at = Number(parts[1] || 0);
        if (id && id !== myId && Date.now() - at < 8000) return false;
        localStorage.setItem(LEADER_KEY, myId + '|' + Date.now());
        return true;
      } catch (e) {
        return true;    // 隐私模式没有 localStorage，退回"不限制"
      }
    }

    function dropLeader(){
      try {
        var raw = String(localStorage.getItem(LEADER_KEY) || '');
        if (raw.split('|')[0] === myId) localStorage.removeItem(LEADER_KEY);
      } catch (e) { /* ignore */ }
    }

    // 认一下这个人是谁：
    //   字幕机器人 = 只发数据流、不发音视频，uid 等于 pubBotUid
    //   自己 = 入房时用的 uid
    //   剩下的就是手表。remoteUid 只有手表才配得上（字幕任务要它当 subScribeId）
    function pickRemote(u){
      if (!u || u.uid == null) return;
      var id = String(u.uid);
      if (voice.pubBotUid && id === voice.pubBotUid) return;
      if (rtc.uid != null && id === String(rtc.uid)) return;
      if (voice.remoteUid && String(voice.remoteUid) === id) return;
      voice.remoteUid = u.uid;
      rtcReport('认出手表 uid=' + id);
      voiceTryStart();
    }

    // 等拿到手表 uid 再叫字幕机器人（没 uid 叫了也白叫 —— 这句是旧逻辑，
    // 现在 subScribeId 用 watchId，不再依赖 uid，所以这里直接放行）
    function voiceTryStart(){
      if (!botWant || voice.on || voice.timer) return;
      voice.timer = setTimeout(function () {
        voice.timer = 0;
        ensureVoice(voice.remoteUid);
      }, 400);
    }

    // 极简 protobuf 读取（只覆盖这两条消息，零依赖）
    function pbVarint(b, o){
      var v = 0, s = 0, x;
      do { x = b[o.i++]; v += (x & 0x7f) * Math.pow(2, s); s += 7; } while ((x & 0x80) && o.i < b.length);
      return v;
    }
    function pbScan(buf, cb){
      var o = { i: 0 };
      while (o.i < buf.length) {
        var key = pbVarint(buf, o);
        var f = key >> 3, w = key & 7;
        if (w === 2) { var len = pbVarint(buf, o); cb(f, buf.subarray(o.i, o.i + len)); o.i += len; }
        else if (w === 0) { cb(f, pbVarint(buf, o)); }
        else if (w === 5) { o.i += 4; }
        else if (w === 1) { o.i += 8; }
        else break;
      }
    }
    function pbText(b){ try { return new TextDecoder().decode(b); } catch (e) { return ''; } }
    function parseCaption(buf){
      var out = { dataType: '', words: [], end: false };
      pbScan(buf, function (f, v) {
        if (f === 13 && typeof v !== 'number') { out.dataType = pbText(v); return; }
        // end_of_segment=1：这一句说完了，比"没有未定词"更准
        if (f === 11 && typeof v === 'number') { out.end = !!v; return; }
        if (f !== 10 || typeof v === 'number') return;
        var w = { text: '', final: false };
        pbScan(v, function (f2, v2) {
          if (f2 === 1 && typeof v2 !== 'number') w.text = pbText(v2);
          else if (f2 === 4) w.final = !!v2;
        });
        if (w.text) out.words.push(w);
      });
      return out;
    }

    // 中文数字 → 数字（「第三个」「第八个」这类）
    function cnNum(x){
      var m = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
      if (/^\d+$/.test(x)) return Number(x);
      if (x === '十') return 10;
      if (x.length === 1) return m[x] || 0;
      if (x[0] === '十') return 10 + (m[x[1]] || 0);
      if (x[1] === '十') return (m[x[0]] || 0) * 10 + (m[x[2]] || 0);
      return 0;
    }

    function refreshMiniBtns(){
      var e = botEls();
      if (e.btnDm) e.btnDm.textContent = '弹幕 ' + (bot.dmOn ? '开' : '关');
      if (e.btnMute) e.btnMute.textContent = '声音 ' + (bot.muted ? '关' : '开');
      if (e.btnPause) e.btnPause.textContent = (bot.video && bot.video.paused) ? '继续' : '暂停';
    }

    // 指令解析：照搬 Xposed 版 VoiceControlHook 的规则顺序
    // 指令解析。顺序照抄 VoiceControlHook.handleCommand：
    // 先处理"会互相截胡"的（静音 vs 取消静音、关闭弹幕 vs 打开弹幕、返回 vs 播放），
    // 最后才是宽泛的「暂停/播放」。顺序错了就是一堆玄学。
    async function runVoiceCommand(raw, fin){
      var t = String(raw || '').replace(/[，。！？、,.!?~]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) return;
      rtcReport('语音指令: ' + t.slice(0, 60));
      // 原版把每个词都回显到画面底部，这里也留一手：用户能看见系统听到了什么
      bot.subtitle = t;
      bot.subAt = Date.now();

      // 1. 静音组（必须先判否定）
      if (/取消静音|关闭静音|解除静音|恢复声音|打开声音/.test(t)) {
        setBotMuted(false);
        refreshMiniBtns(); toast('已取消静音'); return;
      }
      if (/静音/.test(t)) {
        setBotMuted(true);
        refreshMiniBtns(); toast('已静音'); return;
      }

      // 2. 返回帮助（"返回"/"回帮助"/"回到帮助"）
      if (/返回|回帮助|回到帮助/.test(t)) {
        botShowHelp();
        toast('已返回帮助'); return;
      }

      // 3. 挂断：必须说两遍，10 秒内有效（防误触）
      if (/挂断|挂掉|挂蛋/.test(t)) {
        if (voice.hangAt && Date.now() - voice.hangAt < 10000) {
          voice.hangAt = 0;
          toast('确认挂断');
          post('hangup');
        } else {
          voice.hangAt = Date.now();
          toast('再说一次「挂断」确认', true);
        }
        return;
      }

      // 4. 搜索：「搜索 xxx」/「搜 xxx」→ 出列表（不自动播）
      var si = t.indexOf('搜索');
      var sl = 2;
      if (si < 0) { si = t.indexOf('搜'); sl = 1; }
      if (si >= 0) {
        var kw = cleanKeyword(t.slice(si + sl));
        if (kw) {
          voice.awaitKw = 0;
          var e1 = botEls();
          if (e1.kw) e1.kw.value = kw;
          await botSearch();
        } else {
          // ASR 常在"搜索"和关键词之间断句，先记下来，下一句直接当关键词用
          voice.awaitKw = Date.now();
          toast('搜索什么？', true);
        }
        return;
      }
      // 4b. 上一句只说了「搜索」，这一句就是关键词
      if (voice.awaitKw && Date.now() - voice.awaitKw < 8000) {
        voice.awaitKw = 0;
        var kw2 = cleanKeyword(t);
        if (kw2) {
          var e2 = botEls();
          if (e2.kw) e2.kw.value = kw2;
          await botSearch();
          return;
        }
      }

      // 5. 弹幕开关（先判"关"，否则"关闭弹幕"会被"打开"类规则吃掉）
      if (/关闭弹幕|关弹幕|关掉弹幕|不要弹幕|别弹幕/.test(t)) {
        bot.dmOn = false; refreshMiniBtns(); toast('弹幕已关'); return;
      }
      if (/打开弹幕|开弹幕|开启弹幕|显示弹幕|来点弹幕/.test(t)) {
        bot.dmOn = true; refreshMiniBtns(); toast('弹幕已开'); return;
      }

      // 6. 显示比例（原版默认拉伸，说"原比例"切等比）
      if (/原比例|原始比例/.test(t)) {
        bot.aspect = true; toast('原比例显示'); return;
      }
      if (/恢复拉伸|显示拉伸|全屏显示|拉伸显示|铺满/.test(t)) {
        bot.aspect = false; toast('拉伸铺满'); return;
      }

      // 7. 翻页：在列表里翻搜索结果，否则翻帮助菜单
      if (/翻页|下一页|第二页|上一页/.test(t)) {
        if (bot.mode === 'list') {
          botNextPage();
          toast('第 ' + (bot.listPage + 1) + ' 页');
        } else {
          botNextHelp();
          toast(HELP_PAGES[bot.helpPage].title);
        }
        return;
      }

      // 8. 播放 N / 看第 N 个（N 是当前页的 1..3）
      //    也接受"裸序号"：ASR 经常把「第二个」断成单独一个「二」，不带动词
      var n = parsePlayIndex(t);
      if (n < 0 && bot.mode === 'list' && /^(第)?\s*[一二三四五六七八九十两\d]+\s*个?$/.test(t)) {
        n = parsePlayIndex('播放' + t);
      }
      if (n > 0) {
        await botPlayIndex(n);
        return;
      }
      // 8b. 列表页只说「播放」→ 播第一个（列表页本来就没在放，没有"继续"可言）
      if (/^播放$|^开始播放$|^放吧$/.test(t) && bot.mode === 'list') {
        await botPlayIndex(1);
        return;
      }

      // 9. 暂停
      if (/暂停|停一下|别放了/.test(t)) {
        bot.userPaused = true;
        if (bot.video) bot.video.pause();
        refreshMiniBtns(); toast('已暂停'); return;
      }
      // 10. 播放 / 继续
      if (/继续|接着放|恢复播放|播放|开始/.test(t)) {
        if (!bot.video || !bot.video.getAttribute('src')) { toast('先说「搜索 关键词」', true); return; }
        if (bot.video.paused) {
          bot.mode = 'video';
          bot.userPaused = false;
          botKick();
          bot.video.play();
          refreshMiniBtns(); toast('继续播放');
        } else {
          toast('正在播放');
        }
        return;
      }

      // 没命中任何指令：只记录，不乱搜
      rtcReport('未识别的指令: ' + t.slice(0, 40));
    }

    // 关键词清洗。ASR 出来的原句经常带口语："帮我搜一下小猪佩奇吧"。
    // 直接拿去搜 B 站也能搜到，但结果会偏 —— 而且关键词会显示在日志/画面上。
    function cleanKeyword(s){
      var k = String(s || '').replace(/[，。！？、,.!?~]/g, ' ').replace(/\s+/g, ' ').trim();
      var pre = /^(帮我|给我|麻烦|请|一下|找找|搜搜|搜索|搜)/;
      var suf = /(吧|呢|啊|呀|哦|啦|谢谢|谢了|好吗|可以吗|行吗|好不好)$/;
      for (var i = 0; i < 3 && pre.test(k); i++) k = k.replace(pre, '').trim();
      for (var j = 0; j < 3 && suf.test(k); j++) k = k.replace(suf, '').trim();
      if (k.length > 40) k = k.slice(0, 40);   // 长了只会搜出一堆无关结果
      return k;
    }

    // 「播放 3」「看第三个」「播 2」→ 3 / 3 / 2（和原版 parsePlayIndex 一致：
    // 必须带动词，然后先找阿拉伯数字，再找中文数字）
    function parsePlayIndex(cmd){
      if (!/播放|播|看|放/.test(cmd)) return -1;
      var m = cmd.match(/(\d+)/);
      if (m) { var v = Number(m[1]); if (v > 0) return v; }
      if (/两/.test(cmd)) return 2;
      var cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
      for (var i = 0; i < cn.length; i++) {
        if (cmd.indexOf(cn[i]) >= 0) return i + 1;
      }
      return -1;
    }

    // 收一帧字幕。每一帧带的是"这一句到目前为止"的全部词，所以 final 词直接拼起来
    // 就是当前整句（覆盖，不是追加 —— 追加会把「搜索 乌龟」变成「搜索 乌龟乌龟」）。
    function onCaptionFrame(buf){
      var t;
      try { t = parseCaption(buf); } catch (e) { return; }
      if (!voice.gotFrame) {
        // 第一帧一定要记下来：数据流到底有没有来，是这条链路最容易卡住的地方
        voice.gotFrame = true;
        rtcReport('收到第一帧字幕 字节=' + (buf.length || 0) + ' 词数=' + t.words.length
          + ' dataType=' + t.dataType);
      }
      if (t.dataType && t.dataType !== 'transcribe') return;
      var finals = '', partial = '';
      for (var i = 0; i < t.words.length; i++) {
        if (t.words[i].final) finals += t.words[i].text;
        else partial += t.words[i].text;
      }
      if (!finals) return;                 // 还全是半截词，等
      voice.buf = finals;
      // 一句话说完：有明确的 end 标记，或者后面没有待定词了
      if (!t.end && partial) return;
      var cmd = voice.buf;
      voice.buf = '';
      // 同一句连续推送会重复触发，3 秒内相同文本只执行一次
      if (cmd === voice.last && Date.now() - voice.lastAt < 3000) return;
      voice.last = cmd;
      voice.lastAt = Date.now();
      Promise.resolve(runVoiceCommand(cmd, true)).catch(function (e) {
        rtcReport('指令执行异常 ' + (e && e.message));
      });
    }

    // 启动字幕任务（服务端去叫字幕机器人，返回它的 uid）
    async function ensureVoice(uid){
      if (voice.req || voice.on) return;
      voice.req = true;
      try {
        var r = await api('/api/videocall/captions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: uid || voice.remoteUid || 0 }),
          timeout: 12000
        });
        if (r && r.pubBotUid) {
          voice.pubBotUid = String(r.pubBotUid);
          voice.on = true;
          voice.tries = 0;
          toast('语音点播已就绪，说「搜索 关键词」');
          rtcReport('字幕机器人 uid=' + r.pubBotUid + ' 转写 uid=' + (uid || voice.remoteUid));
        } else {
          throw new Error('没有 pubBotUid：' + JSON.stringify(r || {}).slice(0, 100));
        }
      } catch (e) {
        rtcReport('字幕接口失败（第 ' + (voice.tries + 1) + ' 次）' + (e && e.message));
        // 服务端偶尔要等手表那一路真正推流上来才肯建任务，退避重试几次
        voice.tries++;
        if (voice.tries <= 4 && botWant) {
          if (voice.timer) clearTimeout(voice.timer);
          voice.timer = setTimeout(function () {
            voice.timer = 0;
            ensureVoice(voice.remoteUid);
          }, 1500 * voice.tries);
        }
      } finally {
        voice.req = false;
      }
    }

    async function poll(){
      var st;
      try { st = await api('/api/videocall/status?b=' + encodeURIComponent(PAGE_BUILD), { timeout: 8000 }); }
      catch (e) { return; }   // 网络抖动时静默，别每次轮询都弹 toast
      if (!st) return;
      // 页面文件被改过（构建号对不上）→ 自己刷新，别让人对着一份旧 JS 排查。
      // 每个构建号只自动刷一次：万一中间有代理缓存，别刷成死循环。
      if (st.stale) {
        var key = 'jzStale:' + (st.build || '');
        try {
          if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, '1'); location.reload(); }
        } catch (e) { /* 隐私模式下 sessionStorage 可能不可用，忽略 */ }
        return;
      }
      if (st.phase === 'idle') {
        if (wasVisible) { hide(); wasVisible = false; }
        phase = 'idle';
        lastCallKey = '';
        ringed = false;
        return;
      }
      // ⚠️ 判据必须带上频道名：连着来两通电话时，第二通应答后 phase 还是 talking，
      // 只看 phase 会认为"没变化"，于是页面不重新入房，还挂在上一通的旧频道里
      // → 手表在新频道里看不到人，一直显示"接通中"（2026-11-18 实测）。
      var callKey = st.phase + '|' + ((st.call && st.call.channelName) || '');
      if (callKey !== lastCallKey) {
        lastCallKey = callKey;
        phase = st.phase;
        show(st);
        if (st.phase === 'ringing' && !ringed) {
          ringed = true;
          // 开了 bot 的表来电会被自动接听，响铃纯属噪音 —— 用户要的是"后台静默接通"
          if (!(st.bot && st.bot.enabled)) {
            try { ring(); } catch (e) { /* 浏览器策略可能拒绝，忽略 */ }
          }
        }
      } else if (st.phase === 'talking') {
        paintTimer();
      }
      // 通话中续租：不续的话 8 秒后会过期，别的标签页就能抢走。
      // 如果这时发现名额已经被别人（通常是服务端起的无头页面）拿走，
      // 本页必须立刻退出媒体面 —— 同一个 Agora uid 两边一起推，会互相踢出房间。
      if (botWant) {
        if (!isLeader()) {
          botWant = false;
          quietMode = false;
          try { leaveRtc(); } catch (e) { /* ignore */ }
          try { botStop(); } catch (e) { /* ignore */ }
          toast('已由后台页面接管这通电话');
          rtcReport('本页让位：另一个页面（可能是无头页面）已接管');
          return;
        }
      }
      wasVisible = true;
    }

    setInterval(poll, 1500);
    poll();
  }

  // ---------- 挂载 ----------
  // React bundle 先渲染自己的东西，我们在 body 末尾追加浮层。
  // 通话浮层是 position:fixed + z-index:9000，天然盖在最上层。
  //
  // ⚠️ 页面里已经放了一个空的 <div id="jzCallRoot"></div> 当挂载点，
  // 所以**不能用「容器存在」判断是不是挂过了** —— 那样永远都会提前 return，
  // 表现是浮层根本不出现（2026-11-19 踩过）。用容器上的 data-mounted 标记。
  function mount() {
    var root = document.getElementById('jzCallRoot');
    if (root && root.getAttribute('data-mounted') === '1') return;   // 真·已经挂过

    if (!root) {
      root = document.createElement('div');
      root.id = 'jzCallRoot';
      document.body.appendChild(root);
    }

    var st = document.createElement('style');
    st.id = 'jzCallCss';
    st.textContent = CSS + EXTRA_CSS;
    document.head.appendChild(st);

    root.innerHTML = HTML;
    root.setAttribute('data-mounted', '1');

    startCallUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
