# 行内容器：原生 DTO、空正文默认值与文件保存往返

2026-10-26。承接[递归来源范围](hcd-inline-source-bindings.zh.md)。本批接通显式内部编解码和正文来源默认值，用实际 HCD/Office 文件验证链路；不开放尚未完成的活动协作房间、公开 SDK 或插入菜单。完整七阶段目标保持，管理平台和实际提醒发送继续后置。

## 原生正文不再被空 wrapper 过滤

`projectionToJson(projection, {inlineContainers:true})` 与 `jsonToSnapshot(json, {inlineContainers:true})` 作为内部配套编解码选项，映射 native 的 `{text:'',content:{kind:'extension',extension,inlines}}` 与 `hcdExtensionInlineContainer`。父 wrapper 不存 fallback 正文，保留业务身份、未知业务版本、资源及导出适配声明；真实正文递归处理普通格式、自定义 mark、提及、软换行和嵌套/空容器。

默认调用仍拒绝新模型，不能因为 wrapper.text 为空而跳过其正文。公开 `schemaExtensions` 没有注册新节点，HTTP声明、wire7、现有 SDK envelope1/2 不变。新增内部 `SemanticInlineContainerNode` 供后续配套结构绑定使用，尚未提供业务 codec 的节点视图或 HTML 粘贴入口。

校验拒绝 wrapper 上的文字、来源、可见格式、隐藏字段或块内容；允许 Rust 序列化产生的 false 默认格式字段。跨根与 atom/container 的重复业务身份、代码块中的 wrapper、过深/过大内容拒绝；JSON 回写先作迭代式深度/工作量检查，再递归转换，避免在门禁前递归耗尽调用栈。各原生块的深度24、span1000、正文1MiB预算保留。

在新模式中，软换行沿用普通 inline 的完整格式处理，保留来源、自定义 mark 等。旧模式的序列化及冻结摘要规则不因此重写。

## 空正文的来源和字体归属

真实正文即使为空也有独立永久 Y.XmlText。其 `hcdSourceId`、`hcdSourceTypography`、`hcdSourceSizeExplicit` 放在正文载体的 XML 属性中，与不可变业务定义分开；读正文投影时合并为内部 PM 默认属性。定义中的来源默认值保持空值，因此规范来源回执不会被误认成业务属性修改。

递归 `sourceLeafActions` 为正文产生单独的默认值回执，包括空正文；回执不创建个人撤销记录、不改业务定义、不把保存后才插入的字符直接标为旧字符。永久载体属性随 Yjs 状态保存、同步和回读。

来源修复插件识别内部行内容器：首次向映射的空正文输入时继承该正文自己的来源与字体；没有自己的来源时，不借用外层段落来源或外层字体。普通段落原有行为保留。这里实现的是规范来源/字体默认元数据，不是新增任意空文本格式或业务属性候选协议。

## 实际文件链路

`scripts/hcd-inline-projection-files.py` 从已有自有 native r8 的 HCDZ 新建隔离、无源文件的文档副本；原归档逐字节不变。读取当前 Rust CLI 投影后，执行：

1. native DTO → PM → 五个独立正文载体；写入 `.yjs` 文件，销毁原文档后新建 Y.Doc 回读。连同来源 ID、资源、业务身份和全部正文的规范快照相等。
2. 向第一个正文精确追加“已回读”，并明确清空原“新内容”字段以验证空正文来源仍可保存，捕获三个根的递归来源范围，输出实际 block.replace 批次。
3. 当前 Rust CLI 将前端生成的批次保存为 r9，重新读取真实规范内容。
4. 将 r9 的规范来源回执绑定回实际字符和空正文默认值；包括来源 ID 的完整快照与 native 相等。回执不改变语义摘要。再次写文件、销毁并新建 Y.Doc 回读，仍精确相等。
5. 打包/解包实际 r9 HCDZ，规范内容精确相等；归档图片 hash/字节数相等。实际导出 DOCX/PPTX/PDF/Markdown，回读核对嵌套正文、四个人员提及、新增文字及主动清空字段不再输出旧文字；DOCX OOXML核对原有粗体/斜体。

原始产物及命令结果见[文件证据](../assets/hcd-inline-projection-2026-10-26/file-evidence.json)，前端检查见[验证摘要](../assets/hcd-inline-projection-2026-10-26/validation.json)。复现：

```bash
cd examples/hdoc/editor
node --import tsx --test src/semanticInlineProjection.test.ts src/semanticInlineSourceBindings.test.ts src/semanticInlineContainers.test.ts src/semanticInlineFlow.test.ts src/semanticTextFlow.test.ts src/sourceIdentity.test.ts
npm test
npm run build
cd ../../..
python3 scripts/hcd-inline-projection-files.py
```

新增11项回归；连同来源、内核、组合流、段落来源共82项定向回归，完整前端707项。测试包括空/嵌套正文首次输入、无来源时不借用外层默认值、迟到输入不盖旧来源、独立回执不造历史、不可变业务定义、坏默认值不分配/改写数据、读取未知元数据拒绝、重复身份、格式换行和默认模型仍拒绝。

首轮新测试有三个前提需要修正：手写稀疏 DTO 的省略字段与标准 false/null 字段不是同一原始摘要字符串；无 DOM 的 Tiptap 测试需显式配置真实插件；非法来源会在 PM 属性创建时就拒绝。修正断言和夹具后通过，未更改冻结摘要来迁就测试。构建另发现空值缩窄问题，修正后重跑。

## 尚未完成及验收边界

- 本批是真实 CLI/native 保存、来源回执和状态/Office文件证明；不是带签名的协调器 checkpoint、鉴权 socket、双端浏览器行内容器编辑、服务重启或生产验收。
- 结构 store/binding 的预检/永久分配、完整来源遍历与过期来源清理、签名捕获/回执许可、属性候选、未知 codec 保护、复制/粘贴新身份、行内删除审阅与历史仍须接入，之后再升级协作/公开 SDK 和菜单。
- 整段 diff 遇重复字符的精确 PM 事务位置提示尚未补齐；本批文件操作使用明确 Yjs 插入，不能据此宣称已解决。
- Markdown/PPTX 基础富文本格式仍有既有静态化/扁平限制；本轮验证其可读内容和资源兼容，没有把全部可编辑 Office 往返或 PDF 视觉布局当作完成。
- 未修改 Rust 源码，不将之前347项 native测试计作本轮新增测试；使用的当前二进制 hash 单独记录。长文容量/GC、国际化/输入法/设备与完整目标其余项继续。


后续已补[普通单步PM事务的精确文字位置](hcd-transaction-text-positions.zh.md)，修复重复字符时原始item/书签误认；多步事务和可编辑行内容器内部提示仍未接通。该后续批次有独立720项测试、真实socket/浏览器/实际文件证据，不改写本批原始验收范围。


后续已在[内部结构预分配与递归回执](hcd-inline-structure.zh.md)接通结构store、来源遍历/清理与个人历史，另有754项前端及实际文件证据；尚未开放活动binding/签名room/SDK/UI，未据此改写本批原始边界。
