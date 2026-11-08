# 行内容器：结构预分配、个人历史与递归来源回执

2026-10-26。承接[原生转换与正文载体](hcd-inline-projection.zh.md)，把它们接入内部 `SemanticBlockStore`。完整七阶段目标保持，管理平台和实际提醒发送后置。

## 分配与用户编辑分开

`SemanticInlineContainers.prepare(roots)` 对整次操作的全部文字根预检；`allocate()` 执行前再次检查当前定义、身份和容量，再在独立分配 origin 中创建永久定义和空正文载体。任何后续根校验失败都不会先分配前面的根。存在新增正文时，仍拒绝继承外层个人事务的 origin。

结构存储通过显式内部参数 `{inlineContainers:true}` 使用这一准备阶段，初始化、创建节点、跨段移动和已有正文修改共用它。新父段落先只写容器引用，不改正文；正文修改留在随后的用户事务。这样，“把已有字段移到新段落并同时改字”可以通过个人撤销还原正文，永久正文载体本身不被撤掉。

整篇文档检查容器身份与旧行内/块扩展身份的冲突，跨根重复实例拒绝。嵌套与空正文仍是各自独立的 `Y.XmlText`，父段落没有复制其正文 JSON。业务定义仍不可变，字段候选/迁移协议尚待接入。

## 存储模型与活动协议边界

内部结构元数据增加 `inlineContainers:1`。默认结构存储明确拒绝读取它；内部模式也拒绝把未声明该模型的旧存储自动升级。仅有这一声明、尚无正文载体时，wire7 的影子检查也会拒绝，拒绝后正常更新仍可通过。

没有把内部模式加入活动编辑器、公开 schema/SDK、协作协商或插入菜单。活动 wire7/envelope1/2 不因此获得新正文的读写能力。结构 PM binding 的精确正文位置、签名保存捕获、属性/删除/复制等仍需配套后才能开放。

当前内核支持移走同一引用；从保留文字根中删除行内容器，则在共享修改之前抛出 `inlineContainerDeletionRequiresReview`，等待专门的行内容器删除审阅。不能把这一拒绝称为删除功能已完成。整个块的永久隐藏仍沿用现有块回执。

## 历史与来源

个人历史纳入正文载体；结构历史的副本使用同样的内部模型。结构撤销的外来内容检测会遍历可见嵌套正文的字符和格式，不再只看父段落的一个引用。正文文字自己的撤销保留同伴输入；如果撤销外层创建会把同伴正文隐藏，当前会明确拒绝，不静默隐藏。未来需要把这条路径接入删除审阅和恢复。

来源捕获覆盖各正文的字符来源和空正文默认值。规范回执的允许来源集合递归包含内部 inline，回写使用显式内部 DTO 转换及已有 v2 字符范围绑定。来源清理也扫描保留但隐藏的正文，清除失效来源 mark/default，正文与不可变业务定义不变。所有回执预检先于元数据事务；迟到的新增文字不会被标为旧字符，回执不产生个人历史。

## 验证

新增17项回归，71项相关来源/历史/模型/载体专项、完整754项前端通过，TypeScript与独立/嵌入构建结果记录在[检查摘要](../assets/hcd-inline-structure-2026-10-26/validation.json)。包括：

- 多根预检与分配原子性、跨块/atom实例冲突、准备后定义变化、外层个人事务拒绝。
- 嵌套/空正文初始化、正文载体保留、移动到新段落同时编辑的 undo/redo、双方离线正文合并和相对位置。
- 显式模型门禁、wire7 在无正文时也拒绝未来模型且不污染后续影子验证。
- 递归来源/空默认值、迟到正文输入、隐藏正文失效来源清理、无效回执不改共享字节。
- 外层创建撤销不能隐藏同伴正文；正文自己的撤销仍保留同伴输入。

实际文件链路使用已有自有 r8 无源 HCDZ 的新副本：native DTO → 内部结构初始化 → 写 `.yjs` 并销毁/新建 Doc → 结构 reconcile 追加“已接入结构”并清空一个字段 → 精确个人 undo/redo → native CLI 保存 r9 → 完整结构来源回执 → 再次销毁/文件回读。经官方 DTO 编解码统一省略字段形状后的完整快照（包括来源 ID、业务数据中的 null/false/空值）精确相等，空正文来源保留，来源回执不改变语义摘要或个人历史。

新 r9 归档再解包完整精确，图片 hash/字节数精确；真实 DOCX/PPTX/PDF/Markdown 文件回读核对嵌套正文、人员姓名和主动清空字段。DOCX OOXML 另核对原有粗体/斜体。原始归档 hash 不变。[实际文件证据](../assets/hcd-inline-structure-2026-10-26/file-evidence.json)与产物保留在同目录。

```bash
cd examples/hdoc/editor
node --import tsx --test src/semanticInlineStructure.test.ts src/semanticInlineContainers.test.ts src/semanticInlineFlow.test.ts src/semanticSourceBindings.test.ts src/structuralUndoGuard.test.ts src/roomProtocolGuard.test.ts
npm test
npm run build
cd ../../..
python3 scripts/hcd-inline-structure-files.py
```

本批文件脚本依赖仓库中的自有 `inline-native-r8.hcdz`，每次新建隔离副本，不改原归档。实际 native 二进制 hash 在报告中记录；Rust 本批未修改，不重复计入旧 Rust 单元测试。

## 继续项

仍需接通 PM 事务在非叶行内正文里的精确位置、结构 binding 与签名 coordinator、属性候选/迁移、删除审阅/恢复、复制新身份/剪贴板、缺 codec 的只读视图以及升级后的协作/SDK/UI。当前不是双浏览器或带签名 socket 的行内容器验收。实际操作系统输入法、长文本容量、Office 桌面/PDF视觉、服务重启和生产验收仍未据此完成；PPTX/Markdown 的原有富文本静态化限制保持。

## 2026-10-27 后续精确绑定

后续已接入内部 PM 多步文字事务，包括父/子正文存储坐标、原字符身份和完整批次预检；有独立浏览器与原生文件证据，见[精确绑定](hcd-inline-binding.zh.md)。此前本批754项结果仍为历史依据，签名房间、属性/删除审阅及公开 SDK 继续保留为开放项。
