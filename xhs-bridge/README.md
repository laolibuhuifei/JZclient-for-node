# xhs-bridge

独立的小红书自动化桥接服务。把「必须真实浏览器才能完成」的登录/发布/私信，包装成普通 HTTP，
供 JZClient 或任何脚本调用。**可以整个目录打包给别人用。**

## 为什么需要它

小红书全站接口强制 `x-s`（XYS_）签名，算法在混淆的浏览器 SDK 里，纯 Node 无法复现。
本服务不破解签名，而是常驻一个已登录的 headless Chromium，让站点自己签名、自己发请求。

## 目录

```
xhs-bridge/
├── server.js        HTTP 入口（默认 127.0.0.1:18811）
├── browser.js       浏览器单例（持久化 profile）
├── login.js         扫码登录 / 登录态
├── publish.js       发视频（默认演练，不点发布）
├── im.js            私信 / 群聊（默认演练，不发送）
├── data/
│   ├── profile/     浏览器用户目录（登录态在这里，注意保密）
│   ├── token.txt    接口令牌（自动生成，0600）
│   └── last-*.png   最近一次操作截图
├── .browsers/       Playwright 的 headless shell（约 288MB）
└── package.json
```

## 启动

```bash
cd xhs-bridge
PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers node server.js
# 或
XHS_PORT=18811 XHS_HOST=127.0.0.1 PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers npm start
```

首次需要下载内核：

```bash
npm install playwright-core
PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers npx playwright-core install --only-shell chromium
```

## 接口

除 `/v1/health` 外都要 `Authorization: Bearer <data/token.txt>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 服务/浏览器状态，无需令牌 |
| POST | `/v1/login/open` | 打开站点，返回当前登录态 |
| GET | `/v1/login/qr` | 取登录二维码（data URL） |
| GET | `/v1/login/status` | 登录态 + 昵称/UID |
| POST | `/v1/login/logout` | 清 Cookie |
| POST | `/v1/publish/video` | 发视频；`confirm:true` 才真正发布 |
| GET | `/v1/im/chats` | 会话列表 |
| POST | `/v1/im/send` | 私信/群聊；`confirm:true` 才真正发送 |
| GET | `/v1/screenshot` | 当前页面截图，排查用 |
| POST | `/v1/browser/close` | 立刻关浏览器 |

发视频参数：

```json
{ "filePath": "/root/videos/a.mp4", "title": "标题", "desc": "正文", "topics": ["旅行"], "confirm": false }
```

私信参数：

```json
{ "to": "昵称或群名", "text": "你好", "group": false, "confirm": false }
```

`confirm` 省略时是**演练模式**：会上传/填好/截图，但不点发布、不按回车。发布和发消息不可撤销，
所以默认不真正执行。

## 迁移给别人

1. 拷贝整个 `xhs-bridge/`（含 `.browsers/`，或让对方自己下载）
2. **不要**拷贝 `data/profile/`（里面是登录态），让对方自己扫码
3. 启动后把 `data/token.txt` 填到调用方配置里

## 已知限制

- 本机在境外时，小红书会跳转 `www.rednote.com`（国际站），发布/私信的风控更严；国内网络更稳
- 选择器随站点改版会失效，所以每次操作都留截图，失败先看 `data/last-*.png`
- 空闲 3 分钟自动关浏览器（`XHS_IDLE_MS` 可调），下次操作自动拉起，登录态不丢
- 单个浏览器实例约占 300–800MB 内存，低配机器注意

## 多用户部署与风控

风控看的是三样东西：**账号、出口 IP、浏览器指纹**。它不看你有多少个实例。

- 每个用户各自账号、各自 IP、各自 profile：风险互不相干，总量约等于单人风险之和，不会互相放大。
- 共用同一个账号：必然叠加，而且多地登录本身就会触发异常。
- 共用同一台服务器出口 IP：平台看到同 IP 上多个账号高频操作，会拉低 IP 信誉，可能整段限流。
- 共用同一个 `data/profile`：Cookie 和指纹相同，账号会被关联，一个出事会牵连其他。

推荐做法：

1. **一人一实例**（一个进程或一个容器），各自一份 `data/profile`
2. **一人一令牌**，不要共用 `token.txt`
3. **IP 分片**：优先住宅/国内网络，避免多账号挤同一个机房 IP
4. 默认开**只读模式**或低配额，只有明确需要时才放开发布/私信
5. 出现验证码立刻冷却（`paused: true`），别硬重试

当前版本是**单 profile**（一个 data/profile 只对应一个账号）。要真正支持多用户，
需要按用户拆分 profile 目录和令牌（多租户）；最省事的方式就是每人跑一份本服务。
