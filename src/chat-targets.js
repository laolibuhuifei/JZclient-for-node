'use strict';

// 会话列表的归一化：把 /dialogaccount/merge/accounts 的 familyDialogs 转成
// 聊天面板/发送/AI/OneBot 共用的 targets。
//
// 两件线上真踩过的事：
//   1. 同一个家庭在 familyDialogs 里可能出现两条（服务端合并账期数据时会这样），
//      原来逐条 push，聊天列表里就出现两遍「家庭群」和同名单聊。
//   2. 一个家庭可以绑多块表，原来用 accounts.find(accountType === 1) 只取第一块，
//      第二块表在列表里直接不存在 —— 用户看到「绑了四块，只显示三块」。

// 家庭群的 IM 会话 ID 服务端有两个字段：imDialogId（旧）和 upgradeImDialogId（新）。
// 迁移期间三种状态都有：两个相同 / 只有 upgrade / 旧值还在但已过期。
// 所以所有候选都收进数组，发送用第一个（优先 upgrade），匹配时任一中就算命中。
function idsOf(fd, family) {
  const up = [
    fd && fd.upgradeImDialogId,
    family && family.upgradeImDialogId,
  ];
  const old = [
    fd && fd.imDialogId,
    family && family.imDialogId,
  ];
  const clean = (list) => {
    const out = [];
    for (const v of list) {
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (!s || s === '0' || s === 'null' || s === 'undefined') continue;
      if (out.indexOf(s) < 0) out.push(s);
    }
    return out;
  };
  return { up: clean(up), old: clean(old) };
}

// 兼容旧调用：返回「发送优先、匹配全认」的 ID 数组
function chatIdsOf(fd, family) {
  const { up, old } = idsOf(fd, family);
  const out = up.slice();
  for (const id of old) if (out.indexOf(id) < 0) out.push(id);
  return out;
}

function mergeInto(list, add) {
  for (const v of add) if (list.indexOf(v) < 0) list.push(v);
  return list;
}

// 同一个家庭的指纹：成员 IM 账号集合。为空时退回群 ID，避免把不同家庭误并。
function familyFingerprint(accounts, ids) {
  const keys = (accounts || [])
    .map((a) => (a && a.imAccountId != null ? String(a.imAccountId) : ''))
    .filter(Boolean)
    .sort();
  return keys.length ? 'f:' + keys.join('|') : 'g:' + ids[0];
}

function watchAccounts(accounts) {
  return (accounts || []).filter((a) => a && Number(a.accountType) === 1 && a.imAccountId != null);
}

function buildChatTargets(familyDialogs) {
  const targets = [];
  const byKey = new Map();
  const byFamily = new Map();

  function add(target) {
    const hit = byKey.get(target.key);
    if (hit) {
      // 同一会话重复出现：只保留一条，但把成员表补齐（名字/群成员可能来自不同记录）
      if (target.peers && target.peers.length && (!hit.peers || !hit.peers.length)) hit.peers = target.peers;
      return hit;
    }
    byKey.set(target.key, target);
    targets.push(target);
    return target;
  }

  (familyDialogs || []).forEach((fd) => {
    const family = (fd && fd.familyList && fd.familyList[0]) || {};
    const accounts = family.accounts || [];

    // 一个家庭里的每块表都要有自己的单聊，不能只取第一块
    watchAccounts(accounts).forEach((watch) => {
      add({
        key: 's:' + watch.imAccountId,
        type: 'single',
        name: watch.name || '手表',
        sub: [watch.model, '单聊'].filter(Boolean).join(' '),
        receiverId: watch.imAccountId,
        peers: accounts,
      });
    });

    const { up, old } = idsOf(fd, family);
    const ids = chatIdsOf(fd, family);
    if (!ids.length) return;

    const fp = familyFingerprint(accounts, ids);
    const hit = byFamily.get(fp);
    if (hit) {
      // 同一家庭的两条记录：合并 ID（upgrade 始终排在前面，发送要用它）
      mergeInto(hit.up, up);
      mergeInto(hit.old, old);
      hit.aliasIds = hit.up.concat(hit.old.filter((id) => hit.up.indexOf(id) < 0));
      const primary = hit.aliasIds[0];
      if (primary && primary !== hit.dialogId) {
        const nextKey = 'g:' + primary;
        if (!byKey.has(nextKey)) {
          byKey.delete(hit.key);
          byKey.set(nextKey, hit);
          hit.key = nextKey;
        }
        hit.dialogId = primary;
      }
      if (accounts.length && (!hit.peers || !hit.peers.length)) hit.peers = accounts;
      return;
    }

    const group = {
      key: 'g:' + ids[0],
      type: 'group',
      name: '家庭群',
      sub: accounts.map((a) => a && a.name).filter(Boolean).join('、'),
      dialogId: ids[0],
      aliasIds: ids,
      peers: accounts,
      up: up.slice(),
      old: old.slice(),
    };
    byFamily.set(fp, group);
    add(group);
  });

  // up/old 只是合并时用的中间状态，不往外带
  return targets.map((t) => {
    const out = Object.assign({}, t);
    delete out.up;
    delete out.old;
    return out;
  });
}

module.exports = { buildChatTargets, chatIdsOf };
