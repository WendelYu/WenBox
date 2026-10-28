# KVM M2 集成与验收交接

更新：2026-10-28。M2.1 热修复已通过本机与 Windows CI：Windows 接受的非阻塞 TCP 连接恢复阻塞超时模式；服务管道用 PeekNamedPipe 区分空数据和断开，并在客户端确认读完回复后关闭连接。诊断增加 kvmRevision=m2.1 和 serviceError。旧 M2 的安装冒烟通过不代表配对链路已验收；热修复补了真实 TLS 消息往返、Windows 非阻塞管道延迟读取专项回归。

M2 实现已进入可构建阶段；本机回归、Mac 构建与 Windows 实际 NSIS 构建均通过；Windows 一次性 runner 的安装、服务启动、升级和卸载检查通过，集成 UAC 仍待真机验收。M0 用户确认的 Deskflow 管理员窗口/UAC 可行性保留，不将其等同于本轮服务已验证。

## 已实现

- 独立设备证书与私钥、TLS 1.3 双向认证控制通道、通道绑定的 8 位验证码。首次需两端人工核对并确认，2 分钟窗口过期失效；候选设备信息不构成信任。
- 保存授权设备与屏幕方向；两端 WenBox 运行且流转启用时，使用证书指纹自动重连。IP 变化通过发现重新定位，再做认证。停止保留配对，解除配对撤销授权。
- 默认 Mac 使用本机键鼠、Windows 接收输入。上下左右四方向编辑、双屏预览、保存和对端同步；应用方向会短暂重启输入连接，离线对端下次连接时同步。
- 浏览器和 Android 只展示能力提示，控制命令只允许本机桌面主窗口。诊断移除配对验证码、会话标识，不记录输入内容。
- 固定 Deskflow 1.27.0 输入核心随应用提供。下载、源码与资源按 SHA-256 校验，交付物带上游对应源码及许可证；不读取或修改原先 M0 独立 Deskflow 配置。
- Windows 独立 `WenBoxKvm` SYSTEM 服务。只接受固定结构配置，输入程序及状态目录固定；验证本机调用者映像、当前已解锁的控制台会话，客户端确认命名管道服务 PID 与 SCM 一致后才发私钥。子进程进入退出即回收的 Job。
- Windows x64 NSIS 管理员安装（一次性 Windows runner 已验收）：保护安装目录及后台状态目录 ACL，安装服务、防火墙规则，升级前停止服务，卸载清理服务及后台状态。用户侧配对文件保留；要彻底撤销设备请先解除配对。安装后普通权限启动界面，文件/房间功能不以 SYSTEM 运行。
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
- 安装辅助脚本通过 PowerShell 语法解析；Windows runner 实际执行干净安装、服务 Running、SYSTEM 账号、固定且加引号的服务路径、状态目录 ACL、非授权进程管道拒绝、原地升级和卸载清理，均通过。
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

也可手动执行 GitHub Actions 的 **Build KVM M2 test installers**。新增工作流只接受手动触发，不发布 release。Windows 作业在一次性 runner 中进行安装→升级→ACL/非授权调用检查→卸载后上传包。实际构建通过隔离分支 codex/kvm-m2-windows-installer 执行，构建与验收结果将记录在 docs/kvm-m2/windows-build.json；不触发正式 release。

## M2.2 Mac 退出诊断包

用户已确认 M2.1 配对成功并保存授权，Mac 输入核心随后退出。WenBox 两项隐私授权开关已开启，实际退出原因尚待采集，不能将这次状态标记为跨屏输入已通过。

Mac 诊断包：`dist/kvm-m2/WenBox-KVM-M2.2-macOS-universal.zip`。只需退出并替换 Mac 应用，Windows 保持 M2.1；不要解除已有配对。新诊断 `kvmRevision=m2.2`，包含 `engineDiagnostics`（最多 8 KB 内存尾部，采集当前 INFO 启动输出）和消息中的退出码。识别到上游明确的辅助功能拒绝时显示具体授权提示；其他退出保留原错误。

复测时启动流转，等待约 5 秒再复制 Mac 诊断；将 `message` 与 `engineDiagnostics` 返回即可。Mac 两项开关开启不必然代表独立嵌套核心已被系统信任，是否需要授权 WenBox Input 应以实际退出日志为准。本轮没有自动修改系统隐私授权。

## M2.1 配对热修复（请优先使用）

旧 M2 包在真实 Windows 非阻塞连接下可能在验证码出现前断开，且已运行的服务可能被误显示为未就绪。M2.1 已修复 socket 模式、空管道零字节读取、回复读取确认及短暂忙重试。新增真实 TLS 请求/回复及真实 Windows 管道延迟读取测试均通过。Windows 服务身份、调用者路径/会话检查和首次双端人工确认不变。

