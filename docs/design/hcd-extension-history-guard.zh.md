# 扩展卸载后的历史保护

2026-10-25，接续[业务子树撤销审阅](hcd-structural-undo-review.zh.md)。本批修复缺少codec时历史路径仍可能删除或改写未知内容的问题。管理平台与实际提醒发送继续后置。

后续：[来源身份修复与保存取证](hcd-source-identity-repair.zh.md)已独立重现下述400类别，修正裸Fragment探针并修复未知容器误拦核心来源补写的问题。原失败请求未捕获body，旧exit1及稍后重试的记录保持原样；新夹具首次成功与历史异常分开记录，见[后续取证索引](../assets/hcd-codec-history-2026-10-25/save-anomaly-resolution.json)。

## 问题和行为

普通正文事务与块菜单已有codec保护，但结构历史直接修改Yjs，随后作为远端/no-history投影进入编辑器；这条路径不会重新经过普通本地事务过滤。原先没有peer修改的副本，在卸载codec后仍能被undo移除。回归先用旧路径明确复现了这一点。

现在完整语义Word的同一历史管理器在每次undo/redo前查询**当前**宿主注册表，不把创建记录时的codec授权永久缓存。不存在、版本不匹配、adapter/业务校验不再匹配的节点均视为当前不可解释。

- 未知行内/块atom不能被历史移除、改载荷或改marks。未知富文本容器的整个子树保持原值，包含其中普通文字；已知外层也不能隐藏codec已卸载的内层节点。
- 当前历史会影响未知内容时，在真实共享事务之前停止。正文、原始栈顶和本窗口历史均保留，审阅条说明加载对应扩展后重试，或取消/保留内容并跳过。
- 加载匹配codec后，不重建连接或清空历史，继续原来那条undo/redo。替换整个注册表也查询最新实例，不沿用旧注册表。
- 与未知节点无关的普通正文仍可撤销。恢复一个当前缺席的未知节点可以保留并只读展示它；之后的redo若要再次删除，则重新检查并阻止。
- 跳过只处理当前记录，不修改共享正文；较早的无关编辑仍按原时间线撤销。既有同伴修改保护、权限、资源归档/保存门禁继续适用。

保护比对每个原有未知出现的完整PM节点：业务envelope、marks和容器子树都必须相等，不只比较fallback文字或业务type。普通前置文字造成的位置变化不视为内容改变。本批不是未知节点位置权限的独立协议，也不为未知内容开放新编辑命令。

## 接入与范围

`prepareExtensionHistoryGuard` 捕获当前不可解释的节点，检查独立试算后的投影。`protectStructuralUndo` 同一次试算返回外部内容身份范围及完整投影，先检查codec屏障，再检查同伴内容；失败不派发真实修改。

仅检查结构历史不够：富文本容器里的打字、业务字段意图可能没有结构策略标签。因此只要当前投影有未知节点，普通文字/属性历史的执行也要检查该节点是否会改变。没有未知节点且没有结构策略的普通历史仍走原Yjs路径；不会为每次打字建立整份快照。试算64MB上限和无法安全投影的保留/审阅路径沿用前批，长文性能仍需单独验收。

UI连接生命周期通过ref持有当前注册表，注册/卸载和pending状态不重建UndoManager、provider或时间线。工具栏、统一命令及Tiptap快捷键均进入同一个管理器。新增中英/繁中提示，沿用已有取消/精确跳过交互。

底层 `SemanticBlockStore.undoManager(true, prepareProjectionGuard?)` 保留可选宿主投影检查接口。它不凭空推断服务端安装了哪些业务codec；完整Word产品显式接入当前注册表。未配置该检查的底层CRDT原语或 `undoManager(false)` 不代表产品权限/codec验证。可信宿主直接访问Y.Doc不是安全沙箱；服务端鉴权和规范保存CAS仍独立生效。

未改native载荷、协同wire或portable模型：仍分别为wire4、envelope2。没有Rust修改，也不把此前原生单测重复计入本批。

## 证据

558项前端测试、TypeScript及standalone/embed构建通过，12个新增真实Yjs用例覆盖：旧路径反例、三类节点卸载/重载、无关正文、未知容器内部打字、业务属性undo/redo、恢复未知对象再redo、替换注册表、已知外层/未知内层及跳过后旧历史。代码与日志摘要见[验证记录](../assets/hcd-codec-history-2026-10-25/validation.json)。

