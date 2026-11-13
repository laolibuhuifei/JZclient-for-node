'use strict';

// 会话列表的归一化：把 /dialogaccount/merge/accounts 的 familyDialogs 转成
// 聊天面板/发送/AI/OneBot 共用的 targets。
//
// 按明确的会话 key 去重，并为每个手表账号建立单聊。
// 家庭成员相同并不能证明两个群是同一个群，不能仅凭成员合并群 ID。

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

function watchAccounts(accounts) {
  return (accounts || []).filter((a) => a && Number(a.accountType) === 1 && a.imAccountId != null);
}

function buildChatTargets(familyDialogs) {
  const targets = [];
  const byKey = new Map();

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

    const ids = chatIdsOf(fd, family);
    if (!ids.length) return;
    // 仅在主 ID 一致时去重。不同主 ID 即使成员相同也可能是不同群；
    // 不能推断它们是新旧关系，否则消息可能归档或回复到错误的群。
    add({
      key: 'g:' + ids[0],
      type: 'group',
      name: '家庭群',
      sub: accounts.map((a) => a && a.name).filter(Boolean).join('、'),
      dialogId: ids[0],
      aliasIds: ids,
      peers: accounts,
    });
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