新包：`dist/kvm-m2/WenBox-KVM-M2.1-Windows-x64-setup.exe`、`dist/kvm-m2/WenBox-KVM-M2.1-macOS-universal.zip`。诊断中的 `kvmRevision` 应为 `m2.1`。Windows 新包实际运行：[M2.1 Windows CI](https://github.com/WendelYu/WenBox/actions/runs/40620059634)。

复测：退出两端 WenBox；Windows 覆盖安装新包，Mac 替换 Applications 内旧应用；重开后两端各打开一次配对窗口，只在 Mac 点一次连接 Windows，等两端显示相同 8 位码后分别确认。不要连续点连接或反复重开配对窗口。若失败，复制两端新诊断，重点保留 `kvmRevision` 与 `serviceError`。

Windows 服务状态可直接在 CMD 执行 `sc query WenBoxKvm`，`STATE: 4 RUNNING` 为已运行；PowerShell 才使用 `Get-Service WenBoxKvm`。服务运行状态与输入核心是否已在配对后启动是不同状态。

## 旧 M2 Windows 测试包（已由 M2.1 替代）

最终源码提交：`ffc45c8a8750bc06dc9e6f9e515bc6249fa52ece`。成功运行：[Windows M2 安装包构建](https://github.com/WendelYu/WenBox/actions/runs/40614404531)。Windows Rust 61 通过/1 忽略、Node 46 通过，89 个输入资源文件校验通过。

本地产物：`dist/kvm-m2/WenBox_1.4.5_x64-setup.exe`；完整性校验值见同目录 `SHA256SUMS.txt`。测试包尚无 Windows 发布代码签名。不是正式 release，未合并主分支。

## Win11 双机验收

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

### M2.3 Mac 跨屏修复

Mac 包 `dist/kvm-m2/WenBox-KVM-M2.3-macOS-universal.zip` 修正锁定版 Deskflow 1.27 的电脑列表格式，并将 Qt 的单实例锁和停止 IPC 放入独立运行目录。Mac 主控需要自己 PID 监听 9531 才显示就绪，致命退出保留诊断并暂停自动重试；处理问题后先停止再启动流转。

本机 M2.3 实际启动已通过配置解析，但核心仍被 macOS 辅助功能拒绝。用户需要在系统设置的“隐私与安全性 → 辅助功能”中用加号添加 `/Applications/WenBox.app/Contents/Resources/resources/kvm/Deskflow.app`（显示名 WenBox Input）并允许，输入监控出现该项时也需用户授权。不能因 WenBox 主程序开关已开就推断嵌套组件已获授权。不要关闭 UAC 或证书校验。

当前 Windows 目标继续使用 M2.1；本次故障点在 Mac 主控启动，暂不要求重装 Windows。完整跨屏与新服务 UAC 仍需真机验收。

**后续实机修正：** TCC 日志确认嵌套核心的辅助功能请求归到主应用 `com.wendel.wenbox`，当前拒绝原因是新版临时签名与旧授权记录的代码要求不匹配。开关为开并不能排除此情况。遇到这条明确日志时，退出 WenBox，在辅助功能中移除旧 WenBox 条目，重新添加 `/Applications/WenBox.app` 并由用户授权，再启动正式安装版；不要同时运行解压目录中的旧副本。此前只添加 WenBox Input 的步骤不足以处理此类签名变化。发布版仍需稳定签名方案以减少更新后重授权。

### M2.4 流转工作台

- 关闭时只显示开启入口；开启后再显示配对/权限，配对后默认显示四向屏幕布局。点击方向立即保存，接收端只读布局。候选设备过滤未开启者、相同角色和重复网卡记录。房间成员不会因加入房间自动获得流转授权。
- “附近房间”从流转页切换至房间发现页；不解除流转配对。
- Mac 主控通过核心私有 IPC 的 connectedClients 事件显示真实连接。Windows 接收端通过证书固定的 InputStatus 查询取得主控状态，10 秒后过期；旧主控不支持查询时显示接收端就绪，不宣称已连接。
- Mac 主控可调整被控端指针速度 0.5–2.0×，通过锁定核心 Server::onMouseMoveSecondary 的 DESKFLOW_MOUSE_ADJUSTMENT 实现，主控本机移动不变。Windows 主控暂不提供此控件。
- 被控端可独立调整横/纵统一滚轮倍率 0.5–2.0×，写入 client/xScrollScale 和 yScrollScale。Windows 要更新应用和服务安装包。两项偏好保存在独立文件，不改变设备授权文件，保存触发短暂重连。
- 系统权限两个直达入口、只读检测和访达定位已加入；未自动授予权限。测试包使用临时签名，更新后可能仍需刷新两项授权。
