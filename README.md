<h1 align="center">JZClientForNode</h1>

<p align="center">
  <img src="src/assets/icon.png" width="96" alt="项目图标">
</p>

<p align="center">
  用 Node.js 重构的电话手表家长客户端<br>
  账号 CLI + WebUI 单页面板 · 主页仪表盘（CPU/内存实时监控 + 每日一言） · OneBot v11 桥接（HTTP / WS / 反向 WS，含 QQ 兼容层） · 型号能力门控 · 后台消息监听 · 自动同意好友申请 · AI 自动回复
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js"></a>
  <img src="https://img.shields.io/badge/Dependencies-0-2ea44f?style=flat-square" alt="无第三方依赖">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-1668dc?style=flat-square" alt="支持平台">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square&logo=gnu&logoColor=white" alt="License"></a>
</p>

<p align="center">
  <a href="https://github.com/laolibuhuifei/JZclient-for-node/stargazers"><img src="https://img.shields.io/github/stars/laolibuhuifei/JZclient-for-node?style=flat-square&logo=github&label=Stars" alt="Stars"></a>
  <a href="https://github.com/laolibuhuifei/JZclient-for-node/forks"><img src="https://img.shields.io/github/forks/laolibuhuifei/JZclient-for-node?style=flat-square&logo=github&label=Forks" alt="Forks"></a>
  <a href="https://github.com/laolibuhuifei/JZclient-for-node/issues"><img src="https://img.shields.io/github/issues/laolibuhuifei/JZclient-for-node?style=flat-square&logo=github&label=Issues" alt="Issues"></a>
  <a href="https://github.com/laolibuhuifei/JZclient-for-node/commits"><img src="https://img.shields.io/github/last-commit/laolibuhuifei/JZclient-for-node?style=flat-square&logo=github&label=Last%20Commit" alt="Last Commit"></a>
</p>

<p align="center">
  <a href="https://github.com/laolibuhuifei/JZclient-for-node">
    <img src="https://github-readme-stats.vercel.app/api/pin/?username=laolibuhuifei&repo=JZclient-for-node&theme=dark&hide_border=true" alt="仓库卡片">
  </a>
</p>

> 本项目仅用于个人账号的自动化管理与技术学习。请勿用于未授权的账号、设备或任何违法用途。

## 目录

