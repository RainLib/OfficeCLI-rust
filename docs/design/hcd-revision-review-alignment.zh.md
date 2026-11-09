# 跨入口历史审阅/还原对齐（HCD Revision Review Alignment）

本文是 `hcd-overall-audit-2026-10-30.zh.md` 第 4 节 P0 项"跨入口历史审阅/还原对齐"的代码级落点分析与分阶段实施计划。`RevisionReview`/`RestoreRevisionDialog` 目前只接在普通语义入口；区域 Word、固定版式、工作簿三个入口有 revision 历史与 CAS 保存，但没有等价的"看历史版本 → 比较 → 还原"闭环。阶段 0（组件契约去 `Projection` 化）已随本 PR（#108）落地，本文同时记录其实际改动面。

## 1 现状：语义入口的完整链路

审阅侧（`examples/hdoc/editor/src/App.tsx`）：

1. `showRevision`（App.tsx:658-672）并发拉取 `/editor?revision=N` 与 `/editor?revision=head` 两份 `Projection`，构造选择并打开右栏。
2. `RevisionReview` 旧契约 `RevisionSelection={before:Projection;after:Projection}`（原 RevisionReview.tsx:8），diff 模式在组件内调用 `revisionDifferences`（revisionDiff.ts:15，类型锁定 schema.ts:158 的 `Projection/Block`）；文档模式复用 `RevisionDocument`。
3. `RestoreRevisionDialog`（原 RestoreRevisionDialog.tsx:9）为了显示"改动条数"再算一遍全量 `revisionDifferences` —— 组件对 `Projection` 的全部依赖只有这一个数字。

还原侧（协调式事务）：

1. `restoreHistorical`（App.tsx:675-691）先 `save()` 取 head，再核对 `revisionSelection.comparedWith`（不一致即 `restoreComparisonChanged`），生成 `RestoreSubmission{requestId,target,expectedRevision,fromEpoch}`，经 `submitRestore` 发给 sidecar。
2. sidecar 路由 `collaboration/restore/(\d+)`（sidecar.ts:235）：`coordinatedRestore!==true → 409`、协议非 `hcd-semantic-blocks/3|hcd-semantic-inline/1 → 403`（sidecar.ts:440-441），随后 `SidecarRestore` 走 quiesce/freeze/prepare/submit/release/committed 的 journal 事务（sidecarRestore.ts）。
3. 原生端点 `POST /collaboration/restore/{revision}`（hdoc_server.rs:261-263 → hdoc_restore.rs）：协调器版本、身份、`remote.is_none()`（否则 501，hdoc_restore.rs:65-70）、协议白名单 `Structure3|Inline1`（hdoc_restore.rs:72-77）、Inline1 额外 model ack 头（hdoc_restore.rs:79-93）、pending/receipt 双文件 journal、epoch 轮转与 `restore_revision`。
4. 直接还原端点 `POST /restore/{revision}`（hdoc_server.rs:5045-5072）要求 `collaboration_metadata.protocol == hcd-default/1`，否则 426（hdoc_server.rs:5052-5056）；成功后 `publish_mutation + reset_collaboration`（hdoc_server.rs:5069-5070）。
5. `/auth` 返回 `coordinatedRestore = remote.is_none()`（hdoc_server.rs:1046）。

旁证：区域侧的恢复评审已经绕过 Projection 类型 —— `wordRecoveryReview.ts:26` 与 `wordStoppedDraftReview.ts:75` 都用 `{blocks} as Projection` 强转调用 `revisionDifferences`，说明引擎签名已成为复用障碍。

## 2 还原能力矩阵

| 入口 | 房间/协议 | 历史读取 | 直接还原 `POST /restore/{r}` | 协调还原 `collaboration/restore/{r}` |
|---|---|---|---|---|
| 普通语义 | `hcd-semantic-blocks/3`、`hcd-semantic-inline/1`（Hocuspocus 房间） | `/editor?revision=N` → `Projection` | 426（非 Default1） | 已支持（journal + epoch） |
| 区域 Word | `hcd-word-regions/1|2`（拓扑/暂停/分阶段许可） | 房间再投影 `/editor?revision=N`（sidecar.ts:231 `wordRoomProjectionHttp`） | 426 | 400 `unsupported restore protocol`（hdoc_restore.rs:72-77）+ sidecar 403 |
| 固定版式 | presence 通道；fixed 房间连接强制只读（sidecar.ts:179,212），且被协调还原显式排除（sidecar.ts:781 `selected.fixed` 分支 → 409） | manifest + index page + `createPageLoader` 不可变分片（RevisionDocument.tsx:15-17，与格式无关） | 可用（文档 metadata 保持 `hcd-default/1`，需在阶段 1 实测确认） | 不适用 |
| 工作簿 | 无 WebSocket（编辑器内 collab/provider 引用为 0），`watchRevisions` SSE（WorkbookEditor.tsx:359）+ CAS 批量保存（`batchReady`，WorkbookEditor.tsx:115） | 分片 JSON（chunk/revision 可读） | 可用（同上待实测） | 不适用 |

