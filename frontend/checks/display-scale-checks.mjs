import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('手机保持100%，桌面和平板包括iPad桌面UA统一90%，与窗口宽度无关', async () => {
  const script = await readFile(new URL('../../src/assets/display-scale.js', import.meta.url), 'utf8');
  const cases = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', null, '1'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36', null, '1'],
    ['Mozilla/5.0 (Phone; HarmonyOS 5.0) AppleWebKit/537.36', null, '1'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', null, '0.9'],
    ['Mozilla/5.0 (Linux; Android 15; SM-X910) Safari/537.36', { mobile: false }, '0.9'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148', null, '0.9'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15', { mobile: false }, '0.9'],
    ['privacy-preserving-browser', { mobile: true }, '1'],
  ];
  for (const [ua, data, expected] of cases) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
    try {
      Object.defineProperty(dom.window.navigator, 'userAgent', { value: ua });
      Object.defineProperty(dom.window.navigator, 'userAgentData', { value: data });
      Object.defineProperty(dom.window, 'innerWidth', { value: 390 });
      dom.window.eval(script);
      assert.equal(dom.window.document.documentElement.style.getPropertyValue('--ui-scale'), expected);
      assert.equal(dom.window.document.documentElement.dataset.deviceKind, expected === '1' ? 'phone' : 'other');
    } finally { dom.window.close(); }
  }
});
