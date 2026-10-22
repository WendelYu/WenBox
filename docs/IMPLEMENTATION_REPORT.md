# WenBox 修复与重构实施报告

> 对应文档：`docs/BUG_FIX_PLAN.md`（缺陷修复）、`docs/UI_REDESIGN_PLAN.md`（界面优化）
> 验证环境：macOS aarch64 / Rust 1.98 / JDK 17（JBR 17.0.14）/ Gradle 8.2 / Node 26
> 三端验证结果：**Rust 28 项测试通过 + clippy 全绿；Android 构建与 lint 通过（0 error）+ 33 项单测通过；Web/桌面桥接 29 项测试通过 + stylelint 0 error；Electron 源码及打包应用启动通过**

---

## 第三轮接续：Web 细节与 Electron（2026-10-16，最新）

本节覆盖第二轮遗留的 Web 交互与 Electron 升级。后文各轮的“剩余”是当时状态，以本节为最新交接。

### 已完成

- 创建房间新增“需要密码”开关和显示/隐藏按钮，关闭开关会清除本次输入及保存选项。加入窗口由一个可访问的真实密码框承载 6 格 PIN 外观，支持粘贴、删除、光标编辑和自动填充；非数字或超过 6 位自动使用完整密码输入，也可手动切换，继续兼容已有最长 16 位密码。
- HTTP 与 Tauri 原生加入路径均保留 `retryAfter`。按目标 origin 保存绝对截止时间，倒计时按钮在关闭/重开弹窗后仍生效，手动地址加入也使用相同记录。错误显示在弹窗内，输入修改后移除无效状态。Tauri 加入其他房间不再清空本机房主历史。
- 发现阶段显示 3 行骨架，空结果 3 秒后转为空状态；房间一旦出现即可展示。减少动态效果时不运行骨架动画。
- 昵称首字符头像按稳定 hash 选择 8 色；深/浅色最低文字对比分别为 7.80:1 / 13.39:1。连续消息沿用 2 分钟分组规则。
- 消息先插入可见待发气泡，显示“发送中 / 已发送 / 未确认送达”和独立重试按钮；首次同步完成后才创建待发项，服务端回显按当前房间、发送者和内容逐条对账。发送持有原房间凭据，切房间后不回写旧状态。重试前先同步已送达消息，降低断线后重复发送概率；现有协议没有幂等消息键，网络结果不明确时人工重试仍可能重复，按钮提示已说明。
- Electron 与 builder 精确升级至 **44.8.0 / 26.15.3**，同步 lockfile 和 Node ≥22.12.0 引擎要求；相关 Windows/发布工作流使用 Node 24。版本依据 [Electron 官方发布列表](https://releases.electronjs.org/)。
- Electron 增加仅绑定 127.0.0.1 随机端口的静态资源服务，修复 file:// 的 Origin:null 无法加入 LAN 房间的问题。固定代理到本机 9527 后台并流式传输，保留原始 Origin 和鉴权头，限制 Host/来源/路径；CSP 由界面服务控制。导航与剪贴板 IPC 只接受本应用页面，原有隔离、沙箱与 webSecurity 保持开启。
- Windows CI 增加独立 Electron NSIS/portable 构建任务，日常运行只验证，手动触发才上传并保留 7 天。原有未跟踪的 `auto-release.yml` 未修改，未触发远程发布。
- Android 补齐 `ui-state.js` 路由，访客可加载新模块；文件保存失败时上传返回 HTTP 500，防止客户端把空文件 ID 当成成功。

### 验证与产物

- Node：29 项通过，新增冷却/Unicode 头像/待发对账，以及桌面 HTTP 资源、路径/Host/来源限制、二进制代理、鉴权/Origin 保留、后台离线降级测试。
- Chrome：严格 CSP 下全流程通过，新增密码显隐/旧密码兼容、429 重开倒计时、延迟消息/失败重试/对账断言；四宽度深浅主题及三个细节截图共 19 张，另有 Electron 源码和打包应用截图，位于 `docs/ui-screens/phase-3/`。
- Electron：官方 GitHub 下载慢，改从镜像取得相同压缩包，以 npm 包内官方 SHA-256 校验成功，再由原安装器解压。源码应用与 macOS arm64 未签名目录包均实际启动，确认 44.8.0、HTTP/CSP、沙箱/隔离、预加载桥和 JSON 工具；打包产物为 `dist/mac-arm64/WenBox.app`，无上传或发布。
- Rust：28 项测试、clippy `--all-targets -- -D warnings`、build 均通过。新增原生加入保留 429 元数据及不清空房主历史回归。
- Android：JBR 17 / Gradle 8.2 离线 assembleDebug、lintDebug、testDebugUnitTest 通过，33 项测试；APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。
- CSS：0 error，保留原 style.css 的 16 条重复选择器 warning。`git diff --check` 通过。

### 仍需验收与设计差距

- Windows CI 已配置但未在远程执行；macOS 测试包未签名。Windows 原生交互、真实 LAN 多设备传输、后台/断网/旋转、大文件、Safari iOS / Firefox 和 Android Keystore/MediaStore 平台行为仍需目标设备验收。本机无 ADB 设备/AVD。
- Electron 是 Web 外壳，不内置 Rust 后台；手动加入 LAN 主机可走 HTTP，本机建房/发现需要已有 Tauri 服务。未将它描述为独立完整传输服务。
- 完整 UI 设计仍有未逐项落地的内容：手机状态条折叠、成员头像/平台信息细节、工具错误定位/字段分段、系统加入离开消息，以及完整无障碍扫描。可选“移出成员”需要协议扩展，本轮未改协议；不能把本轮核心实现等同整份设计验收完成。

---

## 第二轮接续：Android P2（2026-10-16，历史记录）

本轮补齐上一轮明确列出的 Android P2 缺口，并修复核对中发现的房主消息不显示问题。下面旧轮次的“仍需处理”条目应结合本节阅读。

### 已完成

- **常用房间 PIN 加密**：系统 Android Keystore 保存不可导出的 AES 密钥，配置通过带版本和认证上下文的 AES-GCM 信封保存。旧 `room_profiles` 在加密成功后用一个偏好事务替换；加密或写盘失败不报告迁移成功。已有密文无法解密时不退回明文、不静默生成新解密密钥；界面提供需用户确认的“重置本机常用房间”。Keystore/加解密/读写均在 IO 线程，不新增依赖。备份排除规则继续生效。方案依据 [Android Keystore 官方说明](https://developer.android.com/privacy-and-security/keystore)。
- **附件应用内下载**：点击聊天附件后直接流式保存到 Downloads/WenBox。令牌只通过 X-Room-Token 请求头发送；消息中的旧 token 查询串会移除，复制链接也不包含令牌。只接受当前房间 origin 下的 `/api/download/<id>`，拒绝跨主机、跨端口、用户信息、路径穿越和重定向。下载持有发起时的房间凭据，不随之后切房间改写目标。
- **接收文件存储**：接收和下载的文件不再自动加入分享列表，与 Rust 现有行为对齐；文件 API 字段和端点不变。API 26–28 无公开目录写权限时退回应用专属 Downloads。使用原子 createNewFile 保留同名路径，避免覆盖；MediaStore 无法创建输出流或提交失败时清理未完成条目。“清空分享”保留接收文件及其下载 ID。
- **聊天与文件列表**：分别使用 ListAdapter/DiffUtil，移除 RecyclerView 外层的 NestedScrollView；列表独立滚动，聊天输入区固定在消息列表下方。图片任务随 holder 重绑/回收取消，只为可见消息解码；缓存按房间和消息 ID 索引，不再使用整段 base64 文本作 key。阅读旧消息时不会被每次轮询强制拉到底部。
- **房主消息订阅**：MessageManager 发布 StateFlow 快照；房主进入页面、恢复可见、收到本机/访客消息都会更新列表。JOINED 仍只显示自身房间的 ViewModel 消息，不混入本机房主消息。
- **本地清屏**：Android 清屏仅隐藏当前历史行，保留权威房间记录；下一轮更新只显示新消息，切换房间清除本地隐藏状态。状态由 ViewModel 持有，旋转不会让 Fragment 字段丢失清屏边界。
- **后台 JSON 与恢复**：JsonFragment 在 Dispatchers.Default 解析/格式化，用户编辑后丢弃旧结果，视图销毁后不回写。Cron 恢复表达式时忽略 Spinner 初始化回调，保留用户手输内容。确认消息轮询 JSON 已在后台解析，未重复改写。
- **图片内存边界**：选择图片时先读尺寸再采样；网络缩略图/灯箱流式写入临时文件，再按目标尺寸解码，避免先 readBytes 完整图片。预览上限 64MB，超限可走普通文件下载；取消或失败清理临时文件。修复超宽/超高图因另一边较短而不采样的问题。
- **切房间的在途发送**：上传结束后核对捕获的房间 ID 和令牌，过期请求不会把旧房间的发送结果追加到新会话；文件上传后发消息也检查 HTTP 成功状态。

### 验证

- Android：JBR 17 / Gradle 8.2，`:app:assembleDebug :app:lintDebug :app:testDebugUnitTest --offline` 通过；33 项 JVM 测试通过，lint 0 error，HardcodedText / ContentDescription / TouchTargetSizeCheck 仍为 0。
- 新增 24 项 JVM 用例：AES-GCM 往返/随机 nonce/篡改/错误密钥/损坏版本，明文迁移和失败恢复控制流，下载令牌仅在请求头及禁止重定向，附件 origin/路径/输出文件名校验，房主消息流/去重/500 条上限，本地清屏，以及极端图片采样边界。
- Web：23 项测试通过；本轮未修改共享 Web 源码。
- Rust：build、clippy `--all-targets -- -D warnings`、27 项测试均通过。
- ADB 设备列表为空，且本机没有配置 AVD；未安装到用户设备。JVM 已验证加密和迁移控制流，AndroidKeyStore Provider、MediaStore、API 26–28 权限回退、列表/键盘布局与旋转恢复仍需真机或模拟器验收。

### 剩余范围

Android 本轮列出的 P2 实现已落地。原生真实网络/后台/旋转/大文件验收，以及 Web PIN 开关/分格输入/429 倒计时、骨架屏、头像、乐观消息等设计细节仍待；Electron 与打包工具大版本升级仍未执行。它们不属于本轮通过的 Android 单测范围。

---

## 2026-10-16 接续记录（以本节为准）

本轮接续 UI Phase 3，完成共享 Web 的核心信息架构与 Android 导航调整。下文是上一轮历史报告，其中“Batch 4 除两项外全部完成”“Phase 2/4 全部完成”的表述过于乐观，不能作为全部验收完成的依据。

### 本轮已实现

- Web 一级导航收敛为“快传 / 工具”；聊天与文件在同一房间工作区，JSON、进制、Cron、日期归档进入工具二级导航。
- 三个房间横幅合并为全局状态条，通过 `body[data-room-mode]` 控制角色可见性。状态条支持昵称、成员、访问地址、多网卡切换、复制、二维码、解散/退出。
- 桌面采用会话与 360px 文件面板；平板文件抽屉可用按钮/Esc 关闭；手机用聊天/文件分段和固定底部导航，输入区按 visualViewport 可用高度布局。
- 所有文件选择、全页拖放、聊天附件和粘贴图片进入独立 XHR 队列，最多并发 3 个文件；每项显示已传大小、速率、剩余时间，支持取消、失败重试。完成 3 秒后进入已发送历史，历史最多保留 50 项。切换房间会取消旧队列，旧结果不会向新房间发布文件卡片。
- Tauri 原生“添加分享文件”继续直接引用磁盘文件，并在会话中发布文件卡片，不会为了显示队列而复制一次本地文件。
- HTML 与动态模板移除内联事件和样式，使用按钮 `data-action` 委托；九个浮层改为原生 dialog，包含焦点恢复、Esc 与 Promise 确认/提示关闭处理。Tauri 移除 `script-src 'unsafe-inline'`。
- 离线 SVG sprite 直接随 HTML 提供，修复原来 `#i-*` 无对应内联 symbol 的问题；清理界面 emoji，保留用户消息里的 emoji。
- 三个独立 setInterval 改为 runtime.js 的单一调度器。隐藏页停止定时，恢复可见后补跑；成员、文件、消息和发现响应用房间 revision 检查，避免旧响应覆盖新房间。
- 房间切换与清屏只重置本地消息显示，不再误调 Tauri 的全房间清空命令；清屏保留游标，防止下次轮询把旧消息重新刷回。可见消息最多 500 条。
- 修复 CSS `--primary` / `--danger` 自引用；Android 补齐 `theme.js`、`upload-queue.js`、`workspace.css` 静态资源路由。
- Android 底部导航改为“快传 / 工具”；新增 ToolsFragment，使用 MaterialButtonToggleGroup + 子 ViewPager2 承载三个工具。房间状态/成员/地址固定在顶部，聊天与文件用 TabLayout 切换，二维码与网卡详情按需展开，分段选择保存到实例状态。

### 实现上的取舍

- 保留仍有业务含义的输入、消息列表等 id，只把动态交互参数迁到 data-*，避免为了减少 id 数量引入无关改写。
- 上传队列采用无构建依赖的 classic-script factory，可在 Electron file:// 页面及共享 Android assets 下加载；没有采用会受到 file:// 模块加载限制的 ES module。
- Android 房间页复用现有绑定视图，以 TabLayout 切换显隐；工具页采用子 ViewPager2。房间页尚未拆成独立的两个 Pager Fragment，也没有把消息 LinearLayout 改成 RecyclerView。

### 本轮验证

- `npm test`：23 项通过，含新增 5 项上传队列测试（并发限制、独立取消、排队取消、重试、切房间隔离、空文件/无效确认）。
- `npm run lint:css`：0 error，保留 style.css 原有 16 条重复选择器 warning；新 workspace.css 无 error/warning。
- `cargo build --locked`、`cargo clippy --locked --all-targets -- -D warnings` 通过；Rust 27 项测试通过。网络测试需要允许本地临时端口监听。
- Android 使用本机 JBR 17.0.14 / Gradle 8.2 离线执行 `:app:assembleDebug :app:lintDebug :app:testDebugUnitTest`：通过；lint 0 error，HardcodedText / ContentDescription / TouchTargetSizeCheck 均为 0；JVM 单测 9 项通过。
- 新增 `scripts/check-web-ui.cjs`：独立本地 fixture 服务验证严格 CSP 下的建房、加入/退出、文字/代码复制、上传三文件/取消/重试、下载、工具切换、平板抽屉、手机分页及输入区不被底栏遮挡。该检查使用模拟接口，不代替真实网络与原生 IPC 验收。
- Chrome 无头浏览器生成 16 张截图至 `docs/ui-screens/phase-3/`：大厅/已加入深色各四宽度，房主深浅色各四宽度（1440 / 1024 / 768 / 390），无横向溢出。未生成历史 Phase 0 对照截图。
- Android Studio 当前内置 JBR 已更新为 25，旧 Kotlin/lint 不兼容；改用已安装的 JBR 17 后验证通过，未修改系统 Java 配置。

### 仍需后续处理与验收

- 原生 Tauri/Android 与访客浏览器的多设备真实传输、断网重连、后台 5 分钟、旋转、2GB 文件、Windows 体验，以及 Safari iOS / Firefox；本轮未做这些真机验证。
- Phase 3 的两位新用户 60 秒任务测试；Phase 0 截图对照；深浅主题完整 axe/Lighthouse 与减少动态效果验收。
- 设计文档中的部分交互细节仍未落实：PIN 开关/分格输入和 429 倒计时、发现骨架屏、头像配色、发送消息乐观更新。不能把本轮核心改造等同于整个 UI 计划全部完成。
- Electron / electron-builder 仍为 28.3.3 / 24.13.3，受支持大版本升级与 Windows 打包验证仍待执行。
- 上一轮核对发现的历史缺口（已在顶部第二轮修复）：Android 聊天仍全量重建 LinearLayout，FileAdapter 仍用 notifyDataSetChanged，常用房间 PIN 尚未加密，JsonFragment 格式化仍在主线程，附件下载仍可能交给外部浏览器。这些工作未在本轮扩大范围处理。

---

## 1. 结论速览

| 范围 | 状态 |
|---|---|
| BUG 文档 Batch 1（P0） | ✅ 全部完成（S1 / S2 / A1） |
| BUG 文档 Batch 2（P1 服务端） | ✅ 全部完成（S3–S8 + Rust/Electron 其余条目） |
| BUG 文档 Batch 3（P1 Android） | ✅ 全部完成（A2–A9，含 ViewModel 改造） |
| BUG 文档 Batch 4（P2） | ✅ 完成除 2 项以外全部（详见 §6） |
| UI 文档 Phase 0 | ✅ 完成 |
| UI 文档 Phase 1 | ✅ 完成（Web + Android） |
| UI 文档 Phase 2 | ✅ 完成（Web 组件层 + Android 字符串/触控/图标） |
| UI 文档 Phase 3 | 核心改造已在接续轮次落地；完整验收与细节仍待，见顶部记录 |
| UI 文档 Phase 4 | ✅ 完成（动效 / 浅色主题 / 微文案 / 字体渲染） |

---

## 2. Batch 1 — P0 安全与崩溃

### S1 回环免鉴权 + `ACAO: *`

| 端 | 改动 |
|---|---|
| Rust | 新增 `header_val` / `is_lan_or_loopback_host` / `origin_allowed` / `host_allowed` / `is_trusted_loopback` / `cors_headers_for`；`serve_http_requests` 入口统一拦截：Origin 不属于本机/局域网，或 Host 指向外部域名（DNS rebinding）→ 403；`is_authorized` 的回环分支改为「回环 **且** Origin **且** Host 三者都通过」；CORS 改为回显已校验 Origin + `Vary: Origin` |
| Android | `LanServer` 同步实现 `isOriginAllowed` / `isHostAllowed` / `isTrustedLoopback`，`serve()` 开头 403；`cors()` 回显 Origin；Tauri 的 `tauri://localhost` 与 `https://tauri.localhost` 都放行 |

**回归测试**：`test_cross_site_loopback_fetch_is_blocked`（对 `/api/files`、`/api/messages`、`/api/download/*`、`/api/received_files` 四个接口验证 403 且不泄露内容）、`test_dns_rebinding_host_header_is_blocked`，并验证本机 Tauri 界面仍可访问。

### S2 hostToken 作为成员 id 泄露

- Rust：`/api/room/create` 的 host member 改用独立 UUID；`/api/room/members` 对未授权请求只返回 `{count}`；`join`/`heartbeat` 响应新增 `memberId`；Web 端「是我」判断从 `m.id === roomState.token` 改为 `memberId`（并持久化在 `localStorage.wenbox_member_id`）。
- Android：`RoomManager` 新增 `getHostMemberId()` / `getMemberIdByToken()`；`/api/room/members` 未授权只返回人数。
- Web：`roomState.memberId`，join 时写入，退出时清理。

**回归测试**：`test_room_members_never_expose_tokens`。

### A1 `setRoomMode(HOST)` ↔ `setHostIp` 递归

- `RoomManager.setHostIp` 新增去重：`if (room.hostIp == clean) return`。
- `TransferFragment` 的 `onRoomStateChangedListener` 拆分为两条路径：模式不同才 `setHostMode`，已是房主时只调用 `updateHostHeader(cfg)`（只刷新房间名/在线数，**不重建网卡列表**）。
- `selectIpForQr` 不再因为监听器回调重新进入渲染循环。

**验收路径**：反复点击网卡卡片不会再触发递归；`RoomManager.setHostIp` 是唯一的 IP 写入点。

---

## 3. Batch 2 — P1 服务端（Rust + Android 同步）

| ID | 实现 |
|---|---|
| S3 | `leave` / `heartbeat` 显式拒绝保留键 `"host"`；成员 15s 超时清理时同步移除 `auth_tokens`（Rust 与 Kotlin 两侧都有单测/逻辑） |
| S4 | `read_body_limited()`：控制接口 64KB、消息 8MB，超限返回 **413**；消息保留最近 500 条（`push_message_bounded` / `ArrayDeque` + 锁）；`/api/probe` 设备表上限 256；Android 用 `content-length` 前置判断 |
| S5 | `/api/room/set_ip` 要求「可信回环 **或** 房主令牌」，且 IP 必须属于本机网卡，否则 403 |
| S6 | `room_id` 改为 UUID（三处建房 + Android），`room_name` 仅用于展示；发现列表过滤自身改为按本机网卡 IP；关房通知按 `room_id + sender_ip` 匹配；设备名 macOS 走 `scutil --get ComputerName`，退回 `hostname` crate |
| S7 | Tauri：`fs.all: false` + 精确 API 白名单 + scope 限定；`csp` 落地（含 `object-src 'none'`、`base-uri 'self'`）。Electron：`sandbox`、`setWindowOpenHandler`、`will-navigate`、`will-attach-webview` 防护；`electron` 锁定 `=28.3.3`、`electron-builder` 锁定 `=24.13.3` |
| S8 | PIN 频控：按客户端 IP 连续失败 5 次锁定 60 秒，返回 **429** + 中文文案；比较使用常量时间实现（Rust 手写 XOR，Kotlin `MessageDigest.isEqual`）；Web 与 Android 都会展示 429 文案 |

### Rust 其它条目（全部落地）

- 硬编码 `"Windows"` → `desktop_platform()`
- `percent_decode_strict` 改为按字节解析 hex（不再对 `&input[i+1..i+3]` 切字符串），非 ASCII 输入不再 panic
- `/api/received_files` 纳入受保护接口；`public_file_view()` 在对外序列化前清空 `path`
- `/api/files/clear` 要求 POST + 房主令牌
- 上传完成后不再自动 `state.files.insert`（避免访客私发文件对全房间公开）
- Windows 保留名（`CON`/`NUL.txt`）与结尾点/空格加前缀或裁剪
- `save_remote_file_to_directory` / `save_file_to_directory` 改用 `create_new` + 冲突序号，失败时清理半截文件
- 子网广播按 netmask 计算（`if-addrs = =0.13.4`），不再写死 `/24`
- `broadcast_room_closed()` 抽出，关房命令与 HTTP 接口共用并逐网卡发送
- `/api/room/status`、`/api/probe` 统一 `selected_ip.or(primary)`
- `/api/probe` 不再信任 body 里的 `ip`
- 浏览器房主心跳超 30 秒自动关房
- 建房检查与写入放在同一个 `room` 锁作用域内（消除 TOCTOU）
- 版本号统一为 **1.3.1**（`Cargo.toml` / `tauri.conf.json` / `package.json`）

**回归测试**：`test_room_leave_cannot_remove_host_reserved_key`、`test_oversized_control_body_is_rejected_with_413`、`test_set_ip_requires_authorization_and_local_ip`、`test_pin_bruteforce_is_locked_out`、`test_sanitize_file_name`、`test_unique_target_path_never_overwrites`、`test_pin_public_file_view_hides_path`、`test_push_message_bounded_trims_history`、`test_percent_decode_strict_non_ascii_does_not_panic`、`test_broadcast_addrs_are_not_hardcoded_slash24`。

---

## 4. Batch 3 — P1 Android 客户端

引入 `MainViewModel` 与 `TransferViewModel`（`activityViewModels()`），把 `currentRoomMode / joinedRoom / joinedToken / joinedMessages / 轮询 Job` 全部移出 Fragment：

| ID | 实现 |
|---|---|
| A2 | `setRoomMode` 不再调用 `MessageManager.clearAll()`；只有 `RoomManager.createRoom/closeRoom` 才清服务端消息 |
| A3 | JOINED 消息只进 `TransferUiState.joinedMessages`，**绝不写入 `MessageManager`**；发送也不再写本机服务端 |
| A4 | `MainActivity` 不再持有 Fragment 实例，`createFragment()` 每次新建；服务状态通过 `MainViewModel.serviceState: StateFlow<ServiceState>` 暴露，删除 `updateServerUi()` / `onServiceConnected()` 直调 |
| A5 | View 重建后按 ViewModel 当前状态渲染，JOINED 不再被强制回 HOST；轮询挂在 `viewModelScope`，`onCleared` 调 `/api/room/leave` |
| A6 | 入房请求在 ViewModel 中执行，请求期间禁用按钮，结果通过 StateFlow 回到 UI |
| A7 | Manifest 增加 `WRITE_EXTERNAL_STORAGE (maxSdkVersion=28)`；启动服务时申请；拒绝时退回应用私有目录并在 Toast 说明位置；同名文件追加序号；MediaStore 写入失败执行 `resolver.delete(uri)` 清理 IS_PENDING 残留 |
| A8 | 发送/上传逻辑移入 ViewModel（`viewModelScope`），切页后不会再抛 `IllegalStateException`，失败也会回调 UI |
| A9 | 灯箱改为复用 `decodeSampled`（按屏幕宽高计算 `inSampleSize`），`catch (t: Throwable)`，连接放在 `try/finally { disconnect() }` |

---

## 5. Batch 4（P2）与 UI 阶段

### 已完成

- **Android**：轮询 `catch` 前补 `CancellationException` 重抛；`onDestroyView` 解绑全部单例监听器（`FileManager` / `RoomManager` / `MessageManager` / `UdpDiscoveryManager`）；弹窗统一经 `trackDialog` 登记并在 `onDestroyView` 关闭（消除 WindowLeaked）；`phoneClientId` 持久化到 `wenbox_prefs`；退出房间前调 `/api/room/leave`；热点设置逐级退回 + 兜底 Toast；`ConverterFragment` 负数与前导零修复（抽到 `industrial/RadixConverter.kt`，9 项 JVM 单测）；`FileAdapter` 触控目标提升到 48dp；徽标改用 `backgroundTintList` 不再覆盖圆角 drawable；`backup_rules.xml` / `data_extraction_rules.xml` 排除 `wenbox_prefs`
- **Web**：`fetchWithTimeout` 对 503 做指数退避重试 2 次；新增 `runtime.js` 单一调度器（`document.hidden` 暂停、`roomRevision` 丢弃过期响应、可见时补跑）；删除重复的 `escapeHtml`；`[image:]` 只允许 `data:image/`、`/api/download/` 或房主 origin（阻断轻度 SSRF）；聊天外链加 `rel="noopener noreferrer" referrerpolicy="no-referrer"`；小图内联阈值从 400KB 降到 128KB；`navigator.clipboard` 不支持时给出明确提示
- **UI Phase 0**：`tokens.css`、`icons.svg`（48 个 Lucide 离线图标）、`theme.js`、`.stylelintrc.json`（锁定 stylelint `=16.11.0` / `stylelint-config-standard` `=36.0.1`）
- **UI Phase 1**：`style.css` 十六进制色值 **108 → 0**；字号收敛到 6 档；圆角收敛到 4 档；删除 `.card` 投影与渐变按钮背景；`outline: none` 改为统一 `--focus-ring`；Android 侧 `values/colors.xml`（浅色）+ `values-night/colors.xml`（深色）+ `dimens.xml` + `TextAppearance.WenBox.*` + `windowLightStatusBar=false`；修掉 33 处 `: hover` / `: focus` 这类被浏览器整条丢弃的非法选择器
- **UI Phase 2**：`style.css` 新增 `.btn` / `.card` / `.field` / `.input` / `.badge` / `.status-bar` / `.list-row` / `.empty` / `.progress` / `.toast` / `dialog.modal` / `.segmented` 与工具类；`index.html` 内联样式 **110 → 0**、旧按钮类全部替换、导航改为 SVG 图标；Android `HardcodedText` / `ContentDescription` / `TouchTargetSizeCheck` 告警 **归零**
- **UI Phase 4**：`theme.js` 三态主题切换（跟随系统/深色/浅色，`localStorage` 持久化）；动效放在 `prefers-reduced-motion: no-preference`；`-webkit-font-smoothing` + `tabular-nums`；微文案去掉 emoji

### 上一轮交接状态（当前进度见顶部接续记录）

1. **UI Phase 3 信息架构重组未做**。原因：`app.js` 有 149 处 DOM 引用、`index.html` 有 146 个 id，二者高度耦合。把 5 个 Tab 合成 2 个、把三个 `roomBanner` 合并为单一状态条，需要同步重写 `app.js` 的房间渲染与轮询逻辑——这是一次全量重写，半途而废会留下无法运行的中间态，风险高于收益。因此本轮只做了 Phase 3 中不破坏耦合的部分（`hidden` 属性替代 `style.display` 的初始隐藏、上传队列/状态条的样式已就绪）。
2. **`index.html` 中仍有 64 处 emoji**（标题、按钮、空状态）。原因是这些位置与上面的 `app.js` id 耦合区重叠，随 Phase 3 一起替换更安全。
3. **Electron `electron` 仍锁在 28.3.3**。28 已停止维护；升级到当前受支持大版本需要同步验证 `electron-builder` 的打包与 CI 流程，本轮没有条件验证，故只把范围锁成精确版本。

---

## 6. 验证方式

```bash
# Web
npm test                                   # 18 passed
npx stylelint "app/src/main/assets/web/*.css"   # 0 error（16 条 duplicate-selector warning）

# Rust
cd src-tauri && cargo build
cargo clippy --all-targets -- -D warnings   # 0 warning
cargo test                                 # 27 passed

# Android（JDK 17）
gradle :app:assembleDebug :app:lintDebug :app:testDebugUnitTest
# BUILD SUCCESSFUL；lint 0 error、HardcodedText/ContentDescription/TouchTargetSizeCheck 均 0
```

新增自动化测试：
- Rust 15 项（`is_lan_or_loopback_host`、`origin_allowed`、文件名清洗、唯一路径、常量时间比较、消息裁剪、对外视图、413/403/429 端到端）
- Web 7 项（503 退避重试、非 503 不重试、调度器重复调度/未到期跳过/后台暂停/bump）
- Android 9 项（`RadixConverter`：负数拒绝、前导零字节保留、十六进制往返、非法输入、大数）

---

## 7. 关键契约变更（三端已同步）

| 变更 | Rust | Android | Web |
|---|---|---|---|
| 跨站请求拦截 | Origin + Host 校验 → 403 | 同 | 同源请求不受影响 |
| CORS | 回显 Origin + `Vary` | 同 | 同 |
| 成员 id | 与 token 解耦，join/heartbeat 返回 `memberId` | 同 | `roomState.memberId` |
| 未授权成员列表 | 只返回 `{count}` | 同 | 只读 count |
| PIN 频控 | 5 次 / 60 秒 → 429 | 同 | 展示 429 文案 |
| 请求体上限 | 控制 64KB / 消息 8MB → 413 | 同（content-length 前置） | — |
| `room_id` | UUID，`room_name` 仅展示 | 同 | 用 roomId 做过滤 |
| 消息保留 | 最近 500 条 | 最近 500 条 | UI 列表最近 500 条 |

---

## 8. 下一次迭代建议

1. 做 Phase 3 时先统一 `app.js` 与 `index.html` 的契约（把 146 个 id 收敛成 `data-*` + 事件委托），再动信息架构；这一步做完后 Phase 2 遗留的 64 处 emoji 与 CSP 的 `script-src 'unsafe-inline'` 可以一次性清掉。
2. 补 Phase 3 要求的四个宽度（1440 / 1024 / 768 / 390）截图基线到 `docs/ui-screens/phase-N/`；本轮没有可用的浏览器自动化环境，未生成截图。
3. 真机回归第 6 节的 8 条清单（尤其 S1 的跨站 fetch 与两页网卡切换 20 次）。
4. 评估 Electron 大版本升级与 `electron-builder` 的同步升级。