`RevisionDocument` 已同时覆盖三种渲染：flow（区域 Word 经 `wordRegionVersion(manifest)`，RevisionDocument.tsx:1,17）、固定页（`pageDocument`）、其余格式分片，是天然的历史视图底座。

## 3 各入口差距

- **区域 Word（RegionalWordEditor.tsx，425 行）**：无历史列表/审阅 UI；只有个人 undo（`SemanticHistory`）。客户端可复用 `RevisionDocument` + `wordRecoveryReview` 的 region 粒度 diff；**阻塞在服务端**：hdoc_restore.rs 协议白名单、Inline1 式 model ack、sidecar RestoreProtocol 联合（restoreJournal.ts:4 硬编码两值）、scoped 房间跨 epoch 再投影。
- **固定版式（FixedLayoutEditor.tsx，567 行）**：有 revision/updates 状态与 `exportBlocked()`（:113，草稿/上传/保存/历史忙等完整门闩，可直接充当还原前置门），无历史列表与审阅；缺一个"分片/节点粒度 → `RevisionChangeRow`"的 diff 适配器和走直接端点的传输层。
- **工作簿（WorkbookEditor.tsx，474 行）**：`watchRevisions` 只用于远端刷新（`adapter.applyRemoteText/refreshDrafts`）；单元格模型非 `Projection`，需要 sheet/chunk 粒度的比较器；还原同样走直接端点。

## 4 改动文件清单与分阶段计划

### 阶段 0 —— 组件契约去 Projection 化（本 PR，零行为变更）

| 文件 | 改动 |
|---|---|
| `src/revisionSelection.ts`（新增） | 模型中立契约：`RevisionChangeRow{kind,moved,formatChanged,objectChanged,oldIndex?,newIndex?,beforeText,afterText}`、`RevisionSelection{target,comparedWith,author?,createdAt?,changes}`、`revisionChangedRows` |
| `src/revisionDiff.ts` | 新增 `semanticRevisionSelection(before,after,meta)` 适配器：`revisionDifferences` 输出折叠为行（行文本即时物化），引擎本体不动 |
| `src/RevisionReview.tsx` | 不再 import `Projection/revisionDifferences/revisionBlockText`；revision 号取 `target/comparedWith`；行来自 `selection.changes` |
| `src/RestoreRevisionDialog.tsx` | 改动条数改取 `revisionChangedRows(selection).length`；不再 import 引擎 |
| `src/App.tsx` | `showRevision` 用适配器构造选择；`after.revision → comparedWith`（:680）、`before.revision → target`（:881 onRefresh） |
| `src/revisionDiff.test.ts` | 新增适配器用例（target/comparedWith/meta 透传、行文本、变更计数） |

语义入口行为不变的判据：diff 计算从组件 render 移到选择构造（同一次选择只算一次，成本不升反降）；`key`/`data-revision-change` 导航、`onlyChanges`、`latest` 过期提示、restore 禁用条件（`target>=comparedWith`）逐字保留（两个重写文件与原文件做过字符级 opcode 对比，除上述列出的替换外无其它差异）。

### 阶段 1 —— 固定版式接入（纯客户端，已落地 2026-11-09 commit 31151cc）

`src/directRestoreClient.ts`（新增：`POST /restore/{revision}` + `expectedRevision` CAS + 409/426/501 错误映射）、`src/fixedRevisionReview.ts`（新增：manifest/index page/分片双 revision → `RevisionChangeRow[]`，页/块粒度 kind + 文本粒度 beforeText/afterText）、`src/FixedLayoutEditor.tsx`（历史列表 + 挂载两组件，门闩复用 `exportBlocked`）、`src/api.ts`（`fetchRevisions` 视需要）。实测点：fixed 文档 metadata 是否保持 Default1（§2 备注）、`reset_collaboration` 后 presence 通道重连语义（sidecar.ts:781）。

