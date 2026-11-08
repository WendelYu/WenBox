# WenBox 界面重构

基于 `origin/main` 的 v1.4.12（a665867），工作分支为 `codex/ui-redesign`。
此分支位于独立工作目录 `.worktrees/ui-redesign`，未覆盖原工作目录的未提交改动。

## 交互调整

- 流转页顶部采用完整的两行操作区：开启/关闭流转、文本剪贴板同步、收回并停止输入、复制诊断。剪贴板状态和权限问题直接可见。
- 指针与滚轮合并为一个紧凑面板，共用「保存设置」。预设先修改草稿；轮询保留草稿。只提交修改过的项，部分提交失败后保留待重试项，不重复提交已成功的设置。
- 屏幕布局中的四个方向直接保存方位，删除重复的下拉框和「精确设置」。被控端仍遵守原有角色权限，不能修改主控布局。
- 按键映射、权限细节和控制日志按需展开。
- 房间、快传、文件面板、JSON/进制/Cron、弹窗、下载记录共用同一套中性色表面、紫色主色、字号与间距。桌面侧栏在窄屏折叠，手机使用底部导航。
- 下载记录收紧尺寸，错误默认显示可操作的短提示，完整技术原因可展开或复制。图片缩略图在连续消息分组后仍保留可读尺寸。
- Android 同步深浅主题和语义配色，修复浅色主题上的固定深色表面与主按钮文字颜色，重排聊天输入区和房间操作区，保留现有 view binding ID 与类型。

## 验证

- `npm test`：58 项通过。
- `npm run lint:css`：0 错误；基础 `style.css` 仍有 13 条既有重复选择器警告。
- `scripts/check-web-ui.cjs`：完整浏览器回归通过，包括创建/加入/退出房间、消息重试、文件分享与下载、图片、弹窗、工具、平板抽屉及手机分栏。
- `scripts/check-kvm-ui.cjs`：配对、剪贴板、直接方位调整、双滑块保存、部分失败重试、草稿保护和轮询清理通过；检查 1440/1024/768/390 宽度和深浅主题。
- `scripts/check-electron-ui.cjs`：Electron 44.8.0 实际启动、HTTP 资源/CSP、沙箱、preload 和 JSON 操作通过。
- Android `assembleDebug testDebugUnitTest lintDebug` 通过；41 项原生单元测试通过，lint 无错误，保留既有警告。
- 连续分组缩略图针对桌面、390px、320px 做了尺寸和横向溢出检查。

流转测试使用原生接口模拟，不启动真实输入后端、不进行真实双机配对。当前环境没有 Android 模拟器或已连接设备，因此原生 Android 显示只完成编译与 lint，未做设备截图验证。

## 运行与预览

在本工作目录运行 `npm start` 可启动 Electron 预览。完整键鼠流转仍需项目原有 Tauri 桌面客户端，Electron 只用于共享前端和工具页预览。

Android 调试安装包：`app/build/outputs/apk/debug/app-debug.apk`。

预览图位于 `docs/ui-screens/redesign/`：`kvm-light.png`、`kvm-dark.png`、`kvm-mobile.png`、`transfer-light.png`、`tools-light.png`、`create-room.png`。流转图使用接口模拟数据，快传及弹窗图来自完整浏览器回归中的本地测试房间。
