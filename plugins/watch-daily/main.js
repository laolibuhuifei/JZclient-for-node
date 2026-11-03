// 手表日报 —— 示例插件
//
// 这个插件把「插件能干什么」基本演了一遍：
//   - 定时任务（每天一个时间点）
//   - 读手表列表 / 位置
//   - 往微聊发消息
//   - 接聊天消息里的命令
//   - 给外部管理界面开 HTTP 接口
//   - 读写自己的配置
//
// 想照着写自己的插件的话，重点看 module.exports 里那几个钩子函数的签名。
'use strict';

// 模块级变量跟着插件实例活。重载插件时整个文件会重新执行一遍，
// 所以不用怕这里的值残留 —— 但 onUnload 里该清的还是要清。
let timer = null;

// 每天定时发一份
function schedule(jz) {
  if (timer) jz.timers.clear(timer);
  const at = String(jz.config.get('time') || '08:00');
  if (!/^\d{1,2}:\d{2}$/.test(at)) {
    jz.log.warn('发送时间「' + at + '」格式不对，跳过定时任务（要像 08:00 这样）');
    timer = null;
    return;
  }
  timer = jz.timers.daily(at, async () => {
    const r = await sendDaily(jz);
    jz.log.info('定时日报：' + (r.ok ? '已发送' : '跳过（' + r.error + '）'));
  });
  jz.log.info('定时任务已排好：每天 ' + at);
}

// 目标会话：优先用界面上选的；没选就退到第一个单聊（家庭群不优先，群里刷屏太吵）
async function pickTarget(jz) {
  const saved = String(jz.store.get('targetKey', '') || '');
  const targets = await jz.chat.targets();
  if (saved && targets.some((t) => t.key === saved)) return saved;
  const first = targets.find((t) => t.type === 'single') || targets[0];
  return first ? first.key : '';
}

function fmtBattery(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '电量未知';
  return '电量 ' + Math.round(n) + '%';
}

function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || !n) return '';
  const d = new Date(n < 1e12 ? n * 1000 : n);
  const p = (x) => String(x).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 汇总 + 发送。key 传了就往那个会话发，不传就按配置挑
async function sendDaily(jz, key) {
  const target = key || (await pickTarget(jz));
  if (!target) return { ok: false, error: '还没有可用的会话，先在管理界面里选一个' };

  const watches = await jz.watches.list();
  if (!watches.length) return { ok: false, error: '没有已绑定的手表' };

  const wantBattery = jz.config.get('includeBattery') !== false;
  const wantLoc = jz.config.get('includeLocation') !== false;

  const lines = [];
  for (const w of watches) {
    const bits = [];
    if (wantBattery) bits.push(fmtBattery(w.battery));
    bits.push(w.online === false ? '离线' : '在线');

    if (wantLoc) {
      // 定位是单独一个接口，而且经常慢或者没数据 —— 单块表失败不能拖垮整条日报
      try {
        const loc = await jz.watches.location(w.watchId);
        if (loc && loc.address) {
          bits.push(loc.address + (loc.time ? '（' + fmtTime(loc.time) + '）' : ''));
        } else {
          bits.push('暂无定位');
        }
      } catch (e) {
        bits.push('定位获取失败');
      }
    }
    lines.push('· ' + (w.name || w.watchId) + '：' + bits.join(' · '));
  }

  const text = (String(jz.config.get('prefix') || '今天的日报来了')).trim() + '\n' + lines.join('\n');
  await jz.chat.send({ key: target, kind: 'text', text });
  return { ok: true, key: target, text };
}

// 管理界面要的数据：手表现状 + 会话列表 + 配置 + 上次发送时间
async function snapshot(jz) {
  const [watches, targets] = await Promise.all([
    jz.watches.list().catch(() => []),
    jz.chat.targets().catch(() => []),
  ]);
  return {
    watches: watches.map((w) => ({
      watchId: String(w.watchId),
      name: w.name || '',
      model: w.model || '',
      battery: w.battery == null ? null : Number(w.battery),
      online: w.online !== false,
      lastLocation: w.lastLocation || null,
    })),
    targets: targets.map((t) => ({ key: t.key, type: t.type, name: t.name, sub: t.sub || '' })),
    config: jz.config.all(),
    targetKey: String(jz.store.get('targetKey', '') || ''),
    lastSentAt: Number(jz.store.get('lastSentAt', 0)) || 0,
    lastText: String(jz.store.get('lastText', '') || ''),
  };
}

module.exports = {
  // 插件被启用 / 程序启动时调用。可以返回 Promise
  async onLoad(jz) {
    schedule(jz);
    jz.log.info('已启动，版本 ' + jz.info().version);
  },

  // 配置在界面上被改了
  onConfig(jz) {
    schedule(jz);
  },

  // 每收到一条手表 / 群消息都会进来。注意：这里要尽快返回，别做耗时的事，
  // 它会跟其他插件、AI 回复、OneBot 转发抢时间
  async onMessage(jz, msg) {
    const text = String(msg.text || '').trim();
    // 只认「日报」和「/日报」两种写法，别的消息一律不管
    if (!/^\/?(手表)?日报$/.test(text)) return;
    const r = await sendDaily(jz, msg.key);
    if (r.ok) {
      jz.store.set('lastSentAt', Date.now());
      jz.store.set('lastText', r.text);
    } else {
      jz.log.warn('孩子要日报没发出去：' + r.error);
    }
  },

  // 外部管理界面调的接口。路径是 /api/plugin/watch-daily/api/<下面这个 path>
  //   GET  /status  -> 页面初始化数据
  //   POST /send    -> 立刻发一份
  //   POST /save    -> 保存设置
  async onRequest(jz, req) {
    const p = req.path.replace(/^\/+/, '');

    if (req.method === 'GET' && (p === '' || p === 'status')) {
      return snapshot(jz);
    }

    if (req.method === 'POST' && p === 'send') {
      const r = await sendDaily(jz);
      if (r.ok) {
        jz.store.set('lastSentAt', Date.now());
        jz.store.set('lastText', r.text);
      }
      return Object.assign({ ok: r.ok, error: r.error || '' }, await snapshot(jz));
    }

    if (req.method === 'POST' && p === 'save') {
      const body = req.body || {};
      // 配置项走 jz.config，插件自己的额外状态（比如目标会话）走 jz.store
      const patch = {};
      ['time', 'prefix', 'includeBattery', 'includeLocation'].forEach((k) => {
        if (body[k] !== undefined) patch[k] = body[k];
      });
      if (Object.keys(patch).length) {
        // jz.config 没有批量接口，逐个设也一样（字段少，每次都落盘不心疼）
        Object.keys(patch).forEach((k) => jz.config.set(k, patch[k]));
      }
      if (body.targetKey !== undefined) jz.store.set('targetKey', String(body.targetKey || ''));
      schedule(jz);   // 时间可能改了，重排定时任务
      return { ok: true, config: jz.config.all(), targetKey: String(jz.store.get('targetKey', '') || '') };
    }

    throw new Error('没有这个接口: ' + req.method + ' /' + p);
  },

  onUnload(jz) {
    if (timer) jz.timers.clear(timer);
    timer = null;
  },
};
