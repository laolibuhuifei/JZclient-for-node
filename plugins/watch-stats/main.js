// 手表数据统计 —— 把每块手表的健康数据整理成一个自己的页面
//
// 数据来源（全部只读，只声明 watch.read 权限）：
//   getHealthHome   健康摘要（是一段段文本，步数这类指标只能从里面抠）
//   getSportHome    运动明细（时长 / 消耗 / 次数）
//   getSleepDetail  睡眠（按「前一天 18:00 → 当天 12:00」这个夜间窗口取）
//   getHeartRate    心率（按天）
//   getTemperature  体温（按天）
//
// 两个必须记住的坑：
//
//   1. api.js 的方法返回的是 { status, headers, text, json, raw }，
//      业务数据在 json.data 里，而且成功码是字符串 '000001'。
//      不拆这层信封就会拿到 undefined，页面上一片空白还找不到原因。
//
//   2. 插件处理一次 HTTP 请求只有 20 秒（plugin.js 里的 T.request）。
//      所以「最近几天」不能一次全拉 —— 7 天 × 5 个接口 = 35 次调用，
//      网络稍微慢一点就超时被掐断。这里按天拆成 GET /day?date=...，
//      让页面一天一天地要，拉到一天画一天，顺手把过去的日子缓存下来。
'use strict';

const DAY_MS = 86400000;

// ---------- 日期 ----------

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function todayStr() { return ymd(new Date()); }

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d : null;
}

function shiftDay(base, n) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
}

