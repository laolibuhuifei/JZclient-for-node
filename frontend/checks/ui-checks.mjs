import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import React, { act, useState } from 'react';
import { JSDOM } from 'jsdom';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const globalOverrides = new WeakMap();
let directory;
let filename;
let components;

test.before(async () => {
  const cache = path.join(frontend, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(path.join(cache, 'ui-checks-'));
  filename = path.join(directory, 'ui.mjs');
  const result = await build({
    absWorkingDir: frontend,
    stdin: {
      contents: `export { Button, Field, Input, Select, Modal, Tabs, Textarea, Toggle } from './src/components/ui';`,
      loader: 'tsx', resolveDir: frontend, sourcefile: 'ui-checks-entry.tsx',
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node18', packages: 'external',
    loader: { '.css': 'empty' }, outfile: filename, write: false,
  });
  await writeFile(filename, result.outputFiles[0].contents);
  components = await import(pathToFileURL(filename).href);
});

test.after(async () => {
  if (filename) await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (directory) await rmdir(directory);
});

function replaceGlobal(t, key, value) {
  let originals = globalOverrides.get(t);
  if (!originals) {
    originals = new Map();
    globalOverrides.set(t, originals);
    t.after(() => {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    });
  }
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

async function mountUi(t, Harness) {
  const dom = new JSDOM('<!doctype html><html><body><main id="fixture"></main></body></html>', {
    url: 'http://127.0.0.1/', pretendToBeVisual: true,
  });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent']) {
    replaceGlobal(t, key, dom.window[key]);
  }
  replaceGlobal(t, 'IS_REACT_ACT_ENVIRONMENT', true);
  const requests = [];
  replaceGlobal(t, 'fetch', (...args) => {
    requests.push(args);
    return Promise.reject(new Error('共享控件交互测试不得调用网络'));
  });
  t.after(() => assert.deepEqual(requests, [], '共享控件交互必须保持离线'));
  t.after(() => dom.window.close());
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('fixture');
  const root = createRoot(container);
  const close = () => act(async () => root.unmount());
  try {
    await act(async () => { root.render(React.createElement(Harness)); await delay(0); });
  } catch (error) { await close(); throw error; }
  return { dom, container, close };
}

async function click(element) {
  await act(async () => { element.click(); await delay(0); });
}

async function key(element, keyName, options = {}) {
  const event = new element.ownerDocument.defaultView.KeyboardEvent('keydown', {
    key: keyName, bubbles: true, cancelable: true, ...options,
  });
  await act(async () => { element.dispatchEvent(event); await delay(0); });
  return event;
}

function dialog(ui) {
  const panel = ui.dom.window.document.querySelector('[role="dialog"][aria-modal="true"]');
  assert.ok(panel, '弹窗应作为有名称的模态对话框存在');
  return panel;
}

function accessibleName(element) {
  const ids = element.getAttribute('aria-labelledby');
  if (ids) return ids.split(/\s+/).map(id => element.ownerDocument.getElementById(id)?.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
  const explicit = element.getAttribute('aria-label');
  if (explicit) return explicit;
  return (element.closest('label')?.textContent || element.textContent || '').replace(/\s+/g, ' ').trim();
}

test('发送期间修改弹窗关闭权限保留编辑焦点，恢复后 Escape 关闭并返回入口', async t => {
  const controls = { closed: 0 };
  function Harness() {
    const [open, setOpen] = useState(false);
    const [closeable, setCloseable] = useState(true);
    controls.setCloseable = setCloseable;
    return React.createElement(React.Fragment, null,
      React.createElement(components.Button, { onClick: () => setOpen(true) }, '打开编辑窗口'),
      React.createElement(components.Modal, {
        open, closeable, title: '编辑消息',
        onClose: () => { controls.closed++; setOpen(false); },
      }, React.createElement(components.Textarea, { 'aria-label': '未发送内容', defaultValue: '尚未发送的消息内容' })),
    );
  }
  const ui = await mountUi(t, Harness);
  try {
    const opener = ui.container.querySelector('button');
    opener.focus();
    ui.dom.window.document.body.style.overflow = 'auto';
    await click(opener);
    const editor = dialog(ui).querySelector('textarea');
    editor.focus();
    editor.setSelectionRange(2, 6);
    assert.equal(ui.dom.window.document.activeElement, editor);

    await act(async () => { controls.setCloseable(false); await delay(0); });
    assert.equal(ui.dom.window.document.activeElement, editor, '发送开始不应把焦点恢复到入口或移动到弹窗标题');
    assert.equal(dialog(ui).querySelector('textarea'), editor, '发送状态不应卸载编辑控件');
    assert.equal(editor.value, '尚未发送的消息内容');
    assert.equal(editor.selectionStart, 2);
    assert.equal(editor.selectionEnd, 6);
    assert.equal(dialog(ui).querySelector('button[aria-label="关闭弹窗"]'), null, '发送中不显示无效关闭按钮');
    await key(editor, 'Escape');
    assert.equal(controls.closed, 0, '发送中 Escape 不得结束正在处理的弹窗');
    const backdrop = ui.dom.window.document.querySelector('.modal-backdrop');
    await act(async () => { backdrop.dispatchEvent(new ui.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); await delay(0); });
    assert.equal(controls.closed, 0, '发送中点击遮罩不得关闭');
    assert.equal(ui.dom.window.document.body.style.overflow, 'hidden', '弹窗持续打开时保留页面滚动锁');

    await act(async () => { controls.setCloseable(true); await delay(0); });
    assert.equal(ui.dom.window.document.activeElement, editor, '发送结束不应重置正在编辑的焦点');
    assert.equal(editor.selectionStart, 2);
    await key(editor, 'Escape');
    assert.equal(controls.closed, 1);
    assert.equal(ui.dom.window.document.querySelector('[role="dialog"][aria-modal="true"]'), null);
    assert.equal(ui.dom.window.document.activeElement, opener, '关闭后回到打开弹窗的按钮');
    assert.equal(ui.dom.window.document.body.style.overflow, 'auto', '关闭后恢复原滚动设置');
  } finally { await ui.close(); }
});

test('可关闭弹窗点击遮罩会阻止默认抢焦点，并恢复打开入口', async t => {
  const controls = { closed: 0 };
  function Harness() {
    const [open, setOpen] = useState(false);
    return React.createElement(React.Fragment, null,
      React.createElement(components.Button, { onClick: () => setOpen(true) }, '查看配置'),
      React.createElement(components.Modal, {
        open, title: '配置快照', onClose: () => { controls.closed++; setOpen(false); },
      }, React.createElement(components.Input, { 'aria-label': '配置说明', defaultValue: '保留内容' })),
    );
  }
  const ui = await mountUi(t, Harness);
  try {
    const opener = ui.container.querySelector('button');
    opener.focus();
    await click(opener);
    dialog(ui).querySelector('input').focus();
    const event = new ui.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => { ui.dom.window.document.querySelector('.modal-backdrop').dispatchEvent(event); await delay(0); });
    assert.equal(event.defaultPrevented, true, '遮罩不应在关闭后把焦点从入口抢到 body');
    assert.equal(controls.closed, 1);
    assert.equal(ui.dom.window.document.activeElement, opener);
    assert.equal(ui.dom.window.document.querySelector('[role="dialog"][aria-modal="true"]'), null);
  } finally { await ui.close(); }
});

test('两个弹窗重叠时 Escape 只关闭顶层，逐层恢复焦点与页面滚动', async t => {
  const closed = [];
  function Harness() {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [updateOpen, setUpdateOpen] = useState(false);
    return React.createElement(React.Fragment, null,
      React.createElement(components.Button, { onClick: () => setSettingsOpen(true) }, '打开设备设置'),
      React.createElement(components.Modal, {
        open: settingsOpen, title: '设备设置',
        onClose: () => { closed.push('settings'); setSettingsOpen(false); },
      },
      React.createElement(components.Input, { 'aria-label': '设备名称', defaultValue: '仍在编辑的手表' }),
      React.createElement(components.Button, { onClick: () => setUpdateOpen(true), 'data-test': 'open-update' }, '查看更新提示')),
      React.createElement(components.Modal, {
        open: updateOpen, title: '版本更新',
        onClose: () => { closed.push('update'); setUpdateOpen(false); },
      }, React.createElement(components.Input, { 'aria-label': '更新说明', defaultValue: '本地模拟更新，无网络请求' })),
    );
  }
  const ui = await mountUi(t, Harness);
  try {
    const document = ui.dom.window.document;
    const opener = ui.container.querySelector('button');
    document.body.style.overflow = 'auto';
    opener.focus();
    await click(opener);
    const settings = dialog(ui);
    const editor = settings.querySelector('input[aria-label="设备名称"]');
    const updateTrigger = settings.querySelector('button[data-test="open-update"]');
    updateTrigger.focus();
    await click(updateTrigger);
    const panels = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
    assert.equal(panels.length, 2, '更新提示与原编辑弹窗应同时存在');
    const update = panels[1];
    assert.equal(document.getElementById(update.getAttribute('aria-labelledby'))?.textContent, '版本更新');
    assert.ok(update.contains(document.activeElement), '最上层弹窗接收初始焦点');
    update.querySelector('input').focus();
    await key(document.activeElement, 'Escape');

    assert.deepEqual(closed, ['update'], '首次 Escape 只关闭最后打开的更新提示');
    assert.equal(document.querySelectorAll('[role="dialog"][aria-modal="true"]').length, 1);
    assert.ok(settings.isConnected, '下层设置弹窗继续打开');
    assert.ok(document.activeElement === updateTrigger, '关闭顶层后回到下层的打开入口');
    assert.equal(editor.value, '仍在编辑的手表', '上层弹窗不应重建或清空下层表单');
    assert.equal(document.body.style.overflow, 'hidden', '下层仍打开时保留页面滚动锁');

    await key(document.activeElement, 'Escape');
    assert.deepEqual(closed, ['update', 'settings'], '第二次 Escape 才关闭下层弹窗');
    assert.equal(document.querySelectorAll('[role="dialog"][aria-modal="true"]').length, 0);
    assert.ok(document.activeElement === opener, '全部关闭后回到页面打开入口');
    assert.equal(document.body.style.overflow, 'auto', '最后一个弹窗关闭后恢复原页面滚动');
  } finally { await ui.close(); }
});

test('禁用 fieldset 不进入弹窗焦点顺序，保存失焦时 Tab 回到弹窗，恢复后可继续导航', async t => {
  const controls = {};
  function Harness() {
    const [open, setOpen] = useState(false);
    const [fieldsetDisabled, setFieldsetDisabled] = useState(true);
    const [busy, setBusy] = useState(false);
    controls.setFieldsetDisabled = setFieldsetDisabled;
    controls.setBusy = setBusy;
    return React.createElement(React.Fragment, null,
      React.createElement(components.Button, { onClick: () => setOpen(true) }, '编辑设备资料'),
      React.createElement(components.Modal, {
        open, closeable: false, title: '保存设备资料', onClose: () => setOpen(false),
        footer: React.createElement(React.Fragment, null,
          React.createElement(components.Button, { disabled: busy, 'data-test': 'cancel' }, '取消'),
          React.createElement(components.Button, { loading: busy, 'data-test': 'save' }, '保存设置'),
        ),
      }, React.createElement('fieldset', { disabled: fieldsetDisabled },
        React.createElement('legend', null, '设备字段'),
        React.createElement(components.Input, { 'aria-label': '设备名称', defaultValue: '太阳手表' }),
        React.createElement(components.Input, { 'aria-label': '手表号码', defaultValue: '13900000000' }),
      )),
    );
  }
  const ui = await mountUi(t, Harness);
  try {
    const opener = ui.container.querySelector('button');
    opener.focus();
    await click(opener);
    const panel = dialog(ui);
    const editor = panel.querySelector('input[aria-label="设备名称"]');
    const cancel = panel.querySelector('button[data-test="cancel"]');
    const save = panel.querySelector('button[data-test="save"]');
    assert.equal(editor.disabled, false, '子输入框本身不必具有 disabled 属性');
    assert.equal(editor.matches(':disabled'), true, 'HTML fieldset 禁用状态传递给子输入框');
    assert.ok(ui.dom.window.document.activeElement === cancel, '初次聚焦应跳过 fieldset 中继承禁用的输入框');

    // JSDOM does not lay out elements. Supply only the visibility information
    // needed by the real focus selector; native :disabled still decides eligibility.
    for (const element of panel.querySelectorAll('button,input')) {
      element.getClientRects = () => [new ui.dom.window.DOMRect(0, 0, 80, 44)];
    }
    await key(cancel, 'Tab', { shiftKey: true });
    assert.ok(ui.dom.window.document.activeElement === save, '反向 Tab 只在 fieldset 外的可用按钮之间循环');
    await key(save, 'Tab');
    assert.ok(ui.dom.window.document.activeElement === cancel, '正向 Tab 返回 fieldset 外首个可用按钮');

    await act(async () => { controls.setFieldsetDisabled(false); await delay(0); });
    editor.focus();
    assert.ok(ui.dom.window.document.activeElement === editor, '可编辑字段应能获得焦点');
    await act(async () => { controls.setFieldsetDisabled(true); controls.setBusy(true); await delay(0); });
    assert.equal(editor.matches(':disabled'), true);
    assert.equal(cancel.disabled, true);
    assert.equal(save.disabled, true);
    // Browsers may drop focus when its input becomes disabled during saving.
    // JSDOM keeps it, so model that observed browser state explicitly.
    ui.dom.window.document.body.tabIndex = -1;
    ui.dom.window.document.body.focus();
    assert.ok(ui.dom.window.document.activeElement === ui.dom.window.document.body, '已模拟禁用输入后浏览器失焦状态');
    const trapped = await key(ui.dom.window.document.body, 'Tab');
    assert.equal(trapped.defaultPrevented, true, '保存状态失焦后的 Tab 不能进入遮罩后的页面');
    assert.ok(ui.dom.window.document.activeElement === panel, '没有可用控件时把焦点放在对话框本身');

    await act(async () => { controls.setFieldsetDisabled(false); controls.setBusy(false); await delay(0); });
    await key(panel, 'Tab', { shiftKey: true });
    assert.ok(ui.dom.window.document.activeElement === save, '保存结束后可重新导航到有效操作');
    await key(save, 'Tab');
    assert.ok(ui.dom.window.document.activeElement === editor, '重新启用的表单字段恢复到正常焦点顺序');
    assert.equal(editor.value, '太阳手表', '忙碌状态和焦点恢复不应丢失编辑内容');
  } finally { await ui.close(); }
});

test('分段选项支持方向键和首尾键，跳过禁用项并只保留一个 Tab 入口', async t => {
  const changes = [];
  function Harness() {
    const [value, setValue] = useState('text');
    return React.createElement(components.Tabs, {
      value,
      items: [
        { value: 'text', label: '文字' },
        { value: 'recording', label: '正在录音', disabled: true },
        { value: 'image', label: '图片' },
        { value: 'link', label: '链接' },
      ],
      onChange: next => { changes.push(next); setValue(next); },
    });
  }
  const ui = await mountUi(t, Harness);
  try {
    const tabs = [...ui.container.querySelectorAll('[role="tab"]')];
    const assertSelection = expected => {
      assert.deepEqual(tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.textContent), [expected]);
      assert.deepEqual(tabs.filter(tab => tab.tabIndex === 0).map(tab => tab.textContent), [expected], '只有选中的可用项进入页面 Tab 顺序');
      assert.equal(tabs[1].disabled, true);
      assert.equal(tabs[1].tabIndex, -1, '禁用项不得成为键盘入口');
    };
    assertSelection('文字');
    tabs[0].focus();
    const steps = [
      ['ArrowRight', '图片'], ['ArrowRight', '链接'], ['ArrowRight', '文字'],
      ['ArrowLeft', '链接'], ['Home', '文字'], ['End', '链接'],
    ];
    for (const [keyName, expected] of steps) {
      const event = await key(ui.dom.window.document.activeElement, keyName);
      assert.equal(event.defaultPrevented, true, '已处理的方向键不应滚动页面');
      assertSelection(expected);
      assert.equal(ui.dom.window.document.activeElement.textContent, expected, '选中变化与键盘焦点应保持一致');
    }
    assert.deepEqual(changes, ['image', 'link', 'text', 'link', 'text', 'link']);
    const ignored = await key(ui.dom.window.document.activeElement, 'a');
    assert.equal(ignored.defaultPrevented, false, '普通按键不应被分段选项捕获');
    assert.equal(changes.length, 6);
  } finally { await ui.close(); }
});

test('组合文字开关保留完整名称，点击更新受控状态且禁用时不触发修改', async t => {
  const controls = { changes: [] };
  function Harness() {
    const [checked, setChecked] = useState(false);
    const [disabled, setDisabled] = useState(false);
    controls.setDisabled = setDisabled;
    return React.createElement(components.Toggle, {
      checked, disabled,
      label: React.createElement('span', null, '自动同意', React.createElement('strong', null, '好友申请')),
      onChange: next => { controls.changes.push(next); setChecked(next); },
    });
  }
  const ui = await mountUi(t, Harness);
  try {
    const toggle = ui.container.querySelector('input[role="switch"]');
    assert.equal(accessibleName(toggle), '自动同意好友申请', 'React 组合标签不能被通用“开关”覆盖');
    assert.equal(toggle.checked, false);
    await click(toggle);
    assert.equal(toggle.checked, true);
    assert.deepEqual(controls.changes, [true]);
    await act(async () => { controls.setDisabled(true); await delay(0); });
    assert.equal(toggle.disabled, true);
    assert.equal(accessibleName(toggle), '自动同意好友申请');
    await click(toggle);
    assert.equal(toggle.checked, true, '禁用开关保留已保存的选择');
    assert.deepEqual(controls.changes, [true], '禁用期间不得写入新的配置值');
  } finally { await ui.close(); }
});

test('MD3选择菜单保留表单值与名称，键盘跳过禁用选项并确认，取消不修改值', async t => {
  const changes = [];
  function Harness() {
    const [value, setValue] = useState('0');
    return React.createElement('form', null, React.createElement(components.Field, { label: '回复方式' },
      React.createElement(components.Select, { name: 'mode', value, onChange: event => { changes.push([event.target.tagName, event.target.value]); setValue(event.target.value); } },
        React.createElement('option', { value: '0' }, '自动'),
        React.createElement('option', { value: 'blocked', disabled: true }, '不可用'),
        React.createElement('option', { value: 'keyword' }, '关键词'),
      )));
  }
  const ui = await mountUi(t, Harness);
  try {
    const combo = ui.container.querySelector('[role="combobox"]');
    const canonical = ui.container.querySelector('select');
    assert.equal(accessibleName(combo), '回复方式');
    assert.equal(canonical.tabIndex, -1);
    assert.equal(canonical.getAttribute('aria-hidden'), 'true');
    combo.focus();
    await key(combo, 'ArrowDown');
    assert.equal(combo.getAttribute('aria-expanded'), 'true');
    await key(combo, 'ArrowDown');
    assert.equal(ui.dom.window.document.querySelector('[data-active=true]').textContent, '关键词');
    await key(combo, 'Enter');
    assert.deepEqual(changes, [['SELECT', 'keyword']]);
    assert.equal(new ui.dom.window.FormData(ui.container.querySelector('form')).get('mode'), 'keyword');
    await click(combo);
    await key(combo, 'Home');
    await key(combo, 'Escape');
    assert.equal(canonical.value, 'keyword');
    assert.equal(combo.getAttribute('aria-expanded'), 'false');
    assert.equal(ui.dom.window.document.activeElement, combo);
    assert.equal(changes.length, 1);
  } finally { await ui.close(); }
});

test('嵌套MD3选择菜单先处理Escape，保持外层编辑弹窗与未保存字段', async t => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return React.createElement(React.Fragment, null,
      React.createElement(components.Button, { onClick: () => setOpen(true) }, '打开资料'),
      React.createElement(components.Modal, { open, onClose: () => setOpen(false), title: '编辑资料' },
        React.createElement(components.Field, { label: '性别' }, React.createElement(components.Select, { defaultValue: '0' },
          React.createElement('option', { value: '0' }, '男孩'), React.createElement('option', { value: '1' }, '女孩')))));
  }
  const ui = await mountUi(t, Harness);
  try {
    const opener = ui.container.querySelector('button');
    opener.focus(); await click(opener);
    const combo = dialog(ui).querySelector('[role="combobox"]');
    combo.focus(); await click(combo); await key(combo, 'ArrowDown'); await key(combo, 'Escape');
    assert.ok(dialog(ui), '选择菜单的Escape不得关闭资料弹窗');
    assert.equal(dialog(ui).querySelector('select').value, '0');
    assert.equal(ui.dom.window.document.activeElement, combo);
    await key(combo, 'Escape');
    assert.equal(ui.dom.window.document.querySelector('[aria-modal="true"]'), null);
    assert.equal(ui.dom.window.document.activeElement, opener);
  } finally { await ui.close(); }
});

