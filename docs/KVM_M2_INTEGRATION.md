# KVM M2 集成与验收交接

更新：2026-10-28。M2 实现已进入可构建阶段；本机回归和 Mac 应用构建通过，Windows 安装与新服务运行待验收。M0 用户确认的 Deskflow 管理员窗口/UAC 可行性保留，不将其等同于本轮服务已验证。

## 已实现

- 独立设备证书与私钥、TLS 1.3 双向认证控制通道、通道绑定的 8 位验证码。首次需两端人工核对并确认，2 分钟窗口过期失效；候选设备信息不构成信任。
- 保存授权设备与屏幕方向；两端 WenBox 运行且流转启用时，使用证书指纹自动重连。IP 变化通过发现重新定位，再做认证。停止保留配对，解除配对撤销授权。
- 默认 Mac 使用本机键鼠、Windows 接收输入。上下左右四方向编辑、双屏预览、保存和对端同步；应用方向会短暂重启输入连接，离线对端下次连接时同步。
- 浏览器和 Android 只展示能力提示，控制命令只允许本机桌面主窗口。诊断移除配对验证码、会话标识，不记录输入内容。
- 固定 Deskflow 1.27.0 输入核心随应用提供。下载、源码与资源按 SHA-256 校验，交付物带上游对应源码及许可证；不读取或修改原先 M0 独立 Deskflow 配置。
- Windows 独立 `WenBoxKvm` SYSTEM 服务。只接受固定结构配置，输入程序及状态目录固定；验证本机调用者映像、当前已解锁的控制台会话，客户端确认命名管道服务 PID 与 SCM 一致后才发私钥。子进程进入退出即回收的 Job。
- Windows x64 NSIS 管理员安装：保护安装目录及后台状态目录 ACL，安装服务、防火墙规则，升级前停止服务，卸载清理服务及后台状态。用户侧配对文件保留；要彻底撤销设备请先解除配对。安装后普通权限启动界面，文件/房间功能不以 SYSTEM 运行。
- Mac universal 应用内含 arm64/x86_64 输入组件；独立的 WenBox Input 标识，用于系统权限授权。

## 当前约定及限制

1. 发现范围是同局域网 WenBox 桌面设备，复用成员/设备发现；尚未按房间成员严格过滤。首次授权始终要求双方确认，不以房间 PIN 替代。无法发现时可填私有 IPv4 地址。不支持公网及 IPv6。
2. 一套主控物理键鼠可跨屏并返回；不支持两端实体键鼠同时抢占。换主控需解除配对后改角色并重新配对。
3. 当前锁定的 Mac 输入组件要求 macOS 14+（基础文件互传的系统下限未改变）。代码在启动输入前检测版本。
4. 自动连接要求两端 WenBox 已运行、流转已启用且 Windows 已登录。未实现 Mac 登录启动项或 Windows 登录前控制。
5. M3 的异常按键释放、两秒故障恢复指标、长期重连及多网卡压力验收尚未完成。Control+Alt+Escape 是切回主控热键，不等同于完整故障恢复方案。
6. 文本剪贴板尚未实现，输入核心配置中明确关闭；此需求继续保留为后续必做项。
7. 本轮随包带输入库与对应源码，未达到原设想的 8 MB 包体增量；不能把它标记为达标。本机测试包只有临时签名，尚无开发者签名和公证。
8. 存储写入失败会返回错误；解除配对遇到此类错误应修复可写目录后重试，不应认为磁盘授权已永久清除。

## 本机验证

- Rust 全量：62 通过，0 失败，1 忽略。覆盖双端 TLS 与验证码、错误指纹、双方确认、取消/撤销竞态、持久化失败、安全窗口来源、配置生成及命名管道消息边界。
- 独立生产服务 crate 对 `x86_64-pc-windows-msvc` 执行 `cargo check --locked` 通过，未在 Mac 上链接 Windows 安装包。
- Node 共享逻辑 46 项通过；共享 Web 浏览器回归及 M2 模拟原生桥回归通过。独立服务共享逻辑测试 5 项通过，最终 KVM 定向回归 18 项通过。模拟回归不启动输入组件、不授予真实键鼠权限。
- 安装辅助脚本和一次性 CI 冒烟脚本通过 PowerShell 语法解析；此项不验证 Windows 运行效果。
- Mac universal 应用已构建，主程序和输入核心双架构、68 个资源哈希均已检查；最终包临时签名并验证。生成物位于 `src-tauri/target/universal-apple-darwin/release/bundle/macos/WenBox.app`。