// ---------- 取值 ----------

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 字段名在不同机型/固件上会飘，挨个试
function firstOf(o, keys) {
  if (!o || typeof o !== 'object') return null;
  for (let i = 0; i < keys.length; i++) {
    const v = o[keys[i]];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function stripHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// 时长字段有的给秒、有的给分钟。1440 分钟正好是一天，超过这个数就按秒算
function asMinutes(v) {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return Math.round(n > 1440 ? n / 60 : n);
}

function setIfNull(obj, key, val) {
  if (obj[key] === null || obj[key] === undefined) {
    if (val !== null && val !== undefined) obj[key] = val;
  }
}

// ---------- 调平台接口 ----------

// jz.watches.read 拿到的是 api.js 的原始响应，这里统一拆信封
async function callApi(jz, method, args) {
  const raw = await jz.watches.read(method, ...args);
  const u = raw && raw.json ? raw.json : raw;
  if (!u || typeof u !== 'object') throw new Error('接口没有返回 JSON');
  const code = String(u.code === null || u.code === undefined ? '' : u.code);
  if (code !== '000001' && code !== '0' && code !== '200') {
    throw new Error(u.desc || u.msg || ('接口返回 ' + (code || '空响应')));
  }
  return u.data;
}

// 并发跑一组任务，最多同时 n 个。家长端接口不适合打太猛，n 给 3 就够
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  const n = Math.max(1, Math.min(limit || 1, items.length || 1));
  let next = 0;
  const workers = [];
  for (let k = 0; k < n; k++) {
    workers.push((async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

// ---------- 各数据源的解析 ----------

// 健康摘要：一段段中文，比如「今天走了 5231 步」「消耗 380 千卡」。
// 有结构化字段就用字段，没有就从文本里抠 —— 步数只有文本这一个来源。
function readSummary(home) {
  let list = [];
  if (Array.isArray(home)) list = home;
  else if (home && Array.isArray(home.healthHomeSummaryVos)) list = home.healthHomeSummaryVos;
  else if (home && Array.isArray(home.list)) list = home.list;

  const texts = [];
  const m = {};

  for (const it of list) {
    if (!it) continue;
    const text = stripHtml(firstOf(it, ['textV2', 'text', 'content', 'desc', 'title', 'name']));
    if (text) texts.push(text);
    // 结构化：{title/name, value, unit}
    const val = num(firstOf(it, ['value', 'num', 'count', 'number']));
    const unit = String(firstOf(it, ['unit', 'suffix']) || '');
    if (val !== null && (unit || text)) absorbText(m, (text ? text : '') + ' ' + val + ' ' + unit);
  }
  for (const t of texts) absorbText(m, t);
  return { texts, metrics: m };
}

// 从一句中文里抠指标。只认最稳的几种写法，抠不到就算了，别硬猜
function absorbText(m, text) {
  const t = String(text || '');
  if (!t) return m;
  let x;

  if (m.steps === undefined && (x = /(\d[\d,]*)\s*步/.exec(t))) {
    m.steps = num(x[1].replace(/,/g, ''));
  }
  if (m.calorie === undefined && (x = /(\d+(?:\.\d+)?)\s*(?:千卡|大卡|kcal|卡路里)/i.exec(t))) {
    m.calorie = num(x[1]);
  }
  if (m.distance === undefined && (x = /(\d+(?:\.\d+)?)\s*(?:公里|千米|km)/i.exec(t))) {
    m.distance = num(x[1]);
  }
  if (m.activeSec === undefined && (x = /(\d+(?:\.\d+)?)\s*(?:分钟|min)/i.exec(t))) {
    m.activeSec = Math.round(num(x[1]) * 60);
  }
  if (m.heartRateAvg === undefined && (x = /(\d{2,3})\s*(?:次\/分|次\/分钟|bpm)/i.exec(t))) {
    m.heartRateAvg = num(x[1]);
  }
  if (m.temperatureLast === undefined && (x = /(3[0-9]\.\d)\s*(?:℃|°C|度)/.exec(t))) {
    m.temperatureLast = num(x[1]);
  }
  return m;
}

// 运动：data 直接就是一个数组，每项是一个运动类型的累计
function readSport(data, out) {
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.list)) list = data.list;

  let sec = 0;
  let cal = 0;
  let cnt = 0;
  const items = [];

  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const seconds = num(firstOf(x, ['cumulativeTime', 'sportTime', 'duration', 'totalTime']));
    const calorie = num(firstOf(x, ['cumulativeCalorie', 'calorie', 'kcal', 'totalCalorie']));
    const count = num(firstOf(x, ['cumulativeCount', 'count', 'times', 'sportCount']));
    const name = String(firstOf(x, ['sportName', 'typeName', 'name', 'title']) || '');
    const type = firstOf(x, ['sportType', 'type']);
    if (seconds) sec += seconds;
    if (calorie) cal += calorie;
    if (count) cnt += count;
    items.push({
      type: type === null || type === undefined ? '' : String(type),
      name: name,
      seconds: seconds || 0,
      calorie: calorie || 0,
      count: count || 0,
    });
  }

  out.sport = items;
  if (items.length) {
    setIfNull(out.metrics, 'activeSec', sec ? Math.round(sec) : null);
    setIfNull(out.metrics, 'calorie', cal ? Math.round(cal) : null);
    setIfNull(out.metrics, 'sportCount', cnt || items.length);
  }
}

// 睡眠：顶层是 { topContent, sleepTime, deepSleepTime, ... }
function readSleep(data, out) {
  const d = data && typeof data === 'object' ? data : {};
  const s = num(firstOf(d, ['sleepStartTime', 'startTime', 'fallAsleepTime']));
  const e = num(firstOf(d, ['sleepEndTime', 'endTime', 'wakeUpTime']));

  // 起止时间都在就自己算总时长，比 sleepTime 字段靠谱（那个单位不固定）
  let total = null;
  if (s && e && e > s) {
    const ms = e > 1e12 ? e - s : (e - s) * 1000;
    total = Math.round(ms / 60000);
  }
  if (total === null) total = asMinutes(firstOf(d, ['sleepTime', 'totalSleepTime', 'sleepDuration']));

  out.sleep = {
    text: String(firstOf(d, ['topContent', 'summary', 'desc']) || '').trim(),
    totalMin: total,
    deepMin: asMinutes(firstOf(d, ['deepSleepTime', 'deepTime', 'deepSleep'])),
    lightMin: asMinutes(firstOf(d, ['lightSleepTime', 'lightTime', 'lightSleep'])),
    wakeMin: asMinutes(firstOf(d, ['wakeTime', 'awakeTime', 'wakeDuration'])),
    start: s,
    end: e,
    quality: firstOf(d, ['sleepQuality', 'quality']),
  };

  setIfNull(out.metrics, 'sleepMin', total);
}

// 心率：{ heartRateRecordVoList: [{ heartRate, heartRateTime }] }
function readHeartRate(data, out) {
  const d = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(d.heartRateRecordVoList) ? d.heartRateRecordVoList
    : (Array.isArray(d.list) ? d.list : []);

  const points = [];
  for (const x of list) {
    if (!x) continue;
    const v = num(firstOf(x, ['heartRate', 'avgHeartRate', 'value', 'rate']));
    if (v === null || v <= 0) continue;
    const t = num(firstOf(x, ['heartRateTime', 'time', 'createTime', 'timestamp', 'measureTime']));
    points.push({ v: Math.round(v), t: t || 0 });
  }

  let sum = 0;
  let max = null;
  let min = null;
  for (const p of points) {
    sum += p.v;
    if (max === null || p.v > max) max = p.v;
    if (min === null || p.v < min) min = p.v;
  }

  out.heartRate = {
    count: points.length,
    avg: points.length ? Math.round(sum / points.length) : num(firstOf(d, ['avgHeartRate', 'average'])),
    max: max !== null ? max : num(firstOf(d, ['maxHeartRate'])),
    min: min !== null ? min : num(firstOf(d, ['minHeartRate'])),
    // 只留最后 60 个点，缓存到 store 里不至于越堆越大
    points: points.slice(-60),
  };

  setIfNull(out.metrics, 'heartRateAvg', out.heartRate.avg);
  setIfNull(out.metrics, 'heartRateMax', out.heartRate.max);
  setIfNull(out.metrics, 'heartRateMin', out.heartRate.min);
  setIfNull(out.metrics, 'heartRateCount', points.length || null);
}

// 体温：{ temperatureVoList: [{ temperature, measureTime }], explainText }
function readTemperature(data, out) {
  const d = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(d.temperatureVoList) ? d.temperatureVoList
    : (Array.isArray(d.list) ? d.list : []);

  const points = [];
  for (const x of list) {
    if (!x) continue;
    const v = num(firstOf(x, ['temperature', 'temp', 'value']));
    if (v === null || v <= 0) continue;
    const t = num(firstOf(x, ['measureTime', 'time', 'createTime', 'timestamp']));
    points.push({ v: Math.round(v * 10) / 10, t: t || 0 });
  }

  let max = null;
  let min = null;
  for (const p of points) {
    if (max === null || p.v > max) max = p.v;
    if (min === null || p.v < min) min = p.v;
  }

  out.temperature = {
    count: points.length,
    max: max,
    min: min,
    last: points.length ? points[points.length - 1].v : null,
    explain: String(firstOf(d, ['explainText', 'desc', 'tip']) || '').split('\n')[0],
    points: points.slice(-30),
  };

  setIfNull(out.metrics, 'temperatureMax', max);
  setIfNull(out.metrics, 'temperatureMin', min);
  setIfNull(out.metrics, 'temperatureLast', out.temperature.last);
}

// ---------- 组装一天 ----------

async function buildDay(jz, watchId, date) {
  const d = parseYmd(date);
  if (!d) throw new Error('日期格式应该是 YYYY-MM-DD');

  const out = {
    date: date,
    today: date === todayStr(),
    fetchedAt: Date.now(),
    metrics: {},
    summary: [],
    sport: [],
    sleep: null,
    heartRate: null,
    temperature: null,
    errors: [],
  };

  // 夜间窗口：前一天 18:00 → 当天 12:00（和 WebUI 健康页一个口径）
  const sleepFrom = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 18, 0, 0).getTime();
  const sleepTo = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).getTime();
  const tempFrom = d.getTime();
  const tempTo = tempFrom + DAY_MS;

  const jobs = [
    ['健康摘要', 'getHealthHome', [watchId, date]],
    ['运动数据', 'getSportHome', [watchId, date]],
    ['睡眠', 'getSleepDetail', [watchId, sleepFrom, sleepTo]],
    ['心率', 'getHeartRate', [watchId, date]],
    ['体温', 'getTemperature', [watchId, tempFrom, tempTo]],
  ];

  // 单个接口挂掉只记一笔，不影响其它几块
  const results = await mapLimit(jobs, 3, async (job) => {
    try {
      return { job: job, data: await callApi(jz, job[1], job[2]) };
    } catch (e) {
      return { job: job, error: (e && e.message) ? e.message : String(e) };
    }
  });

  for (const r of results) {
    if (r.error) {
      out.errors.push(r.job[0] + '：' + r.error);
      continue;
    }
    const method = r.job[1];
    if (method === 'getHealthHome') {
      const s = readSummary(r.data);
      out.summary = s.texts;
      Object.keys(s.metrics).forEach((k) => setIfNull(out.metrics, k, s.metrics[k]));
    } else if (method === 'getSportHome') {
      readSport(r.data, out);
    } else if (method === 'getSleepDetail') {
      readSleep(r.data, out);
    } else if (method === 'getHeartRate') {
      readHeartRate(r.data, out);
    } else if (method === 'getTemperature') {
      readTemperature(r.data, out);
    }
  }

  return out;
}