test('MD3选择控件继承fieldset禁用，不提交禁用字段，零值和required契约保留', async t => {
  const changes = [];
  function Harness() {
    return React.createElement('form', null,
      React.createElement('fieldset', { disabled: true }, React.createElement(components.Select, { name: 'disabledMode', value: '0', onChange: event => changes.push(event.target.value), 'aria-label': '禁用模式' }, React.createElement('option', { value: '0' }, '模式零'))),
      React.createElement(components.Select, { name: 'requiredMode', defaultValue: '', required: true, 'aria-label': '必选模式' }, React.createElement('option', { value: '' }, '请选择'), React.createElement('option', { value: '0' }, '模式零')));
  }
  const ui = await mountUi(t, Harness);
  try {
    const combos = ui.container.querySelectorAll('[role="combobox"]');
    await click(combos[0]);
    assert.equal(combos[0].getAttribute('aria-expanded'), 'false');
    assert.equal(new ui.dom.window.FormData(ui.container.querySelector('form')).get('disabledMode'), null);
    const required = ui.container.querySelector('select[name="requiredMode"]');
    await act(async () => { assert.equal(required.checkValidity(), false); await delay(0); });
    assert.equal(combos[1].getAttribute('aria-expanded'), 'true');
    assert.equal(ui.dom.window.document.activeElement, combos[1], '必填选择报错后应聚焦可操作的MD3控件');
    await key(combos[1], 'End'); await key(combos[1], 'Enter');
    assert.equal(required.value, '0');
    assert.equal(required.checkValidity(), true);
    assert.equal(new ui.dom.window.FormData(ui.container.querySelector('form')).get('requiredMode'), '0');
    assert.deepEqual(changes, []);
  } finally { await ui.close(); }
});

