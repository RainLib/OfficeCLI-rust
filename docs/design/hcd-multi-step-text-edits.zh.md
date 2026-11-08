# 多步文字操作、相同文字替换与协同光标

2026-10-26。延续[事务真实位置](hcd-transaction-text-positions.zh.md)，补齐活动结构编辑器的多步纯文字替换。完整七阶段目标继续；管理平台和提醒发送仍后置。

## 行为与实现

同一事务可以在一段或多段中执行多次文字替换。绑定逐步读取 PM 的实际操作位置，每一步都相对于前一步的结果，不再只比较最终整段文字。这保留了两次修改之间未变字符的 Yjs 身份，来源回执、离线同伴输入和相对光标继续关联这些原字符。

例如 `AAA😀AAA` 同时在前后插入 `AA`，原有字符仍保持原身份；程序化的组合输入 `n → ni → 你😀` 也按顺序处理，中间结果不会作为独立可见状态发送给同伴。最终格式独立核对，未改变的格式不重新发布，避免覆盖离线同伴的格式。

还有一个需要单独处理的情况：删除一个 `A`，在末尾重新插入 `A`，最终仍是 `AAA`，但原字符的身份已经变化。共享写入不能因最终内容相等而省略；远端视图也必须重新解析相对选区，即使不用替换任何可见正文。下一次同伴输入因此跟随原字符的实际位置。

| 情况 | 当前行为 |
| --- | --- |
| 同段单步关闭替换 | 保留已有单步精确区间路径 |
| 多步纯文字替换，可跨不同段落 | 逐根收集按时间排序的步骤，完整预检后写入 |
| 附带格式/来源 mark 修复 | 依据最终节点核对格式，不重发未改格式 |
| 后续步骤无效、半个 UTF-16 surrogate、目标不符 | 任何共享修改和新块分配之前拒绝 |
| 最终文字相同的删除重插 | 记录真实身份变化，重新定位同伴光标 |
| 开放 slice、结构拆合、atom 增删、非叶行内容器 | 保留既有处理；不为混合操作发布部分文字提示 |
| 超出每根 256 步或 800 万模拟工作量 | 拒绝整次操作并提示缩小选区/分批处理，原文和草稿保留；后续小操作可继续 |

事务提示只存在于本机内存，不写入业务文档、不增加 wire 字段，也不替代权限和内容校验。全部根的操作先预检，第二根失败不会先修改第一根或分配附加新块。工作量限制是保护上限，不是长文本性能验收；当前仍有全文扫描。

## 证据

新增 17 项回归；相关多步、单步、结构绑定和文字流共 74 项通过，完整前端 737 项通过。覆盖原 item ID、两个更新顺序、组合输入事务分组、跨段、已合并的永久载体、格式/业务 mark、迟到来源回执、只读和容量拒绝后继续输入。

本机真实 Hocuspocus 连接使用生产 PM 绑定和 native 保存协调器：

1. 初始两段 `AAA😀AAA`、`BBB`，Bob 离线；Alice 一次事务修改两段并保存 r2。
2. Bob 在旧版本第一段原字符间输入 `Peer`，第二段程序化执行 `n → ni → 你😀`，重连保存 r3。
3. Alice undo/redo 为 r4/r5，Bob undo/redo 为 r6/r7；自己的撤销始终保留对方内容，两根顺序和全部原字符身份不变。
4. Alice 在第二段删除一个自己插入的 `B`，并在末尾插入 `B`；可见文本不变，同伴光标偏移从 4 变为 3。磁盘新 Y.Doc 回读证实身份变化；语义没有变化，native 版本保持 r7。
5. Bob 直接在修正后的光标输入 `C`，保存 r8 得到 `你😀CBBBBB`。每次从真实持久文件验证 HMAC 回执、规范摘要和原字符身份/偏移。

真实文件审计逐份核对无源 HCDZ 中 r1–r8，比较完整规范块 `r2 == r6`、`r3 == r5 == r7`，并实际导出/回读 DOCX、PPTX、PDF 和 Markdown 的正文。审计排除唯一运行时锁 `.hcd-write-lock`，其余原生文档内容逐字节保持。

证据：[双端及持久状态](../assets/hcd-text-edits-2026-10-26/socket-evidence.json)、[实际文件](../assets/hcd-text-edits-2026-10-26/file-evidence.json)、[检查摘要](../assets/hcd-text-edits-2026-10-26/validation.json)。

```bash
cd examples/hdoc/editor
node --import tsx --test src/semanticTextEdits.test.ts src/semanticTextSplice.test.ts src/semanticStructureBinding.test.ts src/semanticTextFlow.test.ts
npm test
npm run build
cd ../../..
# 在自有临时文件中准备 <p>AAA😀AAA</p><p>BBB</p>，创建新的隔离预览：
python3 scripts/hcd-mention-preview.py --runtime-dir target/hcd-preview-runtime --source-html <输入HTML路径> --pages-prefix .hcd-text-edits-check --checkpoint-probe
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-text-edits-socket.mts <新预览root>/private.json
python3 scripts/hcd-text-edits-files.py <同一预览root>/private.json
```

脚本要求初始 native r1，不能重复运行在已经修改的 fixture 上。私有凭证和签名不进入公共报告；运行目录保留用于重现。

## 仍未完成

这里的组合输入是 PM 事务和 composition 元数据驱动的真实协作测试，不代表 macOS/Windows 实际中文输入法的端到端验收。没有把短段落验证当作长文本延迟或容量通过，也未新增 Office 桌面、PDF 视觉布局或生产服务验收。活动可编辑行内容器的结构预分配、签名来源回执、属性意图、删除/复制/历史、模型门禁与 SDK/UI 配套仍需继续。Rust 本轮未改，不重复计入以前的原生单元测试。
