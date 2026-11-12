'use strict';

// 在 connect() 前安装；激活前暂存消息，激活后按到达顺序同步转交。
// 这是内存缓冲，不是持久化队列；进程退出或连接失败时不能保证消息不丢。
function bufferEarlyMessages(client, onMessage, options = {}) {
  const limit = options.limit == null ? 1000 : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  const onOverflow = options.onOverflow || (() => {});
  const onError = options.onError || (() => {});
  let queue = [];
  let active = false;
  let draining = false;
  let disposed = false;

  function drain() {
    if (!active || draining || disposed) return;
    draining = true;
    try {
      while (queue.length && !disposed) {
        const entry = queue.shift();
        try { onMessage(entry.message, entry.buffered); } catch (err) { onError(err); }
      }
    } finally { draining = false; }
  }
  function listener(message) {
    if (disposed) return;
    if (queue.length >= limit) { onOverflow(message); return; }
    queue.push({ message, buffered: !active });
    drain();
  }
  client.on('message', listener);
  return {
    activate() { if (!disposed) { active = true; drain(); } },
    dispose() {
      if (disposed) return 0;
      disposed = true;
      client.removeListener('message', listener);
      const dropped = queue.length;
      queue = [];
      return dropped;
    },
  };
}

module.exports = { bufferEarlyMessages };