- [功能特性](#功能特性)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [使用](#使用)
- [公告](#公告)
- [OneBot v11 接入](#onebot-v11-接入)
- [实时日志](#实时日志)
- [对外 API](#对外-api)
- [新设备验证](#新设备验证)
- [绑定手表](#绑定手表)
- [后台消息监听](#后台消息监听)
- [型号能力门控](#型号能力门控)
- [AI 自动回复](#ai-自动回复)
- [数据与隐私](#数据与隐私)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [第三方资源](#第三方资源)
- [免责声明](#免责声明)
- [License](#license)

## 功能特性

| 模块 | 能力 |
| --- | --- |
| 账号与手表 | 账号登录与切换、多手表管理、手表详情、在线状态、电量、宝贝资料 |
| 定位与安全 | 实时位置、历史轨迹、安全区域、丢表模式 |
| 社交 | 通讯录、好友列表、好友详情、删除好友、加好友口令、自动同意好友申请 |
| 绑定手表 | 全新手表管理员绑定（手表验证码 + 天才号选择/迁移）、已有管理员手表的申请加入 |
| 聊天 | 文本、表情（图片预览选择）、颜文字、位置、链接、图片、语音、视频 |
| OneBot v11 | HTTP / 正向 WS / 反向 WS、QQ 兼容层、CQ 码与合并转发、四种媒体地址写法、**长语音自动切段**、**按手表分开接入（独立端口 / 令牌 / 会话范围）** |
| 手表设置 | 音量、短信同步、定时开关机、睡眠模式、上课禁用、模式限制、省电、系统模式、上学前模式、话费提醒、提醒与通话开关、自动接听授权、短信接收、系统与网络 |
| 应用与管控 | 应用管理、应用商店设置、使用时长、使用报告、聊天管控、功能开关、隐私项查看 |
| 健康与工具 | 健康数据、运动数据、闹钟提醒、手表 WiFi、隐藏功能 |
| 增强能力 | 型号能力门控、后台 IM 常驻监听、自定义字体与背景、AI 自动回复、WebUI 实时日志（SSE 推送）、本地配置持久化、升级不覆盖已有数据 |
| 公告 | 主页置顶公告卡、独立公告页、Markdown 渲染、图片查看大图、离线缓存降级 |

## 目录结构

```text
JZClientForNode/
├── bin/
│   └── jzclient.js            # CLI 入口
├── src/
│   ├── assets/icon.png        # 项目图标（512×512）
│   ├── assets/fonts/cat-book.ttf        # WebUI 自定义字体（约 15MB，见「第三方资源」）
│   ├── assets/emoji/          # 表情包预览图（32 张 114×114 PNG，见「第三方资源」）
│   ├── assets/node-mascot.svg # Node.js 吉祥物（封底，见「第三方资源」）
│   ├── api.js                 # 业务 API 客户端与签名
│   ├── cli.js                 # 账号 CLI（登录/登出/账号信息/WebUI 启停）
│   ├── crypto.js              # AES/RSA/MD5 与签名
│   ├── device.js              # 本地配置与设备标识
│   ├── im.js                  # 长连接 IM 客户端
│   ├── onebot.js              # OneBot v11 桥接（HTTP API + 正向 WS + 反向 WS 客户端）
│   ├── message.js             # 消息编解码
│   ├── upload.js              # 图片/语音/视频上传
│   ├── sso.js                 # 账号登录
│   ├── ai.js                  # AI 自动回复
│   ├── mask.js                # 日志脱敏
│   ├── logger.js              # 分级彩色日志
│   ├── webui.js               # 本地 HTTP 服务
│   ├── webui.html             # WebUI 页面
│   ├── emoji_preset.json      # 表情清单
│   ├── site.js                # 配置加载器
│   └── site.config.js         # 服务端地址与客户端参数
├── .gitattributes
├── .gitignore
├── LICENSE
├── package.json
└── README.md
```

## 环境要求

- Node.js >= 18
- macOS / Linux / Windows
- 可选：`ffmpeg` + `ffprobe`（发送非 AMR 格式语音时转码；OneBot 发超过 60 秒的长语音时切段）

项目没有第三方 npm 依赖，无需执行 `npm install`。

## 安装

```bash
git clone https://github.com/laolibuhuifei/JZclient-for-node.git JZClientForNode
cd JZClientForNode
```

## 配置

服务端地址与客户端参数集中在 `src/site.config.js`，仓库中已包含可用默认值，正常情况下无需修改。

### api

| 字段 | 说明 |
| --- | --- |
| `mainHost` | 主业务网关 |
| `contactHost` | 通讯录/联系人相关网关 |
| `locationHost` | 定位/轨迹相关网关 |
| `sportHost` | 健康/运动相关网关 |
| `storeHost` | 应用商店相关网关 |
| `chatHost` | 聊天媒体相关网关 |
| `ssoHost` | 账号登录网关 |

### app

| 字段 | 说明 |
| --- | --- |
| `version` | 请求头中的完整版本字符串 |
| `versionCode` | 数字版本号 |
| `versionName` | 语义化版本号 |
| `deviceName` | 请求头中的设备名 |
| `userAgent` | 请求头中的 User-Agent |
| `checksum` | 客户端校验值 |
| `ssoSalt` | 账号登录签名盐 |
| `ssoAppId` | 登录应用 ID |
| `brand` | 请求头中的品牌标识 |
| `apkType` | 请求头中的应用类型 |
| `packageName` | 应用包名 |
| `brandVersion` | 模块查询使用的品牌版本 |
| `signHeader` | 业务请求的签名头名称 |
| `keyHeader` | 业务请求的密钥头名称 |

### im

| 字段 | 说明 |
| --- | --- |
| `host` | 长连接服务地址 |
| `port` | 长连接端口 |
| `appKey` | 长连接应用密钥 |

### assets

| 字段 | 说明 |
| --- | --- |
| `emojiBaseUrl` | 表情资源 CDN 前缀 |

运行期数据保存在 `~/.watch-parent-cli/config.json`，包含登录票据、设备标识、手表状态、AI 配置等，不会进入仓库。

## 使用

### 启动

```bash
npm start
# 或
node bin/jzclient.js
```

首次运行直接进入登录流程（账号密码登录；新设备会引导完成密保问题验证）。登录票据和设备标识缓存在本地，之后每次启动会自动把 WebUI 拉起来。

命令行只负责账号，不提供功能菜单 —— 手表、定位、聊天、通讯录、安全区域、应用管理、闹钟、设置等功能全部在 WebUI 里操作：

```text
1) 登录/切换账号    2) 退出登录    3) 账号信息
4) 查看配置         5) 启停 WebUI    t) 访问令牌
0/q) 退出           h) 帮助
```

日志通过环境变量控制：

| 变量 | 说明 |
| --- | --- |
| `WP_LOG=debug` | 输出请求体、IM 原始帧等细节 |
| `WP_LOG=warn` | 只看告警和错误 |
| `WP_LOG=silent` | 完全静默 |
| `WP_LOG_COLOR=0` | 关闭 ANSI 颜色（`NO_COLOR=1` 同效） |

### 启动 WebUI

登录成功后自动启动，终端会打印地址、局域网地址和**访问令牌**：

```text
WebUI 已启动  http://127.0.0.1:8787
  局域网  http://192.168.1.20:8787

  访问令牌  jz_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
  快捷链接  http://127.0.0.1:8787/?token=jz_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
```

默认监听 `0.0.0.0`（局域网可访问），但**所有 `/api` 接口都要求访问令牌**，没有令牌只能看到登录页。两种进入方式：

- 点「快捷链接」——URL 里的 `?token=` 会自动种 Cookie 再跳回干净的地址
- 直接打开首页，在登录页粘贴令牌

令牌首次启动自动生成并写回配置，之后保持不变；Cookie 有效期 7 天。连续输错 8 次会锁定该 IP 10 分钟。

端口、监听地址和令牌在 `~/.watch-parent-cli/config.json` 的 `webui` 字段里：

```json
"webui": { "port": 8787, "host": "0.0.0.0", "token": "jz_..." }
```

只允许本机访问就把 `host` 改成 `"127.0.0.1"`；`token` 清空后会重新生成。

命令行里 `t` 查看令牌和快捷链接，`t new` 重新生成（会踢掉已登录的浏览器），`5` 启停 WebUI，`1` 换账号会自动先停服务。

WebUI 包含：

- 主页：账号概览（状态胶囊）、系统 CPU 环形表、内存与本程序 CPU/内存磁贴（3 秒实时刷新）、系统架构与运行环境（OS/内核/处理器/Node/PID/运行时长）、手表列表、每日一言；主页不显示顶部手表切换条
- 概览：头像、型号、电量、在线状态、快捷状态
- 定位：实时位置、历史轨迹、安全区域、丢表模式
- 聊天：会话列表、消息收发、图片/语音/视频/位置/链接/表情（录音超过 60 秒会自动切成多条发送）
- 功能：宝贝资料、通讯录、好友、健康、应用、WiFi、闹钟、设置、隐藏功能、绑定
- 我的：账号信息、手表账号、OneBot 接入设置（按手表，启停/端口/令牌/反向 WS）、对外 API（按手表，好友列表/详情/删除 + 加好友口令，开关/令牌）、外观（自定义背景）、退出登录
- 设置：按型号能力自动裁剪的各类开关与时段配置

### 主页仪表盘

打开 WebUI 默认停在「主页」，对应接口 `GET /api/system`（每 3 秒轮询一次，只返回本地采样数据，不会反复请求服务器）：

| 字段 | 说明 |
| --- | --- |
| `system.cpuPercent` | 系统 CPU 占用（两次采样求差，按区间算） |
| `system.memUsed` / `memPercent` | 系统已用内存与百分比 |
| `system.arch` / `platform` / `release` | 架构（arm64/x64）、系统（macOS/Linux/Windows）、内核版本 |
| `system.cpuModel` / `cpuCores` / `loadavg` | 处理器型号、核心数、负载 |
| `process.cpuPercent` | 本程序 CPU 占用（相对单核，多核跑满可超 100） |
| `process.rss` / `heapUsed` / `heapTotal` | 本程序内存占用与 V8 堆 |
| `process.uptime` / `pid` / `node` | 程序运行时长、进程号、Node 版本 |
| `account` | 账号、登录状态、mobileId、IM/OneBot 状态、手表列表 |

**每日一言**由 `GET /api/yiyan` 提供，主源是 [tenapi](https://docs.tenapi.cn/random/yiyan.html)，当天缓存、`?refresh=1` 换一条。主源不可用时自动降级到 [hitokoto](https://hitokoto.cn) 官方接口，再失败则用内置词库（页面会标注「离线词库」），保证首页永远有一句话。

### 深浅色主题

WebUI 支持三种主题状态，点顶栏右上角的图标（登录页则是右上角的圆形按钮）循环切换：

| 状态 | 行为 |
| --- | --- |
| `auto`（默认） | 跟随系统 `prefers-color-scheme`，系统切深浅色时实时跟着变 |
| `light` | 强制浅色，不跟随系统 |
| `dark` | 强制深色，不跟随系统 |

选择存在 `localStorage` 的 `jz_theme` 键里，刷新后保留。

实现上有三个要点：

- **防首屏闪白**：`<head>` 里有一段内联脚本，在第一个 `<style>` 之前就把 `data-theme` 写到 `<html>` 上，不会先渲染浅色再闪成深色。
- **只认 light/dark**：`auto` 在 JS 里就解析成具体的 `light` 或 `dark`，CSS 只处理这两个值，避免多层 `@media (prefers-color-scheme)` 互相打架。旧的两层媒体查询加了 `:root:not([data-theme="light"])` 排除条件，用户手动选浅色时不会被系统深色盖掉。
- **变量 + 具体规则双层覆盖**：页面历史上叠了五层样式，末层有大量硬编码的 `#fff` / `rgba(0,0,0,.88)`，只覆盖 CSS 变量盖不住，所以深色块里同时覆盖了变量和具体选择器。`color-scheme` 也跟着切，滚动条、下拉框这些原生控件才会一起变深。

## 公告

公告由项目作者的官方服务发布，客户端只读、无需配置，也不能改成别的地址。本仓库只包含「拉取 + 渲染」这一侧，不包含公告服务端实现。

- 主页显示置顶优先的前 2 条公告；点「查看全部 ›」进入独立的「公告」页看历史列表。
- 公告正文支持 Markdown：标题、粗体/斜体/删除线、行内代码、代码块、链接、图片、有序/无序列表、引用、分割线、表格。
- 图片点击可看大图；外链一律新窗口打开。
- 没有公告时主页那块整块不渲染，不影响仪表盘；服务临时不可用时继续用上一次的缓存，并标注「离线缓存」。
- Markdown 渲染先整体 HTML 转义再拼标签，正文里的原始 HTML 一律当文本，`javascript:` / `vbscript:` 链接会被替换成 `#`。

## OneBot v11 接入

WebUI 起来后会为**每块手表**各拉起一套 OneBot v11 服务，可以把微聊接进 AstrBot、NoneBot 这类机器人框架。**没有「全局一套收所有表」的模式**——每块表的端口、令牌、会话范围都是分开的，机器人只会看到它那块表的会话。

| 传输 | 地址 | 令牌 |
| --- | --- | --- |
| HTTP API | `http://0.0.0.0:<该表的端口>`（第一块表默认 5700） | `onebotWatches[watchId].http.token` |
| 正向 WebSocket | `ws://0.0.0.0:<该表的端口>`（第一块表默认 5701） | `onebotWatches[watchId].ws.token` |
| 反向 WebSocket | 由 `onebotWatches[watchId].wsClient.url` 指定（默认关闭） | `onebotWatches[watchId].wsClient.token` |

端口留空自动分配，从 `5700` 起按 10 递增（`5700/5701`、`5710/5711`…），会和其它手表的端口一起避让。令牌首次启用时自动生成并写回配置。命令行按 `o` 查看每块表的地址和令牌，`o new` 重置全部（会断开已接入的机器人）。

**在 WebUI 里改设置**

打开 WebUI → 底部「我的」→「OneBot v11 接入」卡片 → 右上角「设置」。卡片只显示**当前手表**（也就是左上角切换条选中的那块），切到别的表它就跟着切过去。

设置区分两组折叠面板：

- **本表设置**——这块表自己的：启用开关、HTTP 端口、WS 端口、反向 WS（地址 / 令牌 / 重连间隔）、「只收这些会话」多选，以及两个令牌的重置按钮。
- **通用设置**——所有手表共用：QQ 兼容模式、心跳间隔。

点「保存」后只重启这块表的实例，别的表不受影响。如果端口被占用，保存会成功但状态显示「未运行」，页面会给出提示。

**这块表能收哪些会话**

默认**自动匹配**：平台没给 `watchId` 和 IM 账号的对应关系，只能拿手表名去对微聊里单聊的名称，家庭群再看成员里有没有同一个 IM 账号。对不上（比如手表昵称和微聊备注不一致）时该实例会退化成接收全部会话，日志里有提示——这时候在「只收这些会话」里手动勾选即可。

`get_friend_list`、`get_group_list`、`get_group_member_list`、各类消息历史、事件推送，全部按这个范围过滤；`self_id` 用的是这块手表自己的 IM 账号 ID，插件据此分清「哪块表在说话」。

**正向还是反向？**

| 场景 | 用哪种 | 说明 |
| --- | --- | --- |
| AstrBot 和本程序在同一台机器 / 同一局域网 | 正向 WS | AstrBot 主动连 `ws://<本机 IP>:5701`，本程序不用开端口映射 |
| AstrBot 跑在公网服务器 / 另一台机器，本程序在家庭网络内 | 反向 WS | 本程序主动连 AstrBot 的 WS 端点，穿透 NAT 不用做端口映射 |
| 只需要偶尔调一下接口 | HTTP API | `POST http://<IP>:5700/<action>?access_token=...` |

**在 AstrBot 里配置**

正向 WS：

1. 平台选 `OneBot v11 (aiocqhttp)`
2. WS 地址填 `ws://<电脑局域网 IP>:<那块表的端口>`（第一块表默认 5701）
3. access_token 填那块表自己的 WS 令牌

多块手表就建多个 `OneBot v11` 平台，各自填对应表的地址和令牌。

反向 WS（由本程序主动连过去）：

1. AstrBot 里新建一个 `OneBot v11` 平台，连接方式选 **反向 WebSocket**，记下它监听的端口（默认 `6199`，路径固定为 `/ws`）和 access_token
2. 在 WebUI 里那块表的「本表设置 → 反向 WS」里打开开关，填地址和令牌；或者直接改配置：
   ```json
   "wsClient": { "enabled": true, "url": "ws://1.2.3.4:6199/ws", "token": "对方设置的令牌", "reconnect": 5 }
   ```
3. 保存后热重启。日志出现 `[onebot] 反向 WS 已连接` 即成功；断线会按 `reconnect` 秒数自动重连

握手时会带上 `X-Self-ID`（这块表的 IM 账号标识）和 `X-Client-Role: Universal`，AstrBot / NoneBot 用的 aiocqhttp 库依赖这两个头识别连接，缺了会被直接拒绝。换成别的框架时如果它要求别的路径，按对方文档改 `url` 即可。

令牌会同时以 `Authorization: Bearer <token>` 和 `?access_token=<token>` 两种形式发送，AstrBot 两种校验方式都认。

**配置结构**

配置在 `~/.watch-parent-cli/config.json`。`onebot` 只放公共行为，端口 / 令牌 / 会话范围都在 `onebotWatches` 里按 `watchId` 分开：

```json
"onebot": { "heartbeat": 30, "qqCompat": true },
"onebotWatches": {
  "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678": {
    "enabled": true,
    "http": { "enabled": true, "host": "0.0.0.0", "port": 5700, "token": "jz_..." },
    "ws":   { "enabled": true, "host": "0.0.0.0", "port": 5701, "token": "jz_..." },
    "wsClient": { "enabled": false, "url": "", "token": "", "reconnect": 5 },
    "targets": []
  }
}
```

`targets` 是会话 key 数组（`s:<IM 账号>` 单聊、`g:<dialogId>` 家庭群），**空数组表示自动匹配**；填了就只认这几个会话。`port: 0` 表示自动分配。

> **从旧版本升级**：以前那套「全局实例」（`onebot.enabled` / `onebot.http` / `onebot.ws` / `onebot.wsClient`）会在首次启动时自动搬到**第一块手表**上，端口和令牌原样保留，已经接好的 AstrBot 不用改。旧的全局对外 API 令牌（`geniusApi`）不再使用，需要按表重新启用。

**ID 映射**

| OneBot 字段 | 微聊里的含义 |
| --- | --- |
| `self_id` | 自己的 IM 账号 ID |
| 私聊 `user_id` | 手表的 IM 账号 ID |
| 群 `group_id` | 家庭群的 dialogId |
| 群成员 `user_id` | 该成员的 IM 账号 ID |

**支持的 action**

真正实现（数据来自微聊，行为与 QQ 一致）：

| 分类 | action |
| --- | --- |
| 基础 | `get_login_info` `get_status` `get_version_info` `can_send_image` `can_send_record` `clean_cache` `.handle_quick_operation` |
| 查询 | `get_friend_list` `get_group_list` `get_group_info` `get_group_member_list` `get_group_member_info` `get_stranger_info` `get_recent_contact` |
| 发送 | `send_private_msg` `send_group_msg` `send_msg` `send_group_forward_msg` `send_private_forward_msg` `send_forward_msg` |
| 消息 | `get_msg` `get_forward_msg` `get_group_msg_history` `get_friend_msg_history` `get_image` `get_record` `get_file` |

消息段支持 `text` `face`（表情序号）`image` `record` `video` `at`（降级成 `@昵称` 文本）`reply`（忽略）`location` `share`（拼成文本）`file`（按扩展名当语音/视频/图片发）`poke` / `shake` / `dice` / `rps`（降级成一句提示）`json` / `xml` / `ark`（捞标题）`forward`（展开成文本）。

**媒体段（`image` / `record` / `video` / `file`）的地址四种写法都认**：

| 写法 | 说明 |
| --- | --- |
| `http(s)://...` | 直接用，不改写 |
| `base64://<data>` | NapCat / go-cqhttp / AstrBot 发本地图片、语音时用这个。解码后按文件头判断真实格式（png/jpg/mp3/wav/amr/ogg/flac/mp4/webm…），落到临时文件，**发完立刻删除** |
| `data:image/png;base64,...` | 同上，认 data URL |
| `file:///abs/path`、`/abs/path`、`C:\x.png` | 直接读本地文件 |

> 只认 http(s) 的话，插件一发表情包、一放歌就整条链 1400（`图片段只支持 http(s) 地址`），AstrBot 的音乐插件还会因为 `record` 被拒去 fallback 发 `file` 段，结果落到「消息内容为空」。这两条现在都通了。
>
> `file` 段本身微聊没有文件传输能力，但很多插件拿它兜底发音频/视频，所以按扩展名转成对应的语音/视频/图片消息；实在认不出类型就发一句 `[文件] 名字`，不会让整条消息失败。
>
> 安全边界：本地路径和 base64 都会被读进内存当媒体上传，内容校验在下游——图片必须能被识别成图片格式，音频必须能被 ffmpeg 解码，否则报错。程序不会把读到的任意文件内容发出去。

**QQ 发来的媒体段有三个字段，优先级是 `url` → `path` → `file`**

NapCat / go-cqhttp 的 `image` / `record` / `video` 段通常同时带三个字段：

| 字段 | 内容 | 处理 |
| --- | --- | --- |
| `url` | CDN 直链 | 有就用它，直接下载 |
| `path` | 框架**自己机器上**的缓存文件路径 | `fs.existsSync` 通过才读 |
| `file` | 常常只是 `A1B2C3.image` 这种裸文件名 | 只有它本身就是 http / base64 / 本地绝对路径时才算数 |

**裸文件名绝不硬读**——那是框架磁盘上的缓存，本程序读不到，以前会直接 `ENOENT` 把整条消息打挂。现在会明确报「这看起来是 QQ 的裸文件名，需要框架提供 `url` 或 `path` 字段」，一眼能看出是框架没给全，而不是本程序的锅。

**表情段的两个坑**

- `face` 的 `id` 是 **QQ 全局表情编号**（`doge` 是 178、`斜眼笑` 是 179……），而本程序只内置 32 个微聊表情。**编号越界一律降级成 `[表情]` 文本**，不报错——硬发一个不存在的表情会让下游回「表情不存在」，然后把整条消息打回 1400。
- `mface`（商城表情）/ `bface`（小表情）本质是图片：带 `url` 就按图片发，没有就降级成 `[表情]`。

字符串形式的消息会完整解析 CQ 码（含 `&#91;` `&#93;` `&#44;` `&amp;` 转义），`[CQ:reply,...]` 这类微聊没有对应能力的段会被丢掉，不会再原样发给手表。

**长语音自动切段**

微聊的语音消息**单条最多 60 秒**，超过会被服务端拒掉。所以 `record` 段（以及按扩展名分流成语音的 `file` 段）会先量时长，超了就自动切开逐条发：

| 参数 | 值 | 说明 |
| --- | --- | --- |
| 切段阈值 | 58 秒 | 留 2 秒余量，卡在 60 秒整容易被拒 |
| 段数上限 | 20 段 | 约 19 分钟，再长直接报错，比刷屏好 |
| 段间隔 | 350 ms | 连发太快平台会吞消息 |

- 时长用 `ffprobe` 读；先试 `ffmpeg -f segment -c copy` 直接切流（不重编码，快且不掉音质），容器不支持时退回重编码成 16 kHz 单声道 mp3 48k 再切。
- 每段在日志里标成 `[语音 2/3]`，发的顺序就是播放顺序。
- `http(s)` 的长语音会先下载到临时文件再切；所有临时文件（解码出来的、切出来的分片）**发完立刻删除**。
- 没有 `ffmpeg` 时会明确报错「音频切分失败（需要 ffmpeg）」，不会把超长语音硬发出去。

> 实测：130 秒音频 → 58 / 58 / 13.9 秒三段，切分耗时 28 ms，三段合计与原音频误差 < 2 秒。
>
> WebUI 聊天框走的是同一套逻辑：浏览器录音（`/api/chats/voice`）和带音频地址的发送（`/api/chats/send`）录多长都会被自动切开，返回值里的 `parts` 就是实际发出的条数。

**QQ 兼容性**

按 QQ（NapCat / go-cqhttp）写的 AstrBot 插件会调一堆 QQ 专有动作，只要有一个返回 1404，很多插件整条链路就崩了。所以这里按三档处理，开关是 `onebot.qqCompat`（默认开，WebUI「我的 → OneBot v11 接入 → 设置 → 基础设置」里可关）：

1. **静默成功**——微聊物理上做不到，返回 `{}` 让插件继续往下跑：`delete_msg` `set_group_ban` `set_group_whole_ban` `set_group_anonymous_ban` `set_group_card` `set_group_name` `set_group_special_title` `set_group_remark` `set_group_anonymous` `send_like` `send_poke` `set_msg_emoji_like` `set_input_status` `mark_msg_as_read` `mark_group_msg_as_read` `mark_private_msg_as_read` `mark_all_as_read` `send_group_notice` `_send_group_notice` `send_group_sign` `set_online_status` `set_diy_online_status` `set_qq_profile` `set_qq_avatar` `set_friend_add_request` `set_group_add_request`

   > 注意：这些动作**不会真的发生**。比如 `delete_msg` 返回成功但消息并没有被撤回——微聊没有撤回接口，收到别人的撤回只会推 `group_recall` / `friend_recall` 通知。关掉 `qqCompat` 后这一档会改成明确报错，方便排查「插件为什么没反应」。

2. **返回空值**——只读查询，结构对得上 QQ、内容是空的，严格模式也保留：`get_group_honor_info` `get_group_shut_list` `get_group_at_all_remain` `get_group_system_msg` `get_group_file_system_info` `get_group_root_files` `get_group_files_by_folder` `get_essence_msg_list` `get_group_notice` `_get_group_notice` `get_group_ignore_add_request` `get_doubt_friends_add_request` `get_unidirectional_friend_list` `get_online_clients` `get_cookies` `get_csrf_token` `get_credentials` `get_clientkey` `get_robot_uin_range` `get_model_show` `_get_model_show` `get_profile_like` `fetch_custom_face` `get_group_info_ex` `get_group_detail_info` `get_mini_app_ark` `get_ai_characters` `get_group_album_media_list` `.get_word_slices`

3. **明确拒绝**——危险或确实做不到，直接报错，绝不静默：`set_group_leave` `set_group_kick` `delete_friend`（会破坏手表绑定）、`ocr_image` `send_packet` `get_ai_record` `send_group_ai_record`、`set_restart`

**合并转发**（`send_group_forward_msg` / `send_private_forward_msg` / `send_forward_msg`）没有卡片式转发可用，会降级成「昵称：内容」的多行文本一次发出（超过 1500 字自动分条），并返回一个 `forward_id`；之后 `get_forward_msg` 能按这个 id 取回原文。`node` 里嵌套引用已有转发（`data.id`）会递归展开。

`node` 段有两种写法都认：**整条消息只有一个 `node`** 时直接当合并转发处理（走上面那套）；**`node` 混在普通消息里**（比如「看这个」+ 转发卡片）就展开成一行「昵称：内容」文本，不会因为夹了个 node 整条报错。

**事件字段**：消息事件的 `sender` 补齐了 `card` / `sex` / `age` / `area` / `level` / `title` / `role`，另有 `anonymous: null` 和 `message_seq`。很多 QQ 插件取昵称走的是 `sender.card`，缺了会直接报错。撤回会转成 `notice` 事件：群 `group_recall`、私聊 `friend_recall`。

**消息历史**：每个会话在内存里保留最近 200 条（全局 800 条），`get_group_msg_history` / `get_friend_msg_history` / `get_msg` / `get_recent_contact` 都读这份缓存。没有客户端连着的时候也照样记，重启程序后清空。

**暂不支持**：HTTP 上报（webhook）、真正的撤回、禁言、戳一戳、群文件、好友/入群申请审批。

某块表只开反向 WS 时，把它的 `http.enabled` / `ws.enabled` 都设成 `false`，那块表就只做客户端，不监听任何端口。

## 实时日志

日志有两个出口：**终端**（带颜色，适合 `> webui.log`）和 **WebUI 日志页**（网页上实时滚动，适合远程看）。两边内容一致，都经过同一套脱敏。

### 终端输出

WebUI 启动后，终端会实时打印带时间戳、按级别着色的日志：

```text
[18:00:56.062] INFO  webui   服务已启动 http://127.0.0.1:8787
[18:00:57.114] HTTP  GET /api/watches?refresh=1 → 200 507ms 686B
[18:00:57.331] API   GET watch.okii.com/mobileinit/authid → 000001 217ms
[18:00:57.402] INFO  im      后台监听在线 imAccountId=100000000
[18:00:58.021] WARN  im      连接已断开，60 秒后重连
[18:00:59.010] ERROR webui   GET /api/nope 失败: 接口不存在
```

| 级别 | 颜色 | 内容 |
| --- | --- | --- |
| `DEBUG` | 灰 | 请求体、IM 帧、绑定查询等细节 |
| `INFO` | 青 | 服务启动、IM 上线、状态变更 |
| `HTTP` | 绿 | 浏览器发来的请求：方法、路径、状态码、耗时、体积 |
| `API` | 蓝 | 发往服务端的业务请求：网关、路径、业务码、耗时 |
| `WARN` | 黄 | 连接断开、可恢复的异常 |
| `ERROR` | 红 | 请求失败、网络错误 |

环境变量：

| 变量 | 说明 |
| --- | --- |
| `WP_LOG=debug\|info\|warn\|error\|silent` | 过滤级别，WebUI 默认 `info` |
| `WP_LOG_COLOR=0\|1` | 强制关/开颜色，默认按是否 TTY 判断 |
| `NO_COLOR=1` | 标准约定，关闭颜色 |
| `WP_DEBUG=1` | 兼容旧开关，等价于 `WP_LOG=debug` |

```bash
WP_LOG=debug npm start   # 最详细
WP_LOG=warn  npm start   # 只看告警和错误
```

输出到文件时会自动去掉颜色转义符，可直接 `> webui.log`。手机号、邮箱等敏感信息在写日志前统一脱敏。

### WebUI 日志页

入口两个：

- **顶栏「日志」按钮**（在「刷新」左边）——任何页面一键进入，左上角返回会回到你来的那一页
- **「我的」页 →「诊断」卡片 →「查看」**

页面默认只保留最近 **600 行** DOM，开一晚上也不会越来越卡（服务端另有 800 条环形缓冲）。

| 控件 | 说明 |
| --- | --- |
| 级别下拉 | 直接改服务端的日志级别，等于终端里的 `WP_LOG`，立即生效；调 `DEBUG` 才能看到接口明细，`SILENT` 停止输出 |
| 自动滚动 | 勾选时始终贴底；手动往上翻会自动失效，翻回底部又恢复（不会把你拽回去） |
| 暂停 / 继续 | 暂停期间新日志不进 DOM，继续时按最近 300 条重刷，不会漏中间段 |
| 清空 | 只清服务端缓冲区，不影响终端；清空后游标不回退，不会重复显示旧行 |
| 复制 | 把当前屏上的日志按行拼成纯文本复制，不带 ANSI 颜色码 |

推送走 **SSE**（`GET /api/logs/stream`，`text/event-stream`）：连上先补 200 条历史，之后逐条推，20 秒一个 `: ping` 心跳防反代掐连接。反代需要 `X-Accel-Buffering: no`（已带）才不会被缓冲；如果环境确实过不去，前端 3 秒内收不到数据会自动退化成 1.5 秒轮询，功能不受影响。

配套接口（都要 WebUI 登录态，和别的接口一样走 Cookie 或 `Authorization: Bearer`）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/logs?limit=300&since=<seq>` | 取最近日志，`since` 只返回更新的条目 |
| `GET /api/logs/stream` | SSE 实时流，先发 `event: init` 带历史，之后每条一个 `data:` |
| `POST /api/logs/level` | `{"level":"debug"}`，取值 `debug/info/warn/error/silent` |
| `DELETE /api/logs` | 清空缓冲区，返回当前 `seq` |

## 对外 API

给第三方脚本 / 机器人用：不用登录 WebUI，凭一个独立令牌就能取加好友口令、读好友列表、删好友。

在 WebUI 底部「我的」→「对外 API」卡片里点「为这块表启用」，会自动生成一个 `gk_` 开头的令牌，页面上能直接复制接口地址和令牌。也可以随时「关闭这块表的接口」或「重置令牌」（旧令牌立即失效）。

**令牌是按手表分开的，没有全局令牌**

卡片只显示**当前手表**那一套——想给另一块表开，用左上角的手表切换条切过去再开。每块表一把独立令牌，配置存在 `extApi[watchId]` 里。

**令牌即身份**：一块令牌只能操作它自己那块表，`watchId` 可以整个省略（自动就是自己那块）；传了也只能传自己，传别家手表直接 `403`。这样几个家长各自用一个机器人时，每个机器人只拿到自己那块表的权限，令牌泄了也只影响一块表。

某块表关掉开关后，它那把令牌立刻失效（`401`），不用重启服务。

**四个接口共用同一套令牌**

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/ext/friends` | 好友列表 |
| `GET` | `/api/ext/friends/:friendId` | 好友详情 |
| `DELETE` | `/api/ext/friends/:friendId?confirm=<好友记录 id>` | 删除好友 |
| `GET` | `/api/ext/genius` | 加好友口令 |

`watchId` 可以整个省略（就是令牌自己那块表）。列表 / 详情也接受 `POST`（等价于 `GET`，方便只支持 POST 的客户端）；**删除只认 `DELETE`**，用 GET 触发删除会被浏览器预取、爬虫或链接预览误伤。

```bash
T=gk_xxxx
H=http://192.168.1.10:8787

# 令牌走 query（推荐，方便直接 curl / 浏览器调试）
curl "$H/api/ext/friends?token=$T"

# 或者走 Header
curl -H "Authorization: Bearer $T" "$H/api/ext/friends"

# 显式写 watchId 也行，但只能是这把令牌自己那块，传别家会 403
curl "$H/api/ext/friends?token=$T&watchId=a1b2c3d4..."

# 好友详情
curl "$H/api/ext/friends/F1001?token=$T"

# 删除好友（confirm 必须和好友记录 id 完全一致）
curl -X DELETE "$H/api/ext/friends/F1001?token=$T&confirm=F1001"
```

**好友列表响应**

```json
{
  "ok": true,
  "data": {
    "watchId": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "watchName": "宝贝的手表",
    "total": 2,
    "friends": [
      {
        "id": "F1001",
        "friendId": "90001",
        "imAccountId": "5550001",
        "friendName": "小明",
        "friendRealName": "王小明",
        "number": "13800000001",
        "bindNumber": "1001",
        "icon": "iconA",
        "customIcon": "",
        "type": 1,
        "avatar": "https://cdn.example.com/iconA.png"
      }
    ]
  }
}
```

好友记录是**平台返回的字段原样带出**，不裁剪（版本一变也不会少字段），只额外补一个 `avatar`（头像直链，优先取 `customIcon`，回退 `icon`；取不到是空串）。

**好友详情响应**是 `data: { watchId, watchName, friend }`，`friend` 就是上面数组里的单个对象。

`:friendId` 依次按 `id`（好友记录 id）→ `friendId` → `imAccountId` → `number` → `bindNumber` → 姓名匹配，任意一个能唯一命中就行。**删好友时 `confirm` 必须填好友记录 `id`**，不是路径里传的那个值。

**删除好友的二次确认**

`DELETE` 不带 `confirm` 或值不匹配会返回 `400`，并在 `data` 里带上目标 `friendId` 和姓名方便核对：

```json
{ "ok": false, "error": "删除好友是破坏性操作，需要带 confirm=<好友记录 id> 二次确认",
  "data": { "friendId": "F1001", "name": "小明" } }
```

成功返回 `{ "ok": true, "data": { "deleted": true, "friendId": "F1001", "name": "小明" } }`。

**加好友口令响应**

```json
{
  "ok": true,
  "data": {
    "watchId": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "watchName": "宝贝的手表",
    "geniusNumber": "88012345",
    "command": "123456",
    "expire": "口令 5 分钟内有效",
    "at": 1792850000000
  }
}
```

失败时 `ok` 为 `false` 并带 `error` 文案。HTTP 状态码：该表未启用 `403`、令牌错误 `401`、越权操作别的手表 `403`、手表 / 好友不存在 `404`、方法不对 `405`、删除缺 `confirm` `400`。

**注意**

- 这个令牌和 WebUI 访问令牌**完全独立**，互不通用（对外令牌调不了 WebUI 接口，WebUI 令牌也调不了这个接口）
- 每次取口令都会真实向服务器申请一个新口令，旧口令可能随之失效，不要高频轮询
- 好友列表没有分页也没有「按 id 查单个」的官方接口，详情是拉全量列表后本地筛出来的，好友多时会多一次网络往返
- 按手表令牌**关掉开关就立刻失效**（下一次请求就 401），不用等重启
- 配置在 `~/.watch-parent-cli/config.json`，每块表一条：

```json
"extApi": {
  "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678": { "enabled": true, "token": "gk_..." }
}
```

## 新设备验证

账号在新设备首次登录时会返回 `010410`。CLI 会列出服务端支持的验证方式，并引导完成密保问题验证：

- 自动拉取该账号的密保问题，例如手表天才号、手表绑定号、手表最后使用过的号码
- 默认选中包含「天才号」的问题，输入 10 位手表天才号即可
- 验证通过后自动换取登录票据并加载手表列表

WebUI 登录遇到该错误时会弹出密保问题对话框，同样默认选中「手表天才号」。

## 绑定手表

支持两种绑定方式，均在 WebUI 的「功能 → 绑定手表」页操作：

**未绑定过的手表**

1. 输入 16 位手表绑定号
2. 若服务端返回 `010014`，输入手表屏幕上显示的验证码
3. 选择手表端登录的账号：
   - `0` 创建新的账号：绑定为管理员，新账号由手表端注册生成，绑定完成后可在账号列表看到
   - `1..n` 选择已有账号：执行跨表迁移，可选择是否保留旧手表上的数据
4. 提交后当前账号成为该手表管理员

**已有管理员的手表**

1. 查询会显示管理员信息，绑定方式只能选择「申请加入」
2. 如服务端要求校验管理员手机号，输入管理员完整手机号（最多 5 次）
3. 提交后由管理员在手表上同意，申请期间可随时撤回

手表验证码相关错误会明确提示：`010015` 验证码错误、`010016` 已失效、`010017` 错误次数上限、`010018` 当日次数上限。

## 后台消息监听

登录成功后（以及 WebUI 服务启动时）会自动建立 IM 长连接，无需手动打开聊天页；断线后每 60 秒自动重连。

监听过程中会把业务推送写入本地状态，并从聊天列表中过滤掉：

| 类型 | 内容 | 处理 |
| --- | --- | --- |
| `27` | 手表电量上报 | 更新电量与上报时间 |
| `11031` / `39000010` | 位置上报 | 更新最近坐标与地址 |
| `30` / `35` / `47` | 宝贝资料、绑定关系、基础信息变更 | 标记需要刷新 |
| `88` | 好友申请 | 可自动同意，不展示为聊天消息 |
| `contentType >= 1000` | 系统消息 | 直接过滤 |

WebUI 每 30 秒同步一次电量与上报时间，不需要手动刷新页面。

## 型号能力门控

不同型号支持的功能不同。项目启动后会向服务端查询当前手表的模块开关，并根据返回值决定是否展示和允许修改某项功能：

- `display = 0`：支持
- `display = 1`：不支持，隐藏入口并拦截写操作
- `display = 2`：可见但不可用，展示提示并拦截写操作
- 没有下发记录：按官方型号默认策略回退，不强行拦截

这样在 WebUI 里不会向服务端提交当前型号不应支持的设置。

## AI 自动回复

在 WebUI 的「功能 → AI 助手」中配置：

- `baseUrl`：兼容 OpenAI 的接口地址
- `apiKey`：接口密钥
- `model`：模型名称
- `trigger`：`auto` 自动回复，或 `keyword` 关键词触发
- `keywords`：关键词列表
- `systemPrompt`：系统提示词
- `sessions`：启用自动回复的会话

配置保存在本地运行期配置文件中，不会提交到仓库。

## 数据与隐私

- 仓库中不包含任何账号、密码、登录票据、手机号、设备标识、手表 ID 或推送密钥；README 示例里的令牌、手表 ID 与名称均为占位符
- 服务地址、版本参数与签名盐集中在内置的 `src/site.config.js`
- 登录票据与设备标识只保存在 `~/.watch-parent-cli/config.json`
- 终端输出默认对手机号、身份证、邮箱、银行卡等做脱敏
- WebUI 默认监听 `0.0.0.0`（局域网可访问），但所有接口都要求访问令牌
- 目录里那几份第三方素材的版权情况见[第三方资源](#第三方资源)

## 已知限制

项目按「能跑通、能日常用」的标准在做，下面这些是明确还没搞定的部分，欢迎提 PR。

**功能缺口**

- 短信验证码登录：SSO 路径已确认，尚未接入，目前只能账号密码登录
- 摄像头管控、应用白名单：未实现
- 隐私相关开关：各网关的写接口都返回 `000007`，目前只能查看不能修改
- 单应用使用时长：接口还没定位到
- OneBot v11 还缺 HTTP 上报（webhook）；撤回/禁言/戳一戳/群文件只是「静默成功」的兼容实现，微聊本身没有这些能力

**需要真机验证**

- 全新手表的管理员绑定：代码已实现，但缺少真表端到端验证
- 非管理员迁移：未实测

**协议风险**

- 接口路径、参数和签名会随官方客户端版本变化，升级后可能需要同步调整 `src/site.config.js`
- 型号能力门控是为了降低异常请求被风控的概率，但**不保证不封号**，请自行评估风险

## 常见问题

**登录失败**

检查 `ssoHost`、`ssoSalt`、`checksum`、`brand`、`apkType` 等参数是否与客户端版本匹配。

**接口返回参数错误**

不同版本的接口路径和参数可能变化，请以实际客户端版本为准。

**WebUI 页面打不开**

确认端口未被占用（`lsof -nP -iTCP:8787`）。默认监听 `0.0.0.0`，本机和局域网都能连；如果连不上，检查系统防火墙是否拦了该端口。

**WebUI 一直停在令牌输入页**

令牌在启动终端里打印，也可以在命令行里按 `t` 再看一次。输错 8 次会被锁 10 分钟，着急的话按 `t new` 重新生成一个。

**反向 WS 一直重连 / 日志报「连接被拒绝 HTTP xxx」**

`ws://` 和 `wss://` 要跟对方一致（对方开了 TLS 就得用 `wss://`）。`url` 要写全路径：AstrBot 固定是 `/ws`，部分框架用 `/onebot/v11/ws`，只写到端口会被拒绝。令牌要和对方设置的一致。日志里 `反向 WS 已连接` 才算成功，之后每隔 `reconnect` 秒重试一次是正常行为。

**语音发送失败**

非 AMR 格式需要本机安装 `ffmpeg` 进行转码。

**长语音报「音频切分失败（需要 ffmpeg）」**

微聊单条语音上限 60 秒，超过 58 秒会走自动切段，这一步依赖 `ffmpeg`（切分）和 `ffprobe`（量时长）。两个都在 `ffmpeg` 的发行包里，装完确认 `ffmpeg -version` 和 `ffprobe -version` 都能跑。另外 `data:` 或 `base64://` 传的超长音频可能撞上 OneBot HTTP 请求体 32MB 上限，改用 `http(s)` 地址或降低码率即可。

## 第三方资源

仓库里的部分素材**不是本项目的原创内容**，也不在 GPL-3.0 的覆盖范围内，版权归各自权利人所有：

| 资源 | 路径 | 来源与说明 |
| --- | --- | --- |
| 自定义字体 | `src/assets/fonts/cat-book.ttf` | 「送给猫咪的一本书」，约 15MB。字体文件内未包含版权与许可声明，此处仅作界面字体使用。**如权利人提出异议会立即移除**；你也可以直接删掉该文件，WebUI 会自动回退到 PingFang SC / 微软雅黑，功能不受影响；或换成任意 `ttf` 并保持文件名不变 |
| 表情预览图 | `src/assets/emoji/*.png`（32 张） | 从官方客户端安装包 `assets/emoji_new.zip` 中的 `small/` 目录导出，仅用于「与官方表情一一对应」的互操作展示。版权归原厂商所有 |
| 表情清单 | `src/emoji_preset.json` | 表情代号与名称，同上，源自官方客户端资源 |
| Node.js 吉祥物 | `src/assets/node-mascot.svg` | 来自 [nodejs.org](https://nodejs.org/)，版权归 OpenJS Foundation，仅用于页脚标识「本项目由 Node.js 驱动」 |
| 项目图标 | `src/assets/icon.png`、`icon-180.png` | 本项目自制 |

如果你要基于本项目二次分发（尤其是商业用途），请自行确认上述素材的授权情况，或替换为你有权使用的资源。

## 免责声明

本项目为个人学习与技术研究项目，与任何品牌、公司无隶属关系。文中出现的产品名、商标、界面素材均归各自权利人所有，仅用于说明本项目与哪个服务互操作。

使用者应仅对自己拥有或已获得明确授权的账号和手表使用本项目。因使用本项目产生的任何后果由使用者自行承担。项目作者不对账号封禁、数据丢失、服务变更或其它损失负责。

请遵守当地法律法规以及服务提供方的用户协议。如果不同意上述内容，请勿使用本项目。

## License

本项目基于 [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html) 发布，完整协议文本见 [LICENSE](LICENSE)。

`src/assets/` 下的字体、表情图与 Node.js 吉祥物属于第三方资源，**不受本项目的 GPL-3.0 覆盖**，版权归各自权利人所有，详见[第三方资源](#第三方资源)。

Copyright (C) 2026 JZClientForNode contributors
