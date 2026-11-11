'use strict';
// 回归：本地模式（bin/daemon.js）首次登录必须先把设备身份补齐。
//
// 2026-11-11 的真实故障：全新配置里 ssoMac 是 null，ssoSign 会跳过 null 参数、
// 请求体却发出 mac=，两边签名不一致 → /app/rsakey 回 010401「签名无效」。
// 云端实例的 launcher.js 一直调了 ensureIdentity，只有安卓本地模式的 daemon.js 漏了。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('全新配置：ensureIdentity 会生成并持久化 ssoMac', () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jzid-'));
  const old = process.env.HOME;
  process.env.HOME = HOME;
  try {
    // USER_DIR / CONFIG_FILE 在 require 时就算好了，所以必须在改 HOME 之后加载
    delete require.cache[require.resolve('../src/device')];
    const device = require('../src/device');
    const raw = device.load();
    assert.equal(raw.ssoMac, null, '全新配置本来就没有 ssoMac');

    const cfg = device.ensureIdentity(raw);
    assert.match(String(cfg.ssoMac), /^[0-9a-f]{32}$/, 'ssoMac 应是 32 位小写 hex');
    assert.ok(cfg.deviceId && cfg.nDeviceId && cfg.machineId, 'deviceId / nDeviceId / machineId 也要补齐');

    const again = device.load();
    assert.equal(again.ssoMac, cfg.ssoMac, '必须写进配置文件，否则每次启动都会变');
  } finally {
    if (old === undefined) delete process.env.HOME; else process.env.HOME = old;
    delete require.cache[require.resolve('../src/device')];
  }
});

test('本地模式入口在起 WebUI 之前就补齐身份', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'daemon.js'), 'utf8');
  assert.match(src, /ensureIdentity\(device\.load\(\)\)/,
    'bin/daemon.js 必须 ensureIdentity(device.load())，否则 APP 首次登录 010401');
});

test('startWebUI 自己也兜底补一次身份', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'webui.js'), 'utf8');
  const i = src.indexOf('async function startWebUI');
  assert.ok(i > 0, '找不到 startWebUI');
  const head = src.slice(i, i + 1200);
  assert.match(head, /device\.ensureIdentity\(cfg\)/, 'startWebUI 开头应补设备身份');
});

test('SSO 表单体和签名用同一套 null 过滤', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'sso.js'), 'utf8');
  assert.match(src, /filter\(\(\[, v\]\) => v !== null && v !== undefined\)/,
    '请求体要把 null/undefined 剔掉，不能编码成空串（签名会跳过它们）');
});
