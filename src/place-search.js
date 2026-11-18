'use strict';

const http = require('http');
const https = require('https');

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const LIMIT = 8;
const MAX_BYTES = 512 * 1024;
const USER_AGENT = 'JZClientForNode/1.3.8 (+https://github.com/laolibuhuifei/JZclient-for-node)';

function number(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function coordinates(latitude, longitude) {
  const lat = number(latitude);
  const lng = number(longitude);
  if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { latitude: lat, longitude: lng };
}

function validateDangerArea(body = {}) {
  const center = coordinates(body.latitude, body.longitude);
  if (!center) throw new Error('区域中心无效，请在地图上重新选择位置。');
  const radius = body.radius === undefined ? 300 : number(body.radius);
  if (radius == null || radius <= 0) throw new Error('区域半径必须大于 0 米。');
  return { ...center, radius };
}

// Public OSM search returns WGS-84. The existing AMap tile surface uses GCJ-02;
// convert only search coordinates, never previously stored watch positions.
function outsideChina(latitude, longitude) {
  return longitude < 72.004 || longitude > 137.8347 || latitude < .8293 || latitude > 55.8271;
}

function transformLatitude(x, y) {
  let result = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x));
  result += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  result += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  return result + (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
}

function transformLongitude(x, y) {
  let result = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x));
  result += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  result += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  return result + (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
}

function wgs84ToGcj02(latitude, longitude) {
  if (outsideChina(latitude, longitude)) return { latitude, longitude };
  const radians = latitude / 180 * Math.PI;
  const magic = 1 - .006693421622965943 * Math.sin(radians) ** 2;
  const root = Math.sqrt(magic);
  const latOffset = transformLatitude(longitude - 105, latitude - 35) * 180
    / ((6378245 * (1 - .006693421622965943)) / (magic * root) * Math.PI);
  const lngOffset = transformLongitude(longitude - 105, latitude - 35) * 180
    / (6378245 / root * Math.cos(radians) * Math.PI);
  return { latitude: latitude + latOffset, longitude: longitude + lngOffset };
}

function gcj02ToWgs84(latitude, longitude) {
  if (outsideChina(latitude, longitude)) return { latitude, longitude };
  let result = { latitude, longitude };
  for (let index = 0; index < 4; index++) {
    const shifted = wgs84ToGcj02(result.latitude, result.longitude);
    result = { latitude: result.latitude - (shifted.latitude - latitude), longitude: result.longitude - (shifted.longitude - longitude) };
  }
  return result;
}

function text(value) { return typeof value === 'string' ? value.trim().slice(0, 250) : ''; }

function normalizePlaces(payload, provider) {
  const rows = provider === 'photon' ? payload?.features : payload;
  if (!Array.isArray(rows)) throw new Error('地点搜索返回了无效数据。');
  const result = [];
  for (const row of rows) {
    const properties = provider === 'photon' ? row?.properties || {} : row || {};
    const raw = provider === 'photon'
      ? coordinates(row?.geometry?.coordinates?.[1], row?.geometry?.coordinates?.[0])
      : coordinates(row?.lat, row?.lon);
    if (!raw || (provider === 'photon' && row?.geometry?.type !== 'Point')) continue;
    const name = text(properties['name:zh']) || text(properties.name) || text(properties.display_name)?.split(',')[0];
    if (!name) continue;
    const parts = provider === 'photon'
      ? [properties.state, properties.city, properties.district, properties.street, properties.housenumber]
      : [properties.address?.state, properties.address?.city || properties.address?.town,
        properties.address?.city_district || properties.address?.suburb, properties.address?.road, properties.address?.house_number];
    const address = [...new Set(parts.map(text).filter(Boolean))].join(' · ') || text(properties.display_name) || text(properties.country);
    const center = wgs84ToGcj02(raw.latitude, raw.longitude);
    // OSM often describes one location with both a node and a building outline.
    if (result.some(place => place.name === name && Math.abs(place.latitude - center.latitude) < .0003
      && Math.abs(place.longitude - center.longitude) < .0003)) continue;
    result.push({
      id: `${provider}:${text(properties.osm_type) || 'place'}:${properties.osm_id ?? properties.place_id ?? result.length}`,
      name, address, ...center, coordinateSystem: 'gcj02', sourceCoordinateSystem: 'wgs84', provider,
    });
    if (result.length >= LIMIT) break;
  }
  return result;
}