test('表单多个MD3选择缺失时聚焦首个无效字段，修正后继续下一项', async t => {
  const invalidFields = [];
  function Harness() {
    return React.createElement('form', null,
      ...['first', 'second'].map(name => React.createElement(components.Select, {
        key: name, name, defaultValue: '', required: true, 'aria-label': name,
        onInvalid: event => invalidFields.push(event.target.name),
      }, React.createElement('option', { value: '' }, '请选择'), React.createElement('option', { value: '0' }, '模式零'))),
      React.createElement('button', { type: 'submit' }, '保存'));
  }
  const ui = await mountUi(t, Harness);
  try {
    const form = ui.container.querySelector('form');
    const combos = ui.container.querySelectorAll('[role="combobox"]');
    form.querySelector('button[type="submit"]').focus();
    await act(async () => { assert.equal(form.reportValidity(), false); await delay(0); });
    assert.equal(ui.dom.window.document.activeElement, combos[0], '第二个invalid事件不得抢走第一个字段焦点');
    assert.equal(combos[0].getAttribute('aria-expanded'), 'true');
    assert.equal(combos[1].getAttribute('aria-expanded'), 'false');
    assert.deepEqual(invalidFields, ['first', 'second'], '保留每个字段的校验事件');
    await key(ui.dom.window.document.activeElement, 'End');
    await key(ui.dom.window.document.activeElement, 'Enter');
    assert.equal(form.elements.namedItem('first').value, '0');
    await act(async () => { assert.equal(form.reportValidity(), false); await delay(0); });
    assert.equal(ui.dom.window.document.activeElement, combos[1]);
    await key(ui.dom.window.document.activeElement, 'End');
    await key(ui.dom.window.document.activeElement, 'Enter');
    assert.equal(form.reportValidity(), true);
    assert.deepEqual([...new ui.dom.window.FormData(form).entries()], [['first', '0'], ['second', '0']]);
  } finally { await ui.close(); }
});