浏览器夹具顶部的“扩展加载验证”只属于测试宿主，调用公共 `register`/注销cleanup；不读取或注入editor/Y.Doc状态，不是管理平台或产品新控件。

实际CUA链路：双socket准备r6 → 整块复制保存r7 → 公共API卸载codec → undo要求审阅且head仍r7 → 重新加载后继续同一undo并保存r8 → redo恢复同一副本并保存r9 → 再卸载后undo仍要求审阅 → 保留内容并跳过，head仍r9。没有通过重开窗口清掉历史来规避验证。复制/恢复的3个业务ID及提及ID在规范回读中一致，原6个envelope保持原值。

Bob随后使用真实socket在普通尾段新增正文，**首次显式保存收到failed，sidecar记录native400**；原探针以exit1停止，未被改写成成功。约5秒后，既有协调器重试提交为r10，author为Bob，当前正文回读完整。本批保留[异常及后续取证步骤](../assets/hcd-codec-history-2026-10-25/save-anomaly.json)。目前尚未捕获首次400的原生响应详情；需要独立复现，对比来源/规范身份和探针的裸Fragment追加与真实PM打字路径。不能把稍后的head10当作首次请求成功，也不能据此声明这条保存链路已完整验收。

当前r10的真实socket只读检查与实际浏览器下载通过：Alice仍未加载codec，未知内容、普通同伴正文和全部9个业务载荷/2处引用均在。r6–r10逐份DOCX及规范回读确认原件不变、r8副本缺席、r9副本同身份恢复；引用创建/删除/恢复actor均为Alice，Bob普通文字不生成引用事件，提醒仍disabled。

无源HCD解包验证与r6–r10原规范投影精确相同，资源字节hash保留。实际离线DOCX/PPTX/PDF/MD与浏览器DOCX回读完整，DOCX4处图片含原始图字节，PDF整页渲染检查通过；回读和浏览器导出后head仍r10。这些证明已提交内容/离线文件保持，不替代上述失败请求的原因调查。通用Office格式中的业务内容仍按适配器静态化；HCD保留envelope及资源，没有真实Office应用/复杂业务组件往返验收。

- [卸载后的审阅与完整副本](../assets/hcd-codec-history-2026-10-25/codec-unloaded-review-r7.png)
- [保留内容并跳过](../assets/hcd-codec-history-2026-10-25/codec-unloaded-skip-r9.png)
- [浏览器记录](../assets/hcd-codec-history-2026-10-25/browser-evidence.json)
- [当前socket回读及保存异常边界](../assets/hcd-codec-history-2026-10-25/codec-history-socket.json)
- [实际文件/引用/资源](../assets/hcd-codec-history-2026-10-25/file-evidence.json)
- [离线HCD归档](../assets/hcd-codec-history-2026-10-25/codec-r10.hcdz)
- [浏览器DOCX](../assets/hcd-codec-history-2026-10-25/browser-r10.docx)

本批没有生产、多实例、设备崩溃、旧epoch或真实Office应用验收。整块历史和公共API卸载/重载有CUA证据，普通容器打字及属性undo/redo的卸载保护由真实Yjs回归覆盖，不能混称为所有输入路径的浏览器验收。

## 复现

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-mention-preview.py --extension-nodes --node-history \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-codec-history
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-business-blocks.mts /absolute/owned-root/private.json
# CUA复制整个外层容器，保存r7；卸载扩展→撤销应进入审阅。
# 重新加载→继续同一撤销→保存r8；重做→保存r9。
# 再卸载→撤销仍审阅→保留内容并跳过；不能重开以丢失历史代替验证。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-codec-history-peer.mts /absolute/owned-root/private.json
# Bob真实socket普通正文保存r10；原窗口实际下载DOCX。
python3 scripts/hcd-codec-history-files.py /absolute/owned-root/private.json \
  /absolute/actual-browser-download.docx
```

未解决项继续保留：完整删除/离线输入竞争、任意custom mark、可编辑行内容器、复杂业务/Office往返、资源容量治理、历史压缩/GC和原完整目标的其他验收。此修复完善缺少codec时的保留语义，不宣称这些扩展已实现。
