# 跨入口历史审阅/还原对齐（HCD Revision Review Alignment）

本文是 `hcd-overall-audit-2026-10-30.zh.md` 第 4 节 P0 项"跨入口历史审阅/还原对齐"的代码级落点分析与分阶段实施计划。`RevisionReview`/`RestoreRevisionDialog` 目前只接在普通语义入口；区域 Word、固定版式、工作簿三个入口有 revision 历史与 CAS 保存，但没有等价的"看历史版本 → 比较 → 还原"闭环。阶段 0（组件契约去 `Projection` 化）已随独立 PR 落地，本文同时记录其实际改动面。

## 1 现状：语义入口的完整链路

审阅侧（`examples/hdoc/editor/src/App.tsx`）：

1. `showRevision`（App.tsx:656-670）并发拉取 `/editor?revision=N` 与 `/editor?revision=head` 两份 `Projection`，构造选择并打开右栏。
2. `RevisionReview` 旧契约 `RevisionSelection={before:Projection;after:Projection}`（原 RevisionReview.tsx:8），diff 模式在组件内调用 `revisionDifferences`（revisionDiff.ts:15，类型锁定 schema.ts:158 的 `Projection/Block`）；文档模式复用 `RevisionDocument`。
3. `RestoreRevisionDialog`（原 RestoreRevisionDialog.tsx:9）为了显示"改动条数"再算一遍全量 `revisionDifferences` —— 组件对 `Projection` 的全部依赖只有这一个数字。

还原侧（协调式事务）：

1. `restoreHistorical`（App.tsx:673-689）先 `save()` 取 head，再核对 `selection.after.revision`（不一致即 `restoreComparisonChanged`），生成 `RestoreSubmission{requestId,target,expectedRevision,fromEpoch}`，经 `submitRestore` 发给 sidecar。
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
| `src/App.tsx` | `showRevision` 用适配器构造选择；`after.revision → comparedWith`（:678）、`before.revision → target`（:879 onRefresh） |
| `src/revisionDiff.test.ts` | 新增适配器用例（target/comparedWith/meta 透传、行文本、变更计数） |

语义入口行为不变的判据：diff 计算从组件 render 移到选择构造（同一次选择只算一次，成本不升反降）；`key`/`data-revision-change` 导航、`onlyChanges`、`latest` 过期提示、restore 禁用条件（`target>=comparedWith`）逐字保留（两个重写文件与原文件做过字符级 opcode 对比，除上述列出的替换外无其它差异）。

### 阶段 1 —— 固定版式接入（纯客户端）

`src/directRestoreClient.ts`（新增：`POST /restore/{revision}` + `expectedRevision` CAS + 409/426/501 错误映射）、`src/fixedRevisionReview.ts`（新增：manifest/index page/分片双 revision → `RevisionChangeRow[]`，页/块粒度 kind + 文本粒度 beforeText/afterText）、`src/FixedLayoutEditor.tsx`（历史列表 + 挂载两组件，门闩复用 `exportBlocked`）、`src/api.ts`（`fetchRevisions` 视需要）。实测点：fixed 文档 metadata 是否保持 Default1（§2 备注）、`reset_collaboration` 后 presence 通道重连语义（sidecar.ts:781）。

### 阶段 2 —— 工作簿接入（纯客户端）

`src/workbookRevisionReview.ts`（按 sheet/chunk JSON 快照比较产出 `RevisionChangeRow[]`，避免整簿矩阵）、`src/WorkbookEditor.tsx`（历史入口 + 还原门 = `batchReady` 全量条件）。复用阶段 1 的 `directRestoreClient`。

### 阶段 3 —— 区域 Word 协调还原（含服务端）

Rust：`crates/officecli/src/hdoc_restore.rs`（协议白名单加入 `WordRegions2`，配套 model ack 头），`hdoc_server.rs`（editor head 426 协调头要求核对），Rust 测试。TS：`sidecar.ts`（restore 分支协议/ack 校验，:430,441）、`src/restoreJournal.ts`+`src/restoreClient.ts`（`RestoreProtocol` 联合扩展）、`src/RegionalWordEditor.tsx`（历史 + 审阅挂载；region diff 直接产行，消除 §1 的 cast 旁证入口之一）。区域房间需要验证跨 epoch 轮转后的 topology 再投影与分阶段许可恢复。

### 阶段 4 —— 收口

`wordRecoveryReview.ts`/`wordStoppedDraftReview.ts` 改用中立行 API 去掉 `as Projection`；更新 `hcd-current-capabilities.zh.md` 与审计状态；统一验收链跑满四入口。

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
