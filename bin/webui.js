#!/usr/bin/env node
'use strict';

// Direct WebUI entry point. Uses the same persisted account/configuration as the CLI.
const device = require('../src/device');
const { startWebUI } = require('../src/webui');

function argument(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

let app;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(0), 3000);
  timer.unref();
  try { if (app) await app.close(); } finally { process.exit(0); }
}
process.on('SIGINT', close);
process.on('SIGTERM', close);

(async () => {
  const cfg = device.load();
  const host = argument('host', cfg.webui.host || '127.0.0.1');
  const port = Number(argument('port', cfg.webui.port || 8787));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数');
  app = await startWebUI({ cfg, host, port });
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : (host.includes(':') ? `[${host}]` : host);
  console.log(`\nWebUI 已启动：http://${browserHost}:${port}`);
  console.log(`访问令牌：${app.token}`);
  console.log('使用 Ctrl+C 停止服务。');
})().catch(error => {
  console.error('WebUI 启动失败：' + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
