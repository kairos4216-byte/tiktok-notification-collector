# TikTok 1TK 扩展安全审核报告

审核日期：2026-11-03。对象：用户提供的 v0.9.1 7z 压缩包（manifest 内声明版本 0.9.6）。

## 项目概况

Chrome Manifest V3 扩展，原生 JavaScript、HTML；6 个原始文件，3 个 JS（background.js 389 行、content.js 856 行、popup.js 206 行），无 package.json、lock 文件或第三方依赖清单。直接依赖及锁定间接依赖均为 0（按随附源码）。没有 Git 元数据、CI/CD 配置、自动化测试或构建脚本。Google Apps Script 服务端源码未提供，不在审核范围。

## 问题汇总

| 编号 | 类别 | 级别 | 位置（原始文件行号） | 状态 | 说明 |
|---|---|---|---|---|---|
| S01 | 代码 | Medium | background.js:200-213 | 已修复 | CAPTURE_RESULT 缺少对发送方 TikTok 域及当前采集任务的校验；扩展内其他上下文发消息时可能伪造结果。现在核对 sender.id、sender.tab、sender.url 和预期任务，保留页面按钮手动采集。 |
| S02 | 代码 | Low | popup.html:59 | 已修复 | Token 输入框使用 text，肩窥风险；改为 password。 |
| S03 | 代码 | High（取决于配置） | background.js:351-379; popup.js:171-173 | 已修复（初始请求地址） | webhookUrl 未限制目的地址；若配置被误改或本地扩展数据遭篡改，可能把 token 和通知数据发送至任意服务器。建议仅允许 HTTPS Google Apps Script 官方域名并校验 URL 路径；需确认是否使用自建转发地址。 |
| S04 | 代码 | Medium | content.js:572-590; background.js:265-279, 310-317 | 待开发者决定 | 开启诊断模式时会传输通知区域 outerHTML，必要时回退到 document.body.outerHTML；可能包含不相关的私人信息。建议只保留最小结构并脱敏，但可能降低诊断能力。 |
| S05 | 密钥 | Medium | background.js:26-31, 361-378; popup.js:12-24 | 建议关注 | Token 保存在 chrome.storage.local，发送到配置的 webhook，且 pending 中含 token；本地设备/扩展环境被攻破时可能泄露。无硬编码实际 token；更强认证方案需配合服务端。 |
| S06 | 代码 | Medium | background.js:42-50, 352-371 | 建议关注 | 失败补发队列无明确容量和保存期限，诊断快照可能持续积累。建议限量、过期清理；可能涉及丢弃未发送数据的业务取舍。 |
| S07 | 代码 | Low | manifest.json:10-28 | 建议关注 | 使用 *://*.tiktok.com/* 匹配，覆盖所有子域及 HTTP；建议确认是否可缩至 https://www.tiktok.com/*，需回归测试。 |
| S08 | 代码 | Low | background.js:381-389 | 建议关注 | 后端错误消息直接展示到 popup 的 textContent（不构成 HTML 注入），但可能透露服务端内部错误细节。建议服务端返回脱敏错误。 |

## 已修复内容

1. background.js：添加 expectedCaptureTabId，任务启动时记录预期标签页，失败时清除；后台消息入口检查扩展身份、TikTok HTTPS 来源、匹配的任务标签页；同时保留 content script 内页面按钮发起的 manual 模式。
2. popup.html：将 token 输入类型由 text 改为 password，不更改 token 的存储和发送协议。

## 检查范围与局限

- 静态检查了所有 JS、HTML、manifest，并扫描常见密钥模式；未发现硬编码的实际 API Key、私钥或密码。没有 .env 或 .gitignore；由于没有 Git 仓库，无法确认历史提交泄露情况。
- 没有第三方包或依赖清单，因此 npm audit / pnpm audit 等不适用；未对不存在的依赖编造 CVE。
- 未发现 eval、动态远程代码、innerHTML 写入、任意命令执行、SQL 查询或解压逻辑；TikTok DOM 快照 outerHTML 是读取而非 HTML 注入。
- 缺少接收端 Apps Script 源码，无法确认 token 校验、表格权限、重放保护、限流、公式注入等服务端风险。
- 未运行真实 Chrome/TikTok 集成测试；语法检查不代表功能完全通过。

## 验证

- `node --check background.js`：通过。
- `node --check content.js`：通过。
- `node --check popup.js`：通过。
- `python -m json.tool manifest.json`：通过。
- 没有原有构建/测试脚本可运行。

## 后续建议

优先确认 webhook 是否必须只支持 Google Apps Script 官方地址，以及诊断模式是否允许上传 HTML。建议随后审计 Apps Script 服务端，进行 Chrome 加载未打包扩展的手动/自动采集与补发回归。若任何 token 曾提交到公开仓库或泄露，应在接收端立即作废并重新生成；仅删除代码无效。

## 第二轮修复：官方 Apps Script URL 白名单（2026-11-03）

开发者确认只使用 Google Apps Script 官方地址。S03 已修复：

