# 停房页面与页眉页脚原请求的设备恢复

2026-10-30。接续[停房草稿设备记录](hcd-word-stopped-device.zh.md)，将原 `wordLayoutAttempt.ts` 的标签页编号替换为 IndexedDB 完整原请求。各格式完整创作、Word 排版、字体、国际化、真实 AI、多实例和其他原目标仍保持开放；管理平台与提醒后置。

## 实现与约束

- 页面操作保存原 revision、reviewHash、transactionId、完整 edits 和原节序号；创建区域保存原 sectionId、页眉/页脚类型、默认/首页/偶数页、reviewHash、原版本和节序号。原节序号用于解释当时选择，服务端仍按稳定身份和版本校验。
- 恢复 resume 和取消分别追加独立动作，不能用它们覆盖原创建参数。正文草稿日志和结构日志按成员、文档、端点、协议及 epoch 隔离，均不保存 token。
- 初次发送前必须 await 完整请求的 IndexedDB 提交；保存成功后也先核对确切编号及版本，再 CAS 移除该记录。存储失败、错误回执、作用域变化、另一窗口修改记录或未知结果都不能清掉原请求。
- 同源结构请求通过同一 CAS 队列协调，最多 16 条、总量 8 MiB，单条 1 MiB、最多 16 个动作；单个页面 HTTP 请求仍限 270 KiB。原始页面/区域创建只能是首个动作，后续恢复或取消不能改成另一种创建请求或换参数。
- 旧标签页 key 保持可迁移。有效编号只生成 `legacy` 动作，不补造旧版缺失的参数；不同原编号排队保留，提交成功且旧值未变化才移除旧值。损坏记录可下载，但不能用于重试或自行丢弃。
- 兼容恢复页显示原动作、原版本、节、页面类型或页面字段差异，支持下载。重试必须单独确认，并绑定确认时的原记录；记录已变化则拒绝。取消未知时重试取消，不切回原 apply。关闭重开不会自动发送。
- 已提交的页面/区域操作仍由原生签名回执和私有日志确认；本机记录不是服务端授权。UI 检查编号、种类及原基准，拒绝用同编号的错误种类/版本冒充确认。

结构与正文草稿日志并非一个跨数据库原子事务。新操作先复查另一日志；已知未知请求会阻止新的内容/结构变更。同源不同窗口在不同日志中同时准备的竞态仍需服务端排他和版本检查，不能宣称已具备跨类型原子预留。取消及现有签名请求的 resume 不被另一未知本机队列互相阻断，避免准备状态需要先恢复才能取消另一请求时死锁；服务端仍逐次验证原请求、成员及租约。这条交错的门禁有专项测试，本批没有浏览器注入两类日志同时准备的竞态。

## 浏览器、服务与文件验收

普通 `EmbeddedHcdEditor` 在布局房间停用时经过实际鉴权/协商进入兼容页；没有直接挂载内部恢复组件。夹具为自有本机原生服务、sidecar、故障代理及合成签名草稿，浏览器交互使用 CUA。

1. **页面成功丢响应**：第一节 Letter 改为 A4，核对三项差异后提交。服务端成功 r2，代理丢成功响应并阻止浏览器自行重发。完整请求实际下载；关闭原标签页并重启 sidecar。
2. **重开核对原页面请求**：新标签页显示第一节及原三项修改，下载与前一份逐字节一致，没有自动重发。手动检查签名结果，确认原 r2 并移除记录。
3. **未发送区域请求重试**：第二节偶数页创建独立空白页脚，预览并明确确认。代理在转发前阻止 apply；同成员第二窗口看到相同编号、原版本及节/页脚/偶数页选择。关闭两个窗口并第二次重启，原下载逐字节一致，未自动重发。经单独确认后用完全相同的原 body/编号重试，创建一次 r3，显示完成反馈。
4. **取消成功丢响应与续接**：第一节偶数页的另一个创建请求在转发前被阻止。取消先落盘，再由服务端封存；成功响应被丢弃，浏览器重试被代理阻止。关闭窗口、第三次重启后，原请求及取消历史仍可下载且字节相同。用户明确重试取消后清除记录，版本仍 r3。
5. **迟到原请求拒绝**：用实际下载件的原 apply body 重放，被服务端以 `word-topology-cancelled` 拒绝，仍 r3，没有第一节的新页脚。
6. **协作草稿保留**：上述页面、创建、取消及三次重启后，原 Bob 正文草稿仍可比较，明确保存为 r4；规范作者仍为 Bob，没有被发起保存的 Alice 替代。
7. **文件验证**：实际 DOCX r2/r3/r4 的纸张、页脚关系/部件及正文回读通过；原图片字节保留。HCDZ 打包/解包后 r1–r4 投影精确一致且校验通过，DOCX 再导入保留新页脚和正文。取消编号未出现在历史提交中。

