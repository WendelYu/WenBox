# WenBox — 内网文件互传与现场实施工具

<p align="center">
  <img src="app/src/main/assets/web/logo.png" alt="WenBox Logo" width="96" height="96">
</p>

<p align="center">
  本地打包，直接传到现场电脑。连接一直在，不再来回插拔 U 盘。<br>
  Windows · macOS · Android · Web ｜ 局域网传输 ｜ 无需云盘或账号
</p>

<p align="center">
  <a href="https://github.com/WendelYu/WenBox/releases"><img src="https://img.shields.io/github/v/release/WendelYu/WenBox?label=Release" alt="GitHub release"></a>
</p>

## 键鼠流转与文本同步

Mac + Windows 支持双机配对、记住设备自动连接、四方向布局、鼠标/滚轮速度、自定义修饰键，以及默认关闭的双向文本剪贴板。Mac 流转组件要求 macOS 14+；Windows 统一安装包包含输入服务，支持已登录桌面的管理员窗口和 UAC。聊天身份会跨重启保留；旧消息位置可在本机恢复。安装步骤见 [安装文档](docs/INSTALLATION.md)，故障恢复的验收边界见 [M3 集成说明](docs/KVM_M3_INTEGRATION.md)。

## 为什么做 WenBox

最初是为了解决我自己的两个需求：**内网互传文件**，以及**现场实施时反复更新程序**。

现场调试经常是这样的：在自己的电脑上修改代码、打包，把程序复制到 U 盘，拔下来插到现场电脑，再复制过去运行。发现问题后继续改、继续打包，再把 U 盘拿回来重来一遍。一次两次还好，需要多次修改时，来回拷贝和插拔就很麻烦。

现场电脑也不一定有 Wi-Fi，已有网口可能正连接工控设备，没有多余网口可用。所以我想让两台电脑通过 **USB 网卡加网线** 保持连接：自己的电脑负责开发和打包，现场电脑接收新程序。线可以一直插着，每次打包后把新文件发过去即可；现场的日志、截图和配置文件也能传回来。

WenBox 围绕这个流程提供文件互传、文字和截图交流，并把 JSON、进制转换、Cron 等现场常用的小工具放在一起。

## 现场怎么用

### 有局域网：直接互传

1. 两台设备接入同一可互通的局域网，打开 WenBox 桌面客户端。
2. 桌面客户端启动时会开启本机服务并创建默认免密房间。普通局域网不会自动把两端合并；可在一端解散默认房间，然后从发现大厅选择另一端的房间加入。
3. 也可以在房主的“连接详情”中复制地址，让另一端通过地址加入；手机或未安装客户端的电脑可用浏览器访问 `http://房主IP:9527`。
4. 在房间内拖入或选择文件发送，也可添加共享文件供对方下载。

### 没有空闲网口或 Wi-Fi：USB 网卡加网线直连

连接方式为：

```text
开发电脑 ─ USB 网卡（USB-A / USB-C 转 RJ45）─ 网线 ─ 现场电脑的网口
```

如果两边都没有空闲网口，两边各接一个 USB 网卡，中间用网线连接。**这里的“USB 网线”是 USB 转以太网适配器加网线，不是普通 USB 数据线直接连接两台电脑。**

1. 提前准备目标系统能识别的 USB 网卡。离线现场应选系统自带驱动可用的型号，或提前装好驱动；WenBox 不包含网卡驱动。
2. 两端新增网卡保持“自动获取 IPv4”，无需路由器或网络共享，原有工控网口可以继续使用。
3. 两端打开 WenBox。无 DHCP 服务时，等待系统给新增网卡分配 `169.254.x.x` 地址；分配速度取决于系统，不保证插线后立即完成。
4. 当只有一个符合条件的对端，且本机是空闲的默认免密房间时，客户端会自动发现并选定房主，另一端加入。连接后即可传文件。
5. 网线保持连接。每次本地重新打包完成，再选择新的程序包发送或共享，现场电脑接收后按原有流程替换、安装或运行。

WenBox 当前负责**传输**，不监听构建目录、不自动发送新产物，也不自动覆盖或部署现场程序。同名文件的保存策略可能生成新名称，更新程序前请确认接收到的是本次构建。

手动房间、密码房或已有内容的会话不会被自动离开；手动退出后也不会立即被自动拉回。更多连接条件、重连行为和排查方法见 [USB 网卡直连指南](docs/USB_ETHERNET_DIRECT.md)。

### 发现不到或连不上

