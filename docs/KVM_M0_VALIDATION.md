# KVM M0 技术验证与真机操作单

日期：2026-10-27。依据：KVM_REQUIREMENTS.md v0.2。

状态：Win11 核心场景已由用户报告通过（无外接键鼠光标、管理员窗口输入、UAC 触发及操作），用户接受核心可行性并要求进入开发。完整 Win10/可靠性/性能矩阵未执行；以下保留为按需使用的测试资料，不要求开发前重复全部上游测试。

## 1. 当前判断与测试路线

优先用 **Deskflow v1.27.0 的 Windows 后台服务 + system 输入进程** 验证 Mac → Windows 无实体键鼠的管理员窗口/UAC 路径。Mac 使用自己的键鼠，Windows 已登录且有可见显示器。用户已确认 Win10、Win11 都有并可安装软件。

这是独立候选软件的 M0 对照，测试通过仍不等于 WenBox 已集成；WenBox 的设备配对、授权 IPC、撤权与输入超时需要 M1–M3 实现并重测。不把“系统服务已运行”“SendInput 返回成功”或观察脚本可访问桌面当成人眼可操作的证明。

### 已检查的证据

- Deskflow 固定 commit：`081f6478e654a112168879e67a41ce7d7e4ae3af`。`MSWindowsWatchdog.cpp` 的 `getUserToken/startProcess` 包含获取高权限 token、启动交互会话输入进程的路径；`MSWindowsDesks.cpp` 使用 `OpenInputDesktop/SetThreadDesktop` 切换输入线程所在桌面，并在 `deskEnter` 调用有上限重试的 `ShowCursor`。设置页明确有后台服务与 system 模式选项。
- lan-mouse v0.11.0 固定 commit 见 backend-lock.json。Windows 后端通过 `SendInput` 注入，但 `send_input_safe` 在返回 0 时无上限重试，无退避/超时；在本次该版本 Rust 源码搜索中未发现 Windows 服务或输入桌面切换实现。UIPI 拒绝注入时可能忙等，原版不作为本轮关键现场机的首选对照。
- Deskflow 涉及 GPL-2.0-only WITH OpenSSL exception，lan-mouse 涉及 GPL-3.0-or-later；本轮没有复制上游实现进 WenBox，也不预设混合源码方案兼容。
- 官方 Windows x64 MSI（15,953,799 字节）与 Mac arm64 DMG（29,145,871 字节）已下载；SHA-256 与 GitHub release API digest 一致。精确 URL、commit、digest 保存于 `docs/kvm-m0/backend-lock.json`。
- 本机 macOS 26.6.2 arm64：授权环境下 `deskflow-core --version`、`--help` 成功，版本 1.27.0、协议 1.8。沙箱运行因 PasteBoard/TIS XPC 访问受限退出，不代表正式安装失败；未启动输入共享会话。
- Mac 官方 arm64 core 的 Mach-O `LC_BUILD_VERSION minos=14.0`：该二进制不覆盖 macOS 12.3。若仍需支持 12.3，需另行验证可兼容构建或后端，不可据本轮本机通过扩大支持范围。

### 仍需真机证明

无实体鼠标时的桌面与 UAC 光标可见性、管理员窗口输入、UAC 同意/拒绝、策略允许时的凭据输入、20 轮桌面切换、断网/代理故障后的输入释放、Win10/11 兼容与实际延迟。其中 Win11 无外接键鼠光标、管理员窗口输入及 UAC 触发操作已由用户报告通过；其余未验收。

## 2. 准备固定测试版本

Windows x64 使用 **MSI 安装版**，先不使用 portable 版。两端同一版本，Win10 与 Win11 分别执行，不把一台结果外推给另一台。

官方入口：https://github.com/deskflow/deskflow/releases/tag/v1.27.0

本轮已准备的本地文件：

- `dist/kvm-m0/WenBox-KVM-M0-Windows.zip`：Windows x64 MSI、采集工具、操作单、结果模板；解压后操作。
- `dist/kvm-m0/deskflow-1.27.0-macos-arm64.dmg`：本机 Mac 对照包。Intel Mac 可使用 backend-lock.json 中对应官方包，但本轮未下载/运行 Intel 包。

安装前可验证 Windows MSI：

```powershell
Get-FileHash .\deskflow-1.27.0-win-x64.msi -Algorithm SHA256
```

应为：`0ca5668c4731f5477d0b189bdb11196a2ca51281985d9d8c0757bf7f3b782d64`。

## 3. 建立对照连接（先保持 Windows 键鼠连接）