- `background.js`：新增 `isAllowedWebhookUrl`，要求 HTTPS、精确主机名 `script.google.com`、无自定义端口、无用户信息、路径严格为 `/macros/s/<部署ID>/exec`，且无查询参数或 fragment；在 `flushPending` 和 `postPayload` 两处校验。非法配置下不发送网络请求，原待补发数据保留。
- `popup.js`：在地址编辑和“立即采集”前执行同一规则；无效输入显示原生校验提示且不写入配置。
- 不修改既有合法 URL、Token、待补发队列、自动/手动模式和数据格式。

**剩余限制（待确认）**：Apps Script 正常响应可能通过 HTTP 重定向至 `script.googleusercontent.com`，当前 `fetch` 保持 `redirect: 'follow'` 以兼容官方服务。URL 白名单约束的是**初始请求目标**，并不保证浏览器后续每一跳重定向都在 Google 官方域名内；如果官方端点本身或重定向链被破坏，仍可能存在风险。要实现严格逐跳验证，需要调整请求/响应机制并做真实 Chrome + Apps Script 集成测试，未擅自修改。

验证：`node --check` 三个 JS、manifest JSON 解析通过；Node VM 测试覆盖合法地址、7 种非法地址、非法地址不触发 fetch 且保留待补发、合法地址正常发送并清队列，均通过。没有运行真实 TikTok/Google Apps Script 端到端测试。原有 S04-S08 风险状态不变。

## UI update (2026-11-03)
- Renamed extension to `TikTok通知采集` in manifest and popup.
- Added `showPageButton` preference (default true) in popup. When disabled, content script removes its floating capture button, mode badge and toast; it does not disable scheduled/background capture.
- Storage change listener applies the preference to open TikTok tabs without reloading. Re-enabling recreates the UI.
- Verified JS syntax with `node --check` and manifest JSON parsing. Live TikTok browser integration remains untested.


## V5 UI 与接收端升级（2026-11-03）
- `popup.html`/`popup.js`：Token 保持密码输入，新增显隐切换按钮。只影响当前弹窗的渲染，不会记录显示状态。
- `content.js`：悬浮采集按钮旁增加“×”按钮；隐藏时立即移除整个 UI，并将 `settings.showPageButton=false` 持久化。可在弹窗恢复；不改变采集模式。
- Google Apps Script `AppsScript接收端_v6.gs` 单独提供（不会注入扩展）：目标 sheet、评论汇总、诊断快照均使用 `Math.max(3, sheet.getLastRow()+1)` 定位新增数据；新表第 1 行是表头，第 2 行预留，不覆盖旧数据。
- 接收端模板中的 TOKEN 采用占位符，请开发者部署前设置与 Chrome 扩展一致的口令。
- JS 语法及服务端模拟功能测试通过；真实浏览器和 Apps Script 联调仍待执行。

## V6 时区设置变更（2026-11-03）

- 插件新增 `settings.timeZone`，默认 `Asia/Ho_Chi_Minh`；弹窗通过 `Intl.DateTimeFormat` 验证自定义时区。
- 新采集正常批次及诊断批次携带 IANA 时区标识；`capturedAt` 仍保存 UTC ISO 时间戳，不参与去重键计算。
- Apps Script 接收端 v7 限制时区输入长度及字符形式，并在时区无效时回退越南时区；展示时间经 `Utilities.formatDate` 转换，格式 `yyyy-MM-dd HH:mm:ss`，写入 A 列按文本格式存储，以避免 Google 表格再次按文件时区自动转换。
- 已有表格记录不修改；从第 3 行开始追加的规则不变。
- 口令不随交付文件输出；本次并未解决接收端服务端去重，断线重试可能造成重复记录。
- 本地通过扩展 JavaScript 语法检查、接收端模拟写表及时区转换测试（包括夏令时变化）；真实浏览器和 Apps Script 生产环境仍待联调。

## V6.1 接收端写入位置调整（2026-11-03）

- 仅调整 Apps Script 接收端 v8，Chrome 插件文件未改动。
- 第三行起的追加写入更改为 `insertRowsBefore(3, rows.length)`，新数据置顶，旧数据随行下移。
- 加入 `LockService.getScriptLock()`，锁内完成目标、评论和诊断工作表的插行与写入，降低并发互相覆盖风险。
- 保留前两行、时区格式、历史数据及评论翻译/分类列；没有增加服务端去重。
- 使用本地 Apps Script mock 覆盖测试；真实 Google 表格部署测试待用户验证。

## V1.0 正式版时区统一（2026-11-03）

- 仅 Chrome 插件配置写入时区，默认 `Asia/Ho_Chi_Minh`；后台将 UTC 采集时间格式化为 `displayCapturedAt` 后发送。
- 接收端移除 `DEFAULT_TIME_ZONE` 及 `Utilities.formatDate`，不接受也不解释时区选择，仅写入显示时间文本。
- 为避免旧待补发队列时间错乱，后台发送前会根据旧批次保存的时区生成 `displayCapturedAt`；不改动原始 `capturedAt`。
- 兼容说明：旧版本插件未发送 `displayCapturedAt` 时，接收端按原样写入 UTC ISO 时间；建议插件和脚本同时升级。
- 本条是对历史 V6 安全记录的**更新**，历史段落仅供参考，不代表当前时区行为。
