# WenBox 缺陷修复文档

> 审计基线：`main@50267d7` + 工作区未提交改动（2026-10-16）。
> 方法：静态读码 + `npm test`（11/11 通过）。**未编译 APK / Tauri，未真机复现**，标注"疑似"的条目需执行者先复现。
> 行号以审计时工作区为准，改动后可能偏移，请用代码片段定位。

## 0. 给执行 Agent 的约定

- 按批次（Batch）顺序执行，每批一个独立提交，提交信息 `fix(<端>): <摘要>`。
- 每批完成后必须跑验证：
  - Rust：`cd src-tauri && cargo build && cargo clippy -- -D warnings`
  - Android：`./gradlew :app:assembleDebug :app:lintDebug`
  - Web：`npm test`
- 三端（Rust / Android / Web）协议必须保持一致：任何接口行为变更（鉴权、字段）要同时改 `src-tauri/src/main.rs`、`server/LanServer.kt`、`assets/web/app.js`。
- 新增依赖必须锁定精确版本（如 `uuid = "=1.x.y"`）。
- 不要顺手重构无关代码。

## 1. 问题总览

| ID | 级别 | 端 | 摘要 |
|---|---|---|---|
| S1 | P0 | Rust+Android | 回环免鉴权 + `ACAO: *`，任意网页可读本机文件/消息 |
| S2 | P0 | Rust | 浏览器建房时 hostToken 作为成员 id 被公开接口泄露 |
| A1 | P0 | Android | `setRoomMode(HOST)` ↔ `setHostIp` 同步无限递归（StackOverflow） |
| S3 | P1 | Rust | 保留键 `"host"` 可被任意客户端删除/改名 |
| S4 | P1 | Rust | 控制接口无上限读 body + 消息无上限，内存打爆 |
| S5 | P1 | Rust+Android | `/api/room/set_ip` 无鉴权，可劫持宣告 IP |
| S6 | P1 | Rust | macOS/Linux 默认 room_id 相同，互相不可见 |
| S7 | P1 | Rust | Tauri `fs` 权限 `**` + `csp: null` |
| S8 | P1 | Rust+Android | PIN 无频率限制，可暴力枚举 |
| A2 | P1 | Android | `setRoomMode` 每次都 `MessageManager.clearAll()` 清空全房间历史 |
| A3 | P1 | Android | JOINED 模式把别人房间的消息写进本机服务端（串房/隐私泄露） |
| A4 | P1 | Android | MainActivity 持有 Fragment 实例，重建后回调失效 |
| A5 | P1 | Android | JOINED 状态在 View 重建后丢失，轮询不恢复 |
| A6 | P1 | Android | `joinRemoteRoom` 完成时 View 已销毁 → 孤儿状态；无防重复点击 |
| A7 | P1 | Android | API 26–28 保存图片/接收上传失败（缺存储权限）+ 同名覆盖 |
| A8 | P1 | Android | 上传中切页后 `viewLifecycleOwner` 抛异常，消息丢失（本次 diff 引入） |
| A9 | P1(疑似) | Android | 大图预览全尺寸解码 OOM |
| P2-* | P2 | 各端 | 见第 5 节清单 |

## 2. Batch 1 — P0 安全与崩溃（必须先做）

### S1 回环免鉴权 + CORS `*`（Rust 与 Android 同病）

**位置**
- Rust：`src-tauri/src/main.rs` `is_authorized()`（约 676 行）`if addr.ip().is_loopback() { return true; }`；`handle_http_request` 中 `Access-Control-Allow-Origin: *`（约 1297 行）。
- Android：`server/LanServer.kt` `isRequestAuthorized()`（约 640 行）`if (remoteIp == "127.0.0.1" || remoteIp == "::1") return true`；`addHeader("Access-Control-Allow-Origin", "*")`（约 765 行）。

**场景**：用户在本机浏览器打开任意外部网页，执行 `fetch('http://127.0.0.1:9527/api/files')` / `/api/messages` / `/api/download/<id>`。请求来自回环地址，鉴权直接通过；`ACAO:*` 又让页面能读到响应。结果密码房的文件和聊天都会泄露。DNS rebinding 也能绕过（没有 Host 校验）。

**修复**
1. 新增 `origin_allowed` / `host_allowed`，在 OPTIONS 处理之后统一拦截：