1. 两端使用同一可互通的局域网，Windows 已登录。首次可提前用实体键鼠安装、授权及配对。保留键鼠在手边作为测试失败时恢复手段，但正式测试阶段需拔掉；若是有内建触控板/键盘的笔记本，记录为“有内建输入设备”，不能冒充完全无硬件。
2. Mac 安装 Deskflow，按系统提示授予其需要的权限。选择 **Use this computer's keyboard and mouse**（服务端/输入来源），在 **Configure Server** 中添加 Windows 屏幕，屏幕名必须与 Windows 客户端显示名一致，先放在 Mac 右侧。
3. Windows 安装官方 x64 MSI，在设置中启用 **Use background service (daemon)** 与 **Always run as system (work at login screen and UAC)**；确认服务已运行。选择使用其他电脑键鼠的客户端模式，**Connect to** 填写 Mac 局域网地址。
4. 保持 TLS/证书验证开启，核对两端显示的对端指纹并确认信任；不要以关闭加密排错。防火墙只允许此测试实际所用网络及对端，按候选软件提示放行（默认 TCP 24800），无需修改 WenBox 9527/9528/9529。
5. 先验证 Mac → Windows → Mac 正常往返，设置并实测候选后端支持的“切回 Mac”热键（在服务端配置热键中选择切换到 Mac 屏幕的动作）。不要假设 WenBox 草案的 Ctrl+Alt+Esc 已在 Deskflow 实现。
6. 不通过 RDP/其他远控代替 Mac 输入或确认 UAC；这些工具会改变会话或注入路径。测试期间停止其它键鼠共享程序，避免冲突。

## 4. Windows 采集与只读观察

以下命令在解压目录、普通 **Windows PowerShell** 中执行。工具使用系统自带 PowerShell 5.1，不需安装 .NET SDK；正常情况下无需管理员启动采集器。脚本不改 UAC、防火墙、服务或系统执行策略。

```powershell
.\Invoke-KvmM0.ps1 -Mode Collect
.\Invoke-KvmM0.ps1 -Mode Observe -Seconds 600
```

