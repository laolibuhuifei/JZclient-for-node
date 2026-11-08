// 识图链路测试：图片格式嗅探 / 地址校验 / 下载编码 / 多模态消息组装
//
// 跑法：node --test test/
//
// 这里不测真实的小天才 CDN（拿不到稳定地址），测的是「图片到手之后」这一段：
// 字节认不认得出格式、超限会不会转码、内网地址拦不拦、拼出来的 content 上游认不认。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const vision = require('../src/vision');
const ai = require('../src/ai');
const trig = require('../src/ai-trigger');

// 1x1 红色 PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
// JPEG 的最小可用文件头（SOI + APP0 + 一个假段），只用来验嗅探
const JPEG_HEAD = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'ascii'),
  Buffer.alloc(9),
]);

// ============ 格式嗅探 ============
test('sniffMime：只认文件头，不信 Content-Type', () => {
  assert.strictEqual(vision.sniffMime(PNG_1PX), 'image/png');
  assert.strictEqual(vision.sniffMime(JPEG_HEAD), 'image/jpeg');
  const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(8)]);
  assert.strictEqual(vision.sniffMime(webp), 'image/webp');
  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(10)]);
  assert.strictEqual(vision.sniffMime(gif), 'image/gif');
  // HEIC：苹果专有，能认出来但要走转码
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic', 'ascii'), Buffer.alloc(8)]);
  assert.strictEqual(vision.sniffMime(heic), 'image/heic');
  // 不是图片
  assert.strictEqual(vision.sniffMime(Buffer.from('<html>nope</html>')), '');
  assert.strictEqual(vision.sniffMime(Buffer.alloc(0)), '');
});

// ============ 地址校验 ============
test('checkUrl：只放行 http(s)，内网地址一律拒', () => {
  assert.strictEqual(vision.checkUrl('https://im-img.xtc.watch/a.jpg').ok, true);
  assert.strictEqual(vision.checkUrl('').ok, false);
  assert.strictEqual(vision.checkUrl('file:///etc/passwd').ok, false);
  assert.strictEqual(vision.checkUrl('ftp://x.com/a.jpg').ok, false);
  // userinfo 绕过
  assert.strictEqual(vision.checkUrl('https://user:pass@x.com/a.jpg').ok, false);
  // 内网 / 元数据
  assert.strictEqual(vision.checkUrl('http://127.0.0.1/a.jpg').reason, 'private-host');
  assert.strictEqual(vision.checkUrl('http://localhost/a.jpg').reason, 'private-host');
  assert.strictEqual(vision.checkUrl('http://169.254.169.254/latest').reason, 'private-host');
  assert.strictEqual(vision.checkUrl('http://192.168.1.1/a.jpg').reason, 'private-host');
  assert.strictEqual(vision.checkUrl('http://10.0.0.5/a.jpg').reason, 'private-host');
  assert.strictEqual(vision.checkUrl('http://172.20.0.1/a.jpg').reason, 'private-host');
});

// ============ 下载 + 编码 ============
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      try {
        await fn(`http://127.0.0.1:${port}`);
        resolve();
      } catch (e) { reject(e); } finally {
        srv.close();
      }
    });
  });
}

test('toDataUrl：正常图片走快路径，产出可直接塞进 image_url 的 data URL', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_1PX.length });
    res.end(PNG_1PX);
  }, async (base) => {
    const r = await vision.toDataUrl(base + '/a.png', { allowPrivate: true });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.mime, 'image/png');
    assert.strictEqual(r.bytes, PNG_1PX.length);
    assert.ok(r.dataUrl.startsWith('data:image/png;base64,'));
    // 解回来要和原图一模一样
    const back = Buffer.from(r.dataUrl.split(',')[1], 'base64');
    assert.deepStrictEqual(back, PNG_1PX);
  });
});

test('toDataUrl：Content-Type 撒谎也按真实字节判断', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PNG_1PX);
  }, async (base) => {
    const r = await vision.toDataUrl(base + '/fake.png', { allowPrivate: true });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.mime, 'image/png');
  });
});

test('toDataUrl：非图片内容直接拒，不会把 HTML 错误页当图发上去', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end('<html>403 Forbidden</html>');
  }, async (base) => {
    const r = await vision.toDataUrl(base + '/x.jpg', { allowPrivate: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not-image');
  });
});

test('toDataUrl：上游 404 时说清楚是 http-404 而不是「读取失败」', async () => {
  await withServer((req, res) => {
    res.writeHead(404);
    res.end('nope');
  }, async (base) => {
    const r = await vision.toDataUrl(base + '/gone.jpg', { allowPrivate: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'http-404');
  });
});

test('toDataUrl：不传 allowPrivate 时内网地址一律拒（生产路径）', async () => {
  const r = await vision.toDataUrl('http://127.0.0.1:1/a.png');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'private-host');
});

// ============ 多模态消息组装 ============
test('normalizeContent：字符串原样保留，数组拆成合法 parts', () => {
  assert.strictEqual(ai.normalizeContent('你好'), '你好');
  assert.strictEqual(ai.normalizeContent(null), '');
  const parts = ai.normalizeContent([
    { type: 'text', text: '看看这张图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    { type: 'input_audio', input_audio: { data: 'x' } },   // 不支持的 part 丢掉
    { type: 'text', text: '   ' },                          // 空文本丢掉
  ]);
  assert.deepStrictEqual(parts, [
    { type: 'text', text: '看看这张图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ]);
});

test('normalizeMessages：带图的 user 消息不会被 String() 变成 [object Object]', () => {
  const out = ai.normalizeMessages([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: [
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ] },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].role, 'user');
  assert.ok(Array.isArray(out[1].content), '带图消息必须保持数组');
  assert.strictEqual(out[1].content[1].type, 'image_url');
});

test('normalizeMessages：纯文本老路径仍是字符串拼接（不破坏历史行为）', () => {
  const out = ai.normalizeMessages([
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: '第二条' },
    { role: 'system', content: '你是助手' },
  ]);
  assert.deepStrictEqual(out, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '第一条\n第二条' },
  ]);
});

test('normalizeMessages：文本 + 图 + 文本的同角色消息合并后图不丢', () => {
  const out = ai.normalizeMessages([
    { role: 'user', content: '第一句' },
    { role: 'user', content: [
      { type: 'text', text: '第二句' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ] },
  ]);
  assert.strictEqual(out.length, 1);
  const parts = out[0].content;
  assert.ok(Array.isArray(parts));
  // 相邻文本合成一段，图片单独一段
  assert.strictEqual(parts[0].type, 'text');
  assert.strictEqual(parts[0].text, '第一句\n第二句');
  assert.strictEqual(parts[1].type, 'image_url');
});

test('normalizeMessages：既没文字也没图的 user 消息被丢掉（避免上游 400）', () => {
  const out = ai.normalizeMessages([
    { role: 'user', content: '   ' },
    { role: 'user', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: '真正的内容' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].content, '真正的内容');
});

test('buildBody：带图消息原样进请求体，messages 不为空', () => {
  const body = ai.buildBody({ model: 'deepseek-chat' }, [
    { role: 'user', content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ] },
  ]);
  assert.strictEqual(body.messages.length, 1);
  assert.strictEqual(body.messages[0].content[1].type, 'image_url');
});

test('chatFull 的正文提取：上游回 content 数组时取 text 部分', () => {
  assert.strictEqual(ai.contentText([{ type: 'text', text: '粉色' }]), '粉色');
  assert.strictEqual(ai.contentText('粉色'), '粉色');
  assert.strictEqual(ai.contentText(null), '');
  assert.strictEqual(ai.hasImage([{ type: 'image_url', image_url: { url: 'x' } }]), true);
  assert.strictEqual(ai.hasImage('纯文本'), false);
});

// ============ 图片 kind 判定 ============
test('isImageKind：图片类消息能被认出来，文本/表情不算', () => {
  ['photo', 'live_photo', 'video_call_photo', 'relay_live_photo'].forEach((k) => {
    assert.strictEqual(trig.isImageKind(k), true, k);
  });
  ['text', 'emoji', 'voice', 'video', 'location', '', null].forEach((k) => {
    assert.strictEqual(trig.isImageKind(k), false, String(k));
  });
});

test('aiTextOf：图片消息不产生正文（图片走 image_url，不走 content.text）', () => {
  const parsed = { kind: 'photo', inner: { source: { downloadUrl: 'https://x/a.jpg' } } };
  assert.strictEqual(trig.aiTextOf(parsed, '[图片 640x480] https://x/a.jpg'), '');
});