```rust
fn header_val(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string())
}
fn is_lan_or_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').split(']').next().unwrap_or(host);
    let h = h.rsplit_once(':').map(|x| x.0).filter(|_| !h.contains("::")).unwrap_or(h);
    if h == "localhost" || h == "tauri.localhost" { return true; }
    match h.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        Ok(std::net::IpAddr::V6(v6)) => v6.is_loopback(),
        Err(_) => false,
    }
}
fn origin_allowed(req: &tiny_http::Request) -> bool {
    match header_val(req, "Origin") {
        None => true, // 非浏览器客户端 / 同源导航
        Some(o) if o == "null" => false,
        Some(o) if o.starts_with("tauri://") => true,
        Some(o) => o.split("://").nth(1).map(is_lan_or_loopback_host).unwrap_or(false),
    }
}
fn host_allowed(req: &tiny_http::Request) -> bool {
    header_val(req, "Host").map(|h| is_lan_or_loopback_host(&h)).unwrap_or(true)
}
```

2. `is_authorized` 中回环分支改为 `if addr.ip().is_loopback() && origin_allowed(req) && header_val(req,"Origin").map_or(true, |o| o.starts_with("tauri://") || o.contains("127.0.0.1") || o.contains("localhost")) { return true; }`。
3. CORS 响应头改为回显已通过校验的 Origin（`Access-Control-Allow-Origin: <origin>` + `Vary: Origin`），不再使用 `*`。
4. Android 同样实现：`session.headers["origin"]`、`session.headers["host"]`，在 `serve()` 开头拦截返回 403；`addCorsHeaders` 回显 Origin。
5. 注意 Tauri 1.x webview 的 Origin 在 macOS 是 `tauri://localhost`，在 Windows 是 `https://tauri.localhost`，两者都要放行（执行者用 devtools 确认实际值）。

**验收**
- 在本机 Chrome 打开 `https://example.com` 控制台执行 `fetch('http://127.0.0.1:9527/api/files').then(r=>r.text())`：密码房下必须失败（403 或 CORS 报错）。
- 桌面端 / Android 自身 UI、局域网其它设备访客页功能不受影响。

### S2 hostToken 作为成员 id 泄露（Rust）

**位置**：`main.rs` `/api/room/create`（约 1437 行）`RoomMember { id: host_token.clone(), ... }`；`/api/room/members`（约 1717 行）无鉴权，直接返回 `members[].id`。

**场景**：访客 A 用浏览器建了密码房。B 不知道密码，直接 `GET /api/room/members` 就能拿到 host_token，用它下载文件，还能 `/api/room/close` 解散房间。

**修复**
```rust
id: uuid::Uuid::new_v4().to_string(),   // 与 Android RoomManager 一致，绝不复用 token
```
同时对 `/api/room/members` 做处理：`need_password` 时未授权只返回 `{count}`，或者整体要求 `is_authorized`。Web 端 `app.js` 中用 `m.id === roomState.token` 判断"是我"的逻辑（约 1745 行）要改成服务端在 join/heartbeat 返回的 `memberId`。三端统一：join 响应新增 `memberId` 字段。

**验收**：未授权 curl `/api/room/members` 的输出中不包含任何 `auth_tokens` 里的值。

### A1 Android `setRoomMode(HOST)` 同步无限递归

**调用链（已读码确认）**
`TransferFragment.setRoomMode(HOST)` → `renderNetworkInterfaces(port)` → `selectIpForQr()` → `RoomManager.setHostIp(ip)`（无去重，总会触发 listener）→ `onRoomStateChangedListener` → `activity?.runOnUiThread {}`（已在主线程时**同步执行**）→ `setRoomMode(HOST)` → …

入口：`onViewCreated` 恢复房间、`onResume`、`onServiceConnected`、点击 IP 卡片。只要处于 HOST 且有可用网卡就会触发。执行者需先真机确认（`adb logcat | grep StackOverflow`）；如果没有崩溃，说明 listener 在某处被覆盖，也照样修。

