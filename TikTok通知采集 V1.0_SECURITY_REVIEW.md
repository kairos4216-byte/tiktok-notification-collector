# TikTok通知采集 V1.0.1 安全审核报告

**日期：** 2026-11-03  
**审核对象：** 用户提供的 TikTok通知采集 V1.0.0 浏览器扩展（`background.js`、`content.js`、`popup.js`、`popup.html`、`manifest.json`、`icon.png`）与 `AppsScript接收端_V1.0.gs`。  
**交付版本：** V1.0.1，安全加固版；Chrome 扩展版本号 `1.0.1`。  
**审核性质：** 对提供源码的静态审计及本地模拟测试；不构成外部认证，也不宣称绝对安全。

## 1. 项目概况

| 项目 | 结果 |
| --- | --- |
| 客户端 | Chrome Manifest V3，原生 JavaScript / HTML |
| 服务端 | Google Apps Script（V8 JavaScript 运行时） |
| 数据目的地 | Google Sheets，指定账号工作表 + 评论收集 + 匿名结构诊断 |
| 第三方包 | **0 个**；没有 `package.json`、lock 文件或其他第三方依赖清单；无可运行的 `npm audit` |
| 构建/CI | 不需要构建；随包提供 Node.js 本地模拟测试，未发现 CI 配置 |
| 审核边界 | 已审核提供的源码；不包含 TikTok 或 Google 基础设施、部署权限、公开 GitHub 历史提交、实际生产数据 |

## 2. 风险与修复汇总

| 编号 | 类别 | 原级别 | 位置（加固版） | 现状 |
| --- | --- | --- | --- | --- |
| S01 | 代码 | High | `AppsScript接收端_V1.0.1.gs`：`safeSheetText()` / `insertRowsAtThird()` | **已修复（代码及模拟测试）**：公式字符安全转义、写入范围设为文本 |
| S02 | 代码 | High | `AppsScript接收端_V1.0.1.gs`：`authorizedSpreadsheetIds()`、`resolveTargetSpreadsheet()` | **已修复（代码及模拟测试）**：未列入授权清单的目标表格拒绝写入 |
| S03 | 代码 | Medium | `AppsScript接收端_V1.0.1.gs`：`noticeKey()`、`keysFromAccountSheet()`、`keysFromCommentSheet()` | **已降低风险**：接收端按现有记录去重；无独立 ID 时有误判边界 |
| S04 | 代码/隐私 | Medium | `content.js`：`diagnosticSnapshot()`、`background.js`：`safeDiagnostic()` | **已修复新采集快照**：仅上传结构性元数据，不上传 outerHTML / 用户内容；补发旧 HTML 时脱敏 |
| S05 | 密钥 | Medium | `background.js`：`setAccessLevel()`、`getPending()`、`flushPending()` | **已降低风险**：Chrome 内容脚本无法直接读取本地 Token / 队列；队列去除 Token，发送时再补入；Token 仍在扩展本地持久化 |
| S06 | 代码 | Medium | `background.js`：`enqueuePending()`、`withPendingMutex()` | **已降低风险**：队列容量上限、串行发送与保存、25 秒网络超时和本地指纹缓存上限，不静默丢弃已有待补发数据 |
| S07 | 代码 | Medium | `background.js`：`isTrustedTikTokSender()`、`captureTask` / `runId`，`content.js`：页面启动入口 | **已修复（本地测试）**：主框架 sender 验证、任务 ID 与标签页一致性验证，禁止无任务的 CAPTURE_RESULT |
| S08 | 代码 | Low | `manifest.json`、`background.js`、`popup.js` | **已收紧**：仅适配 HTTPS `www.tiktok.com`；保留 Apps Script 与重定向目标权限 |
| S09 | 代码 | Medium | `AppsScript接收端_V1.0.1.gs`：`validateRequest()`、`doPost()` | **已降低风险**：按 Token、格式、允许分类、URL 域、条数、正文大小限制 |
| S10 | 代码 | Low | `AppsScript接收端_V1.0.1.gs`：`catch` 分支 | **已修复**：服务器不再将完整异常栈/表格信息直接返回调用者 |
| S11 | 代码 | Low | `content.js` 悬浮采集入口 / `background.js` 成功状态通知 | **已修复**：服务器确认成功后才显示“已发送”，失败显示错误或待补发 |
| S12 | 密钥/配置 | Medium | `AppsScript接收端_V1.0.1.gs`：`readConfig()` | **已修复配置硬编码**：Token、默认 ID、授权表格列表均从 Script Properties 读取 |
| R01 | 功能/完整性 | Medium | 服务端去重键生成 | **剩余风险**：缺失唯一评论 ID、缺失关键字段时无法绝对去重或区分相同文字独立评论 |
| R02 | 运行环境 | Medium | Apps Script / Google Sheets | **剩余风险**：执行配额、扫描耗时及跨表非事务性；真实环境待联调 |
| R03 | 密钥/环境 | Medium | Chrome 本地设置、公开源代码历史 | **剩余风险**：本机恶意软件或已泄露 Token 仍可能导致账户数据被篡改，必须自行轮换 |
| R04 | 网络/信任 | Low | `background.js`：`fetch()` | **剩余风险**：Google Apps Script 官方响应重定向仍使用 `redirect: 'follow'`，没有验证所有中间跳转 |

