# 结构编辑后的文字来源、段落拆合与保存

2026-10-26。继续[行内删除审阅](hcd-inline-deletion-review.zh.md)中实际文件暴露的来源身份缺口；完整七阶段目标继续，管理平台和提醒发送后置。拖动的整行高亮、前后插入线和松手目标反馈见[写作与拖动交互](hcd-notion-writing-and-drag.zh.md)。本批完善结构修改之后的保存身份，避免只凭可见文字一致判定正确。

## 两层原因与修复

原生结构 Replace 过去会为第一段文字之后的 inline 分配新 nodeId。因此插入一个业务 atom 再撤销，文字、业务载荷和块身份一致，但完整规范块不相等，未修改文字的注释也可能失去锚点。原生初始反例先失败，见[原生 RED](../assets/hcd-source-retention-2026-10-26/red-before-fix.log)。

仅修原生还不够。新段落首次保存后，前端只写了段落默认来源，没有把返回的每一个规范 inline ID 绑定到其永久文字。下一次保存把首 ID 借给了剩余文字，严格的 r2→r3 实际文件比较失败。该独立失败夹具保持 head6，见[失败边界](../assets/hcd-source-retention-2026-10-26/negative-default-only/boundary.json)，不当作最终通过证据。

现在结构捕获附带可选 leaf binding：原始 Yjs item 的 carrier、client、clock、length、逻辑 offset，以及规范化文字／atom 身份的 SHA-256。回执先核对快照形状和大小，再绑定具体 source ID。当前永久叶内容完全一致时允许整体重绑，否则只绑定仍然存活的原始 item 范围；晚到新字不会借用相邻 atom 的来源。删除 atom 不会把其 ID 移到后缀，已合并的旧段落仍可通过永久载体接收保存回执。清除旧来源在新绑定之前执行，且系统补写不产生个人历史动作。

前端七项新增测试覆盖逐 inline 绑定、JSON／新 Y.Doc 重载、emoji 与迟到插字、删除 atom、过期标记清除、保存中合并段落、旧捕获兼容及坏范围拒绝。初始四个前端反例见[绑定 RED](../assets/hcd-source-retention-2026-10-26/source-bindings-red.log)。

## 原生来源的合法范围

`ReplacementSources` 从**本批明确 Replace／Delete 的根**收集客户端实际声明的旧 ID 和轻量角色。Replace／Insert 只能复用这个范围中的 ID：普通文字／硬换行、mentionId、业务 instanceId＋类型＋行内／块角色需要匹配。新业务 occurrence 不能借用旧文字的 ID；随机 ID 或未修改根的 ID 不能写入。全局最终唯一性、只读、版本 CAS、资源和原有原子发布校验继续适用。

这比“只许保留当前根的 ID”更完整：段落合并会释放被删段落的来源，拆分可能把来源交给新段落。服务端先计算整个快照中实际修改／移除的根，生成来源计划；同一来源被多个拆分片段声明时，仍声明它的原 owner 优先，否则第一个目标保留，其余分配新 ID。core 再独立证明本批范围和最终唯一性。跨根转移反例先 RED，见[转移 RED](../assets/hcd-source-retention-2026-10-26/source-transfer-red.log)。

未修改的 inline 保留 ID；同一旧来源被拆成不同格式的多个片段时，只能一处保留，其他片段需要新 ID。因此本批不声称任意格式拆分／撤销都能逐字节还原完整规范。来源是 HCD 逻辑身份；结构重建仍生成 editor 来源位置，不等同于原始 OOXML 物理节点、分页或原稿保真。

## 实际验收