- 确认网卡已识别、网线链路正常，两端地址可互通。
- Windows 防火墙需允许 WenBox 在实际使用的网络上通信；直连可能被识别为公用网络。macOS 需允许本地网络访问和入站连接。
- 本机服务使用 **TCP 9527**，自动发现使用 **UDP 9528**。不要在同一电脑同时运行多个网络后台。
- 自动发现受广播域、防火墙和网络隔离影响；可尝试通过对方地址加入。WenBox 不提供跨子网穿透或绕过企业网络策略的功能。

## 现在能做什么

### 文件与消息

- 房主分享文件，其他成员浏览、下载；成员也可向房主上传文件。
- 桌面端接收文件保存到系统下载目录下的 `WenBox` 文件夹；同名文件避免直接覆盖。
- 支持文字、文件卡片和图片预览；桌面/Web 可通过选择、拖放或粘贴截图发送，受当前系统与浏览器权限限制。
- 上传队列支持取消和重试，区分排队、发送进度、等待对方确认、送达与失败。
- 支持昵称名片、在线成员查看、IP 复制、房间地址及二维码分享。
- 可创建密码房，保存常用房间配置。默认房间为免密房，有访问控制需求时请手动创建密码房。

传输由房主服务协调，不是所有成员之间分别建立直连。实际速度取决于网卡、USB 接口、网线、磁盘和网络环境，不承诺固定速率。

### 房间文件与分类归档

在快传的「房间文件 → 选择文件并分类归档」中，勾选分享或接收记录里的文件，填写分类文件夹名（如 `现场照片`、`程序包`），再选择保存位置。可选日期前缀，例如 `2026-10-26_现场照片`。选择已有分类的上级目录即可合并保存；同名文件自动编号，原文件保留。失败项保持勾选，可重试。工具页不再单列日期归档。

- Tauri 桌面端使用原生目录选择与文件保存。v1.4.2 起，上传、图片预览和成员心跳通过 Rust 原生网络请求，避免 Windows HTTPS WebView 对局域网 HTTP 的限制。上传分块读取并临时落盘，发送结束或取消后清理，请保留足够的临时磁盘空间。
- 桌面图片预览上限为 32 MiB；大图或系统不支持的图片格式可用“保存图片”下载后查看。
- 支持目录选择 API 且满足安全上下文要求的浏览器可选择目录。
- 普通局域网 HTTP 网页不支持选择归档目录时会明确提示，请使用桌面客户端归档；仍可逐个下载文件。
- macOS / Windows 的图片复制写入系统图片剪贴板，可粘贴到支持图片的应用；不会复制图片地址或消息标记。原图下载使用原生保存对话框，保留附件所属房间的下载地址。

### 随手工具

- **JSON**：格式化、压缩、语法错误提示和复制。
- **进制转换**：HEX、DEC、BIN、OCT 与 ASCII 的常用转换。
- **Cron**：常用模板、表达式解释和后续触发时间预览。预览有搜索范围限制，不应替代目标调度器的校验。

桌面/Web 使用共享的浅深色界面，包含“快传 / 工具”导航和减少动态效果支持。Android APK 使用独立 Kotlin 原生界面，工具页包含 JSON、进制与 Cron，并非桌面界面的完整复制。

## 下载与安装