// ---------- 缓存 ----------
//
// 只缓存「过去的日子」：今天的数据一直在变，缓存了就是错的。
// 键名 d:<watchId>:<YYYY-MM-DD>，清理时靠日期前缀比大小就行（ISO 日期字符串可以直接比）。

const CACHE_PREFIX = 'd:';

function cacheKey(watchId, date) { return CACHE_PREFIX + watchId + ':' + date; }

function cacheGet(jz, watchId, date, hours) {
  if (date === todayStr()) return null;
  const c = jz.store.get(cacheKey(watchId, date), null);
  if (!c || !c.at || !c.day) return null;
  const ttl = Math.max(0, Number(hours) || 0) * 3600 * 1000;
  if (ttl > 0 && Date.now() - Number(c.at) > ttl) return null;
  return c.day;
}

function cachePut(jz, watchId, day) {
  if (!day || day.date === todayStr()) return;
  jz.store.set(cacheKey(watchId, day.date), { at: Date.now(), day: day });
}

function cacheDrop(jz, watchId, date) {
  if (date) {
    const k = cacheKey(watchId, date);
    // 本来就没有的键不算「清掉了一条」，否则界面上会报一个假数字
    const had = jz.store.get(k, null) !== null;
    jz.store.delete(k);
    return had ? 1 : 0;
  }
  let n = 0;
  const all = jz.store.all();
  Object.keys(all).forEach((k) => {
    if (k.indexOf(CACHE_PREFIX + watchId + ':') === 0) { jz.store.delete(k); n++; }
  });
  return n;
}

