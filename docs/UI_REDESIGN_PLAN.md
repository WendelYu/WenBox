# WenBox 界面优化建议与执行计划

> 范围：Web SPA（`app/src/main/assets/web/`，同时承载 Tauri、Electron 和访客浏览器）以及 Android 原生（`app/src/main/res/` 和 `ui/fragment/`）。
> 前置条件：先完成 `docs/BUG_FIX_PLAN.md` 的 Batch 1–2。UI 重构会大面积改动 `app.js` 和 `TransferFragment.kt`，和修 bug 并行做容易冲突。
> 设计方向：**安静、可信的工具感**。WenBox 是高频工具，不是营销页。目标是"一眼看懂当前状态、两步完成传输"，不追求炫技。

> 2026-10-16 接续：Phase 3 核心改造与 Chrome 四宽度截图已落地，详细验证、实现取舍及剩余验收见 [实施报告](IMPLEMENTATION_REPORT.md#2026-10-16-接续记录以本节为准)。本计划仍作为目标规格，不能把核心改造视为所有细节验收通过。

> 2026-10-16 第三轮：Web PIN/429/骨架/头像/消息重试与 Electron 44.8.0 升级已落地，Node 29 / Rust 28 / Android 33 项测试通过，本机 Electron 源码与打包应用启动通过；Windows 与真机验收仍待。最新细节见 [实施报告](IMPLEMENTATION_REPORT.md)。

## 1. 现状诊断（附依据）

### 1.1 设计体系分裂
- **两套调色板并存**。`style.css:2-24` 同时定义了 slate 蓝系（`--bg-main #0B0F19`、`--card-bg`、`--primary #3B82F6`）和中性灰系（`--ic-bg-main #242424`、`--ic-accent-blue #64B5F6`，注释说明是仿 fagedongxi.com 风格的聊天区）。Android `colors.xml` 也照搬了这两套（`bg_dark #0F172A` 与 `chat_bg #242424`）。结果是文件页偏蓝黑、聊天页偏灰黑，切换 Tab 时底色会跳变。
- **硬编码泛滥**：
  - `style.css` 有 94 处硬编码十六进制色值，而 `var(--` 只有 117 处。
  - `index.html` 有 110 处内联 `style=""`，`app.js` 里拼接的模板还有 42 处，比如 `style="color:#60A5FA"`、`style="margin-top: 20px"`。
- **字号失控**：共 15 档：11/12/12.5/13/13.5/14/15/16/17/18/26/48/54px。其中 11–13px 占了 80% 以上，正文普遍偏小，主次层级拉不开。
- **圆角没有规范**：用了 4/6/8/10/12/16/99px 七档。
- **按钮类名碎片化**：`.btn-secondary`、`.btn-primary-action`、`.btn-primary-mini`、`.btn-download`、`.btn-reimburse`、`.btn-send-message`、`.btn-create-room`、`.btn-qr-action`、`.btn-join-room-action`、`.btn-danger-outline`、`.btn-copy-mini` 等十多种写法，各自定义 padding、渐变和阴影。

### 1.2 对比度（WCAG AA 正文要求 ≥ 4.5:1，已计算）
| 前景 / 背景 | 比值 | 结论 |
|---|---|---|
| `--ic-text-subtle #757575` / `#2a2a2a` | 3.12 | ❌ 不达标，只能用于禁用态 |
| `--ic-text-muted #8B949E` / `#2a2a2a` | 4.67 | ⚠️ 勉强达标 |
| 白字 / `--primary #3B82F6` | 3.68 | ❌ 主按钮文字不达标 |
| 白字 / `--accent #10B981` | 2.54 | ❌ 绿色按钮严重不达标 |
| 白字 / `#64B5F6`（聊天蓝） | 2.21 | ❌ |
| `--text-muted #94A3B8` / `#0B0F19` | 7.47 | ✅ |

### 1.3 信息架构
- **文件快传页**同时堆了这些内容：三种房间横幅（client/host/joined，靠 `display:none` 切换）、发现房间列表、本机分享列表、本机已接收列表、报销归档、对方文件、发送区。房主一屏要看 5 张卡片，主任务"发文件 / 收文件"被淹没。
- **聊天和文件被拆成两个 Tab**。但聊天本身就能发文件，两处入口功能重叠，用户困惑"该去哪发"。
- **报销归档**是很垂直的功能，却和核心传输平级放置。
- 顶部 5 个 Tab 用 emoji 当图标（📁💬📋⚙️⏱️）。各平台 emoji 渲染不一致，读屏会念出"文件夹"，在 390px 宽度下也放不下。

### 1.4 交互与可访问性
- 9 个 `modal-overlay` 弹窗，只有 2 处 `aria-*` 属性。没有 `role="dialog"` 和焦点陷阱，Esc 关闭行为不统一。
- `style.css` 里只有 6 处 `:focus` 样式，另有 4 处 `outline: none`，键盘用户看不到焦点位置。
- 状态全靠 emoji 和颜色表达（🟢 公开免密 / 🔒 需密码 / 👑 房主），色弱用户难以区分。
- 上传进度只有一个全局 `uploadProgressContainer`。多文件上传时看不出是哪个文件、剩余多少，也不能取消。
- 空状态（`.empty-state` 5 处）只有图标和一句话，没有下一步操作按钮。

### 1.5 Android 原生
- strings.xml 只有 11 条，各布局里字面量文案超过 60 处，Kotlin 中还有大量中文拼接。
- 没有 `values-night`。主题是 `Theme.Material3.DayNight`，但颜色写死为深色，状态栏图标颜色可能和背景冲突。
- 触控目标不足 48dp：复制按钮 24dp，删除、复制、发送附件等按钮 36dp。
- 徽标用 `setBackgroundColor`，覆盖了圆角 drawable，显示成直角色块。
- 自定义 `Dialog` 没有统一样式，旋转后会丢失。

## 2. 设计原则（执行者每次改动前对照）

1. **状态优先**：任何时刻页面顶部都要说清楚三件事：我在哪个房间、我是什么角色、有几个人在线。
2. **一个主操作**：每个视图只有一个实心主按钮，其余都用次级或幽灵按钮。
3. **只用 token**：新代码禁止出现十六进制颜色、裸 px 字号和内联 `style`（动态宽度百分比除外）。
4. **不靠 emoji 和颜色单独传达信息**：状态要有"图标 + 文字"，图标用统一的 SVG 线性图标集。
5. **三端同构**：Web 和 Android 共用同一份 token 数值，组件命名一一对应。

## 3. Design Token（直接复制到 `style.css` 顶部，替换现有 `:root`）

色值已逐项计算对比度，括号内为在 `--surface-1` 上的对比度。

```css
:root {
  color-scheme: dark;
  /* ---- 颜色：表面 ---- */
  --bg:            #111317;
  --surface-1:     #181B21;   /* 卡片 */
  --surface-2:     #20242C;   /* 输入框、悬停、嵌套块 */
  --surface-3:     #2A2F39;   /* 按下、选中 */
  --border:        #2A2F39;
  --border-strong: #3A4150;

  /* ---- 颜色：文字 ---- */
  --text-1: #ECEEF2;          /* 正文/标题 (14.85) */
  --text-2: #A3AAB8;          /* 次要说明 (7.39) */
  --text-3: #7C8494;          /* 占位、时间戳 (4.59，AA 下限) */
  --text-disabled: #5B6372;   /* 仅用于禁用态 */

  /* ---- 颜色：语义 ---- */
  --primary:        #2563EB;  /* 白字 5.17 */
  --primary-hover:  #1D4ED8;  /* 白字 6.70 */
  --primary-fg:     #6EA8FE;  /* 用作文字或链接 (7.14) */
  --primary-soft:   rgba(37, 99, 235, .16);
  --success:        #047857;  /* 白字 5.48 */
  --success-fg:     #34D399;  /* (8.97) */
  --success-soft:   rgba(52, 211, 153, .14);
  --warning-fg:     #FBBF24;  /* (10.33) */
  --warning-soft:   rgba(251, 191, 36, .14);
  --danger:         #B91C1C;  /* 白字 6.47 */
  --danger-fg:      #F87171;  /* (6.24) */
  --danger-soft:    rgba(248, 113, 113, .14);
  --focus-ring:     0 0 0 2px var(--bg), 0 0 0 4px #6EA8FE;

  /* ---- 字体 ---- */
  --font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --fs-xs: 12px;   /* 时间戳、徽标 */
  --fs-sm: 13px;   /* 辅助说明 */
  --fs-md: 14px;   /* 正文（默认） */
  --fs-lg: 16px;   /* 卡片标题 */
  --fs-xl: 20px;   /* 页面标题 */
  --fs-2xl: 28px;  /* 空状态主文案、PIN 显示 */
  --lh-tight: 1.3; --lh-normal: 1.55;
  --fw-regular: 400; --fw-medium: 500; --fw-semibold: 600;

  /* ---- 间距（4px 基准） ---- */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-10: 40px;

  /* ---- 圆角 ---- */
  --r-sm: 6px;    /* 徽标、行内代码 */
  --r-md: 10px;   /* 按钮、输入框 */
  --r-lg: 14px;   /* 卡片、弹窗 */
  --r-full: 999px;

  /* ---- 阴影：深色主题主要靠边框，只有浮层用阴影 ---- */
  --shadow-pop: 0 12px 32px rgba(0, 0, 0, .45), 0 0 0 1px var(--border);

  /* ---- 动效 ---- */
  --ease-out: cubic-bezier(.2, .8, .2, 1);
  --dur-1: 120ms; --dur-2: 200ms; --dur-3: 320ms;

  /* ---- 尺寸 ---- */
  --control-h: 40px;  /* 桌面按钮/输入框高度 */
  --touch-min: 44px;  /* 移动端触控下限 */
  --content-max: 1120px;
}

@media (pointer: coarse) { :root { --control-h: 44px; } }

/* 浅色主题（Phase 4 启用，先预留） */
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #F5F6F8; --surface-1: #FFFFFF; --surface-2: #F0F2F5; --surface-3: #E6E9EE;
  --border: #E2E5EA; --border-strong: #CBD0D8;
  --text-1: #15181D; --text-2: #5B6372; --text-3: #6B7280; --text-disabled: #A3AAB8;
  --primary-fg: #1D4ED8; --success-fg: #047857; --warning-fg: #B45309; --danger-fg: #B91C1C;
  --shadow-pop: 0 12px 32px rgba(15, 23, 42, .12), 0 0 0 1px var(--border);
}
```

Android 对应文件 `res/values/colors.xml`（深色）与 `res/values-night/colors.xml`。首期两份都写深色值，Phase 4 再把 `values/` 改为浅色值。名字一一对应：`bg`、`surface_1`、`surface_2`、`text_1`、`text_2`、`text_3`、`primary`、`primary_fg`、`success_fg`、`danger_fg` 等。`dimens.xml` 同步 `sp_1…sp_10`、`r_sm/md/lg`；文字样式用 `TextAppearance.WenBox.Body/Caption/Title`，对应 14/12/16sp。

**旧变量迁移映射**（Phase 1 用全局替换完成）：
| 旧 | 新 |
|---|---|
| `--bg-main`、`--ic-bg-main` | `--bg` |
| `--card-bg`、`--ic-bg-card` | `--surface-1` |
| `--ic-bg-hover` | `--surface-2` |
| `--border-color`、`--ic-border` | `--border` |
| `--text-main`、`--ic-text-main` | `--text-1` |
| `--text-muted`、`--ic-text-muted` | `--text-2` |
| `--ic-text-subtle` | `--text-3` |
| `--primary`、`--ic-accent-blue`（作背景） | `--primary` |
| `--ic-accent-blue`（作文字/链接） | `--primary-fg` |
| `--accent`、`--ic-accent-green` | 背景用 `--success`，文字用 `--success-fg` |
| `--ic-system-amber` | `--warning-fg` |
| `--danger` | 背景用 `--danger`，文字用 `--danger-fg` |

## 4. 组件规范（Web 类名 ↔ Android 组件）

| 组件 | Web | Android | 规格 |
|---|---|---|---|
| 按钮 | `.btn` + `.btn--primary/--secondary/--ghost/--danger` + `.btn--sm/--icon` | `Widget.WenBox.Button.*`（继承 Material3） | 高度 `--control-h`，`.btn--sm` 32px，圆角 `--r-md`，字号 `--fs-md`/500，图标 16px，间距 `--sp-2`。**取消所有渐变和彩色阴影**。hover 换成 `*-hover` 色；`:focus-visible` 用 `--focus-ring`；disabled 时 `opacity:.5; cursor:not-allowed` |
| 卡片 | `.card`、`.card__header`、`.card__title`、`.card__body` | `MaterialCardView` + `Widget.WenBox.Card` | `--surface-1`，1px `--border`，`--r-lg`，内边距 `--sp-5`（移动端 `--sp-4`），**无阴影**；卡片之间用父容器 `gap: var(--sp-4)`，不再给每张卡写 `margin-top` |
| 输入框 | `.input`、`.textarea`、`.field`（含 label 和 hint） | `TextInputLayout` OutlinedBox | `--surface-2` 背景，1px `--border`，focus 时边框变 `--primary` 并显示 focus ring。**每个输入框都必须有可见 label**，不能只靠 placeholder |
| 徽标 | `.badge` + `--success/--warning/--danger/--neutral` | `Chip`（不可点）或 `TextView` + tint | 高 22px，`--fs-xs`，soft 背景配 fg 文字，前面带 12px 图标 |
| 状态条 | `.status-bar` | 自定义 `RoomStatusView` | 见 5.1 |
| 列表行 | `.list-row`（图标、主文本、次文本、尾部操作） | RecyclerView item | 行高 ≥ 56px，hover 时 `--surface-2`；尾部操作按钮平时淡化，hover 或聚焦时完全显示（触屏上常显） |
| 弹窗 | 原生 `<dialog class="modal">` | `MaterialAlertDialogBuilder` / `BottomSheetDialogFragment` | 宽 `min(440px, 100vw - 32px)`；用 `showModal()` 自带焦点陷阱和 Esc 关闭；移动端（<640px）改为底部抽屉 |
| Toast | `.toast`（`role="status"`、`aria-live="polite"`） | `Snackbar` | 底部居中，3 秒，可带一个操作（如"撤销"或"查看"） |
| 空状态 | `.empty`（插图、标题、说明、主操作） | `include layout/view_empty` | 必须包含下一步操作按钮 |
| 进度 | `.progress`（每个文件一行） | `LinearProgressIndicator` | 见 5.3 |
| 图标 | 内联 SVG sprite `icons.svg#name`，`<svg class="icon"><use href="#i-upload"/></svg>` | `res/drawable/ic_*.xml` 矢量 | 统一使用 **Lucide**（ISC 协议）的线性图标，描边 1.75，尺寸 16/20/24。把需要的约 30 个图标离线打包进仓库，**不走 CDN**（局域网离线场景） |

首批图标清单：`upload, download, file, folder, image, send, paperclip, copy, check, x, lock, unlock, users, crown, wifi, qr-code, link, refresh-cw, settings, chevron-right, more-horizontal, trash-2, log-out, plus, search, braces, binary, clock, smartphone, monitor, globe`。

## 5. 关键页面重设计

### 5.1 全局骨架

```
┌───────────────────────────────────────────────────────────┐
│ [logo] WenBox        快传   工具 ▾            [昵称 ▾]   │  顶栏 56px
├───────────────────────────────────────────────────────────┤
│ ● 房主 · WenBox·客厅Mac · 🔒  |  3 人在线  |  192.168.1.8:9527 [复制][二维码]   [退出房间] │  状态条
├───────────────────────────────────────────────────────────┤
│                        主内容                              │
└───────────────────────────────────────────────────────────┘
```
- **一级导航从 5 个缩为 2 个**：「快传」（文件 + 聊天合一）和「工具」（JSON / 进制 / Cron，以二级分段控件切换）。报销归档移进「工具」，或作为快传里"保存到…"的高级选项。
- 状态条始终显示，是房间状态的唯一信息源，取代 `roomClientBanner / roomHostBanner / roomJoinedBanner` 三个横幅。各角色显示内容：
  - client（未入房）：`○ 未加入房间` + [创建房间]（主按钮）+ [输入地址加入]
  - host：角色徽标 + 房间名 + 锁状态 + 在线人数（点击打开成员抽屉）+ 访问地址（多网卡时为下拉）+ 复制 / 二维码 + [解散房间]
  - joined：角色徽标 + 房主设备名 + 在线人数 + [退出房间]
- 移动端（<640px）：顶栏只保留 logo 和昵称头像；导航改为底部 Tab 栏（2 项，高 56px + safe-area）；状态条折叠为一行，点击展开。

### 5.2 「快传」页：未入房（client）
- 主体显示"附近的房间"列表（`.list-row`）：房间名、房主设备与平台图标、锁徽标，尾部是 [加入] 按钮。
- 列表为空时显示空状态：插图 + "附近还没有房间" + 说明"确保设备在同一 Wi-Fi 下" + 主按钮 [创建房间] + 次按钮 [手动输入地址]。
- 发现中：前 3 秒显示 3 行骨架屏，之后列表每 2.5 秒静默刷新，**不要闪烁**。仅在条目增减时做 `--dur-2` 淡入。

### 5.3 「快传」页：已在房间（host / joined）—— 文件与聊天合一
桌面（≥1024px）采用两栏布局：
```
┌──────────── 会话流 (flex 1) ─────────────┬──── 文件面板 (360px) ────┐
│  消息 / 图片 / 文件卡片，按时间排列        │ [对方分享] [我分享的] [已接收] │
│  ...                                      │  list-row × N              │
│                                           │                            │
├───────────────────────────────────────────┤  拖拽区：拖文件到此分享     │
│ [📎] [🖼]  输入消息…  (Enter 发送)   [发送]│                            │
└───────────────────────────────────────────┴────────────────────────────┘
```
- 平板（640–1024px）：文件面板改为右侧抽屉，通过状态条上的 [文件 (n)] 按钮打开。
- 手机（<640px）：单栏会话流，顶部用分段控件切换 [聊天 | 文件]。
- **全页拖放**：任意位置拖入文件时显示全屏遮罩"松开即发送给房间"，松开后走现有上传逻辑，同时在会话流插入文件卡片。
- **上传队列**（替换 `uploadProgressContainer`）：
  - 每个文件一行：文件名、`已传 / 总大小`、速度、剩余时间、细进度条、[取消]。
  - 实现方式：`xhr.upload.onprogress` 驱动，每个文件持有自己的 `xhr`，取消时 `xhr.abort()`。
  - 完成后该行变为 ✓ 并保留 3 秒，然后折叠进"已发送"。
  - 失败时行变红，提供 [重试]。
- 文件 `.list-row`：类型图标（按扩展名映射到 Lucide 的 file-* 图标，**不用 emoji**）、文件名（中间省略，保留扩展名）、大小和时间，尾部是 [下载] 和 [更多 ▾]（复制链接、删除）。
- 会话流消息：
  - 自己的消息靠右显示，用 `--primary-soft` 背景；别人的消息靠左，用 `--surface-2`。
  - 头像使用昵称首字母加按 hash 取色的圆形，颜色从 8 个预设里选，都要满足 4.5:1。
  - 连续 2 分钟内同一个人的消息合并，不重复显示头像。
  - 代码块保留现有的复制按钮，样式改用 `--font-mono` 和 `--surface-2`。
  - 系统消息（加入、离开）居中显示，`--fs-xs`、`--text-3`。

### 5.4 弹窗
- 9 个 `.modal-overlay` 全部改为 `<dialog class="modal">`。新建统一的 `openModal(id)` / `closeModal(id)`，基于 `dialog.showModal()` 实现，关闭后把焦点还给触发元素。
- 创建房间：字段为房间名（默认填设备名）、[需要密码] 开关、PIN（开关打开才显示；可选 4–6 位数字，`inputmode="numeric"`，`autocomplete="off"`，带显示/隐藏切换）、"保存为常用房间"复选框。
- 加入房间时如需 PIN：使用 6 格 OTP 输入框，粘贴后自动分格。出错时晃动并显示 `--danger-fg` 提示；遇到 429 时显示倒计时。
- 二维码弹窗：二维码 240px，白底加 16px 留白（扫码成功率更高），下方显示 URL，带 [复制] 按钮。
- 成员列表改为右侧抽屉（移动端从底部弹出），内容为 `.list-row`：头像、昵称、平台图标、IP，标出"你"，房主可以 [移出成员]（需服务端支持，作为可选项）。

### 5.5 工具页（JSON / 进制 / Cron）
- 统一使用"输入区 → 结果区"的左右布局；<900px 时改为上下布局。
- 工具栏放在输入区上方：主操作（格式化 / 计算）、次操作（压缩、清空、示例）。快捷键 `⌘/Ctrl+Enter` 执行，并在按钮上用 `kbd` 标注。
- 校验错误在结果区顶部用 `.badge--danger` 加行列号显示，并高亮对应行。
- 进制转换中的 5 个输入框每个都要带 label（DEC/HEX/BIN/OCT/ASCII）和尾部复制图标按钮（`--touch-min` 方形）。
- Cron：在表达式下方用自然语言实时解释（"每天 09:30"），未来 5 次执行时间以列表显示，各字段用分段输入加下拉预设。

## 6. 分阶段执行计划

每个 Phase 是一个独立 PR，可以单独回滚。每个 Phase 结束时都必须满足下面的**通用验收**：
- `npm test` 通过，`./gradlew :app:assembleDebug :app:lintDebug` 无新增 error。
- 三种上下文都能完成"建房 → 加入 → 发消息 → 发文件 → 下载"的主流程：Tauri 桌面、Android WebView/原生、访客浏览器（Chrome、Safari iOS、Firefox）。
- 在 1440px、1024px、768px、390px 四个宽度截图，与上一阶段对比，确认无布局破损。截图放在 `docs/ui-screens/phase-N/`。

### Phase 0 — 准备（0.5 天）
1. 新建 `app/src/main/assets/web/icons.svg`（Lucide 离线 sprite）和 `tokens.css`（第 3 节内容），在 `index.html` 中按 `tokens.css → style.css` 的顺序引入。
2. 引入 `stylelint`，锁定版本（`stylelint@16.x.y` 精确号，`stylelint-config-standard` 同理）。新增规则：`color-no-hex` 对 `tokens.css` 之外的文件报警（先设为 warning），`declaration-property-value-disallowed-list` 禁止 `font-size` 使用 px 字面量。
3. 记录基线截图到 `docs/ui-screens/phase-0/`。

### Phase 1 — Token 统一，视觉不变式迁移（1–1.5 天）
目标：**只替换值，不改结构**。完成后颜色会更统一，整体对比度提升。
1. 按第 3 节的映射表全局替换 `style.css` 中的旧变量，然后删除旧变量定义。
2. 把 `style.css` 中 94 处十六进制色值逐个归入最近的 token。半透明叠层统一用 `*-soft`。
3. 字号收敛到 6 档：11/12/12.5px → `--fs-xs`；13/13.5px → `--fs-sm`；14/15px → `--fs-md`；16/17/18px → `--fs-lg`；26px → `--fs-2xl`；48/54px（emoji 图标）在 Phase 2 随图标一起替换。
4. 圆角收敛：4/6 → `--r-sm`；8/10/12 → `--r-md`；16 → `--r-lg`；99px → `--r-full`。
5. 删除 `.card` 的 `box-shadow`，所有渐变按钮背景改为纯色 token。
6. 全局加上：
```css
:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: inherit; }
```
   并删除现有的 4 处 `outline: none`。
7. Android：重写 `colors.xml`（保留旧名字作为 alias 指向新色，避免一次改太多 Kotlin），新增 `values-night/colors.xml`、`dimens.xml`、`themes.xml` 中的 `TextAppearance.WenBox.*`；`themes.xml` 显式设置 `android:windowLightStatusBar=false`。

**验收**：`grep -cE '#[0-9A-Fa-f]{3,8}\b' style.css` ≤ 5（只允许 `#fff` 用于二维码白底等特例，并加注释）；第 1.2 节表格里的组合全部 ≥ 4.5:1；四个宽度截图里布局与 Phase 0 一致。

### Phase 2 — 组件层（2–3 天）
1. 在 `style.css` 新增第 4 节的 `.btn`、`.card__*`、`.input`、`.field`、`.badge`、`.list-row`、`.empty`、`.progress`、`.toast`、`.modal` 组件样式，放在文件靠前的 `/* === Components === */` 区块。
2. 把 `index.html` 中的旧按钮类逐个替换（参照下表），替换完一个就从 CSS 删掉对应旧类：

| 旧类 | 新类 |
|---|---|
| `.btn-primary-action`、`.btn-create-room`、`.btn-send-message`、`.btn-primary-mini` | `.btn.btn--primary`（mini 再加 `.btn--sm`） |
| `.btn-secondary`、`.btn-qr-action`、`.btn-download`、`.btn-reimburse`、`.btn-join-room-action` | `.btn.btn--secondary` |
| `.btn-danger-outline` | `.btn.btn--danger` |
| `.btn-copy-mini`、`.chat-code-copy-btn`、`.modal-close` | `.btn.btn--ghost.btn--icon` |

3. `app.js` 中模板字符串的内联 `style=""`（42 处）全部改为类名，比如 `style="color:#60A5FA"` 改成 `.text-primary`。新增少量工具类：`.text-2`、`.text-3`、`.mono`、`.truncate`、`.stack-{2,3,4}`（纵向 gap）、`.row`（横向 flex + gap）。
4. `index.html` 中 110 处内联样式：`margin-top: 20px` 一律删掉，交给父容器 `gap`；`display:none` 初始隐藏改为 `hidden` 属性，JS 中 `el.style.display = 'none'/'block'` 改成 `el.hidden = true/false`（全局 grep `style.display` 替换）。
5. emoji 图标全部换成 `<svg class="icon">`。导航、标题、按钮、文件类型图标 `getFileIconByExtension()`（`app.js` 约 2885 行）都改为返回图标名。聊天正文里用户自己输入的 emoji 不动。
6. 弹窗改为 `<dialog>`，实现 `openModal/closeModal`，删除旧的 overlay 点击与 Esc 处理代码。
7. Android：`Widget.WenBox.Button.*` 样式；所有触控目标 ≥ 48dp（复制按钮 24→48dp 的点击区域，图标保持 20dp，用 `minWidth/minHeight` 加 `padding` 实现）；徽标改用 `backgroundTintList`；布局里的字面量文案全部抽到 `strings.xml`（Kotlin 里的拼接改为 `getString(R.string.x, arg)`）；矢量图标从同一套 Lucide 导出。

**验收**：
- `grep -c 'style="' index.html` ≤ 10，`grep -c 'style="' app.js` ≤ 5。
- `grep -cE 'class="btn-(primary-action|secondary|copy-mini|download)'` 结果为 0。
- 键盘 Tab 能遍历所有可交互元素，焦点环可见；弹窗打开后焦点在第一个输入框，Esc 能关闭，关闭后焦点回到触发按钮。
- Android Lint 中 `HardcodedText`、`ContentDescription`、`TouchTargetSizeCheck` 无告警。

### Phase 3 — 信息架构重组（3–4 天，风险最高）
1. 实现第 5.1 节的全局骨架：顶栏、状态条，导航缩为 2 项。原 `#tab-transfer` 与 `#tab-chat` 合并为 `#view-room`；原 `#tab-json/#tab-converter/#tab-cron` 移入 `#view-tools`，用二级分段控件切换。
2. `setRoomMode(mode)`（`app.js`）改为只更新状态条和 `document.body.dataset.roomMode = mode`。三种模式的可见性由 CSS 控制：
```css
[data-room-mode="client"] .only-in-room { display: none; }
```
   这样就不再需要散落各处的 `style.display` 切换。
3. 实现第 5.3 节的两栏布局、文件面板分段、全页拖放、上传队列。上传队列放在新文件 `upload-queue.js`，以 ES 模块导出 `enqueue(file)`、`cancel(id)`，供 `app.js` 调用。拖放和"选择文件"按钮共用 `enqueue`。
4. 内联 `onclick="window.xxx(...)"` 改为事件委托：容器上监听 click，用 `data-action="join-room" data-room-id="…"` 分发。完成后可以去掉 CSP 中的 `script-src 'unsafe-inline'`（对应 BUG 文档 S7）。
5. 轮询合并成一个调度器 `scheduler.js`：`document.hidden` 时暂停，房间切换时递增 `roomRevision` 并丢弃过期响应。
6. Android：`fragment_transfer.xml` 按同样的信息架构重排。顶部是自定义 `RoomStatusView`；下面用 `TabLayout + ViewPager2` 放 [聊天 | 文件] 两页；底部导航由 4 项缩为 2 项（快传、工具），工具页内用 `MaterialButtonToggleGroup` 切换。这一步依赖 BUG 文档 A4/A5 的 ViewModel 改造。

**验收**：
- 新用户测试（找 2 位没用过的人）：不看说明，60 秒内完成"手机加入电脑房间并发送一张照片"。
- 房主视图首屏可见：房间状态、在线人数、访问地址、会话流、文件面板，不需要滚动（1440×900）。
- 上传 3 个文件时能分别看到进度，能单独取消其中一个。
- 390px 宽度下没有横向滚动，底部 Tab 不遮挡输入框（处理 `env(safe-area-inset-bottom)` 和虚拟键盘 `visualViewport`）。

### Phase 4 — 打磨（2 天）
1. **动效**：
   - 弹窗 `opacity + translateY(8px)` 过渡，时长 `--dur-2`。
   - 新消息 `--dur-2` 淡入；列表增删用 `--dur-2`。
   - 上传完成时 ✓ 图标做描边绘制动画（`--dur-3`）。
   - 所有动效都放在 `@media (prefers-reduced-motion: no-preference)` 里。现有 `style.css:1957` 的 reduce 规则保留。
2. **浅色主题**：启用 `[data-theme="light"]`，跟随 `prefers-color-scheme`，昵称菜单中提供 [跟随系统 / 深色 / 浅色]，选择存在 `localStorage`。Android 把 `values/colors.xml` 切换为浅色值。
3. **骨架屏与乐观更新**：发送消息先插入"发送中"气泡（半透明），成功后转为正常样式，失败显示 [重试]。
4. **微文案统一**：
   - 按钮用动词开头（"创建房间"，而不是"👑 创建房间 (本机成为服务端主机)"），括号里的解释移到 hint。
   - 报错说明原因和下一步（"无法连接房主，请确认两台设备在同一 Wi-Fi"）。
   - 去掉文案中的 emoji。
5. **字体渲染**：`body { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; font-feature-settings: "tnum"; }`。`tnum` 只加在数字列（文件大小、IP、时间）上。

**验收**：深色和浅色两套主题下截图检查对比度（用 axe DevTools 或 Lighthouse Accessibility ≥ 95）；开启"减少动态效果"后没有过渡动画。

## 7. 不要做的事
- 不引入 React/Vue 或 Tailwind 等框架。现有原生 JS 能满足需求，这些框架会让 Android assets 和 Tauri 包体增大，还会引入构建链。
- 不使用远程字体或 CDN 图标，应用必须能在离线局域网环境下工作。
- 不加毛玻璃（`backdrop-filter`）和大面积渐变。低端安卓 WebView 上性能差，也会削弱工具感。
- 不要在 Phase 3 之前动 `app.js` 的业务逻辑。Phase 1–2 只碰样式和模板。

## 8. 工作量与顺序汇总
| Phase | 内容 | 预计 | 依赖 |
|---|---|---|---|
| 0 | 工具链、基线截图 | 0.5d | — |
| 1 | Token 迁移 | 1–1.5d | Phase 0 |
| 2 | 组件化、图标、弹窗、a11y | 2–3d | Phase 1 |
| 3 | 信息架构重组 | 3–4d | Phase 2 + BUG 文档 Batch 1–3 |
| 4 | 动效、浅色主题、文案 | 2d | Phase 3 |
