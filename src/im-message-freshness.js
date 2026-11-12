'use strict';

const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

// tag17 的单位尚未确认：假设整数 Unix 秒为 10 位，整数 Unix 毫秒为 13 位。
// 不猜测其他长度、字符串、浮点数或不安全整数，避免把异常值当成可信时间。
function timestampMs(value) {
  if (!Number.isSafeInteger(value)) return null;
  if (value >= 1_000_000_000 && value <= 9_999_999_999) return value * 1000;
  if (value >= 1_000_000_000_000 && value <= 9_999_999_999_999) return value;
  return null;
}

// 仅决定是否允许自动回复、插件命令和其他副作用；调用方仍须正常展示/入库消息。
// now 为 Unix 毫秒，显式传入使此函数纯净且便于测试。
function allowMessageSideEffects(message, now) {
  if (!message || (message.source !== 'push' && message.source !== 'sync')) return false;
  if (!Number.isSafeInteger(now) || now <= 0) return false;
  const value = message.createTime;
  // 上游缺少 tag17 时填 0；仅实时 push 对缺失时间放行，其他无效值不放行。
  if (value === undefined || value === null || value === 0) return message.source === 'push';
  const time = timestampMs(value);
  if (time === null) return false;
  return time >= now - MAX_AGE_MS && time <= now + MAX_FUTURE_SKEW_MS;
}

module.exports = { allowMessageSideEffects, MAX_AGE_MS, MAX_FUTURE_SKEW_MS };