## 3. 具体修复方法与安全影响

1. **公式注入：** 原代码直接 `setValues(rows)`；新代码将每个写入字段按文本格式写入，并把以 `=` 开头的字符串加单引号前缀。防止外部评论或诊断数据作为公式运行。历史已写入单元格不自动修改。
2. **服务端去重：** 使用现有账号表、评论收集表的真实数据生成指纹，脚本锁内先检查再插入；使用 `comment_id` 时优先比较该 ID，否则比较账号、互动者、视频与评论内容。新批次从第 3 行插入，原始第 1、2 行与人工填写的翻译/分类不会被覆盖。
3. **表格写入授权：** 未指定目标时只能使用脚本属性中的 `DEFAULT_SPREADSHEET_ID`；指定表格 ID 必须与该 ID 相同或在 `ALLOWED_SPREADSHEET_IDS` 中列明。错误 gid、指向保留的评论/诊断工作表，也会被拒绝。
4. **Token：** 要求脚本属性中的 `TOKEN` 至少 24 字符，建议随机 32 字符以上。Chrome 内容脚本只通过经过验证的消息访问非敏感界面状态；不直接访问本地存储。发送时才将 Token 合入请求正文。若旧 Token 已泄露应作废并轮换。
5. **诊断隐私：** 诊断模式现在只有布尔状态、选择器是否存在、滚动数量等匿名结构信息，不再发送页面 HTML、账户候选名或评论原文；旧补发批次中的 HTML 快照发送前改成脱敏提示。
6. **消息验证：** 内容脚本必须位于 HTTPS 的 `www.tiktok.com` 顶层框架，消息发送方扩展 ID、标签页及服务端生成的一次性 `runId` 必须匹配。手动悬浮按钮仅通知后台发起任务。
7. **队列容量：** 最多 100 批且估计不超过 5 MiB；容量满时不清除既有数据，会拒绝新批次并显示错误；这意味着需要用户及时修复接收端并重新采集被拒绝的批次。
8. **权限：** 将 TikTok 匹配范围从所有协议/子域收紧为 `https://www.tiktok.com/*`。这是一个小的兼容性取舍：如果 TikTok 改用其他子域，需后续评估并调整。
9. **输入限制：** 接收端拒绝超大请求、异常分类、非官方 TikTok 链接及不合理字段长度，避免被滥用；超过上限的任务不会无提示截断写入。

## 4. 本地验证结果

| 测试 | 结果 |
| --- | --- |
| JavaScript 三个扩展源码 `node --check` | 通过 |
| 接收端 `.gs` 通过 Node 标准输入语法检查 | 通过 |
| `manifest.json` 解析 | 通过 |
| `tests/test_receiver.js`：Token、表格白名单、第三行插入、评论双写、公式转义、幂等重试、跨账号隔离、局部失败补写、超限拒绝 | 通过（模拟） |
| `tests/test_extension.js`：存储访问限制、可信消息、任务 ID、后端确认才标记发送成功、诊断隐私与悬浮按钮通信 | 通过（模拟） |
| npm/pnpm 等依赖审计 | 不适用（无第三方依赖清单） |
| 真实 Chrome + TikTok + Apps Script + Google Sheets 联调 | **未执行／待用户验证** |
| GitHub 全部历史提交及在线公开资产泄露检测 | **未执行／待确认** |

## 5. 部署和后续注意事项

- 见 [`README.md`](README.md) 的完整部署流程。**脚本属性配置是强制步骤**：`TOKEN`，以及根据实际目标填写 `DEFAULT_SPREADSHEET_ID`、`ALLOWED_SPREADSHEET_IDS`。
- 扩展版本号增加到 `1.0.1`，因为本次实际修改了安全与消息通信行为；主版本仍属于 V1.0 系列。更新 Chrome 扩展和 Apps Script 后必须验证手动/自动采集与补发。
- 不要把实际 Token、个人表格 ID 或含个人数据的报错/日志上传公共 GitHub。若此前已提交或在公开场所展示，重新生成 Token、在接收端和插件同时更换；删除代码不能让已泄露密钥失效。
- 若日后增长到数十万条，请考虑在接收端维护独立去重索引或切换至有事务与唯一索引的数据库，避免全表扫描性能瓶颈。

## 6. 官方安全依据

- [Google Apps Script Range.setValues 文档](https://developers.google.com/apps-script/reference/spreadsheet/range)：以 `=` 开头的字符串可能被视为公式。
- [Google Apps Script Script Properties](https://developers.google.com/apps-script/guides/properties)：应用级配置。
- [Google Apps Script LockService](https://developers.google.com/apps-script/reference/lock/lock-service)：脚本锁。
- [Chrome Extensions Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)：`chrome.storage.local.setAccessLevel()` 及本地存储访问约束。

**最终结论：** 本版本已经修复或显著降低本轮审计发现的可安全修复问题；但无法证明“零漏洞”“百分之百不重复”或“所有浏览器/Google 表格环境均正常”。建议先在测试环境部署验证，通过后再公开作为稳定版。
