# 行内容器：接入组合文字流与拆合位置

2026-10-26。承接[永久载体内核](hcd-inline-carriers.zh.md)。本批将内核接入 `SemanticTextFlow` 的显式内部模式，仍未开放 SDK、活动结构房间或浏览器编辑入口。完整七阶段目标继续，管理平台与提醒发送继续后置。

后续已补齐[递归来源范围与语义摘要](hcd-inline-source-bindings.zh.md)内核，原生DTO/签名回执、空正文默认值和活动结构绑定仍未接通；下列675项为本批原始结果。

## 已接入的链路

内部宿主可以向 `SemanticTextFlow` 显式传入同一文档、schema、用户事务 origin 的 `SemanticInlineContainers`。父级 Map 也必须属于同一文档；不匹配在读取/修改共享内容前拒绝。现有活动 `SemanticBlockStore` 仍未传入此选项，默认文字流继续拒绝新模型。

```ts
const containers = new SemanticInlineContainers(document, schema, origin)
const flow = new SemanticTextFlow(document, carriers, schema, origin, containers)
```

组合文字流的 adapter 跨多个永久父载体读取/写入，过滤已有拆分边界。行内容器在父载体仍占一个 embed，内部文字从独立载体展开。普通 atom 的属性/提及存储转换继续复用既有 storage 函数；本批将所有叶子转换预检并缓存，再分配或修改载体，防止后面一个叶子转换失败却已改写前面的正文。返回未知属性、隐藏 content 或更换节点类型的转换也拒绝。

## 拆分、合并和书签

| 场景 | 处理 |
|---|---|
| 容器引用之前/之后拆段 | 先将 PM 偏移映射为父载体偏移，再插入永久边界；不复制容器正文 |
| 容器内部调用段落拆分 | 明确拒绝，字节不变；内部软换行或容器专用操作应由后续编辑命令实现 |
| 两端在引用两侧分别拆段 | 容器仍只出现一次，内部离线输入合并到同一正文载体 |
| 合并多个父载体 | 沿用 flow links/order；内部文字不搬家，内部及外部书签解析为合并后的 PM 偏移 |
| 内部光标 | `TextFlowPoint` 保持 `{carrier,relative}` 字段，relative 指向实际子正文；carrier 保留父引用所属的物理载体 |
| 第二个载体以容器开头 | 内部书签保留第二载体，不能误取前一载体末尾的插入边界；已补回归 |
| 隐藏/多个候选父级 | 调用方可提供可见 roots；默认出现两个父引用时拒绝歧义，不任意选择一个 |

普通父级字符书签也重新映射为展开后的 PM 偏移，因此容器正文增长不会让后方光标停在旧位置。空/嵌套内容、UTF-16 emoji 与各载体接缝的全部 PM 偏移有往返回归。

文字流个人历史范围现在在内部模式包含子正文，但不包括定义与永久分配元数据。自己的正文撤销保留同伴内容；撤销拆合不会撤销同伴的内部输入。新增分配不能发生在外层用户事务内：Yjs 嵌套事务会继承外层 origin，可能使永久 Map 条目进入个人撤销。当前遇到此情况要求先准备载体，原文不变；**活动结构 binding 后续必须实现该准备阶段，不能直接套用此 opt-in 开启功能**。

## 验证

新增17项组合文字流回归，与16项载体内核和16项原文字流测试共49项专项通过：

- 两种更新顺序下的引用前/后拆分、合并期间离线正文输入、父/子光标及自己的撤销/重做。
- 多父载体的正文合并、来源 mark 的实际 `nodeId`、自定义 mark 与永久正文对象身份保持。
- 同时从两侧切分，以及三个离线副本在乱序拆合与内部插字后，每个插入字符/容器身份只出现一次并收敛。
- 所有 PM 偏移往返、引用位于合并接缝、歧义父级及可见范围、转换失败/非法拆分/错误宿主不改共享字节。
- 实际写入 `.yjs` 与书签 JSON 临时文件，销毁原来的全部 `Y.Doc` 后，新文档从文件回读组合根与书签，继续编辑同一正文载体。临时文件在测试结束后清理。

完整前端、TypeScript、独立/嵌入构建和 source hash 见[检查记录](../assets/hcd-inline-flow-2026-10-26/validation.json)。复现：

```sh
cd examples/hdoc/editor
node --import tsx --test src/semanticInlineFlow.test.ts src/semanticInlineContainers.test.ts src/semanticTextFlow.test.ts
npm test
npm run build
```

这里的文件回读仅证明内部 Yjs 快照与书签；不是 native HCD/HCDZ、Office 导出、生产持久化服务或重启验收。本批没有 Rust 修改，也没有把之前的 native 文件或浏览器结果计作本批新增验收。

## 仍须完成

1. 将新模式接入结构 store/binding 的完整预检和分配阶段，以及活动根范围；禁止跨根复用身份，复制/粘贴分配新身份。
2. 后续已补递归捕获各正文永久字符范围与 wrapper 边界，仍需接入签名快照/回执、空正文默认值及 native inline.content 转换；保留 mark 身份或内核范围测试不等于实际回执链路已实现。
3. 接入属性候选、未知 codec 只读保护、内部 atom/容器删除审阅和历史保护，完成保存/导出门禁，防止迟到内容在隐藏载体中无人审阅。
4. 更新配套协同模型/SDK能力与只读节点视图，再做真实 socket、双端浏览器、保存重开和实际多格式文件验收。
5. 继续原计划其余格式保真、长文容量/GC、国际化/输入法/设备及生产验收。当前 wire7、公开 envelope1/2、blocks-v1 和 native 的 inline 模型声明门禁保持不变。