如果直接执行提示禁止运行脚本，可仅对新进程指定 RemoteSigned，不修改用户/机器永久设置：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\Invoke-KvmM0.ps1 -Mode Collect -OutputDirectory ".\results"
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\Invoke-KvmM0.ps1 -Mode Observe -Seconds 600 -OutputDirectory ".\results"
```

修订记录（2026-10-27）：Win11 真机报告旧脚本参数默认值中的 `$PSScriptRoot` 为空。已将目录解析移至参数绑定后的脚本正文，并改用脚本调用路径定位探针。旧包可显式传入 `-OutputDirectory ".\results"` 绕过参数默认值问题；推荐替换新版 Invoke-KvmM0.ps1。该故障不构成 UAC 输入能力的测试结果。

可信下载文件若提示未签名/来自互联网，请在查看脚本后对这一个脚本解除锁定。若仍受阻，提供 `Get-ExecutionPolicy -List` 和完整错误，不更改组织策略。

输出位于旁边的 `results` 目录：

- `environment-*.json`：系统版本、UAC 注册表值、观察器权限、候选服务、进程会话、输入设备枚举、候选 EXE 版本/哈希/签名状态。缺失项标作未知并记录错误，不自动补默认值。
- `desktop-*.jsonl`：每 250ms 记录一次可访问的输入桌面名、系统光标显示标记和鼠标存在标记。**不记录键值、鼠标坐标、窗口标题、剪贴板、密码或截图。**

普通观察进程在 UAC 时 `OpenInputDesktop` 返回拒绝访问是预期现象之一，不能据此判定候选后端失败；同样 `CursorShowing=true` 也不能代替人眼确认光标可见。鼠标枚举/SM_MOUSEPRESENT 可能包含虚拟设备，必须人工记录拔插情况。

## 5. 关键测试（Win10、Win11 分别执行）

复制一份 `results-template.json` 为各系统的结果记录，默认状态均为 `NOT_TESTED`。每项填写 PASS / FAIL / NOT_TESTED / NOT_APPLICABLE、实际现象与证据文件；只有确实受系统策略限制的凭据分支可写 NOT_APPLICABLE，并注明原因。

### A. 普通桌面，无实体键鼠

拔掉 Windows 所有可拆卸键鼠及接收器，保留显示器、网线。再运行一次 `-Mode Collect` 记录拔掉后的设备状态。用 Mac 在 Windows 记事本输入 `WENBOX-M0-DESKTOP-123`，测试滚动、拖选、点击，并切回 Mac。记录 Windows 光标是否始终肉眼可见。隐藏光标即 FAIL，不能用“插回鼠标就好了”算通过；内建或虚拟输入设备须在环境中注明。

### B. UAC 拒绝与管理员终端

观察器继续运行，另开一个普通 Windows PowerShell，完全用 Mac 输入执行：

```powershell
.\Invoke-KvmM0.ps1 -Mode Uac
```

1. 第一次在 UAC 上用 Mac 移动光标并点击“否”，确认回普通桌面仍可操作。
2. 第二次运行同一命令，在 UAC 上点击“是”，在新打开的管理员窗口输入 `WENBOX-M0-ADMIN-123`。出现 Marker matched 后按 Enter 关闭。
3. 保持 `EnableLUA=1`、安全桌面策略有效；UAC 若显示在普通桌面或被系统自动同意，不算完成安全桌面验收。注册表缺失/策略不明时先保留为未确认，结合系统设置或管理员策略核实，不作通过判断。
4. 若现场有标准用户账户且策略允许凭据提升，再验证管理员用户名/密码输入；使用测试凭据，不记录密码、不在录像中展示。仅管理员“是/否”不能证明凭据场景通过；无该环境则明确保留覆盖范围。

脚本只是显式请求系统 `RunAs` 并打开一次临时终端；不会自动批准 UAC，不会安装服务，也不会根据终端启动自动给出 UAC 控制通过结论。UAC 被拒绝时不创建管理员窗口。

### C. 安装程序流程

选择可信、可取消且不会影响现场业务的安装程序。从普通桌面启动，用 Mac 处理 UAC，在安装向导执行下一步/返回/取消，不要求实际修改业务软件。记录安装器名称、版本及是否出现额外提升；管理员 PowerShell 测试不能替代这一项。不要在生产现场测试驱动、网络组件或需要重启的安装。

### D. 连续切换

按“普通桌面 → UAC → 管理员窗口 → 普通桌面 → Mac”循环 20 次，记录完成次数、首次失败轮次、光标、普通键、Shift/Ctrl/Alt 与按钮是否残留。不得仅运行一次就填写 20 轮通过。

### E. 故障与恢复

先在普通桌面验证 Mac 的本地切回动作，再进入 UAC 测试：

- 人工拔掉测试链路网线，或在 Mac 上停止候选共享会话，记录 Mac 恢复本机操作时间，目标 ≤2s；恢复网络后重新进入 Windows 验证可继续处理 UAC。
- 先保持无按键按下，再在 Windows `services.msc` 停止 **Deskflow** 服务，以模拟组件不可用，验证 Mac 恢复；这项动作有意改变候选服务状态，由测试者明确操作，结束后重启服务。
- 丢失控制时重新插入预备键鼠进行恢复，记录 FAIL；首次测试不要把恢复手段也移走。再根据故障结果决定是否进行“按键/按钮按住时中断”的独立测试，该测试必须在记事本等可丢弃窗口，避免持续输入到管理员终端。
- 稍后仍需单独验证输入进程崩溃、后台服务异常退出、双端全部远程按键/按钮清理；“正常停止服务”不能替代全部崩溃测试。

### F. 性能与升级后的覆盖

对照软件的主观跟手仅记作观察。p95 30ms、1% 丢包下无卡键等指标仍需独立测量方案，不从 ping 或本脚本 250ms 采样间隔推导。实际安装器、显示器、UAC 策略及系统版本须记录；12.3 Mac、Intel Mac、签名/升级保权、后台重启与 WenBox 集成后的授权边界均未覆盖。

## 6. 需要回传的最小信息

先在任一 Windows 上完成 A/B，回传系统版本、无键鼠时光标是否可见、UAC 能否点“是/否”、管理员终端能否输入，以及 environment JSON。失败时说明停在哪一步；不要为了完成后续步骤反复尝试或改 UAC。

再对 Win10/11 各回传完整结果记录和对应 observer 文件。必要时用手机拍摄 Windows 显示器上的光标/UAC 交互，因为普通截图软件未必能捕获安全桌面；不要拍摄凭据。日志回传前检查本机设备名称等元数据。

## 7. 后端决策门槛

- A/B/C 在 Win10/11 且无可拆卸键鼠时成功，只能说明优先候选路径可行；还需 D/E 及故障清理证明，不能先宣称 M0 全通过。
- 无实体鼠标光标不可见、UAC 不能控制、Mac 不能可靠收回任一失败，则暂停将该候选集成到产品，按记录排查，不以改变 UAC 或长期接实体鼠标降级需求。
- 候选满足核心路径后，评估 Deskflow 辅助进程封装与自建受限 Windows 输入代理两种集成方式的成本、权限、故障隔离、许可证及体积；不默认混合 GPL2-only 和 GPL3 源码。

## 8. 来源（源码已下载检查，链接固定到 commit）

- Deskflow Windows watchdog：https://github.com/deskflow/deskflow/blob/081f6478e654a112168879e67a41ce7d7e4ae3af/src/lib/platform/MSWindowsWatchdog.cpp
- Deskflow 桌面/光标：https://github.com/deskflow/deskflow/blob/081f6478e654a112168879e67a41ce7d7e4ae3af/src/lib/platform/MSWindowsDesks.cpp
- Deskflow 服务设置：https://github.com/deskflow/deskflow/blob/081f6478e654a112168879e67a41ce7d7e4ae3af/src/lib/gui/dialogs/SettingsDialog.ui
- lan-mouse Windows 后端：见 backend-lock.json 中 commit，对应 input-emulation/src/windows.rs。
- 官方服务/UAC 说明：https://github.com/deskflow/deskflow/wiki/Workarounds
- Microsoft SendInput / UIPI：https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
- Microsoft OpenInputDesktop：https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop
