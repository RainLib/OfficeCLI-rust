# 全局 AI 正文撤销与同段协作

适用范围为工作台对 DOCX、Markdown、HTML 和 TXT 正文选区执行的改写。撤销时按段落身份和当前修订读取内容，恢复 AI 替换前的文字及格式，并保留同段中后续输入的可区分文字及格式。改写结果内部插入的文字会保留在恢复的原句之后；原句与改写句之间没有足够信息来确定原始插入位置。

AI 新增段落也使用同样的文字归属检查。段落未变化时整段删除；同事补写后，仅移除可唯一识别且格式未变化的 AI 文字，保留补写、其字符格式及当前段落结构。新增身份由文件 ID、提交 ID 与操作序号生成，并与原作者的新增回执逐项核对，不依赖回执或显示顺序，也不需要新增历史读取权限。归属不明确或 AI 原字已被改写时拒绝整次撤销。

位置映射检查所有最短字符插入/删除对齐。只要存在最短对齐会删除某个 AI 字符，或同一字符可能映射到多个位置，就拒绝撤销并保留当前内容。AI 文字被他人修改、格式改变、文本归属不明确或目标段落消失时也拒绝；空替换使用同样的唯一位置约束。仅有插入的长段落通过从前、从后匹配来判断唯一性，计算随文字长度线性增长；同时存在删除时，按一次撤销最多 400 万个矩阵格计算，超出后使用原有的精确上下文匹配，仍无法定位则拒绝。该判断使用当前文字而非 CRDT 逐字符因果身份，不能证明所有历史编辑的真实归属。

提交继续使用当前段落 hash、文档修订及协作代次作为守卫。若协作服务已将协作者输入标记为尚未落盘，服务拒绝本次撤销；输入完成检查点后可以重试。客户端尚未送达协作服务的输入不在这项服务端守卫的可见范围。表格单元格和白板对象仍使用各自的撤销规则，不属于上述同段文字合并范围。

## 验证

```bash
npm test --prefix apps/workspace
OFFICECLI_WORKSPACE_DIST=/path/to/built-workspace HCD_BROWSER_PATH=/path/to/chrome \
  npm run test:workbench-undo --prefix apps/workspace
OFFICECLI_WORKSPACE_DIST=/path/to/built-workspace HCD_BROWSER_PATH=/path/to/chrome \
  OFFICECLI_UNDO_CASE=pending npm run test:workbench-undo --prefix apps/workspace
OFFICECLI_WORKSPACE_DIST=/path/to/built-workspace HCD_BROWSER_PATH=/path/to/chrome \
  OFFICECLI_UNDO_CASE=append npm run test:workbench-undo --prefix apps/workspace
```

本地测试通过 41 项工作区单元测试，包含一万余字长段落的插入定位。独立启动的工作区使用两个不同账号与浏览器会话：第一项在 AI 改写句中插入协作者文字，撤销后检查双方页面、刷新、服务端正文和源格式 DOCX；第二项在撤销请求准备完成后插入尚未保存的文字，确认请求被拒绝，检查点完成后重试成功，且双方及导出的 DOCX 均保留输入；第三项在 AI 新增段落内部插入加粗的补写，撤销后仅留下加粗补写，并在原格式导出、重新上传和打开 Word 后核对格式。计划使用本地确定性指令，没有调用真实模型。验证限于该 DOCX 样例，不代表任意格式与所有并发场景均已验证。

本轮主工作台回归另通过 36 项检查，包含三文件审核与回执恢复、逐项撤销、MCP 外部编辑、CSV/TSV、资源引用与图表移位、依赖任务重新核对、项目目录，以及 PPT、Excel、Word 对象的原格式导出重开。其入口为 `npm run test:workbench --prefix apps/workspace`。这些检查不等同于完整 Office/WPS 排版保真或所有并发场景验收。

## 表格同格撤销的当前阶段

2026-11-20 的后续实现为新的工作台 XLSX 任务保存原生富文本片段，在撤销时恢复原文字和格式，并保留可唯一识别的后续补写。新增 `hcd-patch/65` 将富文本恢复、数值恢复和未被后续修改的新建格清理放在一次原子提交中；旧服务需先通过能力协商。CSV/TSV 采用纯文字映射。数值或类型被协作者改变、AI 文字及其格式被改变、映射有歧义时仍拒绝，不覆盖现有编辑。旧任务缺少原生格式基线时不能补算出已经丢失的格式。

本阶段工作区单元测试 **46/46**、核心 **145/145**、格式 **226/226**、能力协商 **2/2** 通过。原生 XLSX 用例验证混合操作失败全部回滚、成功提交的幂等重放、源格式导出重开保留补写及双下划线/颜色，并确认数值恢复和新建格消失；JSON Schema 2020-12 检查验证混合批次及非法属性/缺少富文本操作的拒绝。此前 41 项单元测试为正文阶段记录，不与本阶段相加。

真实双账号验证通过：管理员在工作台审核并应用 A2:D2 的 AI 修改；另一个账号在 AI 文字中插入带下划线的 emoji，并补写一个 AI 新建格，再在该行之前插入新行。管理员刷新后从任务回执撤销，在一个新修订中恢复原有三段富文本和数值、保留两处人工补写，只清空未被继续编辑的新建格。两端实际复制 A3:D3 的结果均与服务端一致。源格式 XLSX 下载、重新上传、节点片段和重新打开的网格均核对通过。使用本地确定性模型输出，没有调用真实供应商；本例通过不代表任意编辑归属都能自动合并。

验证中修复了两处断点：宿主 AI 已提交的回执现通过现有协作通道通知其他固定版式客户端，由 sidecar 核对服务端修订后广播；插行/列后的原格式导出允许原生行内富文本属性和注音偏移随单元格保留，只在字符串内部开放这些标签。四类行列增删分别验证文字、格式、原始富文本 XML 和注音保持；字符串外部的同名标签和未知扩展仍被拒绝。

```bash
OFFICECLI_WORKSPACE_DIST=/path/to/built-workspace HCD_BROWSER_PATH=/path/to/chrome \
  npm run test:workbench-sheet-undo --prefix apps/workspace
```

[双账号结果](hcd-workbench-selective-undo/sheet-validation.json) · [撤销后](hcd-workbench-selective-undo/sheet-undo.png) · [原格式重开](hcd-workbench-selective-undo/sheet-undo-reopened.png)。新增工作台 CI job 配置了完整构建、主工作台及正文/表格双账号撤销回归；远端运行尚未验收。

本轮更新后，编辑器独立/嵌入及工作台构建通过，主工作台再次完成 **36 项**回归，包含真实表格 → Word → 白板的依赖任务、失败文件重新核对、逐文件撤销、资源区域移位及三类 Office 原格式重开。该组合首轮发现刷新 Word 后点击批注定位时浏览器选区可能为空；定位改为由 Tiptap 在侧栏点击和布局更新后恢复焦点与选区。随后审阅专项两项及最终完整组合均通过，包含批注的回复/解决/重开和原生文字修订的接受/拒绝。可用 `npm run test:workbench-review --prefix apps/workspace` 单独复现审阅流程。

[最终工作台结果](hcd-workbench-selective-undo/workbench-validation.json) · [审阅专项结果](hcd-workbench-selective-undo/review-validation.json) · [审阅界面](hcd-workbench-selective-undo/word-review.png)。这些结果是本地隔离服务与浏览器验收，没有进行本轮真实模型、远端 CI 或 Word/WPS 的逐页排版对照，也未重启日常业务实例。

## 当前构建复验

协议指纹 `b09a50c9aede5d778995be061dbd4b0a9c49d8d573d5a1e395114f58de71d016` 的工作台再次通过正文、未保存并发输入、AI 新增段落和插行后原生富文本表格四组双账号复验。[正文](hcd-workbench-selective-undo/word-current-validation.json) · [未保存输入守卫](hcd-workbench-selective-undo/pending-current-validation.json) · [新增段落](hcd-workbench-selective-undo/append-current-validation.json) · [表格](hcd-workbench-selective-undo/sheet-validation.json)。当前主工作台结果为 39 项，包含后续加入的页边批注、母版文字、原生对象和恢复能力；前述 36 项为当时的历史记录。

2026-11-21 的最终构建使用协议指纹 `9dd62f7cf9f39d9ac1f31f538be07c2c9e4fc0ad23e40889da2df3d16a98fdac`，主工作台再次通过 **42 项**。新增的三项覆盖 Word 原位合并/拆分、双页面结构撤销保留其他正文、源格式 DOCX 重开。表格双账号同格撤销在工作簿焦点约束更新后也重新通过；读取与实际输入、原生样式和源格式重开保持一致。以上链接中的主工作台结果已更新为本次最终构建；更早的 36/39 项记录保留用于说明验证阶段。