**修复（两处都要改）**
```kotlin
// RoomManager.setHostIp
val room = currentRoom ?: return
if (room.hostIp == clean) return          // 新增：无变化不通知
```
```kotlin
// TransferFragment.initRoomEvents
RoomManager.onRoomStateChangedListener = { cfg ->
    activity?.runOnUiThread {
        if (_binding == null) return@runOnUiThread
        if (cfg?.isActive == true) {
            if (currentRoomMode != RoomMode.HOST) setRoomMode(RoomMode.HOST, cfg)
            else updateHostHeader(cfg)   // 新抽出的函数：只刷新房间名/IP/在线数，不重建网卡列表
        } else if (currentRoomMode == RoomMode.HOST) setRoomMode(RoomMode.CLIENT)
    }
}
```
**验收**：反复切换网卡卡片、前后台切换 20 次，不崩溃，聊天记录不清空（联动 A2）。

## 3. Batch 2 — P1 服务端（Rust + Android 同步改）

### S3 保留键 `"host"` 可被删除或改名
**位置**：`main.rs` `/api/room/leave`（约 1697–1710 行）`members.remove(&t)`；`/api/room/heartbeat`（约 1662–1672 行）`members.get_mut(t)`。Android `RoomManager.leaveRoom(token)` 也一样（`members.remove(token)`，而 host 的键就是 `"host"`）。
**场景**：未鉴权的 `POST /api/room/leave {"token":"host"}` 会删掉房主，房主从此不再出现在成员列表里。`heartbeat {"token":"host","name":"假房主"}` 可以改房主名。
**修复**：
```rust
if t == "host" { /* ignore */ } else { members.remove(&t); state.auth_tokens.lock().unwrap().remove(&t); }
// heartbeat
} else if t != "host" { if let Some(m) = members.get_mut(t) { ... } }
```
```kotlin
fun leaveRoom(token: String) { if (token.isBlank() || token == "host") return; ... }
```
**扩展**：成员 15 秒超时清理时同步移除 `auth_tokens`（Rust 约 1720 行的 `retain`），避免已退出成员的旧 token 永久有效。

### S4 请求体与消息无上限
**位置**：`main.rs` 中所有 `req.as_reader().read_to_string(&mut body)`（约 1350/1459/1516/1537/1621/1699/1813/2010 行）；`state.messages` 是无界 Vec。Android `MessageManager.messages` 也是无界 `CopyOnWriteArrayList`，而且每次写入都要整表复制。
**修复**：
```rust
fn read_body_limited(req: &mut tiny_http::Request, max: u64) -> Option<String> {
    if req.body_length().map_or(false, |l| l as u64 > max) { return None; }
    let mut s = String::new();
    std::io::Read::take(req.as_reader(), max + 1).read_to_string(&mut s).ok()?;
    if s.len() as u64 > max { None } else { Some(s) }
}
const CTRL_MAX: u64 = 64 * 1024;          // 房间控制类接口
const MSG_MAX: u64 = 8 * 1024 * 1024;     // 消息（含 <400KB base64 图片，留余量）
```
超限返回 413。消息只保留最近 500 条：`if msgs.len() > 500 { msgs.drain(..msgs.len()-500); }`。Android 用 `synchronized` 包住 add + `while (size > 500) removeAt(0)`，或者改用 `ArrayDeque` 加锁。
**验收**：`head -c 20000000 /dev/zero | curl -X POST --data-binary @- :9527/api/messages` 返回 413，进程内存无明显上涨。

### S5 `/api/room/set_ip` 无鉴权
**位置**：`main.rs` 约 1514 行；`LanServer.kt` 约 326 行。
**修复**：只接受回环请求（经过 S1 的 Origin 校验后）或带 host token 的请求，并校验 IP 属于本机网卡：
```rust
let valid = get_all_lan_ips().iter().any(|i| i.ip == clean);
if !(is_loopback_trusted || is_host_token) || !valid { /* 403 */ }
```
Android：`NetworkUtils.getAllLocalIpAddresses(context).any { it.ip == ip }`。