| 独立夹具 | 操作与严格结果 |
|---|---|
| 行内删除 r2–r7 | 新段含人员／资源 atom；删除、离线属性与人员改目标、浏览器恢复、双成员同一恢复幂等、自己的插入／撤销及迟到修改恢复 |
| 同夹具来源 | r2 的三段未改文字在 r3／r4 精确不变，r4 的全部原 inline 在 r5／r6／r7 精确保留，**r4.blocks == r6.blocks**，包括 nodeId／blockHash |
| 段落拆合 r2–r7 | 真实生产 PM join→离线 Bob 追加→自己的 undo／redo／undo；两个文字来源 ID 每个版本各出现一次，Bob 文字保留、双端投影一致 |
| 保存／读取 | 两个夹具各六条首次 native checkpoint 全200；原段落和原图完整规范块不变；新 Y.Doc 读取实际持久文件，最终签名回执与规范 digest 一致 |
| 浏览器 | 实际恢复、二次确认取消、保存 r4／r7、导出区下载 DOCX、无 codec 只读重开，未重启服务 |
| 实际文件 | 两个夹具逐份 r2–r7 DOCX；无源离线 HCD 全版本1–7与原规范精确相同，DOCX／PPTX／PDF／MD文字与资源检查；两份PDF各一页整页检查 |
| 保护 | 只读403／旧wire5 426／错误epoch409；21次原生版本门禁426；旧socket同步前拒绝；伪造／借用未修改段落来源的checkpoint400，head／持久Yjs不变 |

段落拆开时，已经退役的块根可以分配新 blockId；该夹具要求文字来源身份和语义正确，不假称退役根复活。规范／离线格式和 wire6／structure3／coordinator4／envelope2／mention1 均不变；旧捕获不带 bindings 时仍可读，只有形状完全匹配的存活叶可以安全补写。前端、sidecar 和 native 应一起更新。

628 项前端测试、82 项 hcd-core 与159项 officecli 测试通过；TypeScript、standalone／embed、native 构建、相关 all-targets Clippy deny warnings、全仓 fmt／diff 检查通过。本批没有改 TSX 组件。见[检查摘要与文件哈希](../assets/hcd-source-retention-2026-10-26/validation.json)。

证据：[逐版本与离线文件](../assets/hcd-source-retention-2026-10-26/file-evidence.json)、[拆合 socket](../assets/hcd-source-retention-2026-10-26/transfer-socket.json)、[拆合实际文件](../assets/hcd-source-retention-2026-10-26/transfer-file-evidence.json)、[来源拒绝](../assets/hcd-source-retention-2026-10-26/source-ownership-fence.json)、[最终页面](../assets/hcd-source-retention-2026-10-26/restored-r7.png)、[缺扩展重开](../assets/hcd-source-retention-2026-10-26/reader-no-codec-r7.png)。

## 复现

```sh
python3 scripts/hcd-mention-preview.py --node-portable --checkpoint-probe \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-source-final
# 沿用行内删除文档 prepare → 持久r3 → 浏览器恢复人员 → race → 浏览器保存r4
# → history → 持久r6 → 浏览器确认/取消/恢复/保存r7/下载DOCX流程。
# 其脚本的最后一个可选参数设为 docs/assets/hcd-source-retention-2026-10-26。
python3 scripts/hcd-inline-deletion-files.py <root>/private.json <actual-download.docx> \
  docs/assets/hcd-source-retention-2026-10-26 --strict-sources
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-source-retention-fence.mts <root>/private.json

# 另开全新夹具，不复用上面的head7：
python3 scripts/hcd-mention-preview.py --node-portable --checkpoint-probe \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-source-join
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-source-transfer.mts <join-root>/private.json
python3 scripts/hcd-source-transfer-files.py <join-root>/private.json
```

脚本只用于具名自有本地夹具，凭证留在私有 runtime；公开证据包含 ZIP／gzip 内部扫描。收起侧栏的浏览器输入曾超时，重新读取 AX 后确认已收起，再操作导出；未重复点击或重启服务。

## 保留的边界

本批不是服务重启、PostgreSQL／多实例、真实 Office、真实模型、全输入法／设备或生产验收。协调器恢复需要在线，仍未加入浏览器个人撤销栈。行内格式删除竞争、任意 custom mark／可编辑行内容器、复杂多树操作、旧丢失数据修复、原稿保真、长文容量／压缩／GC 和完整计划其余范围继续。捕获元数据受现有签名载荷大小限制，未以这些小夹具证明长文容量。
