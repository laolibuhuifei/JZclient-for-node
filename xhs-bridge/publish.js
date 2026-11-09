'use strict';
// 发视频：走创作服务平台页面。默认只「演练」——填好、传好、截图，但不点发布。
// 传 confirm: true 才真正点发布（发布不可撤销，所以必须显式确认）。
const fs = require('fs');
const path = require('path');
const { withPage, DATA } = require('./browser');

const CREATOR_URLS = [
  'https://creator.xiaohongshu.com/publish/publish?source=official',
  'https://creator.rednote.com/publish/publish?source=official',
];

const TITLE_SEL = ['input[placeholder*="标题"]', 'input[placeholder*="填写标题"]', 'input.d-text'];
const BODY_SEL = ['div[contenteditable="true"]', 'div.ql-editor', 'textarea[placeholder*="正文"]'];

function shotPath(tag) { return path.join(DATA, 'last-' + tag + '.png'); }

async function firstVisible(page, selectors, timeout) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count() && await loc.isVisible().catch(() => false)) return loc;
    } catch (e) { /* 继续试下一个 */ }
  }
  return null;
}

async function publishVideo(opts) {
  const o = opts || {};
  const file = String(o.filePath || '');
  if (!file || !fs.existsSync(file)) throw new Error('视频文件不存在: ' + file);
  const sizeMb = fs.statSync(file).size / 1048576;

  return withPage(async (page) => {
    let landed = '';
    for (const u of CREATOR_URLS) {
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2500);
        landed = page.url();
        if (!/login/i.test(landed)) break;
      } catch (e) { /* 换下一个域名 */ }
    }
    if (/login/i.test(landed)) {
      return { ok: false, needsLogin: true, error: '创作平台要求登录，请先在「登录」里扫码', url: landed };
    }

    const input = page.locator('input[type=file]').first();
    await input.waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
    if (!(await input.count())) {
      const buf = await page.screenshot();
      fs.writeFileSync(shotPath('publish'), buf);
      return { ok: false, error: '没找到上传控件（页面结构可能变了）', url: page.url(), screenshot: 'data:image/png;base64,' + buf.toString('base64') };
    }
    await input.setInputFiles(file);

    // 等上传/转码：按文件大小粗略给时间，最多 90 秒
    const waitMs = Math.min(90000, 8000 + sizeMb * 2500);
    await page.waitForTimeout(waitMs);

    if (o.title) {
      const t = await firstVisible(page, TITLE_SEL);
      if (t) { await t.click({ timeout: 3000 }).catch(() => {}); await t.fill(String(o.title)).catch(() => {}); }
    }
    const desc = [o.desc || '', ...(Array.isArray(o.topics) ? o.topics.map((x) => '#' + String(x).replace(/^#/, '')) : [])].filter(Boolean).join(' ');
    if (desc) {
      const b = await firstVisible(page, BODY_SEL);
      if (b) {
        await b.click({ timeout: 3000 }).catch(() => {});
        await b.fill(desc).catch(async () => { await page.keyboard.type(desc, { delay: 10 }).catch(() => {}); });
      }
    }

    await page.waitForTimeout(1500);
    const buf = await page.screenshot();
    fs.writeFileSync(shotPath('publish'), buf);
    const screenshot = 'data:image/png;base64,' + buf.toString('base64');

    if (!o.confirm) {
      return { ok: true, dryRun: true, url: page.url(), screenshot, hint: '演练模式：已上传并填好，未点发布。传 confirm:true 才真正发布' };
    }

    const btn = page.getByRole('button', { name: '发布', exact: true }).last();
    const exists = await btn.count();
    if (!exists) return { ok: false, error: '没找到「发布」按钮', url: page.url(), screenshot };
    await btn.click({ timeout: 8000 });
    await page.waitForTimeout(6000);
    const after = await page.screenshot();
    fs.writeFileSync(shotPath('publish-after'), after);
    return {
      ok: true, url: page.url(),
      screenshot: 'data:image/png;base64,' + after.toString('base64'),
      hint: '已点击发布，请在页面截图里确认结果',
    };
  });
}

module.exports = { publishVideo };
