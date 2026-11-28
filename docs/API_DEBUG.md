# 接口调试

入口：桌面 WenBox → 工具 → 接口调试。

## 双栏 API Studio（项目目录 / JAR 自动扫描与智能模拟）

采用左目录、右调试的双栏工作台设计（已移除旧版手动粘贴 VTO 面板）：

- **自动读取接口**：在左侧边栏点击“选择项目目录”或“选择 JAR / 文件”（浏览器端支持直接拖入文件），本地离线扫描 Java / Spring Boot 项目目录、普通 `.jar`、Spring Boot Fat JAR（自动解析 `BOOT-INF/classes` 与 `BOOT-INF/lib/*.jar` 内关联 DTO/VO/Enum 字节码）、单个 `.java` 控制器源码以及 OpenAPI 3.x / Swagger 2.0 JSON。
- **自动填参与行内路径编辑**：识别 `@RestController`、`@Controller`、`@FeignClient`、`@RequestMapping`、`@GetMapping`/`@PostMapping`/`@PutMapping`/`@DeleteMapping`/`@PatchMapping` 与 `@Tag`/`@Operation`；自动读取 `application.yml`/`properties` 的 `server.port` 与 `context-path` 预填 Base URL；点击左侧接口目录即可一键填入 URL、`@PathVariable`（支持在激活接口栏直接行内编辑并实时同步 URL）、`@RequestParam`（含查询 DTO 展开）、`@RequestHeader` 与 `@RequestBody` JSON。
- **智能模拟与 cURL**：支持在“智能模拟”与“空默认值”间切换及一键“重新模拟”，优先读取 `@Schema(example=...)`、`defaultValue`、字段初值、枚举常量及 `@Min/@Max/@Size/@Email` 约束，并结合字段名与类型语义填充测试参数；同时支持在 URL 栏直接粘贴 `curl` 命令以及一键“复制 cURL”。

## 请求与响应

支持 GET、POST、PUT、PATCH、DELETE、HEAD、OPTIONS；Query、Headers、JSON/表单编码/文本 Body、Bearer Token，以及每行 name=value 的变量。使用 {{name}} 引用变量。表单 Body 使用 application/x-www-form-urlencoded 文本，暂不支持 multipart 文件上传。

点击“发送请求”或 Ctrl/Cmd + Enter，显示状态码、耗时、大小、响应头及正文；4xx/5xx 的正文同样保留。会话历史最多 20 条，关闭页面即清除，不写入磁盘。暂不提供 Postman Collection、持久化环境、脚本执行或团队协作。

Tauri 与 Electron 使用独立本机 HTTP/HTTPS 通道，不受浏览器 CORS 限制，不向房间成员开放代理。HTTPS 保留证书校验；不自动跟随重定向；不读取浏览器 Cookie。超时 1–120 秒，请求体最大 1 MiB，响应最多显示 4 MiB。网页版采用 fetch，目标需允许 CORS。Android 原生工具面板本次未新增入口。

cURL 支持常见 -X/-H/-d/--data-raw/--data-binary/--json/-G/-I/-u/-b；不执行 shell，不读取 @文件，不导入管道、命令替换或未知选项。自动管理的 Host、Content-Length 等会提示移除。

## 开源调研与选择（2026-11-16）

- [Hoppscotch](https://github.com/hoppscotch/hoppscotch/releases)：MIT，参考请求工作台交互。
- [Bruno](https://github.com/usebruno/bruno/releases)：MIT，参考本地请求编辑与 [cURL 导入](https://blog.usebruno.com/curl-to-gui-import-curl-commands)。两者均是完整客户端，不直接嵌入现有无框架页面。
- [EasyYapi](https://github.com/tangcent/easy-yapi)：已有 Java/Kotlin 字段生成 JSON 的相近能力；依赖 IntelliJ PSI，AGPL-3.0，本实现不复制其源码。
- 实际复用 [shell-quote](https://github.com/ljharb/shell-quote) 1.12.0（MIT）解析 cURL token（构建生成 `api-debug.js` 与 `api-debug.js.LICENSES.txt`）。

解析器本地运行，无在线转换服务。现有 Electron / electron-builder 构建依赖的审计告警未在本功能中跨版本升级。

## 开发验证

- npm ci --ignore-scripts，然后 npm run build:api-tools（修改 src-tools 后重新构建）。
- npm test
- cargo test --manifest-path src-tauri/Cargo.toml
- PLAYWRIGHT_MODULE 指向 Playwright，BROWSER_EXECUTABLE 可指定 Chrome；运行 node scripts/check-api-tools.cjs。

UI 测试使用隔离本机 fixture，覆盖双栏欢迎页、Spring Boot 项目扫描与过滤、行内路径参数联动、智能模拟与空值切换、重新模拟、手动发送真实 HTTP 422、cURL 导入、历史、工具切换、浅深色及窄屏。原生测试覆盖窗口来源校验（`tauri://localhost` / `tauri.localhost`）、请求校验、422 正文、重定向、响应限额、超时及拒绝不受信任 HTTPS 证书。
