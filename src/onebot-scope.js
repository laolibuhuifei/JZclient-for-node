'use strict';

// 未绑定手表的旧式全局实例保持兼容；绑定手表时空范围必须拒绝所有会话。
function createOnebotScope(watchId, scopeKeys) {
  const bound = watchId !== null && watchId !== undefined && String(watchId) !== '';
  const keys = new Set(Array.isArray(scopeKeys) ? scopeKeys : []);
  return {
    allows: (key) => !bound || keys.has(key),
    filter: (targets) => bound ? targets.filter((target) => keys.has(target.key)) : targets.slice(),
  };
}

module.exports = { createOnebotScope };
