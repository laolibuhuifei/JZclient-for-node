'use strict';
// 插件加载器的相对引用解析 —— 2026-11-11 两个上架插件全挂在这：
//   lib/novel.js 里 require('./yunzhi') 被解析成 <root>/yunzhi.js（实际在 lib/ 下）
//   → 「找不到插件内的文件: ./yunzhi」，安装成功但加载失败。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// USER_DIR 在模块加载时就算好了，所以必须先改 HOME 再 require
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jzplug-'));
process.env.HOME = HOME;
const PLUGINS = path.join(HOME, '.watch-parent-cli', 'plugins');

function write(rel, content) {
  const f = path.join(PLUGINS, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

function mkPlugin(id, files) {
  write(id + '/plugin.json', JSON.stringify({
    id, name: id, version: '1.0.0', main: 'main.js',
  }, null, 2));
  for (const [rel, code] of Object.entries(files)) write(id + '/' + rel, code);
}

// 三层：main.js → lib/a.js → ./b（b 与 a 同目录）+ 跨目录 ../core
mkPlugin('nested-ok', {
  'main.js': [
    "const a = require('./lib/a');",
    "const core = require('./core');",
    'module.exports = { onLoad() {}, value: a.value, core: core.name };',
  ].join('\n'),
  'lib/a.js': [
    "const b = require('./b');",
    "const j = require('./data.json');",
    'module.exports = { value: b.value * 2, extra: j.k };',
  ].join('\n'),
  'lib/b.js': "module.exports = { value: 21 };",
  'lib/data.json': '{ "k": "ok" }',
  'core.js': "module.exports = { name: 'core' };",
});

// 目录逃逸必须仍然被拒
mkPlugin('escape-bad', {
  'main.js': "require('./lib/x');\nmodule.exports = { onLoad() {} };",
  'lib/x.js': "require('../../../../../etc/passwd');\nmodule.exports = {};",
});

const { PluginManager } = require('../src/plugin.js');

test('子目录里的 ./x 以文件自身目录为基准', async () => {
  const mgr = new PluginManager({ host: {}, cfg: { plugins: { disabled: ['watch-daily', 'watch-stats'] } } });
  await mgr.init();

  const p = mgr.plugins.get('nested-ok');
  assert.ok(p, '插件应被扫描到');
  assert.equal(p.error, '', '加载不应报错：' + p.error);
  assert.equal(p.loaded, true, '应加载成功');
  assert.equal(p.exports.value, 42, 'lib/a.js 里 require("./b") 应命中 lib/b.js');
  assert.equal(p.exports.core, 'core', 'main.js 里 require("./core") 应命中根目录 core.js');
});

test('子目录里 require JSON 也按自身目录解析', async () => {
  const mgr = new PluginManager({ host: {}, cfg: { plugins: { disabled: ['watch-daily', 'watch-stats'] } } });
  await mgr.init();
  const p = mgr.plugins.get('nested-ok');
  // exports.extra 没导出，用模块内部值间接验证：a.value 已用到 data.json 之外的东西，
  // 这里单独读 a 模块不可行，改为断言加载没报错即可（JSON 解析失败会抛）
  assert.equal(p.loaded, true);
});

test('往插件目录外逃的引用仍然被拒绝', async () => {
  const mgr = new PluginManager({ host: {}, cfg: { plugins: { disabled: ['watch-daily', 'watch-stats'] } } });
  await mgr.init();
  const p = mgr.plugins.get('escape-bad');
  assert.ok(p, '插件应被扫描到');
  assert.equal(p.loaded, false, '不应加载成功');
  assert.match(p.error, /插件不能引用自己目录之外的文件/);
});
