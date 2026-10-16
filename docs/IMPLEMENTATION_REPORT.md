# WenBox 修复与重构实施报告

> 对应文档：`docs/BUG_FIX_PLAN.md`（缺陷修复）、`docs/UI_REDESIGN_PLAN.md`（界面优化）
> 验证环境：macOS aarch64 / Rust 1.98 / JDK 17（JBR 17.0.14）/ Gradle 8.2 / Node 26
> 三端验证结果：**Rust 27 项测试通过 + clippy 全绿；Android 构建与 lint 通过（0 error）+ 9 项单测通过；Web 18 项测试通过 + stylelint 0 error**

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
| UI 文档 Phase 3 | ⚠️ 部分完成（见 §5，最大缺口） |
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

### 未完成（需明确交接）

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
