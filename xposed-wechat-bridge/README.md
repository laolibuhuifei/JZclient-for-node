# JzLoginBridge（LSPosed 模块）

在 `com.xtc.watch` 小天才家长端内复用宿主已有的微信 SDK。手机网页发起请求后，模块在小天才里显示来源确认，再打开微信完成 `snsapi_userinfo` 授权；真实 `code` 直接交给宿主官方登录链路，网页只取得宿主生成的账号会话。

当前版本用于完成真实微信登录。模块主界面使用 Jetpack Compose 与 Material Design 3，并沿用 WebUI 的 `JZCatBook` 字体；授权确认使用小天才宿主的原生对话框，会在登录方式选择页稳定显示后出现。页面会显示登录是否转交小天才以及最近一次宿主登录结果。模块不会把微信授权码交给网页、写入日志或保存到文件。

## 安装与启用

1. 安装 `app-debug.apk`。APK 在桌面显示为 **JzLoginBridge**，可查看登录流程和最近一次结果。
2. 打开 LSPosed，进入“模块”，选择 **JzLoginBridge** 并启用。
3. 作用域只勾选 **小天才家长端**（`com.xtc.watch`）。
4. 彻底关闭并重新打开小天才家长端，让模块注入新进程。
5. 每次捕获到微信授权响应，模块会打开凭证界面。也可以从桌面图标手动打开；它只显示当前运行期间的内存数据。如需确认加载结果，在 LSPosed 日志中查找：

   ```text
   [JzLoginBridge] loaded in com.xtc.watch
   ```

LSPosed 不需要重打包或重签名小天才 APK，因此不会引入 LSPatch 重签名导致的微信签名校验变化。

## 网页使用

网页必须在**同一台手机**的浏览器中打开，因为桥接地址是手机自己的回环地址：

```text
http://127.0.0.1:38787
```

ES 模块客户端位于 `client/wechat-bridge.js`：

```js
import { requestWechatAuthorization } from './wechat-bridge.js';

const { session, state } = await requestWechatAuthorization({
  onStatus(snapshot) {
    console.log(snapshot.status); // 不输出 code
  },
});

// session 由小天才宿主登录后生成，应立即交给 JZ 后端，不要持久化。
```

也可以从 `client/` 目录启动一个静态 HTTP 服务，用手机访问 `demo.html` 做真实授权联调。不要直接用 `file://` 打开，因为模块会拒绝 `Origin: null`。

网页点击“使用微信登录”后，浏览器先创建一次性随机状态，随后打开下面的深链：

```text
jzloginbridge://authorize?state=<一次性状态>&returnUrl=<原网页地址>
```

`JzLoginBridge` 校验状态格式后打开小天才。深链不携带账号、会话、设备标识或微信授权码。小天才未运行时，模块会直接启动宿主并传递一次性状态；宿主已在前台时，则通过 `onNewIntent` 接收状态，无需退出小天才重来。网页同时会在最长 25 秒内重试连接桥接服务，避免宿主尚未启动时直接提示“连不上桥”。

完整流程：

1. 网页检查模块状态并生成 32 字节随机 `state`。
2. 网页通过 `jzloginbridge://authorize` 打开模块，模块再启动小天才。宿主进程通过 `onResume` 或 `onNewIntent` 收到一次性状态，等待登录方式选择页保持在前台并连续稳定后，才显示宿主原生确认框；启动页和页面切换不会提前弹出确认框，微信 SDK 是否初始化也不会阻塞确认。
3. 只有用户点击“允许并登录”后，模块才再次探测微信 SDK（最多 8 秒），就绪后通过宿主官方登录链路打开微信；取消、返回键或点击遮罩会结束本次请求。
4. 用户在微信中授权。
5. 桥接把微信 `code` 交给小天才宿主官方 `MobileService.wc()`。
6. 宿主完成 SSO 换票、下载账号和手表后，桥接读取 `MobileAccount`。
7. 成功后 JzLoginBridge 显示“授权已完成，请返回网页继续操作！”，并在宿主页面更新结束时再次将模块任务置前。网页轮询取得账号会话并校验 `state`。

模块不会自动切回浏览器。用户返回原网页后，网页会读取待处理结果。

如果浏览器没有直接打开 `JzLoginBridge`，可手动从桌面启动；页面仍会保留待处理的授权状态并从 `waiting_for_host` 继续。手机会在返回浏览器时恢复轮询，不要求浏览器在宿主前台保持运行。

## 原生界面

捕获成功后会自动打开模块界面，并显示以下内容：

- 宿主官方账号登录是否完成。
- 请求来源、微信错误码、捕获时间和小天才版本。
- 独立结果详情使用 Material 3 底部浮层；页面只复制一次性状态，不显示完整宿主会话。

界面使用模块自己的 Activity，不依赖小天才 WebView。`code/session/state` 只短暂保留在内存中，不写入日志、SharedPreferences 或文件。窗口设置了 `FLAG_SECURE`，系统最近任务缩略图和录屏不会显示凭证。再次捕获或点击“清空结果”会覆盖或清除当前内容。

## 安全边界

- 服务只绑定 `127.0.0.1`，局域网其他设备无法直接连接。
- 每次授权都需要用户在小天才里确认完整网页来源。
- `Origin`、`Host` 和随机 `state` 均校验，支持浏览器 CORS 与 Private Network Access 预检。
- 同时只允许一个进行中的请求，请求两分钟后过期。
- 成功和失败结果都只能由原来源读取一次。
- 桥接响应不会进入小天才原有的登录广播，避免宿主先消费一次性授权码。
- 宿主原生登录使用固定 `login_state`，也会拦截并交给 JZ App，阻止宿主消费一次性授权码；账号绑定的 `relative_state`、分享和支付流程不受影响。
- 微信授权码不返回网页、不写日志、不落盘，模块不包含也不处理微信 AppSecret。

## 构建与验证

需要 JDK、Android SDK 和网络连接：

```powershell
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat testDebugUnitTest assembleDebug
```

输出：

```text
app/build/outputs/apk/debug/app-debug.apk
```

项目使用旧版 Xposed API 82 作为 `compileOnly` 依赖，`assets/xposed_init` 指向 `XposedEntry`。该格式兼容 LSPosed，且 API 桩不会进入 APK。

## 当前验证范围

- Android Java 编译和 Debug APK 签名打包已通过。
- 授权状态、来源隔离、单次读取、过期和取消等单元测试已通过。
- 已在小天才家长端 `9.48.00` 上验证原生 `login_state` 回调、桥接服务启动和 APK 构建。
- 网页微信登录还要求在实机点击一次真实授权，以确认宿主完成换票后的账号会话格式。

若模块已加载但授权时报 `host_incompatible`，请提供小天才版本和 LSPosed 中 `[JzLoginBridge]` 附近的错误日志。
