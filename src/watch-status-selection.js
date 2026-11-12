'use strict';

// 只接受明确的百分比，拒绝空字符串、布尔值和越界值；0 是有效电量。
function batteryValue(value) {
  if (typeof value === 'string') {
    if (!/^\s*\d+(?:\.\d+)?\s*$/.test(value)) return null;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

// 时间必须由调用者明确标注为设备采样时间或本机接收时间，不能混作一谈。
function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function candidate(value, source, at, timeKind) {
  const battery = batteryValue(value);
  if (battery === null) return null;
  const time = timestamp(at);
  const kind = time && (timeKind === 'observed' || timeKind === 'received') ? timeKind : null;
  return { battery, batterySource: source, batteryAt: kind ? time : null, batteryTimeKind: kind };
}

// 默认以接口为准：无可比较的设备采样时间时，不推断推送必定更新。
// 双方都具有可信的设备采样时间才按时间选；相等时保留接口。
// 参数中的 apiAt / pushAt 都必须是毫秒时间戳，timeKind 由调用方依据协议指定。
function selectBattery({ apiValue, apiAt, apiTimeKind, pushValue, pushAt, pushTimeKind } = {}) {
  const api = candidate(apiValue, 'api', apiAt, apiTimeKind);
  const push = candidate(pushValue, 'push', pushAt, pushTimeKind);
  if (!api) return push || { battery: null, batterySource: null, batteryAt: null, batteryTimeKind: null };
  if (!push) return api;
  if (api.batteryTimeKind === 'observed' && push.batteryTimeKind === 'observed' && push.batteryAt > api.batteryAt) return push;
  return api;
}

// 无字段、未识别类型或两个字段冲突都是未知，不把缺失转为离线。
function selectOnline(online, watchOnline) {
  const values = [online, watchOnline].filter((v) => typeof v === 'boolean');
  if (!values.length || (values.includes(true) && values.includes(false))) return null;
  return values[0];
}

module.exports = { batteryValue, selectBattery, selectOnline };