证据：[网络、下载、截图与回读](../assets/hcd-word-stopped-topology-device-2026-10-30/validation.json)。同源第二窗口证明已准备记录的通知与门禁，不等于真实设备崩溃、不同物理设备或生产多实例。

## 可复现命令

```bash
cd examples/hdoc/editor
node --import tsx --test src/wordLayoutAttempt.test.ts src/wordStoppedRecoveryGate.test.ts src/wordStoppedLayoutClient.test.ts src/wordStoppedStoryClient.test.ts src/wordTopologyRecoveryClient.test.ts src/wordStoppedDraftRecoveryClient.test.ts
node --import tsx --test --test-concurrency=4 src/*.test.ts
npm run build
```

相关专项 29 项、完整前端 1987 项及含 TypeScript 的独立/嵌入构建的最终结果记录在 validation.json。构建仍有既有的大包和第三方 `use client` 提示。初次类型检查发现旧同步测试接口及联合类型分支尚未更新，已修正后复验；后续门禁枚举漏接 legacy 的类型错误也已补上明确拒绝并复验。没有将这些失败计为通过。

从仓库根启动新隔离样本：

```bash
python3 scripts/hcd-word-layout-browser.py --story-source --stopped --draft-only --allow-restart --topology-ui-proxy
```

只操作该样本自己的目录：`topology-ui-proxy-control` 支持 `drop-success-block-retry`、`block-submit`；只读 inspect/preview/details 不被这些控制阻断。`restart-sidecar` 文件触发侧车重启。完成实际浏览器流程并保留下载件后，运行：

```bash
python3 scripts/hcd-word-stopped-topology-device-files.py <隔离样本目录> docs/assets/hcd-word-stopped-topology-device-2026-10-30
```

该脚本核对已发生的交互和实际文件，不制造浏览器步骤。React 复核沿用 `vercel:react-best-practices`，关注异步准备、卸载、订阅、原参数快照、确认过期和迟到回执；本批未改 Rust 或重建原生二进制，未重跑 Rust 工作区/Clippy，原有未通过项继续开放。

## 仍然开放

- 本批实际浏览器验证已提交的页面检查、未提交区域的原请求重试和取消续接；服务器已 prepared 但未 promoted 时的 resume 新接线，以及旧标签页 migration 的浏览器故障注入仍需独立验收。相关动作持久化、隔离、回执与门禁有专项测试，不替代该浏览器路径。
- 原节/页面字段的结构撤销、复杂资源复制、历史私有草稿比较合并、正文分段、精确分页和连续排版、页码和自动目录仍未完成。
- 下载文件是请求证据，不是包含正文/资源的完整文档或自动跨设备执行凭据。旧编号缺参数、旧 epoch、损坏队列及服务器无法查询的任意历史编号仍需保留和另行处理。
- IndexedDB 配额、浏览器清理、真实断电/设备故障、不同来源或物理设备、远端存储与生产多实例均未由本机样本证明。PDF/PPT/Excel、字体/国际化、真实 AI 和完整原目标继续。