## 构建

Mac（安装 Rust、Node 与 Apple 工具链后）：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx --yes @tauri-apps/cli@1.5 build --target universal-apple-darwin --bundles app
node scripts/prepare-kvm-backend.cjs --verify-only
```

Windows 11 x64（Rust MSVC 工具链、VS C++ 构建工具、WebView2、Node）：

```powershell
npx --yes @tauri-apps/cli@1.5 build --bundles nsis
node scripts/prepare-kvm-backend.cjs --verify-only
```

构建前置脚本自动准备固定版本核心和独立后台服务，首次需要联网，之后可复用通过哈希检查的缓存。不要用 Electron 的 `npm run dist:win` 代替此 Tauri 安装包。

也可手动执行 GitHub Actions 的 **Build KVM M2 test installers**。新增工作流只接受手动触发，不发布 release。Windows 作业在一次性 runner 中进行安装→升级→ACL/非授权调用检查→卸载后上传包。该工作流目前尚未提交触发或远程执行，本机不能提供已验证的 Windows exe。

## Win11 双机验收（有 Windows 包后执行）

### 1. 安装与权限

先保留 Windows 实体键鼠。退出原独立 Deskflow，会话及服务不要同时与 WenBox 输入核心运行。不要卸载它，也不要关闭 UAC。

Windows 运行本轮 NSIS 安装包，接受安装的管理员提示；安装位置固定为 Program Files\WenBox。确认界面能以普通用户打开，在 PowerShell 查看服务：

```powershell
Get-Service WenBoxKvm
```

应为 Running。如果缺失或启动失败，停止后续无键鼠测试，保留安装报错和服务状态。

Mac 解压并复制 WenBox.app 到 Applications 后启动。仅在系统提示需要时，通过隐私与安全性授权 WenBox/WenBox Input 辅助功能、输入监控，再重启应用。不需要另装 Deskflow。测试包只有临时签名、未开发者签名或公证，使用系统提供的“仍要打开”流程；不要求关闭系统整体保护。

### 2. 配对和方向

两端接同一局域网，进入“键鼠流转”。Mac 保持“使用本机键鼠”，Windows 保持“接收对端输入”。两端分别打开“允许新设备配对”，一端刷新并选择另一台设备；如未出现，输入对端局域网 IPv4。

核对两个屏幕的 8 位码完全一致，再在两端分别确认。只确认一端时不应获得授权。Mac 选择 Windows 所在方位并应用，光标越过对应屏幕边缘应进入 Windows；按 Control+Alt+Escape 应返回 Mac。

### 3. 拔键鼠与管理员窗口

确认普通输入可用后再拔掉 Windows 键鼠。从 Mac 在 Windows 普通记事本输入 `wenbox-m2-normal`。随后从 Mac 在普通 PowerShell 执行：

```powershell
Start-Process powershell.exe -Verb RunAs
```

Windows 应弹出真实 UAC（桌面通常变暗）；仅用 Mac 键鼠点击“是”，或按策略输入管理员凭据。进入提升后的 PowerShell，执行：

```powershell
whoami /groups | Select-String 'S-1-16-12288'
Write-Output 'wenbox-m2-admin'
```

确认高完整性 SID 与输入标记。如果没有弹窗，先检查 UAC 当前是否仍被关闭；保留系统默认安全桌面策略，不以关闭 UAC 作为通过条件。UAC 出现但无法控制时，接回实体键鼠取消，并复制两端诊断信息。

### 4. 记忆、停止和布局

重开两端 WenBox，已启用的流转应记住设备并连接，不能再次要求抄指纹。把 Windows 临时断网再恢复，应恢复原配对。Mac 修改左右/上下方位并验证边缘，再让对端离线时保存一次、恢复后检查方向。

停止流转后跨屏应无效；解除配对后重开应用不应恢复授权。Windows 锁屏后不要求无人登录控制，解锁后再检查恢复。

反馈只需：Windows 版本、安装/服务是否正常、配对是否一致、普通输入/管理员输入/UAC 三项结果，以及失败时两端复制的诊断。不需发送证书私钥或整个设备配置文件。

此验收针对本轮 WenBox 新服务和统一安装链路；无需再重复成熟上游的完整稳定性测试矩阵。