### 阶段 2 —— 工作簿接入（纯客户端，已落地 2026-11-09 commit 9adbae1）

`src/workbookRevisionReview.ts`（按 sheet/chunk JSON 快照比较产出 `RevisionChangeRow[]`，避免整簿矩阵）、`src/WorkbookEditor.tsx`（历史入口 + 还原门 = `batchReady` 全量条件）。复用阶段 1 的 `directRestoreClient`。

### 阶段 3 —— 区域 Word 协调还原（含服务端）

阶段 3a（服务端围栏 + 停房协调还原 + 区域入口只读审阅）已落地 2026-11-09 commit b1d0ca8：`hdoc_restore.rs` 白名单加入 `WordRegions2` 并在 journal 写入前钉住 layout 模型 ack（regions 2 / layout 1 / node edits 7，缺失 426，Rust 测试覆盖）；`sidecar.ts` 在任意 writer 在线时对 layout 房间失败关闭（词客户端尚不识别 drain 握手），停房后经哈希围栏还原，negotiate 时重放已提交未确认的崩溃日志；`restoreJournal.ts`/`restoreClient.ts` 贯通 `hcd-word-regions/2`；`RegionalWordEditor.tsx` 挂载共享审阅对话框，走中立分片描述符读取器（与固定版式同一 `loadFixedRevisionSelection`），还原按钮保持 `canRestore=false`。

3a 原拟的停房围栏（`/collaboration/state` 哈希）在实机中被证明架构上不可行：原生对 regional 房间的 `PUT/GET /collaboration/state` 一律 426（区域房间字节只经私有 checkpoint journal 持久化，`semanticSaveCoordinator` 之外没有该文件的写入者），`<id>.epoch-N.bin` 对 `/2` 房间根本不存在。围栏改为 **owner store 的 journal tip**：`hdoc_word_owner.rs` 在每次 acquire/renew/record 往返后把原生确认的 journal 尖写入 `collaboration/word-owners/{id}.{epoch}.store.json`（`journalHash`，初始为 `none`），sidecar 在 prepare 阶段从本租约取回同一尖（先 `persist` 冲刷房间 checkpoint，使 quiesce 后的落盘写入也推进围栏），原生在写 journal 前校验 `sourceHash` 等于 store 中当前 tip（校验 version/documentId/epoch；缺文件 412 失败关闭）——quiesce 之后任何 durable 房间写入都会移动该尖并使提交失败关闭。`/2` 协议额外允许字面量 `none`（从未落盘过的房间），其余协议仍必须为 64 位十六进制哈希。

阶段 3b 已落地 2026-11-09（与本文档增补同一 commit）：词客户端 drain 握手（`wordBrowserState.installRestoreDrain`：prepare→freeze、ready 回报前 flush+sync+分阶段许可检查、release/committed 复位）、跨 epoch 的 topology 再投影与分阶段许可恢复（committed 后 `followCommittedRestore` 冲刷设备队列再 `onEpochChange`，sidecar `hcd-restore-committed` 广播紧随 4409 关连——close 触发的 `word-browser-reconnect-required` 围栏不再否决它刚刚触发的 follow）、region diff 直接产行（`RegionalWordEditor.showRevision` 走 `readWordStorySessionProjection`（审阅侧，不可变原生历史）+ `readWordBrowserProjection`（在线侧，钉住活动房间 owner），消除中立分片描述符旁路）；sidecar restore/N 路由与 `sessionForService` 补上 `wordLayoutV2` 会话接纳（`/2` 此前在 `restore/*` 前缀上被 `unsupported-collaboration-session` 拒绝）。在线房间还原不再失败关闭。

Rust：`crates/officecli/src/hdoc_restore.rs`（协议白名单加入 `WordRegions2`，配套 model ack 头），`hdoc_server.rs`（editor head 426 协调头要求核对），Rust 测试。TS：`sidecar.ts`（restore 分支协议/ack 校验，:430,441）、`src/restoreJournal.ts`+`src/restoreClient.ts`（`RestoreProtocol` 联合扩展）、`src/RegionalWordEditor.tsx`（历史 + 审阅挂载；region diff 直接产行，消除 §1 的 cast 旁证入口之一）。区域房间需要验证跨 epoch 轮转后的 topology 再投影与分阶段许可恢复。