前往 [GitHub Releases](https://github.com/WendelYu/WenBox/releases)，选择已成功发布的版本。源码或工作流更新不代表所有平台安装包已经构建完成。

- **Windows 10 / 11**：优先下载文件名含 `Installer` 的 EXE，安装包配置为携带离线 WebView2 安装器。裸 EXE 需要电脑已安装 WebView2，不适合缺少运行时的离线现场。单位安装策略仍需事先确认。
- **macOS 12.3+**：下载 `WenBox-macOS-v版本号-universal.dmg`，打开后拖入“应用程序”；也可解压同名 ZIP。通用包包含 Intel 与 Apple Silicon 两种架构，附有 `SHA256SUMS-macOS-v版本号.txt`。
- **Android 8.0+**：下载 APK 安装。当前工作流输出 Debug APK；后台传输会受系统电池优化和厂商策略影响，不保证永久保活。
- **浏览器**：访问房主的 `http://IP:9527`，无需单独安装。浏览器访问的是房主提供的网页，不会独立启动 UDP 发现服务。Linux / iPhone / iPad 可使用可用的现代浏览器，当前不提供对应原生安装包。

自动发布附件可能带版本号，标签发布附件使用固定名称，以 Release 页面实际文件为准。

## macOS 提示“已损坏，无法打开”怎么办？

当前流水线未配置 Apple Developer ID 签名与公证，首次启动可能被 Gatekeeper 拦截。请仅对从本项目 Release 下载且确认可信的 WenBox 使用下述办法。

1. 先将 `WenBox.app` 拖到“应用程序”，不要直接在 DMG 中运行。
2. 打开“终端”，粘贴执行：

   ```bash
   xattr -dr com.apple.quarantine "/Applications/WenBox.app"
   ```

3. 回到“应用程序”，重新双击 WenBox。若提示“Operation not permitted”，确认应用归当前用户所有；安装到 `~/Applications` 时将命令中的路径换成 `"$HOME/Applications/WenBox.app"`。受单位管理的设备请联系管理员，不要关闭系统安全机制。

此命令只移除 WenBox 的下载隔离标记，不会修复真正损坏的文件，也不等同于 Apple 公证。若提示“无法验证开发者”，可先到“系统设置 → 隐私与安全性 → 仍要打开”。若提示会损坏电脑/发现恶意软件，不要绕过。

如果是 **DMG 本身无法挂载** 或以上方法无效，请重新下载或改用 ZIP，并与同页 `SHA256SUMS-macOS-v版本号.txt` 核对校验值；不要反复执行解除隔离命令。

参考：[Apple 安全打开应用说明](https://support.apple.com/102445)、[Tauri macOS 签名与公证](https://v1.tauri.app/v1/guides/distribution/sign-macos/)。

## 技术实现与代码位置

- **Windows / macOS**：Rust + Tauri 1.x。Windows 使用 WebView2，macOS 使用系统 WKWebView；HTTP 文件服务使用 `tiny_http`，UDP 承担发现与广播。
- **Android**：Kotlin、Jetpack、协程与 NanoHTTPD，使用原生页面及前台传输服务。
- **共享网页**：HTML、CSS 和原生 JavaScript，供桌面客户端及房主的浏览器访客使用。
- **会话**：房间、成员心跳、PIN 和令牌；文件与消息通过房主 HTTP API 交换。桌面服务启动时就监听端口，不是点击建房后才启动。

```text
src-tauri/src/main.rs             桌面房间、HTTP 文件服务和原生命令
src-tauri/src/native_transport.rs 原生请求、分块上传、进度与取消
src-tauri/src/network.rs          IPv4、子网匹配与发现网络接口
src-tauri/tauri.conf.json         窗口、离线 WebView2 与 macOS 最低版本
app/src/main/assets/web/          共享 UI、上传队列与交互逻辑
app/src/main/java/com/landrop/    Android 原生界面与网络服务
app/src/test/                    Android 单元测试
tests/                           JavaScript 回归测试
scripts/check-web-ui.cjs          三浏览器引擎交互回归
scripts/check-direct-connection.cjs  模拟双端直连回归
.github/workflows/               平台构建、兼容性检查与发布
```

仓库保留 Electron 相关开发入口，但正式 Windows / macOS 发布使用 Tauri。`npm start` 启动的是 Electron 外壳，不等于完整的 Tauri 传输客户端。

## 本地构建与验证

### 桌面端

使用当前 Rust stable 与 Node.js 24。Windows 构建还需 MSVC C++ 构建工具及 Windows SDK；Mac 需 Xcode Command Line Tools。首次安装依赖和准备离线运行时需要构建机器联网，不是在现场安装时下载。

```bash
npm ci
npx --yes @tauri-apps/cli@1.5 dev
# 生成当前平台安装包
npx --yes @tauri-apps/cli@1.5 build
```

Windows 输出位于 `src-tauri/target/release/` 及其 `bundle/` 子目录。在 Mac 上生成通用包：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx --yes @tauri-apps/cli@1.5 build --target universal-apple-darwin --bundles app,dmg
```

通用包输出位于 `src-tauri/target/universal-apple-darwin/release/bundle/`。

### Android

使用 Android Studio 打开项目，配置 **JDK 17、Android SDK 34、Gradle 8.2**。可从 IDE 构建 APK；命令行环境缺少 `gradlew` 时先用 Gradle 8.2 生成 wrapper：

```bash
gradle wrapper --gradle-version 8.2
./gradlew assembleDebug testDebugUnitTest lintDebug
```

Windows 使用 `gradlew.bat`。APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

### 回归检查

```bash
npm test
npm run lint:css
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

浏览器测试使用模拟服务，不访问真实房间或用户文件：

```bash
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium webkit firefox
BROWSER_ENGINE=chromium UI_SCREEN_DIR=dist/compat-chromium node scripts/check-web-ui.cjs
BROWSER_ENGINE=webkit UI_SCREEN_DIR=dist/compat-webkit node scripts/check-web-ui.cjs
BROWSER_ENGINE=firefox UI_SCREEN_DIR=dist/compat-firefox node scripts/check-web-ui.cjs
node scripts/check-direct-connection.cjs
```

以上环境变量写法适用于 macOS/Linux shell。也可用 `PLAYWRIGHT_MODULE` 指定 Playwright 模块，用 `BROWSER_EXECUTABLE` 指定已有浏览器。

当前版本已完成本机 Mac 构建、三引擎界面回归和共享逻辑、Rust、Android 单元测试。Android lint 仍有警告。模拟回归不能替代 Win10 离线安装、实际 WebView2、Intel Mac、Android 真机和 USB 网卡双机验收。

## 更新与发布

当前代码版本为 **v1.4.0**，详细变更见 [更新说明](docs/RELEASE_NOTES.md)。本轮主要增加 USB 网卡直连、网卡热插拔与重连支持，重做房间、昵称、成员、归档和传输 UI，修复 WebKit 焦点恢复，并配置 macOS 通用包与 Windows 离线运行时。

- `auto-release.yml`：main/master 的非纯文档更新触发多平台构建，成功后按 `package.json` 版本发布；发布新版本前应同步提升各端版本号。
- `release.yml`：推送 `v*` 标签或手动选择标签发布。
- `release-macos.yml`：两个发布入口共用的 macOS 通用 DMG/ZIP 打包、架构检查与校验文件生成。
- `web-compatibility.yml`：Chromium、WebKit、Firefox 交互回归。

发布正文来自 `docs/RELEASE_NOTES.md`。修改 README 不会自动更新已发布版本的说明或重新生成安装包。

## 使用边界与隐私

文件和消息在设备之间通过局域网 HTTP 传输，不需要云存储或外部账号。当前传输不是端到端加密通道，PIN/令牌用于房间访问控制，不能替代网络加密；请在可信或受控的网络中使用。默认免密房间可被可达设备加入，有需要时改用密码房。

WenBox 不负责现场程序的安装、进程重启、回滚或构建目录同步。它解决的是反复搬运文件的过程：**线保持连接，修改完成后直接传输，部署步骤仍由使用者确认执行。**

## 作者

[Wendel](https://github.com/WendelYu)

### 网卡地址缺失或加入超时

Windows 已有 `169.254.x.x` 地址但 WenBox 没显示时，请先升级到 v1.4.1 或更新版本。新版通过 Windows IPv4 地址表补充枚举网卡；开房后可点击“附近房间”，同时查看 WiFi 和网线发现的房间。

保持 Windows 端 WenBox 打开，在命令提示符执行 `ipconfig` 和 `netstat -ano | findstr :9527`，再在该电脑浏览器打开 `http://127.0.0.1:9527/api/status`：

- `all_ips` 应包含网线的 `169.254.x.x` 地址；`version` 可确认运行版本。
- `0.0.0.0:9527 LISTENING` 表示服务监听所有 IPv4 接口，但不能证明其他电脑能通过防火墙访问。
- 多网卡时，请选择卡片上实际可达的地址；WiFi 和网线使用各自的地址，直连地址不需要默认网关。
- 如地址齐全但仍超时，检查 Windows 防火墙是否允许当前 WenBox 程序在对应网络配置文件上接收 TCP 9527 和 UDP 9528，以及 macOS 是否允许 WenBox 访问本地网络。无需关闭整个防火墙。

客户端顶部显示当前版本，并每 5 秒检查服务状态。显示“服务未就绪”时可点击“重新检测”；服务版本与客户端版本不一致时，请退出旧客户端再打开新版。服务正常仅表示本机接口可用，不代表对端防火墙已放行。

桌面端支持把 Finder / Windows 资源管理器中复制的文件粘贴到聊天输入框，也支持多文件和截图；文件会进入发送队列，普通文字仍保留在输入框。文件夹请先压缩成 ZIP。

桌面房主从 v1.4.4 开始保存房间、消息和附件索引，重启后恢复；原始接收文件保存在接收端的 `Downloads/WenBox`。短暂断线时保留原房间并重试。错误通知支持“复制错误详情”及手动关闭。旧版丢失的索引无法自动找回，请在原接收端下载目录中检查文件。

详细步骤见 [安装、更新和流转设置](docs/INSTALLATION.md)。
