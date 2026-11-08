# 业务子树撤销保护与审阅

后续：[撤销创建后的迟到输入恢复](hcd-history-late-input-recovery.zh.md)在本阶段“已收到同伴修改”保护之外，补齐永久隐藏拓扑及既有wire5删除receipt。以下保留本阶段原始实现与证据边界。

后续：[扩展卸载历史保护](hcd-extension-history-guard.zh.md)进一步把当前codec检查接入完整Word历史，覆盖未知容器的打字及属性记录；保存探针新发现的首次400也单独记录，未计为正常保存通过。

2026-10-25，接续[整个业务块与嵌套容器](hcd-business-block-operations.zh.md)。本批补齐“副本已有同伴修改后，撤销创建/复制会隐藏这些修改”的本窗口历史保护，继续沿用资源归档、portable envelope、人员引用和规范保存路径。管理平台、实际提醒发送仍后置。

## 当前行为

- 创建或复制业务子树后，若同伴已新增文字、行内格式、标题类型、块属性、业务属性、人员引用或子块，撤销前先检查这些修改是否会离开可见正文。会隐藏时保留正文及操作记录，进入审阅。
- 审阅条位于工具栏下方，完整显示原因、“取消”和“保留当前内容并跳过此记录”。不依赖当前工具选项卡，也不会挤到横向工具栏末端。取消保留历史；跳过只放弃本窗口这一条历史动作，不修改共享正文、资源或规范版本。
- 重做删除也重新检查。用户原本明确删除时已存在的同伴内容允许随该动作重做；删除后才到达的离线同伴内容在撤销恢复后，不能未经检查再次隐藏。
- 没有新增同伴修改的副本仍能撤销/重做，恢复相同出现ID。保存补发的来源绑定、规范ID和来源字体回执不当作同伴编辑。
- 跳过必须匹配当前历史版本和当前原始栈顶，不能跳过另一条动作。跳过后保留较早文字/图片操作的先后顺序，也保留相反方向的历史分支；只读、上传、保存及资源请求门禁继续适用。

这里没有“强制撤销并删除同伴修改”入口。用户仍可在正文里明确编辑或删除当前已审阅的内容；完整的删除/离线编辑竞争处置是后续独立工作。

## 实现边界

`SemanticBlockStore.undoManager()` 默认接入 `protectStructuralUndo`。结构动作记录原动作明确移除的外部内容身份范围；撤销/重做时，在独立 `gc:false` Y.Doc 中试算同一 StackItem，比较当前可见投影中的外部CRDT时钟范围。不根据文字相同、显示姓名或重新分配的序号判断归属。

比较覆盖可见的结构分配、类型/位置/可见性、用户属性、可见文字和格式项、当前业务节点及引用意图。来源回执单独排除。普通打字无需每键复制整份文档；受检查的结构动作超过64MB编码上限或无法安全投影时，保留原正文和历史，提示取消/跳过。试算失败不派发真实共享事务。实际Yjs执行也隔离当前一条栈项，避免跳过无效项时穿越到未审阅的更早动作。

Yjs的本地 `redone` 映射不包含在网络快照中。隔离试算也复制这些映射和准确的Item边界，才能检查“撤销较新删除后，再撤销更早创建”的历史。回归同时覆盖：存在peer修改时跳过redo后更早undo仍要求审阅；没有peer修改时，较早创建/较新删除可以连续undo/redo，ID不变。

跳过调用Yjs的栈清理以释放保留标记，再恢复较早的栈项。Yjs `clear` 会替换数组，不能把旧项恢复到失效数组；本批的回归覆盖了这个实际发现的问题。

此实现依赖当前固定的Yjs 13.6.27 Item/ContentFormat等内部身份接口，升级依赖时必须复验。没有新增共享恢复记录、后端载荷或协议版本；wire仍4，portable envelope仍2。本窗口历史不是跨设备持久历史，服务器权限/规范CAS仍沿用原路径。

**不是完整删除竞争协议：**检查只能保护已进入当前窗口的同伴修改。检查后才送达的离线编辑、服务端因果删除审阅、历史压缩/GC和跨epoch迁移仍需独立实现与验收；不能把本地预检查当作分布式锁或服务端授权。

## 验证

546项前端测试、TypeScript和standalone/embed构建通过，源码hash及日志见[检查摘要](../assets/hcd-undo-review-2026-10-25/validation.json)。新增用例先证明未保护的Yjs复制撤销会隐藏peer子树，再验证文字、格式、标题、属性、引用、新子块、来源回执、删除重做、精确跳过和旧历史顺序。本批没有Rust修改，不重复计入此前原生单测。

