<h1 align="center">JZClientForNode</h1>

<p align="center">
  <img src="src/assets/icon.png" width="96" alt="项目图标">
</p>

<p align="center">
  用 Node.js 重构的电话手表家长客户端<br>
  账号 CLI + WebUI 单页面板 · 主页仪表盘（CPU/内存实时监控 + 每日一言） · OneBot v11 桥接（HTTP / WS / 反向 WS） · 型号能力门控 · 后台消息监听 · 自动同意好友申请 · AI 自动回复
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
- [加好友口令 API](#加好友口令-api)
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
| 社交 | 通讯录、好友列表、加好友口令、自动同意好友申请 |
| 绑定手表 | 全新手表管理员绑定（手表验证码 + 天才号选择/迁移）、已有管理员手表的申请加入 |
| 聊天 | 文本、表情（图片预览选择）、颜文字、位置、链接、图片、语音、视频 |
| 手表设置 | 音量、短信同步、定时开关机、睡眠模式、上课禁用、模式限制、省电、系统模式、上学前模式、话费提醒、提醒与通话开关、自动接听授权、短信接收、系统与网络 |
| 应用与管控 | 应用管理、应用商店设置、使用时长、使用报告、聊天管控、功能开关、隐私项查看 |
| 健康与工具 | 健康数据、运动数据、闹钟提醒、手表 WiFi、隐藏功能 |
| 增强能力 | 型号能力门控、后台 IM 常驻监听、自定义字体与背景、AI 自动回复、本地配置持久化、升级不覆盖已有数据 |
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
- 可选：`ffmpeg`（发送非 AMR 格式语音时用于转码）

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
- 聊天：会话列表、消息收发、图片/语音/视频/位置/链接/表情
- 功能：宝贝资料、通讯录、好友、健康、应用、WiFi、闹钟、设置、隐藏功能、绑定
- 我的：账号信息、手表账号、OneBot 接入设置（启停/端口/令牌/反向 WS）、加好友口令 API（开关/令牌）、外观（自定义背景）、退出登录
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

WebUI 起来后会同时拉起一个 OneBot v11 服务，可以把微聊接进 AstrBot、NoneBot 这类机器人框架。

| 传输 | 默认地址 | 令牌 |
| --- | --- | --- |
| HTTP API | `http://0.0.0.0:5700` | `onebot.http.token` |
| 正向 WebSocket | `ws://0.0.0.0:5701` | `onebot.ws.token` |
| 反向 WebSocket | 由 `onebot.wsClient.url` 指定（默认关闭） | `onebot.wsClient.token` |

令牌首次启动自动生成并写回配置，命令行按 `o` 查看地址和令牌，`o new` 重置（会断开已接入的机器人）。

**在 WebUI 里直接改设置**

打开 WebUI → 底部「我的」→「OneBot v11 接入」卡片 → 右上角「设置」。设置区按 `基础设置` / `HTTP API` / `正向 WebSocket` / `反向 WebSocket` 分成四组折叠面板，点标题展开，标题上会显示当前值摘要（如 `已启用 · :5700`）。可以改：

- 总开关、心跳间隔
- HTTP API / 正向 WS：各自启停、监听地址、端口
- 反向 WS：启停、地址、令牌、重连间隔
- 每个令牌旁边的「重置」按钮（旧令牌立即失效）

点「保存并重启」后 OneBot 会**热重启**，不用重启整个程序。如果端口被别的程序占用，保存会成功但状态显示「未监听」，页面会给出提示。

**正向还是反向？**

| 场景 | 用哪种 | 说明 |
| --- | --- | --- |
| AstrBot 和本程序在同一台机器 / 同一局域网 | 正向 WS | AstrBot 主动连 `ws://<本机 IP>:5701`，本程序不用开端口映射 |
| AstrBot 跑在公网服务器 / 另一台机器，本程序在家庭网络内 | 反向 WS | 本程序主动连 AstrBot 的 WS 端点，穿透 NAT 不用做端口映射 |
| 只需要偶尔调一下接口 | HTTP API | `POST http://<IP>:5700/<action>?access_token=...` |

**在 AstrBot 里配置**

正向 WS：

1. 平台选 `OneBot v11 (aiocqhttp)`
2. WS 地址填 `ws://<电脑局域网 IP>:5701`
3. access_token 填上面的 WS 令牌

反向 WS（由本程序主动连过去）：

1. AstrBot 里新建一个 `OneBot v11` 平台，连接方式选 **反向 WebSocket**，记下它监听的路径（形如 `ws://<AstrBot 地址>:6199/onebot/v11/ws`）和 access_token
2. 本程序配置文件里填：
   ```json
   "wsClient": { "enabled": true, "url": "ws://1.2.3.4:6199/onebot/v11/ws", "token": "对方设置的令牌", "reconnect": 5 }
   ```
3. 重启 WebUI。日志出现 `[onebot] 反向 WS 已连接` 即成功；断线会按 `reconnect` 秒数自动重连

令牌会同时以 `Authorization: Bearer <token>` 和 `?access_token=<token>` 两种形式发送，AstrBot 两种校验方式都认。

**ID 映射**

| OneBot 字段 | 微聊里的含义 |
| --- | --- |
| `self_id` | 自己的 IM 账号 ID |
| 私聊 `user_id` | 手表的 IM 账号 ID |
| 群 `group_id` | 家庭群的 dialogId |
| 群成员 `user_id` | 该成员的 IM 账号 ID |

**支持的 action**

`get_login_info` `get_status` `get_version_info` `get_friend_list` `get_group_list` `get_group_info` `get_group_member_list` `get_stranger_info` `send_private_msg` `send_group_msg` `send_msg` `get_msg` `can_send_image` `can_send_record`

消息段支持 `text` `face`（表情序号）`image` `record` `at` `reply`（忽略）`location`；字符串形式的消息支持 `[CQ:image,file=...]` / `[CQ:face,id=...]` 这种简单 CQ 码。

**暂不支持**：HTTP 上报（webhook）、撤回、禁言、戳一戳、合并转发。

配置在 `~/.watch-parent-cli/config.json`：

```json
"onebot": {
  "enabled": true,
  "heartbeat": 30,
  "http": { "enabled": true, "host": "0.0.0.0", "port": 5700, "token": "jz_..." },
  "ws":   { "enabled": true, "host": "0.0.0.0", "port": 5701, "token": "jz_..." },
  "wsClient": { "enabled": false, "url": "", "token": "", "reconnect": 5 }
}
```

只开反向 WS 时可以把 `http.enabled` / `ws.enabled` 都设成 `false`，本程序就只做客户端，不监听任何端口。

### 实时日志

WebUI 启动后，终端会实时打印带时间戳、按级别着色的日志：

```text
[18:00:56.062] INFO  webui   服务已启动 http://127.0.0.1:8787
[18:00:57.114] HTTP  GET /api/watches?refresh=1 → 200 507ms 686B
[18:00:57.331] API   GET watch.okii.com/mobileinit/authid → 000001 217ms
[18:00:57.402] INFO  im      后台监听在线 imAccountId=115554045
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

## 加好友口令 API

给第三方脚本 / 机器人用：不用登录 WebUI，凭一个独立令牌就能取到孩子的加好友口令。

在 WebUI 底部「我的」→「加好友口令 API」卡片里点「启用接口」，会自动生成一个 `gk_` 开头的令牌，页面上能直接复制接口地址和令牌。也可以随时「关闭接口」或「重置令牌」（旧令牌立即失效）。

**请求**

```bash
# query 传令牌（推荐，方便直接 curl / 浏览器调试）
curl "http://192.168.1.10:8787/api/ext/genius?token=gk_xxxx"

# 指定手表（不传则用第一台）
curl "http://192.168.1.10:8787/api/ext/genius?token=gk_xxxx&watchId=a1b2c3d4..."

# 也可以走 Header
curl -H "Authorization: Bearer gk_xxxx" "http://192.168.1.10:8787/api/ext/genius"
```

**响应**

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

失败时 `ok` 为 `false` 并带 `error` 文案。HTTP 状态码：未启用 `403`、令牌错误 `401`、手表不存在 `404`、方法不对 `405`。

**注意**

- 这个令牌和 WebUI 访问令牌**完全独立**，互不通用（对外令牌调不了 WebUI 接口，WebUI 令牌也调不了这个接口）
- 每次调用都会真实向服务器申请一个新口令，旧口令可能随之失效，不要高频轮询
- 配置在 `~/.watch-parent-cli/config.json` 的 `geniusApi` 字段：

```json
"geniusApi": { "enabled": true, "token": "gk_..." }
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
- OneBot v11 还缺 HTTP 上报（webhook）、消息撤回、禁言、戳一戳、合并转发

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

`ws://` 和 `wss://` 要跟对方一致（对方开了 TLS 就得用 `wss://`）。`url` 要写到对方的完整路径，通常是 `.../onebot/v11/ws`，只写到端口会 404。令牌要和对方设置的一致。日志里 `反向 WS 已连接` 才算成功，之后每隔 `reconnect` 秒重试一次是正常行为。

**语音发送失败**

非 AMR 格式需要本机安装 `ffmpeg` 进行转码。

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
