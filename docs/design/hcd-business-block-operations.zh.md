# 整个业务块、嵌套容器与严格结构投影

后续更新：[子树撤销审阅](hcd-structural-undo-review.zh.md)已补上副本已有peer修改时的undo保护，以及删除redo前复查。下文r11/r12是本批当时的raw CRDT历史留存证据；现在默认产品历史会阻止再次隐藏后来到达的peer修改，旧复现脚本已明确使用raw管理器。不能把历史重放作为当前安全交互验收。

2026-10-25，接续 [行内节点的段落操作](hcd-inline-node-block-operations.zh.md)。本阶段开放当前codec能够完整理解的业务块/容器复制、移动和删除；资源、子树、提及、保存及导出仍走既有共同模型。管理平台与提醒发送继续后置。

## 块操作契约

1. 检查整棵子树的codec。未知类型/版本、未知子节点、原稿保护对象和未知外层容器仍是屏障；只理解外层不能删除未知内层。注册卸载后的旧授权不缓存。
2. 复制为外层、嵌套业务块、行内业务节点及每次人员提及分配独立身份。保留data、版本、资源和导出快照；递归清理结构/规范来源ID及块atom fallback中的来源回执，保留可见字体样式。原件/副本属性可独立修改。
3. 移动保留子树及出现ID，使用结构移动意图。删除隐藏当前子树；自己的撤销恢复原身份，重做重复删除。**这不是删除与并发编辑的完整冲突审阅：**离线新增的子文字保留在共享存储中，删除后隐藏，撤销后才重新进入可见正文和规范导出。删除后的恢复/显式选择界面仍需完善。
4. 不把业务块转换成普通标题/列表/代码而丢失envelope；这些不兼容转换禁用。在整块前后新增内容仍是普通插入。
5. 暂存移动不仅重新检查目标，还重新检查跨越的邻居。邻居codec在等待期间失效，同一旧事务也不能越过新保护屏障。
6. 块菜单按真实同级目标计数；选中一个含五个后代的容器仍显示“1个块”。Shift扩选限定同一父范围，不能混入另一层容器的后代。命令、选区和权限门禁共用已有路径。

没有新增native载荷或协同版本：wire仍4、portable envelope仍2。行内元素仍为atom，任意custom mark、可编辑行内容器和业务类型的任意结构转换未因此实现。

## 实际发现的投影故障

第一次打开含嵌套容器的浏览器页面曾报 `duplicateExtensionIdentity` 并空白；独立native规范投影和两个socket中的6个业务ID唯一。最初DOM标记假设未通过复验，相关试改已撤回。

当前结构绑定原先使用diff边界的开Slice最小替换。已构造可复现的纯PM反例：引用块中带业务容器、改两段文字并增加尾段和列表时，fitter生成合法但与目标不同的树。现在 `structureProjectionTransaction` 必须核对完整目标；最小替换失败或不相等时，从顶层使用闭合内容替换，再核对相等才派发。选择仍由原稳定结构/文字书签恢复，事务为remote/no-history，**不重写共享CRDT载体**。

回归用例明确证明旧fitter结果不等于目标、新事务精确相等且只有一个容器身份。修复后的实际页面重开、嵌套内容显示、整块复制、协作更新和属性保存通过。长文fallback成本、全部设备输入法及热更新窗口迁移没有因此获得验收。

## 验证链路与范围

**534项前端测试**、TypeScript、standalone/embed构建和差异空白检查通过。本轮没有Rust修改，不把历史原生单测重复计入；native证据为实际HTTP/协同保存和文件回读。

| 版本 | 已观察动作和结果 |
|---|---|
| r6 | 两个真实鉴权socket建立6个业务节点：两个未知v77、资源行内节点、外层富文本容器、内层资源节点及嵌套容器；一处人员引用，Alice/Bob离线子段文字已保存 |
| r7 | CUA实际整块复制；新增3个独立业务ID及一处新mentionId，所有原envelope保持原值 |
| r8 | Alice离线移动副本，Bob离线在副本嵌套段落新增文字；重连收敛，保存后位置/ID/peer文字保留 |
| r9 | 删除副本；Bob离线在其旧副本中另加文字。重连后子树隐藏，原件未变 |
| r10 | 自己的undo恢复同一外层/内层/引用ID，以及两处Bob新增文字 |
| r11/r12 | redo再次删除，undo再次恢复；实际规范文件分别只有原件/同时包含副本 |
| r13 | 新浏览器窗口仅将副本容器标题改为“副本容器”，原件、内层和资源未变；Bob新窗口重开及浏览器实际DOCX下载通过 |

移动/删除/undo/redo采用真实两个WebSocket及生产块转换函数与结构意图，不是浏览器拖放演示。浏览器实际覆盖菜单复制、正确计数、属性、保存、导出和重开。多次鼠标/焦点观察超时先检查实际状态；未据超时重启服务。CUA脚本曾超时并恢复现有tab绑定；不把尝试当成功。旧热更新窗口曾有按钮响应异常及React render警告，保留了限定说明；最终属性/下载使用新窗口，不声称热更新迁移已通过。

实际r6–r13 DOCX逐份回读：ID唯一且稳定，原6个业务载荷及未知v77保持；引用新建/删除/恢复的actor均为实际Alice，移动和改属性不创建关联事件，反复查询事件不变，reminders仍disabled。资源字节hash保留。DOCX在只有原件时3处图片，有副本时4处，源图hash一致。

无源HCD解包后r6–r13投影与在线规范一致；DOCX/PPTX/PDF/MD包含原件/副本可读内容、两个姓名和两处peer新增正文。PDF整页检查通过。通用文件中的业务关联静态化，不能冒称Office原生控件或业务载荷仍可编辑。最后回读head仍r13。

- [整块菜单与计数](../assets/hcd-business-blocks-2026-10-25/whole-container-menu.png)
- [最终副本及资源](../assets/hcd-business-blocks-2026-10-25/whole-container-saved-r13.png)
- [实际socket竞争与历史](../assets/hcd-business-blocks-2026-10-25/socket-evidence.json)
- [浏览器与限制](../assets/hcd-business-blocks-2026-10-25/browser-evidence.json)
- [版本、事件、资源与文件](../assets/hcd-business-blocks-2026-10-25/file-evidence.json)
- [源码和检查摘要](../assets/hcd-business-blocks-2026-10-25/validation.json)
- [实际浏览器DOCX](../assets/hcd-business-blocks-2026-10-25/browser-r13.docx)

## 复现

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-mention-preview.py --extension-nodes --node-portable \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-business-blocks
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-business-blocks.mts /absolute/owned-root/private.json
# 浏览器选外层容器，Mod+/ → 搜索复制 → Enter，保存r7。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-business-block-actions.mts /absolute/owned-root/private.json
# 保存至r12后，浏览器改副本标题保存r13，并实际下载DOCX。
python3 scripts/hcd-business-block-files.py /absolute/owned-root/private.json
```

探针仅适用于上述命名夹具；独立创建导出/解包目录，不改变head，不记录凭证。没有生产、真实Office应用、数据库、多实例、旧epoch或设备/浏览器崩溃验收。**尚未验收“副本已有他人修改后，撤销创建/复制本身”的审阅与保护**，本批的移动/删除撤销不能替代它。完整删除竞争、长期历史压缩、任意mark/行内容器及原目标其余范围继续推进。