### S6 macOS/Linux 默认房间 ID 冲突
**位置**：`main.rs` 约 2397–2409 行。`COMPUTERNAME`/`HOSTNAME` 在 GUI 启动时为空，于是 `room_id = "WenBox·macOS电脑"`，所有 Mac 都一样；发现过滤（约 492 行）和关闭通知（约 2282 行）都按 room_id 匹配。
**修复**：
1. 三处建房（`create_room_cmd`、HTTP create、默认房）都用 `room_id = Uuid::new_v4()`，`room_name` 只用于展示。
2. 设备名：macOS 执行 `scutil --get ComputerName`，失败时退回 `gethostname`（引入 `gethostname = "=0.4.3"`）。
3. 发现列表过滤自身改为 `!self_ips.contains(&r.ip)`；关闭通知改为 `retain(|_, v| !(v.room_id == id && v.ip == sender_ip))`。
4. Android 侧检查 `UdpDiscoveryManager` 是否同样按 roomName 去重，若是则一并改。
**验收**：两台 Mac 同时打开，能互相在"发现房间"中看到对方。

### S7 Tauri 权限过宽 / 无 CSP
**位置**：`src-tauri/tauri.conf.json`：`"fs": {"all": true, "scope": ["**"]}`、`"csp": null`。
**修复**：
```json
"fs": { "all": false, "readFile": true, "writeFile": true, "createDir": true, "exists": true,
        "scope": ["$DOWNLOAD/**", "$DESKTOP/**", "$DOCUMENT/**"] },
"security": { "csp": "default-src 'self'; img-src 'self' data: blob: http: https:; connect-src 'self' http: ipc: https://ipc.localhost; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" }
```
`app.js` 里大量内联 `onclick="window.xxx(...)"`，所以 script-src 暂时保留 `'unsafe-inline'`。UI 重构阶段改为事件委托后再去掉（见 UI 文档 Phase 3）。先 grep `__TAURI__.fs` 的所有调用，确认用到的 API 都在白名单里。

### S8 PIN 暴力破解
**位置**：`main.rs` 约 1552 行 `room.pin != pin`；`LanServer.kt` 中 `/api/room/join` 的 PIN 比较。
**修复**：按客户端 IP 计数，连续失败 5 次锁定 60 秒，返回 `429` 和 `{"message":"尝试过多，请 60 秒后再试"}`。比较 PIN 时用常量时间比较（Rust 用 `subtle` 或手写异或，Kotlin 用 `MessageDigest.isEqual`）。Web 端要把 429 文案展示出来。

### Rust 其它 P1/P2（同批顺手修）
- `main.rs` 约 1389 行仍硬编码 `"Windows".into()`，改为 `desktop_platform().into()`（本次 diff 遗漏）。
- `percent_decode_strict`（约 619 行）对 `&input[i+1..i+3]` 做字符串切片，遇到非 ASCII 会 panic。改为按字节解析 hex。
- `/api/received_files` 不在 `is_protected` 列表里；`/api/files` 等接口返回 `SharedFile.path` 绝对路径（含用户名）。对外序列化前清空 `path`。
- `/api/files/clear` 不限请求方法，也没有房主校验。改为要求 POST + host token。
- 上传完成后自动 `state.files.insert`（约 1964 行），访客发给房主的文件会对全房间公开。确认产品意图；如不是有意设计，删掉这一行。
- Windows 保留文件名（`CON`/`NUL.txt`/结尾带点或空格）在保存前加前缀 `_`。
- `save_remote_file_to_directory`（约 895 行）用 `File::create`，会覆盖同名文件。改为 `create_new` 加冲突后缀，失败时 `remove_file` 清掉半截文件。`save_file_to_directory`（约 327 行）对 `file_name` 只取 `Path::file_name()`。
- 子网广播写死为 `/24`（约 439/2106/2132/2344 行）。用 `if-addrs = "=0.13.x"` 取 netmask，按 `ip | !mask` 计算广播地址。
- HTTP 关房（约 1493 行）只从 `0.0.0.0` 发一次广播。抽出 `broadcast_room_closed()` 与 `close_room_cmd` 共用，逐网卡发送。
- 端口 9527/9528 绑定失败时只打 `eprintln`。引入单实例插件（Tauri v1 对应 `tauri-plugin-single-instance` v1 分支），或在绑定失败时弹窗并跳过默认建房。
- `/api/room/status`、`/api/probe` 用 `get_primary_ip()`，与 `selected_ip` 不一致。统一改为 `selected_ip.or(primary)`。
- `/api/probe` 信任 body 里的 `ip` 字段。一律改用 `remote_addr`，`devices` 最多保留 256 条。
- 浏览器建的房间，房主关页后永不结束。非 Tauri 房主心跳超过 30 秒就自动关房。
- 建房和入房存在 TOCTOU 竞态：检查 `is_active` 和写入要放在同一个 `room` 锁作用域内完成。
- 版本号：`Cargo.toml` 是 1.3.0，`tauri.conf.json`/`package.json` 是 1.3.1，统一。

