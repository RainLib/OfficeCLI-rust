# 文档内表格直接编辑验收

分支：`feature/hcd-font-format-integration`。

问题来自原先的 opaque 表格 NodeView：表格在 inert iframe 中只读展示，按钮另开弹窗，通过 textarea 修改后再提交。现在直接在文档中的原单元格输入，保留源表格 DOM、字号、颜色、边框和合并关系，不增加编辑卡片或单元格选中框。

## 实现

- DOCX、HTML、Markdown 投影用 `editableTextNodeIds` 声明可编辑的表格文字节点。外层表格仍保护结构；内部 `hcdOpaqueRun` 保存原 nodeId，文字变更进入正文的同一 Y.Doc，支持字符协同、撤销重做、纯文本粘贴与 Tab 导航。
- 普通键入更新实际 run 的 Text 节点，NodeView `update` 保留 iframe、表格与段落。编辑与预览切换只更新输入权限；历史版本、只读文档不能输入。中文组合输入保留当前原生 DOM，将远端事务映射后再合并。
- 表格文字取得焦点时，正文的格式/结构工具暂停操作，避免修改上一次正文选区；保存和撤销仍可用。返回正文后恢复。
- sidecar 一次性迁移旧 opaque 协同状态，保留已有正文草稿，重复加载不重复插入 run。
- checkpoint 不归并表格的源 run，保留空 run、顺序、marks、font 和 source anchor。仅允许声明可写节点的文字变化；格式、源身份、受保护文字或表格结构变化使整个 checkpoint 失败，正文也不会部分写入。
- 保存点先确认共享 checkpoint，再允许后续导出或 Agent 操作。MCP 仍核对 revision、epoch、nodeHash 和 pending marker。保存状态按已确认的历史 revision 核对，并归并等价的文字分段，避免已保存草稿误报冲突。

## 验证命令

使用公开样例 `word-table-edit.docx`，含纵向合并、蓝色粗体与绿色斜体的两个文字 run。浏览器测试启动临时 API、sidecar 与 UI，不接触私人合同。

```bash
cargo test -p hcd-core structure::tests
cargo test -p officecli --bin officecli hdoc_server
cargo build -p officecli
cd examples/hdoc/editor
./node_modules/.bin/tsx --test src/opaqueTable.test.ts src/textRunEdits.test.ts
npm run build
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  ./node_modules/.bin/playwright test e2e/workspace.spec.ts \
  --grep 'complex Word tables|Word table text editing|Word table edits share|inline Word table keyboard|HTML and Markdown source tables|inline tables keep' --reporter=line
```

验证内容包括：直接输入、Unicode/emoji、源 run 保留、双窗口同步、撤销重做、MCP 接续与旧版本拒绝、编辑/预览权限切换、深色界面、非法 checkpoint 整批拒绝、长表格滚动和输入法并发，以及刷新重开与导出。

DOCX 源格式导出逐一比较 ZIP 部件：仅 `word/document.xml` 中目标文字变化，其他部件完全相同。HTML/Markdown 验证保存、重开和目标格式中的表格语义，不承诺原文件字节不变。

本次执行：10 项浏览器回归、58 项服务端测试、10 项结构测试、3 项共享状态/run 测试通过，前端构建与 Rust 格式检查通过。验收截图：[原位输入](hcd-inline-table-edit/word-table-text-editor.png)、[协同](hcd-inline-table-edit/word-table-inline-collaboration.png)、[长表格滚动](hcd-inline-table-edit/word-table-inline-at-scroll.png)、[深色](hcd-inline-table-edit/table-inline-dark.png)。

## 当前范围

支持已有可写源文字节点（包含空 run）的文字编辑。后续已补齐表格插入、增删行列及结构撤销，详见[结构与撤销验收](hcd-table-structure-undo.zh.md)。新建单元格直接可写；结构编辑会为完全空白且无源文字的普通单元格补齐可写节点。合并/拆分、任意表格样式及任意图片对象编辑仍未开放。只读字段保持只读。离线未同步草稿尚无 IndexedDB 持久化；不宣称任意复杂对象编辑或跨格式无损。