function requestJson(url, { signal, timeoutMs = 7000, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !['photon.komoot.io', 'nominatim.openstreetmap.org'].includes(target.hostname)) {
      reject(new Error('地点搜索地址无效。')); return;
    }
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      error ? reject(error) : resolve(value);
    };
    const request = https.get(target, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=.9,en;q=.5' },
    }, response => {
      if (response.statusCode !== 200) {
        finish(new Error('地点搜索服务暂不可用，请稍后重试。')); response.destroy(); return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          const error = new Error('地点搜索响应过大，请缩小搜索范围。');
          finish(error); request.destroy(error); return;
        }
        chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new Error('地点搜索连接中断，请重试。')));
      response.on('end', () => {
        if (settled) return;
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(new Error('地点搜索返回了无效数据。')); }
      });
    });
    const aborted = () => request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('地点搜索已取消。'));
    request.on('error', error => finish(error));
    timer = setTimeout(() => request.destroy(new Error('地点搜索超时，请重试。')), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function cancelled(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('地点搜索已取消。');
}

function wait(ms, signal) {
  if (ms <= 0) { cancelled(signal); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('地点搜索已取消。')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function createPlaceSearch({ transport = requestJson, now = Date.now, cacheTtlMs = 180000, maxCacheEntries = 100, timeoutMs = 7000, requestIntervalMs = 1000 } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const nextRequest = { photon: 0, nominatim: 0 };
  const rateGate = { photon: Promise.resolve(), nominatim: Promise.resolve() };

  function startRequest(provider, signal) {
    const task = rateGate[provider].then(async () => {
      cancelled(signal);
      await wait(Math.max(0, nextRequest[provider] - now()), signal);
      cancelled(signal);
      nextRequest[provider] = now() + requestIntervalMs;
    });
    rateGate[provider] = task.catch(() => {});
    return task;
  }

  async function queryProvider(provider, query, bias, signal) {
    await startRequest(provider, signal);
    cancelled(signal);
    const url = new URL(provider === 'photon' ? PHOTON : NOMINATIM);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(LIMIT));
    if (provider === 'photon') {
      if (bias) { url.searchParams.set('lat', String(bias.latitude)); url.searchParams.set('lon', String(bias.longitude)); }
    } else {
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('accept-language', 'zh-CN,zh,en');
      if (bias) {
        const delta = .5;
        url.searchParams.set('viewbox', `${Math.max(-180, bias.longitude - delta)},${Math.min(90, bias.latitude + delta)},${Math.min(180, bias.longitude + delta)},${Math.max(-90, bias.latitude - delta)}`);
        url.searchParams.set('bounded', '0');
      }
    }
    const payload = await transport(url, { signal, timeoutMs, maxBytes: MAX_BYTES });
    cancelled(signal);
    return normalizePlaces(payload, provider);
  }

  async function perform(query, bias, signal) {
    let primaryFailed = false;
    try {
      const places = await queryProvider('photon', query, bias, signal);
      if (places.length) return { places, provider: 'photon', coordinateSystem: 'gcj02' };
    } catch (error) { cancelled(signal); primaryFailed = true; }
    try {
      const places = await queryProvider('nominatim', query, bias, signal);
      return { places, provider: 'nominatim', coordinateSystem: 'gcj02' };
    } catch (error) {
      cancelled(signal);
      if (!primaryFailed) return { places: [], provider: 'photon', coordinateSystem: 'gcj02' };
      throw new Error('地点搜索暂时无法连接，请重试，或直接在地图上选择。');
    }
  }

  return async function search({ q, latitude, longitude, signal } = {}) {
    cancelled(signal);
    const query = typeof q === 'string' ? q.trim().replace(/\s+/g, ' ') : '';
    if (Array.from(query).length < 2 || Array.from(query).length > 80) throw new Error('请输入 2～80 个字的地点关键词。');
    const hasBias = latitude !== undefined || longitude !== undefined;
    const center = hasBias ? coordinates(latitude, longitude) : null;
    if (hasBias && !center) throw new Error('搜索中心无效，请重新选择地图位置。');
    const key = `${query.toLocaleLowerCase()}|${center ? `${center.latitude.toFixed(3)},${center.longitude.toFixed(3)}` : ''}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < cacheTtlMs) {
      cache.delete(key); cache.set(key, cached);
      return structuredClone(cached.result);
    }
    if (cached) cache.delete(key);
    let entry = inFlight.get(key);
    if (!entry) {
      if (inFlight.size >= 8) throw new Error('地点搜索请求较多，请稍后重试。');
      const controller = new AbortController();
      entry = { controller, waiters: 0, promise: null };
      const bias = center ? gcj02ToWgs84(center.latitude, center.longitude) : null;
      entry.promise = perform(query, bias, controller.signal).then(result => {
        if (!controller.signal.aborted) {
          cache.set(key, { at: now(), result });
          while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
        }
        return result;
      }).finally(() => { if (inFlight.get(key) === entry) inFlight.delete(key); });
      inFlight.set(key, entry);
    }
    entry.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        entry.waiters--;
        if (!entry.waiters && inFlight.get(key) === entry) {
          inFlight.delete(key);
          entry.controller.abort(new Error('地点搜索已取消。'));
        }
        error ? reject(error) : resolve(structuredClone(value));
      };
      const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('地点搜索已取消。'));
      entry.promise.then(value => finish(null, value), error => finish(error));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
}

const searchPlaces = createPlaceSearch();

function readAuthStatus(backend, headers, signal) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/auth/status', backend);
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
      reject(new Error('本地鉴权服务地址无效。')); return;
    }
    const forwarded = {};
    for (const key of ['cookie', 'authorization']) if (typeof headers[key] === 'string') forwarded[key] = headers[key];
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const request = http.get(target, { headers: forwarded }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 16384) { const error = new Error('本地鉴权响应无效。'); finish(error); request.destroy(error); return; }
        chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new Error('本地鉴权连接中断。')));
      response.on('end', () => {
        try { finish(null, response.statusCode === 200 && JSON.parse(Buffer.concat(chunks).toString('utf8'))?.data?.authed === true); }
        catch { finish(new Error('本地鉴权响应无效。')); }
      });
    });
    const abort = () => request.destroy(new Error('地点搜索已取消。'));
    request.on('error', error => finish(error));
    timer = setTimeout(() => request.destroy(new Error('本地鉴权超时，请重试。')), 3000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

// The development WebUI reuses the running backend's auth status. Only this
// read-only route is served here; other API traffic remains in Vite's proxy.
function createDevSearchMiddleware({ backend = 'http://127.0.0.1:8787', search = searchPlaces, authStatus = readAuthStatus } = {}) {
  return async function placeSearchMiddleware(req, res, next) {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch { return next(); }
    if (!/^\/api\/map\/search\/?$/.test(url.pathname)) return next();
    const json = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return json(405, { ok: false, error: '地点搜索仅支持读取。' });
    const controller = new AbortController();
    const closed = () => { if (!res.writableEnded) controller.abort(new Error('地点搜索已取消。')); };
    res.once('close', closed);
    try {
      if (!await authStatus(backend, req.headers, controller.signal)) {
        return json(401, { ok: false, unauthorized: true, error: '未授权，请先输入访问令牌。' });
      }
      const result = await search({ q: url.searchParams.get('q') || '',
        latitude: url.searchParams.has('latitude') ? url.searchParams.get('latitude') : undefined,
        longitude: url.searchParams.has('longitude') ? url.searchParams.get('longitude') : undefined,
        signal: controller.signal });
      json(200, { ok: true, data: result });
    } catch (error) {
      if (!controller.signal.aborted) json(200, { ok: false, error: error?.message || '地点搜索失败，请重试。' });
    } finally { res.removeListener('close', closed); }
  };
}

module.exports = { searchPlaces, createPlaceSearch, createDevSearchMiddleware, validateDangerArea, wgs84ToGcj02, gcj02ToWgs84, normalizePlaces, requestJson };