### 阶段 4 —— 收口

已落地 2026-11-09：`revisionDifferences` 签名收窄为只读块序列（`{blocks:Block[]}`），`wordRecoveryReview.ts`/`wordStoppedDraftReview.ts` 去掉 `as Projection`；评审可选意见一并处理——`App.tsx` `showRevision` 先构造选择再落 state（diff 抛错不再留下"编辑器已隐藏、审阅未挂载"的半开态），`RestoreRevisionDialog` 改用 `revisionChangedCount`（判定谓词收敛到 `revisionSelection.ts` 单处）。`hcd-current-capabilities.zh.md` 增补 2026-11-09 条目；统一验收链实测结果见 §7 增补。

## 5 验收链

总链（审计 §4）：正常 UI 操作 → 关闭重开 → 自己撤销保留同伴 → 冲突/丢响应/恢复 → 固定版本导出 → 独立回读与必要视觉检查。

- 阶段 0：`npx tsc --noEmit`；`node --import tsx --test --test-concurrency=2 --test-force-exit src/*.test.ts`；`npm run build`。语义入口手工回归：历史选 r2 → 文档页渲染、diff 行/上一条下一条/仅变更勾选、比较过期提示与刷新、还原确认框改动计数与 r 显示、还原成功产生 r+1 且 `patchId=restore-2-{r+1}`。
- 阶段 1/2（每入口）：列表 → r{target} 文档 → diff 行 → 还原 → head 变化时确认框 `restoreComparisonChanged` 且按钮禁用（非 uncertain）→ 还原后新 revision → 关闭重开内容一致 → 同伴草稿/在场不受影响 → `officecli hdoc validate` 与 `hdoc get-chunk --revision` 回读 → 固定版本导出目检。
- 阶段 3：上述之外加 sidecar 崩溃恢复（pending journal 重放、epoch 恰轮转一次、receipt 幂等重放），双客户端房间写权限在还原后重建。

## 6 风险与边界

- 直接还原只认 Default1（hdoc_server.rs:5052）：若 fixed/workbook 文档曾被 `/auth` 升级到协调协议，阶段 1/2 需回到协议判定而不是假定可用；实现时以实测 metadata 为准。
- remote 存储：`coordinatedRestore=false`（hdoc_server.rs:1046）但直接端点不检查 remote —— 阶段 1 需在 remote 后端验证 `publish_mutation`/`reset_collaboration` 的行为，再决定放行文案。
- 区域 Word（阶段 3）涉及 epoch 轮转 + topology 再投影 + Inline1 型 model ack 三套机制的交集，是四个阶段中唯一需要 Rust 变更的；失败关闭（fail-closed）语义必须与 hdoc_restore.rs 现有一致。
- 阶段 0 后 diff 行仍携带全量文本（`beforeText/afterText`），巨型文档审阅内存占用与旧实现同阶（旧实现也在组件里持有整对 Projection）；如需截断，行适配器是分格式插拔点。

## 7 验证记录（阶段 0，2026-11-08 实测）

```bash
cd examples/hdoc/editor && npm ci
cd ../xlsx-univer-viewer && npm ci   # editor 以相对路径直接引用其源码，typecheck/build 前必须安装
cd ../editor
npx tsc --noEmit                                    # 通过
node --import tsx --test --test-concurrency=2 --test-force-exit src/*.test.ts   # 2081 pass / 0 fail（基线 2080，+1 条适配器用例）
npm run build                                       # tsc + vite 主构建 + embed 构建均成功
```

`RevisionReview.tsx`/`RestoreRevisionDialog.tsx` 两个重写文件与 HEAD 做过字符级 opcode 比对：除 §4 阶段 0 表中列出的替换外无任何其它差异（过程中曾捕获并修复两处漏写 `}` 的转写错误，说明该比对是必要的）。语义入口的浏览器手工回归（§5 阶段 0 步骤）不在本次自动化范围内；改动为纯类型与数据搬运，行为等价性由 opcode 比对、全量测试与双构建背书。

### 阶段 1-4 统一验收链增补（2026-11-09 实测）

自动化：

```bash
# 前端（examples/hdoc/editor，阶段 4 落地后重跑）
npx tsc --noEmit                                                                # 通过
node --import tsx --test --test-concurrency=2 --test-force-exit src/*.test.ts   # 2095 pass / 0 fail（阶段 0 基线 2081）
npm run build                                                                   # tsc + vite 主构建 + embed 构建成功
# 原生
cargo test --workspace                                                          # 954 passed / 1 failed / 1 ignored
cargo fmt -- --check                                                            # 通过
cargo clippy --all-targets                                                      # exit 0；本窗口改动文件零告警
```