### Electron（`main.js`）
```js
const { shell } = require('electron');
win.webContents.setWindowOpenHandler(({ url }) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
  return { action: 'deny' };
});
win.webContents.on('will-navigate', (e, url) => { if (url !== pathToFileURL(indexPath).href) e.preventDefault(); });
// webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload }
```
`package.json` 中 `electron: ^28.2.0` 已停止维护，锁定到当前受支持的大版本精确号。`preload.js` 本身没问题（只暴露 `writeText`，主进程校验了 senderFrame）。

## 4. Batch 3 — P1 Android 客户端（`ui/fragment/TransferFragment.kt` 为主）

> 建议先做 A4 + A5（引入 ViewModel）。A2/A3/A6/A8 的修复都依赖"状态不放在 Fragment 字段里"。

### A2 `setRoomMode` 无条件清空消息
**位置**：`setRoomMode()` 开头 `MessageManager.clearAll(); refreshChatUi()`（约 366 行）。MessageManager 同时是本机 `/api/messages` 的数据源，所以每次网卡切换、服务重连、网页端调 set_ip，都会清空**所有终端**看到的历史。
**修复**：
```kotlin
val prev = currentRoomMode
currentRoomMode = mode
if (_binding == null) return
if (prev != mode) { joinedMessages.clear(); refreshChatUi() }   // 不再清 MessageManager
```
只有 `RoomManager.createRoom/closeRoom` 才清 MessageManager（RoomManager 内已在做）。

### A3 JOINED 模式串房
**位置**：轮询里 `MessageManager.addReceivedMessage(...)`（约 940/946 行），发送时 `MessageManager.addPhoneMessage(...)`（约 1005 行）。
**场景**：MainActivity 启动就自动建了免密房 A。手机加入别人的房间 B 后，B 的消息写进 A 的服务端，连着 A 的设备就能看到 B 的聊天。
**修复**：在 ViewModel 中维护 `joinedMessages: MutableStateFlow<List<ChatMessage>>`，JOINED 模式的 UI 只从这里渲染，绝不写入 MessageManager。产品层面也要决定加入他人房间时是否关闭本机自建房（推荐：保留服务，但把本机房间标记为"暂停"，不再广播）。

### A4 MainActivity 持有 Fragment 实例
**位置**：`MainActivity.kt` 约 38–41 行 `private val transferFragment = TransferFragment()`，`createFragment(position) = fragments[position]`。
**修复**：
```kotlin
override fun createFragment(position: Int): Fragment = when (position) {
    0 -> TransferFragment(); 1 -> JsonFragment(); 2 -> ConverterFragment(); else -> CronFragment()
}
```
服务状态放进 `MainViewModel`，用 `StateFlow<ServiceState>` 暴露，Fragment 在 `viewLifecycleOwner.repeatOnLifecycle(STARTED)` 里收集。删除所有 `transferFragment.updateServerUi()` / `onServiceConnected()` 直接调用。

### A5 JOINED 状态在重建后丢失
**修复**：新建 `TransferViewModel`（`activityViewModels()`），把 `currentRoomMode / joinedRoom / joinedToken / joinedMessages / 轮询 Job` 移进去。轮询放在 `viewModelScope`，`onCleared` 时调用 `/api/room/leave`。`onViewCreated` 按 ViewModel 当前状态渲染，不再根据 `RoomManager.currentRoom` 强制回到 HOST。

### A6 `joinRemoteRoom` 竞态
**位置**：约 808/822 行，用 Fragment 级 `lifecycleScope`。
**修复**：请求逻辑放进 ViewModel（`viewModelScope`），确认按钮在请求期间 `isEnabled=false`，结果通过 StateFlow 回到 UI。

