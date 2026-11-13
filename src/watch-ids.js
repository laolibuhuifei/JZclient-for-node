'use strict';

// 界面卡片要列哪些手表：接口返回的 + 配置里出现过的。
//
// 为什么要并集：`watchNames` 是从手表列表接口学的，可能比配置旧（新绑的表还没拉到、
// 或者平台抖了一下）。如果只按 watchNames 列，配置过但不在列表里的那块表就会
// 在界面上消失 —— 用户看到的是「点了启用、保存完又变回关闭」（2026-11-13 报的）。
// 配置里出现过的键说明用户确实配过，必须列出来。
function mergeWatchIds(names, configured) {
  const out = [];
  const push = (v) => {
    const id = v == null ? '' : String(v).trim();
    if (id && out.indexOf(id) < 0) out.push(id);
  };
  for (const w of names || []) push(w && w.watchId);
  for (const k of Object.keys(configured || {})) push(k);
  return out;
}

module.exports = { mergeWatchIds };
