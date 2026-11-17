// UI-only fixture server. No real credentials, device clients, or outbound HTTP.
// node frontend/tools/preview-server.mjs [--port 8790] [--self-test]
// POST /__test/scenario {name:"normal|logged-out|no-watches|expired|error|unauthorized|managed|update|force-update|xss",failPath?,delayPath?,delayMs?}
// GET /__test/requests inspects the in-memory mutation log; DELETE clears it.
// Binding suffixes: 0002=existing admin, 0003=watch code, 0004=already bound.
// Login account containing "verify" exercises the security-question challenge.
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFixtureState, readFixture, writeFixture, setScenario, fixtureLogs, fixtureNotice, notFound } from './fixtures.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scene = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360" viewBox="0 0 600 360"><rect width="600" height="360" fill="#edf0ee"/><rect x="70" y="85" width="460" height="220" rx="18" fill="#d9dfd9"/><path d="M70 130L300 35l230 95" fill="#c5cdc7"/><rect x="250" y="150" width="100" height="155" rx="10" fill="#afbdb5"/><g fill="#fff" opacity=".7"><rect x="110" y="160" width="80" height="90" rx="5"/><rect x="410" y="160" width="80" height="90" rx="5"/></g><text x="300" y="338" font-family="sans-serif" font-size="18" text-anchor="middle" fill="#66756b">LOCAL UI PREVIEW</text></svg>';

function tone() {
  const rate = 8000, samples = 8000;
  const output = Buffer.alloc(44 + samples * 2);
  output.write('RIFF'); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8); output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22); output.writeUInt32LE(rate, 24); output.writeUInt32LE(rate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36); output.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) output.writeInt16LE(Math.round(Math.sin(i * 440 * Math.PI * 2 / rate) * 1000 * Math.sin(Math.PI * i / samples)), 44 + i * 2);
  return output;
}
const toneData = tone();
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(type.startsWith('application/json') ? JSON.stringify(body) : body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buffer.length, 'Cache-Control': 'no-store', 'X-JZ-Preview': 'fictional-data-only' }); res.end(buffer);
}
async function readBody(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 100 * 1024 * 1024) throw new Error('预览文件超过 100MB'); chunks.push(chunk); }
  const buffer = Buffer.concat(chunks);
  if (String(req.headers['content-type']).includes('application/json')) return buffer.length ? JSON.parse(buffer.toString('utf8')) : {};
  return { _binaryBytes: bytes, _contentType: req.headers['content-type'] || '' };
}
function redact(body) {
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, /^(password|apiKey|token|sessdata|data)$/i.test(key) ? '[redacted]' : value]));
}

