// Local, fictional API data for UI checks. Never imports the real client/config.
export const fixtureNotice = '本地 UI 验证数据；所有修改仅保存在这个进程的内存中。';
const now = () => Date.now();
const clone = value => structuredClone(value);
const ok = data => ({ status: 200, body: { ok: true, data } });
const failure = (message, status = 400) => ({ status, body: { ok: false, error: message } });
export const notFound = path => failure(`预览未实现接口：${path}`, 404);

export function createFixtureState(options = {}) {
  const first = { watchId: 'watch-demo-1', name: '小满的手表', model: 'Z8 少年版', innerModel: 'I8', firmware: '4.2.1', number: '10000000001', bindNumber: '1234567890000001', relationId: 'relation-demo-1', battery: 86, onlineStatus: true, lastSeenAt: now() - 40000 };
  const second = { watchId: 'watch-demo-2', name: '小禾的手表', model: 'Z7 轻享版', innerModel: 'I7', firmware: '3.8.0', number: '10000000002', bindNumber: '1234567890000002', relationId: 'relation-demo-2', battery: 57, onlineStatus: false, lastSeenAt: now() - 1800000 };
  const extras = [
    { name: '小星的周末手表', model: 'Z9 运动版', battery: 24, onlineStatus: true },
    { name: '小鹿的手表', model: 'Z6', battery: 0, onlineStatus: false },
    { name: '晨晨的备用手表', model: 'Z8 少年版', battery: 98, onlineStatus: true },
    { name: '圆圆的手表', model: 'Z10 旗舰版', battery: null, onlineStatus: null },
    { name: '小宇的运动手表', model: 'Z9 运动版', battery: 63, onlineStatus: true },
    { name: '安安的手表', model: 'Z7 轻享版', battery: 12, onlineStatus: false },
  ].map((watch, index) => ({ ...watch, watchId: `watch-demo-${index + 3}`, innerModel: `I${index + 3}`, firmware: '4.2.1', imei: `86700000000000${index + 3}`, number: `1000000000${index + 3}`, bindNumber: `123456789000000${index + 3}`, relationId: `relation-demo-${index + 3}`, lastSeenAt: now() - (index + 1) * 60000 }));
  const watches = [first, second, ...extras];
  const targets = [
    { key: 's:demo-1', name: '小满的手表', type: 'single', sub: '手表单聊', count: 4, enabled: true },
    { key: 'g:demo-family', name: '我们的小家', type: 'group', sub: '家庭群 · 3 位成员', count: 3, enabled: true },
    { key: 's:demo-2', name: '小禾的手表', type: 'single', sub: '手表单聊', count: 1, enabled: false },
  ];
  const settings = {
    watch: first, capabilities: {}, capabilityOk: true,
    volume: { soundMode: 1, soundLevel: 6, totalLevel: 10, disableMode: 0, modeDefault: '标准' },
    sms: { smsSync: 1 }, receiveType: { receiveType: 0, isDisplayAll: 1 },
    endurance: { enduranceType: 0, autoSwitch: 1, threshold: 20, smartPowerSaveSwitch: 1 },
    disableMode: { classModeWeichat: 0, classModeCall: 1, sleepModeWeichat: 0, sleepModeCall: 0, enduranceWeichat: 1, enduranceCall: 1 },
    systemMode: { status: 0 }, beforeSchool: { status: 0 },
    timezone: { language: 'zh-CN', globalTimeZoneV2: 'Asia/Shanghai', globalTimeZone: 'GMT+08:00' },
    chargeAlert: { chargeSwitch: 1 }, charges: { phoneCharges: 45.2, totalCount: 10, successCount: 10 },
    waterSwitch: 1, waterInterval: 2400, powerLowProtectSwitch: 1, locationAlertSwitch: 1, interactionCallSwitch: 0,
    flow: { stream: 1048576 }, languages: { appDisplayLanguages: ['zh-CN', 'en', 'zh-HK'] },
    time0: [{ id: 'power-1', name: '日常作息', startTime: '07:00', endTime: '21:30', classWeek: 31 }],
    time1: [{ id: 'sleep-1', name: '晚间休息', startTime: '21:00', endTime: '07:00', classWeek: 127 }],
    classModes: [{ id: 'class-1', classId: 'class-1', title: '上午课堂', classWeek: 31, classSwitch: 1, holidaySwitch: 1, timePeriod: JSON.stringify([{ startTime: '08:00', endTime: '11:40' }]) }],
  };
  const devices = Object.fromEntries(watches.map((watch, index) => [watch.watchId, {
    profile: { ...watch, imAccountId: `demo-${index + 1}`, realName: index ? '林禾' : '林满', birthday: new Date(2016, 5, 15).getTime(), height: 138, doubleWeight: 31.5, gender: index ? 2 : 1, grade: 4, classes: 2, geniusNumber: `9000000${index + 1}` },
    settings: clone({ ...settings, watch }),
    autoagree: false,
    contacts: [{ id: 'contact-1', name: '妈妈', salutation: '妈妈', number: '10000000003', mobileNumber: '10000000003', shortNumber: '6001', autoCall: true, type: 3 }, { id: 'contact-2', name: '爸爸', salutation: '爸爸', number: '10000000004', mobileNumber: '10000000004', shortNumber: '', autoCall: false, type: 3 }],
    friends: [{ id: 'friend-1', friendName: '星星', number: '10000000005', bindNumber: '1234567890000005', avatar: '/assets/icon.png' }],
    alarms: [{ id: 'alarm-1', title: '起床啦', hours: 7, minutes: 0, weeks: 31, status: 1 }, { id: 'alarm-2', title: '记得带水杯', hours: 7, minutes: 30, weeks: 31, status: 0 }],
    location: { latitude: 31.2304 + index * .004, longitude: 121.4737 + index * .003, radius: 35, accuracy: 35, desc: index ? '社区运动公园（演示位置）' : '城市图书馆旁（演示位置）', poi: '城市图书馆', createTime: now() - 60000, locationPushTime: now() - 45000, type: 'GPS' },
    lossSwitch: 0,
    lostMessage: '这是演示手表，请联系家长。',
    commonAreas: [{ areaId: 'common-1', areaName: '家', name: '家', x: 31.2304, y: 121.4737, radius: 300 }],
    dangerAreas: [{ areaId: 'danger-1', areaName: '河道附近', name: '河道附近', x: 31.233, y: 121.479, radius: 200 }],
    appStore: { autoUpdateSwitch: 2, watchAllowSwitch: 1, allowDownloadSwitch: 1, watchAuthoriseSwitch: 1, downChannelSwitch: 2, personalRecommend: 0, userAppLevel: 2 },
    appDuration: { totalDuration: 45, isOpen: 1, remindSwitch: 1, remindDuration: 10 },
    appReport: { reportSwitch: 1, nickname: watch.name },
    chatControl: { parentAudit: { v: 1 }, subs: [{ switchName: '家庭群消息', switchStatus: 1 }], privacy: [{ switchId: 1, name: '步数排行', description: '允许展示演示步数', status: 1 }, { switchId: 2, name: '附近的朋友', description: '控制附近好友发现', status: 0 }] },
  }]));
  const state = {
    scenario: 'normal', authed: true, loggedIn: true, noWatches: false, expired: false, failPath: '', delayPath: '', delayMs: 0,
    requests: [], unknownRequests: [], watches, devices, targets,
    account: { userName: '演示家长', mobileId: 'parent-demo-1', loggedIn: true, nickName: '演示家长', deviceId: 'demo-device', imAccountId: 'parent-demo-1' },
    messages: {
      's:demo-1': [{ id: 'm1', time: now() - 360000, kind: 'text', text: '今天读书分享很有意思！', self: false }, { id: 'm2', time: now() - 300000, kind: 'text', text: '真棒，回家讲给我听。记得带上水杯。', self: true }, { id: 'm3', time: now() - 180000, kind: 'emoji', text: '开心', url: '/assets/emoji/second_001.png', self: false }, { id: 'm4', time: now() - 60000, kind: 'text', text: '我在图书馆等你～', self: false }],
      'g:demo-family': [{ id: 'g1', time: now() - 600000, kind: 'text', text: '周末一起去公园吧。', self: true }, { id: 'g2', time: now() - 550000, kind: 'text', text: '好呀！', self: false }, { id: 'g3', time: now() - 500000, kind: 'voice', url: '/__test/tone.wav', text: '[语音] 1 秒', self: false }],
      's:demo-2': [{ id: 's2-1', time: now() - 2000000, kind: 'text', text: '已经到家了', self: false }],
    },
    im: { connected: true, alive: true, lastRecvAgo: 16, lastError: '' },
    pluginsEnabled: true,
    plugins: [{ id: 'watch-stats', name: '手表数据', description: '在一个页面中查看运动、睡眠和健康数据。', version: '1.0.0', author: 'JZClient', loaded: true, disabled: false, builtin: true, hasUi: true, uiTitle: '健康数据', icon: 'chart', hasCover: false, permissions: ['watch.read'], config: [{ key: 'days', label: '展示天数', type: 'number', default: 7 }], values: { days: 7 } }, { id: 'watch-daily', name: '手表日报', description: '每天按时汇总手表状态，发送到选择的家庭会话。', version: '1.0.0', author: 'JZClient', loaded: true, disabled: false, builtin: true, hasUi: false, permissions: ['watch.read', 'chat.send'], config: [{ key: 'time', label: '发送时间', type: 'text', default: '08:00' }, { key: 'enabled', label: '定时发送', type: 'boolean', default: true }, { key: 'prefix', label: '问候语', type: 'textarea', default: '新的一天，早上好！' }], values: { time: '08:00', enabled: true, prefix: '新的一天，早上好！' } }],
    onebot: { heartbeat: 30, qqCompat: true, running: true, clients: 1, selfId: 'parent-demo-1', watches: watches.map((watch, index) => ({ watchId: watch.watchId, name: watch.name, enabled: !index, running: !index, clients: index ? 0 : 1, keys: [targets[index ? 2 : 0].key], auto: true, http: { enabled: true, running: !index, host: '127.0.0.1', port: 5700 + index * 10, token: 'ob_demo_http' }, ws: { enabled: true, running: !index, host: '127.0.0.1', port: 5701 + index * 10, token: 'ob_demo_ws' }, wsClient: { enabled: false, url: 'ws://127.0.0.1:6199/ws', token: '', reconnect: 5000, connected: false, state: 'stopped' } })), targets },
    external: { watches: watches.map(watch => ({ watchId: watch.watchId, name: watch.name, enabled: true, token: 'gk_demo_access_token' })) },
    bili: { watches: watches.map(watch => ({ watchId: watch.watchId, name: watch.name, enabled: false, auto: true, keys: ['s:demo-1'], maxDuration: 600, maxBytes: 104857600, maxPerDay: 20, commentImage: true, searchImage: true })), targets, comment: { sessdata: '', maxComments: 60, maxHeight: 12000 } },
    ai: { managed: false, source: 'own', running: false, autoStart: false, connected: true, config: { baseUrl: 'https://example.invalid/v1', model: 'demo-model', hasKey: true, apiKeyMask: 'demo-***', temperature: .7, trigger: 'keyword', keywords: ['小助手'], keywordsMode: 'auto', timeoutMs: 60000, systemPrompt: '用简洁、友好的语言回应孩子。', vision: true, visionMaxBytes: 4194304, visionPrompt: '请描述图片中有趣的事物。' }, targets, sessions: ['s:demo-1'], diagnostics: { chatTargets: 3, sessions: 1, hasBaseUrl: true, hasKey: true, model: 'demo-model' } },
    links: { count: 3, source: 'local', remoteUrl: 'https://example.invalid/links.txt', auto: true, lastSyncAt: now() - 3600000, lastError: '', remoteFromEnv: false, manualHold: false },
    linkItems: [{ name: '演示读书清单', url: 'https://example.invalid/books' }, { name: '演示天气', url: 'https://example.invalid/weather' }, { name: '演示课程表', url: 'https://example.invalid/schedule' }],
    background: null,
    logs: [{ seq: 1, t: now() - 20000, sev: 20, cat: 'preview', text: fixtureNotice }, { seq: 2, t: now() - 15000, sev: 20, cat: 'webui', text: 'React 界面预览已就绪' }, { seq: 3, t: now() - 10000, sev: 20, tag: 'HTTP', cat: 'GET', text: '/api/watches → 200' }, { seq: 4, t: now() - 5000, sev: 30, cat: 'demo', text: '这是一条用于检查告警样式的演示日志' }],
    logLevel: 'info',
    notices: [{ id: 'notice-1', title: '欢迎体验新版工作台', summary: '更清楚的信息、更顺手的日常操作。', pinned: true, updatedAt: now() - 86400000, createdAt: now() - 86400000, content: '# 新版工作台\n\n这是**虚构演示数据**，用于检查 React 页面。\n\n- 功能按使用场景分组\n- 页面支持浅色与深色\n- 聊天消息稳定更新\n\n> 这里的操作仅记录在本地预览进程中。\n\n| 页面 | 状态 |\n|---|---|\n| 聊天 | 可预览 |\n| 设备 | 可预览 |\n\n```js\nconsole.log("Hello, JZClient");\n```' }, { id: 'notice-2', title: '日常功能入口说明', summary: '了解账号、设备与集成设置。', updatedAt: now() - 172800000, createdAt: now() - 172800000, content: '## 日常功能\n\n从底部导航进入聊天、定位和全部功能。' }],
  };
  for (const plugin of state.plugins) plugin.configValues = clone(plugin.values);
  setScenario(state, options);
  return state;
}