function cacheDates(jz, watchId) {
  const prefix = CACHE_PREFIX + watchId + ':';
  const out = [];
  const all = jz.store.all();
  Object.keys(all).forEach((k) => {
    if (k.indexOf(prefix) === 0) out.push(k.slice(prefix.length));
  });
  out.sort();
  return out;
}

// 40 天以前的数据没人看，顺手删掉，别让 store.json 无限长
function prune(jz) {
  const cutoff = ymd(shiftDay(new Date(), -40));
  const all = jz.store.all();
  let n = 0;
  Object.keys(all).forEach((k) => {
    if (k.indexOf(CACHE_PREFIX) !== 0) return;
    const parts = k.split(':');
    const date = parts[2] || '';
    if (date && date < cutoff) { jz.store.delete(k); n++; }
  });
  return n;
}

// ---------- 配置 ----------

function cfgDays(jz) {
  const n = Number(jz.config.get('days'));
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(Math.round(n), 30));
}

function cfgCacheHours(jz) {
  const n = Number(jz.config.get('cacheHours'));
  if (!Number.isFinite(n) || n < 0) return 24;
  return Math.min(n, 720);
}

// ---------- 对外 ----------

function watchBrief(w) {
  return {
    watchId: String(w.watchId),
    name: w.name || '',
    model: w.model || '',
    battery: w.battery === null || w.battery === undefined ? null : Number(w.battery),
    online: w.online !== false,
  };
}

async function status(jz) {
  const watches = await jz.watches.list().catch(() => []);
  const today = todayStr();
  const d = parseYmd(today);
  const days = cfgDays(jz);

  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(ymd(shiftDay(d, -i)));

  return {
    watches: watches.map(watchBrief),
    today: today,
    days: days,
    cacheHours: cfgCacheHours(jz),
    dates: dates,
    cached: watches.map((w) => ({ watchId: String(w.watchId), dates: cacheDates(jz, String(w.watchId)) })),
    serverNow: Date.now(),
  };
}

async function day(jz, watchId, date, force) {
  const id = String(watchId || '').trim();
  if (!id) throw new Error('缺少 watchId');
  const d = String(date || todayStr()).trim();
  if (!parseYmd(d)) throw new Error('日期格式应该是 YYYY-MM-DD');

  if (!force) {
    const hit = cacheGet(jz, id, d, cfgCacheHours(jz));
    if (hit) return Object.assign({}, hit, { cached: true });
  }

  const fresh = await buildDay(jz, id, d);
  cachePut(jz, id, fresh);
  return Object.assign({}, fresh, { cached: false });
}

module.exports = {
  async onLoad(jz) {
    const n = prune(jz);
    jz.log.info('已启动，版本 ' + jz.info().version + '，默认看最近 ' + cfgDays(jz) + ' 天'
      + (n ? '，清掉了 ' + n + ' 条过期缓存' : ''));
  },

  // 页面调这个插件自己的接口：/api/plugin/watch-stats/api/<path>
  //   GET  /status                       -> 手表列表 + 日期范围 + 已缓存的日子
  //   GET  /day?watchId=&date=&force=1   -> 某一天的全部数据
  //   POST /refresh { watchId, date? }   -> 丢掉缓存（不传 date 就清这块表全部）
  async onRequest(jz, req) {
    const p = String(req.path || '').replace(/^\/+/, '').replace(/\/+$/, '');
    const q = req.query || {};

    if (req.method === 'GET' && (p === '' || p === 'status')) {
      return status(jz);
    }

    if (req.method === 'GET' && p === 'day') {
      return day(jz, q.watchId, q.date, q.force === '1');
    }

    if (req.method === 'POST' && p === 'refresh') {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const id = String(b.watchId || q.watchId || '').trim();
      if (!id) throw new Error('缺少 watchId');
      const n = cacheDrop(jz, id, b.date ? String(b.date) : '');
      return { ok: true, dropped: n };
    }

    throw new Error('没有这个接口：' + req.method + ' /' + p);
  },
};