### A7 API 26–28 存储
**位置**：保存图片（约 1371 行，`getExternalStoragePublicDirectory(PICTURES)`）；`FileManager.saveIncomingFile` 中 Android 9 及以下分支写 `Downloads/WenBox`。Manifest 没有存储权限，而 `minSdk 26`。另外这个分支用 `FileOutputStream(File(dir, fileName))`，会**覆盖同名文件**。
**修复**：
```xml
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28"/>
```
- 前台保存图片前用 `registerForActivityResult(RequestPermission())` 申请权限。
- 后台接收上传无法弹框，所以首次启动服务时就申请。拒绝时退回 `context.getExternalFilesDir(DIRECTORY_DOWNLOADS)`，并在 UI 提示保存位置。
- 同名冲突：文件已存在时追加 ` (1)`、` (2)`。
- Q+ 分支写入失败时执行 `resolver.delete(uri, null, null)`，避免留下 IS_PENDING 残留。

### A8 上传中切页后发消息失败（本次 diff 引入）
**位置**：`sendChatContent()` 中 JOINED 分支改成了 `viewLifecycleOwner.lifecycleScope.launch`（约 993 行）。而调用方 `chatFilePickerLauncher`（约 195–213 行）和图片上传（约 150 行）运行在 Fragment 级作用域，上传期间 View 被 ViewPager2 销毁后，访问 `viewLifecycleOwner` 会抛 `IllegalStateException`。
**修复**：发送逻辑移进 ViewModel（`viewModelScope`），UI 回调 `context?.let { toast }`。所有提前 `return` 的分支（`val ctx = context ?: return`、`val room = joinedRoom ?: return`，约 977/991 行）都要先 `onSent?.invoke(false)`，否则发送按钮会一直保持禁用。

### A9（疑似）大图预览 OOM
**位置**：lightbox `BitmapFactory.decodeByteArray(bytes, 0, bytes.size)`（约 1312/1319 行）。
**修复**：复用 `decodeImagePayload` 的 `inSampleSize` 逻辑，目标尺寸取屏幕宽高；`catch (t: Throwable)`；连接放进 `try/finally { conn.disconnect() }`。

## 5. Batch 4 — P2 清单

### Android
| 位置 | 问题 | 修复 |
|---|---|---|
| TransferFragment 轮询 `catch (_: Exception) {}`（约 953 行） | 吞掉 CancellationException，取消后仍会累计 failCount | 在它前面加 `catch (e: CancellationException) { throw e }` |
| `FileManager/RoomManager.on*Listener`（约 262/341/352 行） | 单例强引用 Fragment，onDestroyView 未解绑 | onDestroyView 中全部置 null（迁到 ViewModel 后改为 Flow） |
| 所有 `Dialog(ctx)`（454/485/505/713/778/1251/1398/1659 行） | 旋转时 WindowLeaked；`requireContext()` 在回调中崩溃 | 改用 `DialogFragment` 或 `MaterialAlertDialogBuilder`；回调里用 `dialog.context` |
| 轮询 `JSONObject(res)`（约 924 行） | 首轮全量拉取含 base64 的历史，在主线程解析 | `withContext(Dispatchers.Default)` 解析后再映射 |
| 聊天列表 LinearLayout 全量重建（约 1062 行） | 消息多时卡顿；LruCache 用整段 base64 作 key | 改成 RecyclerView + ListAdapter + DiffUtil，以 `msg.id` 为 key |
| 图片/文件 URL 写死 `127.0.0.1:9527`（约 1111/1154 行） | 端口变化后加载失败 | `getTransferService()?.currentPort ?: 9527` |
| `phoneClientId by lazy`（约 974 行） | 重建后 ID 改变，自己的消息显示两次 | 持久化到 `SharedPreferences("wenbox_prefs").client_id` |
| `confirmLeaveRoom`（约 641 行） | 不通知房主，成员残留 15 秒 | 先调用 `/api/room/leave` |
| 热点设置兜底 `startActivity`（约 1712 行） | 定制 ROM 上抛 ActivityNotFoundException | try/catch 后 toast |
| 文件链接拼 `token=` 后交给外部浏览器（约 1158 行） | token 进浏览器历史 | 改为应用内下载（OkHttp + header token），保存到 Downloads |
| 常用房间 PIN 明文存储 + `allowBackup=true` | 备份泄露 | 用 `EncryptedSharedPreferences`（`androidx.security:security-crypto` 锁定版本）；`backup_rules.xml` 排除 prefs |
| ConverterFragment 负数 / 前导零（约 30–56、116–140 行） | `-5` 显示成 `0-101`；`00 41` 丢掉前导零字节 | 负数直接报错；Hex↔ASCII 按字节数组互转，不经过 BigInteger |
| CronFragment Spinner 恢复（疑似） | 旋转后用户输入被预设覆盖 | 用 `userInitiated` 标志跳过首次回调 |
| JsonFragment 主线程格式化 | 输入数 MB 时 ANR | 放到 `Dispatchers.Default` |
| FileAdapter `notifyDataSetChanged` + 嵌套 NestedScrollView | 回收失效 | 改成 ListAdapter；页面结构改为单一 RecyclerView + ConcatAdapter |
| `tvRoomModeBadge.setBackgroundColor` | 覆盖圆角 drawable | 改用 `backgroundTintList = ColorStateList.valueOf(...)` |

