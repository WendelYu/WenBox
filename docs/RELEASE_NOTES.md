## WenBox v1.4.1 · 网线直连与多网卡修复

- Windows 增加系统 IPv4 地址表补充枚举，补全第三方网卡库可能漏掉的 `169.254.x.x` 地址；过滤已断开、删除或无法绑定的地址。
- 保留 WiFi、网线和 VPN 接口，未手动选择时优先显示局域网地址，避免自动刷新持续沿用旧 VPN 地址。
- 新增“附近房间”入口，开房后也能查看附近设备，无需先解散房间。
- 修复同一房间经多个网卡被发现时，点击加入却连接了其他卡片地址的问题。
- 广播与单播发现不再因网卡拒绝组播选项而被一起跳过。
- 连接失败提示包含目标地址与排查信息；状态接口增加版本号，便于确认实际运行版本。
- 增加 Windows 网卡枚举、WiFi 与 APIPA 共存、多地址选择和解散后加入回归。实际现场网卡与防火墙环境仍需两端安装新版验证。

Windows 安装包继续包含离线 WebView2 运行时；macOS 提供 Intel 与 Apple Silicon 通用 DMG、ZIP 和 SHA-256 文件。

### macOS 提示“已损坏”
确认安装包来自本项目 Release，并把 WenBox 拖到“应用程序”后，在终端执行：

```sh
xattr -dr com.apple.quarantine "/Applications/WenBox.app"
```

仅对确认来源可信的 WenBox 应用执行；如果 DMG 本身无法挂载，请重新下载或使用 ZIP，并核对 SHA-256。

---

## WenBox v1.4.0 · 本次更新

### macOS 正式下载包
- 新增 Tauri 原生 macOS 通用包，同时包含 Intel（x86_64）和 Apple Silicon（arm64），要求 macOS 12.3 或更新版本。
- 同时提供 DMG 安装镜像、ZIP 应用包与 SHA-256 校验文件。
- Windows 继续使用 Tauri，安装包包含离线 WebView2 安装器，现场无需联网下载运行时。裸 EXE 仍需要电脑已安装 WebView2。

### 网线直连与设备发现
- 支持 USB 网卡加网线直连产生的 `169.254.x.x` 地址。
- 默认空闲免密房间可自动发现并选定房主；支持网卡热插拔、断线重连和多网卡环境。
- 手动房间、密码房以及已有会话不会被自动切换。

### 界面与操作体验
- 产品名称统一为 WenBox；重新整理导航、浅深色、间距与响应式布局。
- 重做昵称名片、在线成员、创建/加入房间和日期归档页面。
- 文件卡片展示更清晰，上传区分排队、进度、确认接收、成功与失败，支持取消与重试。
- 统一弹窗滑入、按钮按压和进度过渡，遵循系统减少动态效果设置。
- 归档增加快捷主题、文件夹预览、名称校验和部分失败反馈。

### 兼容性修复与验证
- 修复 WebKit 弹窗关闭后的焦点恢复，增加视口高度回退。
- Chromium、WebKit、Firefox 交互回归通过；增加多引擎 CI。
- 共享逻辑 35 项、Rust 后端 34 项、Android 单元测试 33 项通过。Android 构建及 lint 无错误，仍有警告。
- Win10 离线安装、真实 WebView2、Intel Mac 与 USB 网卡双机互传仍需目标设备验收。Android APK 保留独立 Kotlin 原生界面。

## 选哪个下载？

- **macOS**：优先下载 `WenBox-macOS-universal.dmg`，打开后把 WenBox 拖到“应用程序”；也可解压 `WenBox-macOS-universal.zip` 后拖入。
- **Windows**：离线现场优先选择文件名含 `Installer` 的 EXE。裸 EXE 不包含 WebView2。
- **Android**：下载 APK 安装，要求 Android 8.0 或更新版本。

## macOS 提示“已损坏，无法打开”怎么办？

当前流水线未配置 Apple Developer ID 签名与公证，首次启动可能被 Gatekeeper 拦截。请仅对从本项目 Release 下载且确认可信的 WenBox 使用下述办法。

1. 先将 `WenBox.app` 拖到“应用程序”，不要直接在 DMG 中运行。
2. 打开“终端”，粘贴执行：

   ```bash
   xattr -dr com.apple.quarantine "/Applications/WenBox.app"
   ```

3. 回到“应用程序”，重新双击 WenBox。若提示“Operation not permitted”，确认应用归当前用户所有；安装到 `~/Applications` 时将命令中的路径换成 `"$HOME/Applications/WenBox.app"`。受单位管理的设备请联系管理员，不要关闭系统安全机制。

此命令只移除 WenBox 的下载隔离标记，不会修复真正损坏的文件，也不等同于 Apple 公证。若提示“无法验证开发者”，可先到“系统设置 → 隐私与安全性 → 仍要打开”。若提示会损坏电脑/发现恶意软件，不要绕过。

如果是 **DMG 本身无法挂载** 或以上方法无效，请重新下载或改用 ZIP，并与同页 `SHA256SUMS-macOS.txt` 核对校验值；不要反复执行解除隔离命令。

参考：[Apple 安全打开应用说明](https://support.apple.com/102445)、[Tauri macOS 签名与公证](https://v1.tauri.app/v1/guides/distribution/sign-macos/)。
