'use strict';
// 私信 / 群聊：同样走页面自动化。选择器会随站点改版失效，所以每次操作都留截图。
const fs = require('fs');
const path = require('path');
const { withPage, DATA } = require('./browser');

const MSG_URL = 'https://www.xiaohongshu.com/messages';

function shot(tag, buf) {
  const p = path.join(DATA, 'last-' + tag + '.png');
  fs.writeFileSync(p, buf);
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function openMessages(page) {
  await page.goto(MSG_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  return page.url();
}

async function listChats() {
  return withPage(async (page) => {
    const url = await openMessages(page);
    if (/login/i.test(url)) return { ok: false, needsLogin: true, url };
    const items = await page.evaluate(() => {
      const sel = '[class*="chat-item"],[class*="conversation"],[class*="session"],[class*="chatItem"]';
      const seen = new Set();
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const name = (el.innerText || '').trim().split('\n')[0].slice(0, 40);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({ name, preview: (el.innerText || '').trim().slice(0, 120) });
        if (out.length >= 50) break;
      }
      return out;
    });
    const buf = await page.screenshot();
    return { ok: true, url, items, screenshot: shot('im-list', buf) };
  });
}

async function send(o) {
  const opt = o || {};
  const to = String(opt.to || '').trim();
  const text = String(opt.text || '').trim();
  if (!to) throw new Error('缺少收件人（昵称或会话名）');
  if (!text) throw new Error('消息内容为空');

  return withPage(async (page) => {
    const url = await openMessages(page);
    if (/login/i.test(url)) return { ok: false, needsLogin: true, url };

    if (opt.group) {
      // 切到群聊标签（文案各版本不同，尽量都试）
      for (const label of ['群聊', '群组']) {
        const tab = page.getByText(label, { exact: true }).first();
        if (await tab.count()) { await tab.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(1200); break; }
      }
    }

    const target = page.getByText(to, { exact: false }).first();
    if (!(await target.count())) {
      const buf = await page.screenshot();
      return { ok: false, error: '会话列表里没找到「' + to + '」', url, screenshot: shot('im-miss', buf) };
    }
    await target.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const box = await (async () => {
      for (const sel of ['div[contenteditable="true"]', 'textarea', '[class*="editor"]']) {
        const loc = page.locator(sel).last();
        if (await loc.count() && await loc.isVisible().catch(() => false)) return loc;
      }
      return null;
    })();
    if (!box) {
      const buf = await page.screenshot();
      return { ok: false, error: '没找到输入框', url: page.url(), screenshot: shot('im-nobox', buf) };
    }

    await box.click({ timeout: 4000 }).catch(() => {});
    await box.fill(text).catch(async () => { await page.keyboard.type(text, { delay: 8 }); });
    const buf = await page.screenshot();
    const screenshot = shot('im-typed', buf);

    if (!opt.confirm) {
      return { ok: true, dryRun: true, url: page.url(), screenshot, hint: '演练模式：已填好未发送。传 confirm:true 才发送' };
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    const after = await page.screenshot();
    return { ok: true, url: page.url(), screenshot: shot('im-sent', after) };
  });
}

module.exports = { listChats, send };