`cargo test --workspace` 唯一失败为 pdf-handler `reader::tests::real_ascii85_flate_pages_decode_in_order_with_the_same_limits`：其夹具 `docs/assets/hcd-pdf-search-2026-10-25/ascii85-content-source.pdf` 从未提交进仓库（测试与夹具自 82a121f 起未变），在任何检出上都失败，属基线既有故障，与本窗口改动无关。`cargo clippy --all-targets -- -D warnings`（CLAUDE.md 标准门禁）在当前 clippy 0.1.99 下被未改动 crate（hcd-core、oxml 等）的既有 lint 挡住；放宽为不带 `-D` 的整仓运行 exit 0，且 officecli 内两条 `hdoc_server.rs` 告警（:7285、:10234）均在本分支触碰区之外。

实机运行（`officecli hdoc serve` 于 127.0.0.1:18766，导入 md/wb2/wr 三份文档）：

- 直接还原：`POST /v1/documents/{id}/restore/0`（`{"expectedRevision":1}`）→ 200，`patchId=restore-0-2`，head 变 r2；过期 CAS → 409；`expectedRevision` 不符 → 409；r2 分片回读与 r0 内容一致；`officecli hdoc validate` 通过；`/revisions` 列表出现带作者的还原条目。
- 真实客户端模块走 HTTP 验证（tsx 直接 import 编辑器源码）：`loadFixedRevisionSelection(md,1,2)` 产出 modified 行（新→旧）；`loadWorkbookRevisionSelection(wb2,0,1)` 产出 GRID modified（旧值→新值）；`directRestoreSupported` 为 true；`submitDirectRestore(wb2,0,1)` 成功返回 r2 且回读一致；区域文档经 `fixedChunkInfos` 拿到中立分片描述符 `[{s:0,r:'body',bc:1}]`。
- 实机发现并修复一个原生路由不一致：还原复用目标版本的内容寻址 index 对象后，`index_page` 回显存储的旧 revision，与 `/chunks` 的回显矛盾，触发客户端 `fixed-index-mismatch` 严格校验。修复为两个分支都以解析后的 manifest revision 覆写 `revision` 字段（不放松客户端校验），并新增回归测试 `index_page_echoes_the_resolved_revision_after_restore_reuses_history`。阶段 3 的 layout 协调还原另由 Rust 测试 `layout_coordinated_restore_pins_the_word_layout_model_and_rotates_the_epoch` 覆盖（ack 缺失 426 先于 journal、epoch 恰轮转一次；该测试现改为种入 owner store 的 journal tip 作围栏，并断言陈旧尖与 `none` 尖均 412 失败关闭、区域房间不存在 `/collaboration/state` bin 文件）。

阶段 3b 实机验证增补（2026-11-09 实测，双 Hocuspocus 在线 writer + 真实原生/sidecar）：夹具为 `hdoc import --word-regions`（r0）+ `hdoc project-editor --word-regions`（r1，flowLayout 2 正典化，layout 房间 head 校验要求）+ 离线 patch（r2，文本标记），随后 `hdoc serve` + tsx sidecar（`HCD_WORD_LAYOUT_ROOMS=1`）、两个带 `--user-id` 的写 token 客户端。全部 15 项检查通过：epoch 0 协商到 `/2`、双 writer 就绪于 r2；writer 资源挂起时协调还原失败关闭为 `restore-client-busy` 且拒绝轮正确释放对端围栏；双 writer 在线时协调还原成功（receipt r3/epoch 1，drain 握手期间两侧均观测到 readOnly）；提交方回执与广播 committed 不双轮转（epoch 1 恰一次）；双方客户端各自 follow 到 epoch 1；epoch 1 房间重投影到还原后的 r3 且内容丢弃 r1 标记；A2/B2 以 epoch 1 重连就绪；region diff 直接产行——r1→r2 单条 modified 行（标记注入）、r2→r3 逆向行、r1→r3（还原后）无变更行。前端 `node --import tsx --test src/*.test.ts` 2097 pass / 0 fail，`npx tsc --noEmit` 通过。

未覆盖：§5 的浏览器手工验收链步骤未跑。
