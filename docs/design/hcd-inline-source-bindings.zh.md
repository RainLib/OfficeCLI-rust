# 行内容器：递归来源捕获与保存摘要

2026-10-26。承接[组合文字流](hcd-inline-flow.zh.md)。本批实现内部来源范围与语义摘要，不启用活动结构保存或浏览器行内容器；完整七阶段目标、管理平台/实际提醒后置约束保持。

## 来源范围按实际载体递归

原平面 `SourceLeafBinding` 要求字符范围总长度等于 PM content 大小。行内容器的父 embed 长度是1，PM大小却是正文大小加2，不能沿用这个假设。

现在包含容器的层使用 version2：

| 字段 | 含义 |
|---|---|
| `size` | 本层 PM content 大小，包含展开的子正文及 wrapper 边界 |
| `storedSize` | 本层实际载体长度，每个容器引用占1 |
| `pieces` | 本层原始 Yjs carrier/client/clock/length，offset 使用本层存储单位 |
| `containers` | 按本层引用 offset 排序的 occurrence ID 及该正文的独立 binding |

没有容器的层继续输出原有 key/shape/size/pieces，**不增加 version 或其他字段**。因此既有合法平面捕获的序列化不变。内部正文若仍包含容器就继续递归，否则其子 binding 可使用原平面形状；空正文保留大小0的独立 binding。

来源内容 hash 包括文字、提及/atom/容器身份及递归正文，忽略可变来源 mark。应用前对照已保存的期望内容，逐层检查 hash、大小、身份和引用 offset，拒绝重复身份、未知字段、未来模型、错载体/范围及结构不一致。深度24、总容器1000、总 piece 100000等边界有校验。wrapper 边界不属于正文字符，也不获得来源 mark。

每层分别按实际 Yjs item 身份产生来源格式动作：

- 父级或内部有新插入时，仅绑定捕获过的字符；不把后来的字符标成旧来源。
- 子节点移除、相同文字复制成新 occurrence 时，旧来源不会重定向给新 occurrence 或后方正文。原隐藏载体仍可接收原版本的非可视来源回执。
- 段落切分/合并后，捕获的父字符和内部字符各自沿永久载体绑定，不依赖当前屏幕偏移。
- 当前子正文恰好匹配期望内容时，可独立重新捕获撤销后复活的字符；父段落出现其他新增内容不会妨碍这一步。
- 处理只修改 `hcdSource`，保留业务数据、可见格式、custom mark 和提及，不增添用户撤销记录。所有校验先于动作执行，负例不改变共享字节。

`validateSourceLeaf` 默认只接受旧模型。保存协调器恢复来源目标时，依据实际结构实例是否启用新内核，显式传入模型许可；当前活动 store 未启用，因此 version2 会拒绝，不能作为旧回执忽略掉。

## 内部 DTO 与语义摘要

内部 `Inline` DTO 增加 native 的 `content` 类型，公开节点 SDK 仍为 envelope1/2、blocks-v1，`projectionToJson` 的旧模型拒绝保持。没有因此增加协作声明、HTTP能力头或插入菜单。

当前语义摘要递归去掉子正文的来源 ID、合并同格式普通文字；来源回执本身不会让同一正文变成一次新编辑。业务 `data.nodeId` 等字段仍保留，修改业务身份、文字、格式或子引用结构会改变摘要。容器 wrapper 不合并；native 的空来源占位不会生成可见正文。空内容的来源默认值还需单独绑定，并未在本批实现。

冻结的 v1 回执函数保持旧行为：不进入此前未知的 `inline.content`，保留内部来源 ID，平面序列化也有固定字符串回归。没有以新归一化规则重写既有 v1 签名语义。

## 验证及边界

新增9项递归来源和3项摘要回归；连同原来源/摘要测试共22项专项通过。覆盖两层正文、空载体、中文/emoji、粗体/custom mark、提及/软换行、精确的父级与内部并发插入、旧节点替换为新身份、拆合、撤销复活、JSON捕获和新Y.Doc回读、个人历史、错误模型/几何/范围不改字节。完整前端与构建结果见[检查记录](../assets/hcd-inline-source-2026-10-26/validation.json)。

```sh
cd examples/hdoc/editor
node --import tsx --test src/checkpointSnapshot.test.ts src/semanticInlineSourceBindings.test.ts src/semanticSourceBindings.test.ts
npm test
npm run build
```

首轮测试用整段 PM 投影重构模拟 `PREFIX` 插在 `P😀` 前，原文字 diff 可复用相同的首个 P，因此“PREFIX 的每个字符都刚创建”的测试前提不成立。现改用实际 Yjs 精确插入，建立可审计的字符身份。这验证回执按真实 item 范围绑定，**不证明整体投影 diff 能保留重复字符输入的原操作位置**；结构 binding 接入前仍须处理 PM 事务位置提示。首轮 TypeScript 也发现测试 helper 的只读数组声明不匹配，修正后重验。

本批没有新 native checkpoint、HTTP/socket、浏览器、HCD/HCDZ或Office导出验收，没有 Rust 修改。旧模型拒绝仍有效；不能把这些内核测试当作“保存链路已打通”。

下一步依次接：native inline DTO 与 PM 的明确转换、空正文来源/字体默认值、全部内部来源遍历与过期来源清理、签名捕获/回执和结构预分配阶段；再接属性候选、缺codec保护、删除审阅/历史及配套协同模型，最后进行真实双端保存重开和实际导出。长文容量、格式往返、国际化/输入法/设备与完整目标其余项继续。


后续已接通[内部 native DTO/PM 转换、空正文来源/字体默认值及实际 r8→r9 文件往返](hcd-inline-projection.zh.md)；原生/Office文件证据属于该后续批次，不改写本批687项内核测试的证据范围。签名协调器、结构活动绑定与其他开放项仍需继续。


后续已补[普通单步PM事务的精确文字位置](hcd-transaction-text-positions.zh.md)，修复重复字符时原始item/书签误认；多步事务和可编辑行内容器内部提示仍未接通。该后续批次有独立720项测试、真实socket/浏览器/实际文件证据，不改写本批原始验收范围。