export function setScenario(state, options = {}) {
  const name = typeof options === 'string' ? options : options.name || options.scenario || 'normal';
  state.scenario = name; state.authed = name !== 'unauthorized'; state.loggedIn = name !== 'logged-out';
  state.noWatches = name === 'no-watches'; state.expired = name === 'expired';
  state.failPath = options.failPath || (name === 'error' ? '/api/watches' : '');
  state.delayPath = options.delayPath || ''; state.delayMs = Math.min(60000, Number(options.delayMs) || 0);
  if (name === 'xss') {
    const text = '<img src=x onerror="alert(1)">&\'演示';
    state.watches[0].name = text; state.devices['watch-demo-1'].profile.name = text;
    state.onebot.watches[0].name = text; state.external.watches[0].name = text; state.bili.watches[0].name = text;
  }
  state.ai.managed = name === 'managed'; state.ai.source = name === 'managed' ? 'platform' : 'own';
  return { name, authed: state.authed, loggedIn: state.loggedIn, noWatches: state.noWatches, expired: state.expired, failPath: state.failPath, delayPath: state.delayPath, delayMs: state.delayMs };
}

function logPayload(state, search = new URLSearchParams()) {
  const since = Number(search.get('since')) || 0;
  const limit = Math.max(1, Math.min(600, Number(search.get('limit')) || 300));
  return { entries: state.logs.filter(entry => entry.seq > since).slice(-limit), seq: state.logs.at(-1)?.seq || 0, level: state.logLevel, levels: ['debug', 'info', 'warn', 'error', 'silent'] };
}
export function readFixture(path, search, state) {
  if (path === '/api/auth/status') return ok({ authed: state.authed });
  if (!state.authed) return { status: 401, body: { ok: false, unauthorized: true, error: '演示访问令牌已失效' } };
  if (state.failPath && path.startsWith(state.failPath)) return failure('模拟接口暂时不可用，请重试', 503);
  if (path === '/api/account') return ok({ ...state.account, loggedIn: state.loggedIn });
  if (path === '/api/watches') return state.expired ? failure('000003 token is invalid') : ok({ watches: state.loggedIn && !state.noWatches ? state.watches : [] });
  if (path === '/api/system') return ok({ system: { platform: 'linux', arch: 'x64', release: '6.8.0', hostname: 'jz-demo', cpuModel: 'Demo 4-Core Processor', cpuCores: 4, cpuPercent: 12.4, loadavg: [.18, .22, .16], memTotal: 8589934592, memUsed: 2338603008, memPercent: 27.2, uptime: 275430 }, process: { pid: 1208, node: 'v24.11.0', arch: 'x64', cpuPercent: 1.4, rss: 127926272, heapUsed: 69206016, heapTotal: 100663296, uptime: 86430 }, account: { ...state.account, loggedIn: state.loggedIn, imConnected: state.loggedIn, onebotRunning: state.loggedIn, watchCount: state.loggedIn && !state.noWatches ? state.watches.length : 0, watches: state.loggedIn && !state.noWatches ? state.watches.map(watch => ({ ...watch, online: watch.onlineStatus })) : [] } });
  if (path === '/api/config') return ok({ config: { note: fixtureNotice, webui: { host: '127.0.0.1', port: 8790 }, ai: { model: 'demo-model' } } });
  if (path === '/api/ui/background') return ok({ background: state.background });
  if (path === '/api/map/search') {
    const query = (search.get('q') || '').trim().replace(/\s+/g, ' ');
    const queryLength = Array.from(query).length;
    if (queryLength < 2 || queryLength > 80) return failure('请输入 2～80 个字的地点关键词。', 200);
    if (search.has('latitude') || search.has('longitude')) {
      const latitudeText = (search.get('latitude') || '').trim();
      const longitudeText = (search.get('longitude') || '').trim();
      const latitude = Number(latitudeText); const longitude = Number(longitudeText);
      if (!latitudeText || !longitudeText || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return failure('搜索中心无效，请重新选择地图位置。', 200);
    }
    if (query === '搜索失败') return failure('地点搜索暂时无法连接，请重试，或直接在地图上选择。', 200);
    const provider = 'fixture'; const coordinateSystem = 'gcj02';
    const places = query === '无结果' ? [] : [
      { id: 'place-demo-city', name: '演示城市广场', address: '上海市黄浦区演示路 1 号（虚构地点）', latitude: 31.2304, longitude: 121.4737 },
      { id: 'place-demo-school', name: '演示学校', address: '上海市黄浦区演示路 2 号（虚构地点）', latitude: 31.2341, longitude: 121.4792 },
      { id: 'place-demo-library', name: '演示图书馆', address: '上海市黄浦区演示路 3 号（虚构地点）', latitude: 31.2278, longitude: 121.4771 },
    ].map(place => ({ ...place, coordinateSystem, sourceCoordinateSystem: 'wgs84', provider }));
    return ok({ places, provider, coordinateSystem });
  }
  if (path === '/api/announcements') return ok({ notices: state.notices });
  if (path.startsWith('/api/announcements/')) { const notice = state.notices.find(item => item.id === path.split('/').at(-1)); return notice ? ok({ notice }) : notFound(path); }
  if (path === '/api/yiyan') return ok({ text: '把平凡的日子，过成值得记住的时光。', author: '', from: '', upstream: 'local' });
  if (path === '/api/update/check') return ok({ managed: state.scenario === 'update' || state.scenario === 'force-update', hasUpdate: true, force: state.scenario === 'force-update', latest: '1.4.0', running: '1.3.8', notes: '演示更新说明\n\n- React 界面\n- 完整功能迁移' });
  if (path === '/api/chats') return ok({ targets: state.targets, im: state.im });
  if (path === '/api/chats/avatar') return ok({ url: state.targets.some(target => target.type === 'single' && target.key === search.get('key')) ? '/assets/icon.png' : '' });
  if (path === '/api/chats/messages') return ok({ messages: state.messages[search.get('key')] || [], im: state.im });
  if (path === '/api/chats/emojis') return ok({ emojis: Array.from({ length: 12 }, (_, index) => ({ index, desc: ['开心', '笑脸', '可爱', '鼓掌', '加油', '收到'][index % 6], url: `/assets/emoji/second_${String(index + 1).padStart(3, '0')}.png` })) });
  if (path === '/api/onebot') return ok(state.onebot);
  if (path === '/api/genius-api') return ok(state.external);
  if (path === '/api/bili') return ok(state.bili);
  if (path === '/api/bili/search') return ok({ keyword: search.get('kw') || search.get('keyword') || search.get('q') || '科学', list: [{ index: 1, title: '演示：一分钟认识太阳系', author: '演示频道', bvid: 'BV_DEMO_001', duration: '01:36' }, { index: 2, title: '演示：跟着地图去旅行', author: '演示频道', bvid: 'BV_DEMO_002', duration: '03:02' }] });
  if (path === '/api/ai') return ok(state.ai);
  if (path === '/api/links') return ok(state.links);
  if (path === '/api/links/search') { const q = search.get('q') || ''; const items = state.linkItems.filter(item => `${item.name} ${item.url}`.includes(q)); return ok({ items, total: state.linkItems.length, matched: items.length, hasMore: false }); }
  if (path === '/api/plugins') return ok({ mode: state.scenario === 'managed' ? 'managed' : 'local', enabled: state.pluginsEnabled, list: state.plugins, dir: '/demo/.watch-parent-cli/plugins', consoleUrl: 'https://example.invalid', note: fixtureNotice });
  if (path === '/api/logs') return ok(logPayload(state, search));
  const match = /^\/api\/watch\/([^/]+)\/(.*)$/.exec(path);
  if (!match) return notFound(path);
  const watch = state.watches.find(item => item.watchId === decodeURIComponent(match[1]));
  const device = state.devices[decodeURIComponent(match[1])]; const action = match[2];
  if (!watch || !device) return notFound(path);
  const status = { battery: watch.battery, batteryAt: now() - 45000, batterySource: 'push', batteryTimeKind: 'reported', onlineStatus: watch.onlineStatus, lastSeenAt: watch.lastSeenAt, lastLat: device.location.latitude, lastLng: device.location.longitude };
  if (action === 'capabilities') return ok({ modules: {}, ok: true });
  if (action === 'status') return ok(status);
  if (action === 'profile') return ok({ account: device.profile });
  if (action === 'avatar') return ok({ url: '/assets/icon.png', icon: `demo-avatar-${id}` });
  if (action === 'overview') return ok({ account: device.profile, watch, status, batteryInfo: status, battery: watch.battery, onlineStatus: watch.onlineStatus, location: device.location, classModes: device.settings.classModes, members: [{ mobileId: 'parent-demo-1', name: '演示家长', salutation: '妈妈', mobileNumber: '10000000003', authorize: 1 }, { mobileId: 'parent-demo-2', name: '演示家人', salutation: '爸爸', mobileNumber: '10000000004', authorize: 0 }], guard: { allDayGuardIsOpen: 1, commonPlaceIsOpen: 1, schoolGuardIsOpen: 1 } });
  if (action === 'autoagree') return ok({ enabled: device.autoagree });
  if (action === 'friends') return ok({ friends: device.friends });
  if (action === 'contacts') return ok({ contacts: device.contacts });
  if (action === 'genius') return ok({ geniusNumber: device.profile.geniusNumber, command: { command: 'DEMO-ONLY-1234', expireTime: now() + 600000 }, config: { commandExpireDescription: '演示口令不关联任何真实手表。' } });
  if (action === 'wifi') return ok({ list: [{ wifiName: 'Home-Demo', mac: '02:00:00:00:00:01', status: 2 }, { wifiName: 'Library-Demo', mac: '02:00:00:00:00:02', status: 1 }], max: 10 });
  if (action === 'alarms') return ok({ alarms: device.alarms });
  if (action === 'health') return ok({ date: new Date().toISOString().slice(0, 10), home: { healthHomeSummaryVos: [{ text: '今天运动很充足，继续保持。' }, { text: '昨日睡眠 9 小时 12 分钟。' }] }, sport: [{ name: '步数', title: '步数', step: 6832, steps: 6832, value: 6832, unit: '步' }, { name: '运动时间', title: '运动时间', value: 48, unit: '分钟' }], sleep: { topContent: '昨晚睡眠 9 小时 12 分钟，睡眠规律。' }, temperature: { explainText: '体温记录仅作演示', temperatureVoList: [{ temperature: 36.5, time: now() - 3600000, createTime: now() - 3600000 }] }, heartRate: { heartRateRecordVoList: [{ heartRate: 86, time: now() - 1800000, createTime: now() - 1800000 }] } });
  if (action === 'apps') return ok({ apps: [{ id: 'app-1', name: '词汇练习', packageName: 'demo.vocabulary', versionName: '1.0.0', size: 10485760, status: 1 }, { id: 'app-2', name: '每日故事', packageName: 'demo.story', versionName: '2.0.1', size: 12582912, status: 1 }], storeSwitch: device.appStore, levels: [{ appLevel: 1, name: '基础应用' }, { appLevel: 2, name: '学习成长' }], duration: device.appDuration, todayUse: { alreadyDuration: 18 }, report: device.appReport });
  if (action === 'settings') return ok(device.settings);
  if (action === 'settings/timezones') return ok({ list: [{ k: 'Asia/Shanghai', gmt: '+08:00', v: { 'zh-CN': '北京时间', en: 'Beijing' } }, { k: 'Asia/Tokyo', gmt: '+09:00', v: { 'zh-CN': '东京时间', en: 'Tokyo' } }] });
  if (action === 'autocall') return ok({ contacts: device.contacts });
  if (action === 'chatcontrol') return ok(device.chatControl);
  if (action === 'location') return ok({ location: device.location, lossSwitch: device.lossSwitch, onlineStatus: watch.onlineStatus });
  if (action === 'track') return ok({ points: [{ id: 'point-1', locationTime: now() - 7200000, address: '演示社区', poi: '南门', latitude: 31.228, longitude: 121.471 }, { id: 'point-2', locationTime: now() - 3600000, address: '演示图书馆', poi: '阅读区', latitude: 31.2304, longitude: 121.4737 }] });
  if (action === 'lost/photos') return ok({ photos: [{ id: 'photo-1', url: '/__test/scene.svg', createTime: now() - 60000, location: '演示图书馆' }] });
  if (action === 'lost/wifi') return ok({ wifi: [{ name: 'Library-Demo', signal: -55, mac: '02:00:00:00:00:02' }], meta: { reportTime: now() - 60000, wifiCount: 1 } });
  if (action === 'lost/message') return ok({ message: device.lostMessage });
  if (action === 'guard') return ok({ status: { allDayGuardIsOpen: 1, commonPlaceIsOpen: 1, schoolGuardIsOpen: 1, dangerAreaIsOpen: 1, commonAreaIsOpen: 1, waterAreaIsOpen: 1, travelIsOpen: 0, fallIsOpen: 0, basicServiceIsOpen: 1 }, common: { commonAreaList: device.commonAreas }, danger: { dangerAreaList: device.dangerAreas } });
  if (action === 'hidden') return ok({ baseState: { battery: watch.battery, online: watch.onlineStatus }, offLocation: {}, markedLocations: [], accessibility: { status: 0 }, memberPermission: [], unreadNotice: {}, autocall: { contacts: device.contacts }, disableMode: device.settings.disableMode, noticeContent: { noticeDesc: '这是演示通知。' }, beforeSchool: device.settings.beforeSchool, whiteApps: { version: '1', funcs: ['微聊', '电话'] }, baiduNetdisk: null, userAgreement: [], systemMode: device.settings.systemMode, receiveType: device.settings.receiveType, nfcPending: { shiftOrDelCardVoList: [] }, nfcCards: [] });
  return notFound(path);
}

export function writeFixture(path, method, body, state) {
  if (path === '/api/auth/login') { if (body.token !== 'demo-token') return failure('演示访问令牌为 demo-token'); state.authed = true; return ok({ authed: true }); }
  if (path === '/api/auth/logout') { state.authed = false; return ok({ authed: false }); }
  if (!state.authed) return { status: 401, body: { ok: false, unauthorized: true, error: '演示访问令牌已失效' } };
  if (state.failPath && path.startsWith(state.failPath)) return failure('模拟保存失败，请重试', 503);
  if (path === '/api/account/login') {
    if (String(body.account).includes('verify')) return ok({ needVerify: true, challenge: { checkCode: 'demo-check-code', checkTypes: [4], endTime: now() + 600000 } });
    state.loggedIn = true; state.expired = false; state.account.userName = body.account || '演示家长'; return ok({ userName: state.account.userName, loggedIn: true });
  }
  if (path === '/api/account/verify/questions') return ok({ questions: [{ questionId: 'q1', question: '宝贝的天才号是什么？', content: '填写任意演示答案即可继续' }, { questionId: 'q2', question: '你最喜欢的颜色？', content: '填写任意演示答案即可继续' }] });
  if (path === '/api/account/verify/question') { state.loggedIn = true; state.expired = false; return ok({ loggedIn: true }); }
  if (path === '/api/account/logout') { state.loggedIn = false; return ok({ loggedIn: false }); }
  if (path === '/api/ui/background') { state.background = body.background || null; return ok({ background: state.background }); }
  if (path === '/api/links/auto') { state.links.auto = !!body.auto; return ok({ state: state.links }); }
  if (path === '/api/links/refresh') { state.links.lastSyncAt = now(); return ok({ count: state.links.count, notModified: true, state: state.links }); }
  if (path === '/api/logs/level') { state.logLevel = body.level; return ok({ level: state.logLevel }); }
  if (path === '/api/logs' && method === 'DELETE') { const seq = state.logs.at(-1)?.seq || 0; state.logs = []; return ok({ seq }); }
  if (path === '/api/update/apply') { state.scenario = 'normal'; return ok({ restarting: true }); }
  if (path === '/api/chats/connect') { state.im.connected = true; state.im.alive = true; return ok({ im: state.im }); }
  if (path === '/api/chats/send' || path === '/api/chats/voice' || path === '/api/chats/media') {
    const key = body.key || 's:demo-1'; const kind = body.kind || (path.endsWith('voice') ? 'voice' : 'image');
    const row = { id: `sent-${now()}`, time: now(), kind, text: body.text || body.desc || (kind === 'location' ? body.poi : `[演示${kind}]`), self: true };
    if (kind === 'image' || kind === 'emoji') row.url = '/assets/icon.png'; if (kind === 'voice') row.url = '/__test/tone.wav'; if (kind === 'link') row.url = body.url;
    (state.messages[key] ||= []).push(row); return ok({ sent: true, parts: 1 });
  }
  if (path === '/api/ai/test') return ok({ model: 'demo-model', ms: 125, reply: '你好！这是本地模拟回复。' });
  if (path.startsWith('/api/ai/')) {
    const action = path.split('/').at(-1);
    if (action === 'start' || action === 'stop') { state.ai.running = action === 'start'; state.ai.autoStart = state.ai.running; }
    else if (action === 'sessions') { state.ai.sessions = body.keys || []; state.ai.targets = state.ai.targets.map(target => ({ ...target, enabled: state.ai.sessions.includes(target.key) })); }
    else if (['config', 'prompt', 'trigger', 'vision'].includes(action)) Object.assign(state.ai.config, body);
    else return notFound(path);
    return ok(state.ai);
  }
  if (path.startsWith('/api/onebot/')) {
    const watch = state.onebot.watches.find(item => item.watchId === body.watchId);
    if (watch && path.endsWith('/token')) { const which = body.which || 'http'; watch[which].token = `ob_demo_${which}_${now()}`; }
    else if (watch) { const transport = { http: { ...watch.http, ...body.http }, ws: { ...watch.ws, ...body.ws }, wsClient: { ...watch.wsClient, ...body.wsClient } }; Object.assign(watch, body, transport, { running: !!body.enabled }); if (Array.isArray(body.targets)) { watch.keys = body.targets.length ? body.targets : ['s:demo-1']; watch.auto = !body.targets.length; } }
    else Object.assign(state.onebot, body);
    return ok(state.onebot);
  }
  if (path.startsWith('/api/genius-api/')) { const item = state.external.watches.find(watch => watch.watchId === body.watchId); if (item) Object.assign(item, body, path.endsWith('/token') ? { token: `gk_demo_${now()}` } : {}); return ok(state.external); }
  if (path.startsWith('/api/bili/')) { if (path.endsWith('/comment')) Object.assign(state.bili.comment, body); else { const item = state.bili.watches.find(watch => watch.watchId === body.watchId); if (item) Object.assign(item, body); } return ok(state.bili); }
  if (path === '/api/plugins/toggle') { state.pluginsEnabled = !!body.enabled; return ok({ enabled: state.pluginsEnabled, list: state.plugins }); }
  if (path === '/api/plugins/rescan') return ok({ list: state.plugins });
  if (path === '/api/plugins/upload') return ok({ result: { id: 'demo-upload', name: '演示上传插件', loaded: true }, list: state.plugins });
  const pluginMatch = /^\/api\/plugins\/([^/]+)\/(enable|disable|reload|config|uninstall)$/.exec(path);
  if (pluginMatch) {
    const plugin = state.plugins.find(item => item.id === pluginMatch[1]); if (!plugin) return notFound(path);
    if (pluginMatch[2] === 'enable' || pluginMatch[2] === 'disable') { plugin.disabled = pluginMatch[2] === 'disable'; plugin.loaded = !plugin.disabled; }
    if (pluginMatch[2] === 'config') { plugin.values = body.values; plugin.configValues = body.values; }
    if (pluginMatch[2] === 'uninstall') state.plugins = state.plugins.filter(item => item.id !== plugin.id);
    return ok({ list: state.plugins });
  }
  if (path === '/api/bind/lookup') {
    const number = String(body.bindNumber || '');
    if (number.endsWith('0003') && !body.randcode) return ok({ needCode: true, hint: '请输入演示验证码 1234。' });
    return ok({ watch: { watchId: 'watch-demo-new', model: 'Z9 演示版' }, admin: number.endsWith('0002') ? { salutation: '演示管理员', mobileNumber: '100****0001' } : null, needMobileCheck: number.endsWith('0002'), alreadyBound: number.endsWith('0004'), talents: [{ id: 'talent-demo', geniusNumber: '90000001', watchId: 'watch-demo-1', bindNumber: '1234567890000001', name: '小满', isLogin: 1 }], geniusLimit: { isLimit: false }, hint: fixtureNotice });
  }
  if (path === '/api/bind/submit') {
    if (body.type === 3 && !body.adminNumber) return ok({ needAdminNumber: true, hint: '请填写演示管理员完整手机号。' });
    if (body.origWatchId && !body.transferCode) return ok({ needAdminCode: true, hint: '请填写演示管理员验证码。' });
    return ok({ bound: true, transferred: !!body.origWatchId });
  }
  if (path === '/api/bind/transfercode') return ok({ adminSalutation: '演示管理员', adminPhoneNumber: '100****0001' });
  const match = /^\/api\/watch\/([^/]+)\/(.*)$/.exec(path);
  if (!match) return notFound(path);
  const id = decodeURIComponent(match[1]); const device = state.devices[id]; const action = match[2];
  if (!device) return notFound(path);
  if (action === 'profile') { Object.assign(device.profile, body, { doubleWeight: Number(body.weight), birthday: body.birthday ? new Date(body.birthday).getTime() : null }); Object.assign(state.watches.find(watch => watch.watchId === id), { name: body.name }); }
  else if (action === 'autoagree') device.autoagree = !!body.enabled;
  else if (action === 'lost') device.lossSwitch = body.enabled ? 1 : 0;
  else if (action === 'lost/message') device.lostMessage = body.message;
  else if (action === 'lost/sound') return ok({ sent: true });
  else if (action === 'guard/danger') device.dangerAreas.push({ areaId: `danger-${now()}`, x: body.latitude, y: body.longitude, radius: body.radius });
  else if (action.startsWith('guard/danger/') && method === 'DELETE') device.dangerAreas = device.dangerAreas.filter(item => item.areaId !== action.split('/').at(-1));
  else if (action === 'alarms') device.alarms.push({ ...body, id: `alarm-${now()}`, status: 1 });
  else if (action.startsWith('alarms/')) { const alarm = device.alarms.find(item => item.id === action.split('/')[1]); if (method === 'DELETE') device.alarms = device.alarms.filter(item => item !== alarm); else if (alarm) alarm.status = alarm.status ? 0 : 1; }
  else if (action === 'contacts') device.contacts.push({ ...body, id: `contact-${now()}` });
  else if (action.startsWith('contacts/')) { const contactId = action.split('/')[1]; if (method === 'DELETE') device.contacts = device.contacts.filter(item => item.id !== contactId); else Object.assign(device.contacts.find(item => item.id === contactId) || {}, body); }
  else if (action.startsWith('friends/') && method === 'DELETE') device.friends = device.friends.filter(item => item.id !== action.split('/')[1]);
  else if (action === 'autocall') Object.assign(device.contacts.find(item => item.id === body.id) || {}, { autoCall: body.autoCall });
  else if (action === 'chatcontrol/parentaudit') device.chatControl.parentAudit.v = body.v;
  else if (action === 'chatcontrol/privacy') Object.assign(device.chatControl.privacy.find(item => item.switchId === body.switchId) || {}, { status: body.status });
  else if (action === 'unbind') state.watches = state.watches.filter(item => item.watchId !== id);
  else if (action.startsWith('appstore/')) Object.assign(action.endsWith('report') ? device.appReport : action.endsWith('duration') ? device.appDuration : device.appStore, body);
  else if (action.startsWith('settings/')) {
    const setting = action.split('/')[1];
    const property = { volume: 'volume', receivetype: 'receiveType', endurance: 'endurance', disablemode: 'disableMode', systemmode: 'systemMode', beforeschool: 'beforeSchool', flow: 'flow', chargealert: 'chargeAlert' }[setting];
    if (property) Object.assign(device.settings[property], body);
    else if (setting === 'watchswitch') Object.assign(device.settings, body);
    else if (setting === 'language') device.settings.timezone.language = body.language;
    else if (setting === 'timezone') device.settings.timezone.globalTimeZoneV2 = body.zoneKey;
    else if (setting === 'time') { const list = Number(body.type) === 1 ? device.settings.time1 : device.settings.time0; const index = list.findIndex(item => item.id === (body.id || action.split('/')[2])); if (method === 'DELETE' && index >= 0) list.splice(index, 1); else if (index >= 0) Object.assign(list[index], body); else if (method !== 'DELETE') list.push({ ...body, id: `period-${now()}` }); }
    else if (setting === 'classmode') { if (body.disabled !== undefined) device.classDisabled = body.disabled; else if (method === 'DELETE') device.settings.classModes = device.settings.classModes.filter(item => item.id !== action.split('/')[2]); else { const id = action.split('/')[2]; const existing = device.settings.classModes.find(item => item.id === id); const values = { ...body, timePeriod: JSON.stringify([{ startTime: body.startTime, endTime: body.endTime }]) }; if (existing) Object.assign(existing, values); else device.settings.classModes.push({ ...values, id: `class-${now()}`, classSwitch: 1 }); } }
    else return notFound(path);
  } else return notFound(path);
  return ok({ saved: true });
}

export function fixtureLogs(state) { return logPayload(state); }