最终验证使用新的独立本地夹具和窗口：

| 动作 | 实际结果 |
|---|---|
| 两个真实鉴权socket准备r6 | 6个业务节点，包括未知v77、资源行内元素、富文本与嵌套容器；离线子段编辑收敛，自己的文字undo/redo保留peer输入 |
| CUA整块复制并保存r7 | 新增3个业务出现ID及一处提及ID；原6个envelope未变 |
| Bob真实socket修改并保存r8 | 副本标题、行内资料属性、Bob人员目标、嵌套标题/加粗正文及新增子块均进入规范版本 |
| Alice实际点击撤销 | 出现审阅，副本和peer内容保持；取消后再次撤销仍要求审阅，说明历史没有被取消操作丢弃 |
| Alice保留内容并跳过 | 审阅关闭，本窗口复制历史消失，正文和head仍r8；没有生成重做删除的动作 |
| Bob新浏览器窗口重开 | r8的副本、姓名、标题及新增子块都在，实名在线位置仍显示 |
| 浏览器实际DOCX下载 | 下载r8并回读；导出区明确提示11个业务节点静态化，包括9个业务出现和2处人员引用 |

实时socket快照在保存回复后可能迟到补上 `inline.nodeId` 来源回执；初次严格实时比对捕获了这一差异。探针仅在用户内容比对中排除这个来源字段，**业务ID、引用ID及其他字段仍精确比较**。离线规范投影与原规范投影则包括已提交来源ID在内逐份精确比较，未将回执变化误写为审阅导致内容改变。

实际r6/r7/r8文件回读：原6个envelope和未知v77不变，副本3个ID稳定，引用创建actor为Alice、改目标actor为Bob，重复查询不生成额外事件，reminders仍disabled。无源HCD解包验证通过，历史规范投影完全一致，归档资源字节hash不变。

实际无源DOCX/PPTX/PDF/MD及浏览器DOCX均包含原件/副本、Alice/Bob姓名和同伴新增正文/子块。DOCX有4处图片，源图字节保持；PDF整页渲染检查通过。通用格式输出的是适配后的可读静态内容，业务载荷/可编辑关联保留在HCD中，不声称Office原生业务控件或外部Office应用验收。所有回读后head仍r8。

- [审阅条和同伴内容](../assets/hcd-undo-review-2026-10-25/review-required.png)
- [跳过后正文仍在](../assets/hcd-undo-review-2026-10-25/review-skipped-r8.png)
- [浏览器记录](../assets/hcd-undo-review-2026-10-25/browser-evidence.json)
- [实际socket保存](../assets/hcd-undo-review-2026-10-25/undo-review-socket.json)
- [实际文件、引用和资源](../assets/hcd-undo-review-2026-10-25/file-evidence.json)
- [浏览器DOCX](../assets/hcd-undo-review-2026-10-25/browser-r8.docx)
- [可解包的HCD离线归档](../assets/hcd-undo-review-2026-10-25/review-r8.hcdz)
- [离线PDF预览](../assets/hcd-undo-review-2026-10-25/review-offline-r8-1.png)

早期开发热更新会重建本窗口历史，不记作历史迁移通过；最终取消/重试/跳过/下载链路在代码修改后的新夹具与新窗口完成。浏览器观察超时后检查实际状态，不根据超时重复派发或重启服务。没有生产、数据库、多实例、真实Office、旧epoch、设备崩溃或长文规模验收。

## 复现与剩余范围

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-mention-preview.py --extension-nodes --node-portable \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-undo-verified
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-business-blocks.mts /absolute/owned-root/private.json
# 浏览器整块复制原始外层容器并保存r7；保留这个窗口，不重开。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-undo-review.mts /absolute/owned-root/private.json
# r8后，原浏览器撤销→取消→重新撤销→保留内容并跳过；实际下载DOCX。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-undo-review.mts /absolute/owned-root/private.json verify
python3 scripts/hcd-undo-review-files.py /absolute/owned-root/private.json \
  /absolute/actual-browser-download.docx
```

探针仅面向上述具名、独立夹具，凭证不写入证据目录。旧 `hcd-business-block-actions.mts` 现明确为raw CRDT历史留存复现，使用未保护管理器重放此前r8–r12；不能拿它冒充当前产品允许未经审阅的redo。

完整删除竞争、任意custom mark、可编辑行内容器、复杂格式往返、历史压缩、规模/远端/旧epoch及完整计划其他验收仍继续；管理平台和实际提醒发送不做。