export function createPreviewServer(options = {}) {
  let state = createFixtureState(options);
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(res, 400, { error: 'Bad URL' }); }
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (pathname === '/__test/requests') {
        if (req.method === 'DELETE') { state.requests = []; state.unknownRequests = []; }
        return send(res, 200, { note: fixtureNotice, requests: state.requests, unknownRequests: state.unknownRequests });
      }
      if (pathname === '/__test/scenario') {
        if (req.method === 'POST') { const body = await readBody(req); if (body.reset !== false) state = createFixtureState(); return send(res, 200, setScenario(state, body)); }
        return send(res, 200, { name: state.scenario, note: fixtureNotice });
      }
      if (pathname === '/__test/scene.svg') return send(res, 200, scene, 'image/svg+xml');
      if (pathname === '/__test/tone.wav') return send(res, 200, toneData, 'audio/wav');
      if (pathname === '/' || pathname === '/index.html') {
        let html = await readFile(path.join(project, 'src/webui.html'), 'utf8');
        const previewTheme = url.searchParams.get('__theme');
        if (previewTheme === 'light' || previewTheme === 'dark') {
          // The fixture can choose a real persisted theme before the app boots.
          html = html.replace('<head>', `<head><script>localStorage.setItem('jz_theme',${JSON.stringify(previewTheme)})</script>`);
        }
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (pathname.startsWith('/assets/')) {
        const assetRoot = path.join(project, 'src/assets'); const file = path.resolve(assetRoot, pathname.slice(8));
        if (!file.startsWith(assetRoot + path.sep)) return send(res, 403, { error: 'Invalid asset path' });
        const type = ({ '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' })[path.extname(file)] || 'application/octet-stream';
        try { return send(res, 200, await readFile(file), type); } catch { return send(res, 404, { error: 'Asset not found' }); }
      }
      if (/^\/api\/plugin\/[^/]+\/ui\/$/.test(pathname)) return send(res, 200, '<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px system-ui;margin:24px;color:#27272a;background:#fafafa}html[data-theme="dark"] body{color:#eee;background:#27272a}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{padding:24px;border-radius:18px;background:#e4e4e740}strong{font-size:28px;display:block;margin:15px 0}</style></head><body><h2>手表数据</h2><p>本地插件界面演示</p><div class="grid"><div class="card">今日步数<strong>6,832</strong>步</div><div class="card">睡眠时长<strong>9h 12m</strong>昨晚</div><div class="card">最近心率<strong>86</strong>次 / 分</div></div><script>parent.postMessage({__jzPluginHeight:420},location.origin)</script></body></html>', 'text/html; charset=utf-8');
      if (pathname === '/api/bili/search/preview' || pathname === '/api/bili/comment/preview' || pathname === '/api/bili/preview') return send(res, 200, scene, 'image/svg+xml');
      if (state.delayPath && pathname.startsWith(state.delayPath)) await new Promise(resolve => setTimeout(resolve, state.delayMs));
      if (pathname === '/api/logs/stream') {
        if (state.scenario === 'polling') return send(res, 503, { ok: false, error: '模拟 SSE 不可用' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: init\ndata: ${JSON.stringify(fixtureLogs(state))}\n\n`); streams.add(res);
        const timer = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
        req.on('close', () => { clearInterval(timer); streams.delete(res); }); return;
      }
      let result;
      if (req.method === 'GET' || req.method === 'HEAD') result = readFixture(pathname, url.searchParams, state);
      else {
        const body = await readBody(req); const requestBody = { ...Object.fromEntries(url.searchParams), ...body };
        state.requests.push({ method: req.method, path: pathname, query: Object.fromEntries(url.searchParams), body: redact(requestBody), at: Date.now() });
        if (state.requests.length > 1000) state.requests.shift();
        result = writeFixture(pathname, req.method, requestBody, state);
      }
      if (!result) result = notFound(pathname);
      if (result.status === 404) state.unknownRequests.push({ method: req.method, path: pathname });
      send(res, result.status, result.body);
    } catch (error) { send(res, 500, { ok: false, error: `预览服务错误：${error.message}` }); }
  });
  server.on('close', () => { for (const stream of streams) stream.destroy(); });
  server.fixtureState = () => state;
  return server;
}

async function selfTest() {
  const { default: assert } = await import('node:assert/strict');
  const server = createPreviewServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async path => { const response = await fetch(origin + path); return { status: response.status, value: await response.json() }; };
  const post = async (path, body) => { const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return response.json(); };
  try {
    const routes = ['/api/auth/status', '/api/account', '/api/watches', '/api/system', '/api/plugins', '/api/onebot', '/api/genius-api', '/api/bili', '/api/ai', '/api/chats', '/api/watch/watch-demo-1/settings', '/api/watch/watch-demo-1/guard', '/api/watch/watch-demo-1/location'];
    for (const route of routes) assert.equal((await get(route)).status, 200, route);
    const searchRoute = query => `/api/map/search?q=${encodeURIComponent(query)}`;
    const beforePlaceSearch = structuredClone(server.fixtureState());
    const placeSearch = await get(searchRoute('城市') + '&latitude=31.2304&longitude=121.4737');
    assert.equal(placeSearch.status, 200); assert.equal(placeSearch.value.ok, true);
    const searchData = placeSearch.value.data;
    assert.equal(searchData.provider, 'fixture'); assert.equal(searchData.coordinateSystem, 'gcj02');
    assert.equal(searchData.places.length, 3);
    for (const place of searchData.places) {
      assert.equal(typeof place.id, 'string'); assert.match(place.name, /演示/); assert.match(place.address, /虚构/);
      assert.equal(place.coordinateSystem, 'gcj02'); assert.equal(place.sourceCoordinateSystem, 'wgs84'); assert.equal(place.provider, 'fixture');
      assert.ok(Number.isFinite(place.latitude) && place.latitude > 31 && place.latitude < 32);
      assert.ok(Number.isFinite(place.longitude) && place.longitude > 121 && place.longitude < 122);
    }
    for (const query of ['城市', '学校', '图书馆', '  城市  ', '🙂'.repeat(80)]) assert.deepEqual((await get(searchRoute(query))).value.data, searchData);
    assert.deepEqual((await get(searchRoute('无结果'))).value, { ok: true, data: { places: [], provider: 'fixture', coordinateSystem: 'gcj02' } });
    assert.deepEqual((await get(searchRoute('搜索失败'))).value, { ok: false, error: '地点搜索暂时无法连接，请重试，或直接在地图上选择。' });
    for (const query of ['', '城', '🙂'.repeat(81)]) assert.deepEqual(await get(searchRoute(query)), { status: 200, value: { ok: false, error: '请输入 2～80 个字的地点关键词。' } });
    for (const center of ['latitude=31', 'latitude=&longitude=', 'latitude=91&longitude=121', 'latitude=31&longitude=181', 'latitude=NaN&longitude=121']) assert.deepEqual((await get(searchRoute('城市') + '&' + center)).value, { ok: false, error: '搜索中心无效，请重新选择地图位置。' });
    assert.deepEqual(server.fixtureState(), beforePlaceSearch);
    assert.equal((await get('/api/not-implemented')).status, 404);
    await post('/api/watch/watch-demo-1/settings/watchswitch', { waterInterval: 5400 });
    assert.equal((await get('/api/watch/watch-demo-1/settings')).value.data.waterInterval, 5400);
    assert.equal((await get('/__test/requests')).value.requests.at(-1).body.waterInterval, 5400);
    await post('/api/chats/send', { key: 's:demo-1', kind: 'text', text: '离线测试消息' });
    assert.equal((await get('/api/chats/messages?key=s%3Ademo-1')).value.data.messages.at(-1).text, '离线测试消息');
    const lookup = await post('/api/bind/lookup', { bindNumber: '1234567890000003' }); assert.equal(lookup.data.needCode, true);
    const migration = await post('/api/bind/submit', { origWatchId: 'watch-demo-1' }); assert.equal(migration.data.needAdminCode, true);
    await post('/__test/scenario', { name: 'expired' }); assert.equal((await get('/api/watches')).status, 400);
    await post('/__test/scenario', { name: 'logged-out' }); assert.equal((await get('/api/account')).value.data.loggedIn, false);
    await post('/__test/scenario', { name: 'unauthorized' }); assert.equal((await get('/api/account')).status, 401);
    assert.equal((await get(searchRoute('城市'))).status, 401);
    console.log('Preview fixture self-test passed: routes, map search, unknown API, writes, chat, binding, expired/logged-out/unauthorized.');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

if (process.argv.includes('--self-test')) await selfTest();
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--port'); const port = index >= 0 ? Number(process.argv[index + 1]) : 8790;
  const server = createPreviewServer(); server.listen(port, '127.0.0.1', () => console.log(`Fictional UI preview: http://127.0.0.1:${server.address().port}\n${fixtureNotice}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