### Web（`assets/web/app.js`）
| 位置 | 问题 | 修复 |
|---|---|---|
| 存在两个 `escapeHtml`（约 2198 和 2858 行） | 后一个覆盖前一个，行为一致但容易误改 | 删掉一个，统一放进 `runtime.js` 并写单测 |
| 聊天 URL 自动链接（约 3046 行）`href="$1"` | 输入已转义所以无 XSS，但 `&amp;` 会进入 href，查询参数被破坏 | 不必改，或先解码实体再 `encodeURI`；补单测覆盖 `?a=1&b=2` |
| `[image:...]` 渲染（约 2947 行） | `img.src` 接受任意 `http(s)`，访客可借图片对内网地址发 GET（轻度 SSRF/追踪） | 只允许 `data:image/`、`/api/download/` 或当前房主 origin |
| `resolveChatUrl`（约 2872 行） | 把 token 拼进 URL，在 `<a target=_blank>` 中会经 Referer 和历史泄露 | 加 `referrerpolicy="no-referrer"`；中长期改为 fetch + header + blob 下载 |
| 小图 `readAsDataURL` 后直接发消息（约 3198 行） | 400KB 文件 base64 后约 533KB 存进消息，每个客户端首轮全量拉取 | 阈值降到 128KB，或一律走上传 |
| `localStorage wenbox_room_profiles`（约 477 行） | 常用房间 PIN 明文存储 | 在 UI 中提示"仅在本机保存"；可选用 WebCrypto 加主密码 |
| 3 个 `setInterval`（2611/2629/3431 行） | 当前没有重复注册问题；但 2.5s 成员轮询和 2s 消息轮询在后台标签页仍在计时 | 改为单一调度器，`document.hidden` 时完全暂停；房间切换时用 `roomRevision` 丢弃过期响应（消息轮询已有，成员和文件轮询需补上） |
| 503 队列满（Rust 新线程池，第 33 个请求） | 前端未重试 | `fetchWithTimeout` 对 503 做指数退避重试 2 次 |
| `navigator.clipboard`（约 3301 行） | 访客通过 `http://LAN` 访问不是安全上下文，API 不可用 | 已有 fallback 的话确认它覆盖到图片复制；不支持时隐藏"复制图片"按钮 |

## 6. 回归测试清单（每批完成后全量走一遍）
1. 桌面 A 建密码房 → 手机 B 扫码加入 → 浏览器 C 输入 IP 加入：三方互发文字、图片（<128KB 和 >5MB 各一张）、文件（中文名、空格、2GB）。
2. B 上传过程中切到 Cron 页再切回：消息正常出现。
3. A 切换网卡 10 次：不崩溃，历史不丢。
4. 手机旋转、后台 5 分钟再回来：仍在 JOINED 状态。
5. B 退出：A 的成员列表在 3 秒内更新。
6. 第 1 节 S1 的跨站 fetch 测试失败（预期）。
7. 两台 Mac 同时运行，能互相发现。
8. 输错 PIN 6 次：第 6 次返回"尝试过多"。

## 7. 建议补充的自动化测试
- Rust：把 `percent_decode_strict`、`is_lan_or_loopback_host`、`origin_allowed`、文件名清洗、广播地址计算抽成纯函数，加 `#[cfg(test)]`。
- Android：`ConverterFragment` 的转换逻辑抽到 `industrial/` 下，加 JVM 单测；`RoomManager` 的 leave/host 保护加单测。
- Web：`tests/runtime.test.js` 扩展覆盖 `escapeHtml`、聊天渲染器（链接、代码块、`[file:]`/`[image:]` 解析）。
