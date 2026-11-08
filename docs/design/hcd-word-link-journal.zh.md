# Word 链接前一节：签名日志与停止房间恢复

后续更新：活动侧车提交、停写/替换及已安装回执核对已经接通，见[活动链接与最新证据](hcd-word-active-link.zh.md)。下文保留本批停止协调器的原验收范围；未完成链接的停止恢复 HTTP 和普通恢复页也已接通，见[最新恢复与验证](hcd-word-link-recovery.zh.md)；正常创建确认、原窗口桥接和历史草稿合并仍待继续。

2026-10-30。接续[原生事务与签名回执](hcd-word-link-transactions.zh.md)。本批接通共享签名链中的链接准备、确认、提升和停止协调器恢复，并验证恢复后普通协作房间续存；**没有开放活动链接提交、在线房间替换或正常链接确认 UI**。管理平台与实际提醒仍后置。

## 日志与状态保护

链接使用显式版本 5 的私有 `WordSaveCapsule`：`pendingLink` 与 `linkAcknowledgement` 必须恰有一个，不能混入普通 checkpoint、页面或独立区域的待处理事务。请求完整保留原编号、作者代次、候选布局及原生预检摘要。新读取器需明确允许链接；旧读取器拒绝版本 5，不自动丢弃或降级。

准备、确认和提升只能经过各自的方法。普通 `save` 无法制造已确认状态或清掉未知请求；签名链加载也逐条检查版本、父摘要和转换。准备时检查本链是否已使用相同拓扑编号；取消扫描包含已准备及已确认链接。多窗口/进程争用仍由不可覆盖的文件 link/CAS 决定，不能覆盖另一请求。

确认时从签名父状态创建隔离 Y.Doc，验证原生前后投影只有指定绑定变化、正文/批注/区域目录不变，再只更新布局 hash。作者、引用台账、上传任务和恢复决定保持。最终原生回执绑定生成的确切 Yjs 字节、请求、候选和父日志 tip。存储的初始状态是确认时的真实副本；草稿和原独立区域均保留，调用方原文档不被原位改写。

原生签名按 Rust serde 的实际字段顺序和 BTreeMap 作者顺序核验，使用独立协作链接摘要域。有效签名还必须匹配文档、端点摘要、epoch、coordinator、作者、原/目标版本、原请求、root、布局、预检和初始字节；单纯拥有一个签名不能授权房间替换。

## 停止协调器恢复

`submitPreparedWordLink` / `recoverCommittedWordLink` 要求调用方保持停止房间的排他约束，并提供当前原生 lease 和原发起人的实时授权。函数不会在活动房间中重载或替换共享状态；调用方必须串行化日志操作。

- 只有固定基准仍是 head，才发送同一个已经持久准备的原请求。成功响应丢失时保留请求；后续先查历史，不更换编号或自动重发。
- 已提交时，读取固定基准/目标记录及原生投影，核对本地基线、请求、来源、内容及签名，再写确认。原生登记响应丢失时，确认记录仍保留；重试登记同一完整链，不再次提交。
- head 已超过目标时，可确认原链接版本并返回 `historical: true`，保留签名草稿，但**禁止提升为当前可编辑基线**。历史核对不是完成了三方合并；该状态的比较、重基准与正常 UI 仍需继续。
- head 等于确认目标时，可经专用路径提升回普通模型 3。侧车 `/2` 读取器现能核验包含版本 5 的历史并打开已提升的模型 3；仍有版本 5 待处理/确认状态时，原有房间准入继续拒绝直接编辑。

没有新增普通成员可直接调用的停止链接恢复 HTTP 入口，也没有绕过已有成员停写或签名准备去开放提交按钮。

## 实际验证

前端完整 **1926 项**、新增日志/恢复专项 **12 项**及 TypeScript、standalone/embed 构建通过。既有页面、独立区域及签名日志的首轮相关专项共 44 项通过；它们与全量有重叠，不相加计数。第三方 `use client` 与包体积提示保留。

普通成功分支使用真实原生、侧车及不同 Node 进程：

1. 进程 A 在停止协调器中保留未提交正文草稿，持久准备链接；TCP 代理在真实原生成功提交 r2 后断开响应。只调用一次链接提交，日志仍是版本 5 的原请求。
2. A 退出并释放 lease；隔离父进程显式重启自己启动的原生服务，保持同一文档和密钥。
3. 进程 B 重新获取 owner，从签名日志核对原生 r2 回执，不重提链接。保留的正文草稿经普通 `WordSaveCoordinator` 保存至 r3。
4. 实际侧车随后加载这条含版本 5 历史的已提升日志；两名写成员和一名只读成员通过三个**新** Socket 会话加入，继续共享正文并保存到 r4/r5。
5. r2/r3/r5 的语义 DOCX 回读核对草稿出现时机、双方新文字及原图片字节；HCDZ 解包逐版本比较 r1–r5，区域目录与资源保留、规范和离线校验通过。

另一个独立样本同样注入成功提交后断响应及原生重启，再通过 CLI 将原文档还原为新的 r3。恢复器确认原链接 r2、保留私有签名草稿并拒绝提升；规范 r3 不变。r2/r3 DOCX 与 r1–r3 HCDZ 回读确认私有草稿未被偷偷发布，链接和还原的绑定分别正确。

完整源码/二进制摘要、命令、文件及范围见[验证清单](../assets/hcd-word-link-journal-2026-10-30/validation.json)。本批没有 Rust 修改，使用已有原生二进制完成真实 HTTP 验证，未重跑 Rust 全工作区或 Clippy。

## 复现和剩余工作

```bash
python3 scripts/hcd-word-layout-browser.py --clean --story-source --allow-native-restart
# 使用打印的隔离 ROOT；OUT 应为新的证据目录。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-link-journal.mts ROOT OUT commit-drop
# 向该自有 ROOT/restart-native 写入 restart，等待 native-restarted.json 确认。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-link-journal.mts ROOT OUT recover-save
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-link-journal-peers.mts ROOT OUT
python3 scripts/hcd-word-link-journal-files.py ROOT OUT
```

原生重启开关默认关闭，仅让测试父进程接受自己目录中的标记，不是应用 HTTP 能力。历史分支需另起隔离夹具，在首个进程结束及原生重启后，使用 CLI 从 head r2 还原 r1 为 r3，再运行 `historical-check` 与 `hcd-word-link-journal-historical-files.py`。完成后停止自有父进程、确认子进程终止，再清理私有根；令牌、密钥和完整私有签名日志不归档。

仍需把链接接入实际侧车的活动阶段编排、在线停写/替换及客户端桥接，补浏览器设备原请求、明确影响的确认和取消交互。历史基线草稿的完整比较/合并、结构自身撤销、复杂文件任务、原稿混合导出、真实 IME/物理设备/Office 与生产多实例均未由本批证明；其余格式继续见[完整能力矩阵](hcd-current-capabilities.zh.md)。
