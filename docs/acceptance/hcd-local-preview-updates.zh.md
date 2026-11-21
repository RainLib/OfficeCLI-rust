# 文档局部更新与 Agent 节点定位验收

2026-11-15。修复 Agent 标记在滚动后错位，以及编辑或协同版本变化造成整页重建、闪烁和返回顶部的问题。

## 实现

- Agent 箭头和操作效果放在文档画布坐标中，跟随实际节点及画布滚动、缩放；明确指定的节点不存在时，不再误指整页。重复页眉优先选取当前视口中的节点。保留连续移动轨迹、仅姓名标签及无边框操作效果。
- 普通画布通过 DOM、尺寸、滚动事件合并到下一动画帧测量，不再每 250 ms 追踪屏幕坐标。表格通过原生单元格锚点和原生命令更新几何，不再每 100 ms 轮询；跨冻结区域或滚动变换时更新锚点，保留同一支移动箭头。
- 固定版式预览使用稳定节点 ID 同步文本、属性和子树，保留未修改节点、图片和编辑器门户。修订通知通过 `htmlHash`、`mapHash` 判断需要更新的分片，复用内容寻址的图片资产；已访问页面保留挂载和高度。
- Word 在不可见的隔离 iframe 中准备分页，再把差异同步到可见 iframe；可见 Document 不导航。协同初次同步完成后才生成预览，后续切换协同版本时保留可见页面。
- 语义编辑器保留 EditorView，等待新协同房间同步后重新绑定新的 Y.Doc，不将旧 CRDT 内容合入新版本。未保存文字与表格草稿仍走原有冲突保护。
- 固定版式的文字编辑器直接在目标 iframe 内初始化，避免跨 Document 移动视图后选区监听仍留在外层页面；连续全选替换、输入与撤销继续使用真实编辑器事务。表格预览内的 Escape 使用相同的草稿保护关闭逻辑。

## 可重复验证

先准备包含 HCD 服务功能的 `officecli` 二进制，然后在仓库根目录运行：

```sh
cd examples/hdoc/editor
npm run build
OFFICECLI_BIN="$PWD/../../../target/debug/officecli" \
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm run test:workspace -- workspace.spec.ts agent-harness.spec.ts \
  --output /tmp/hcd-local-preview-regression
```

`OFFICECLI_BIN` 可指向已有构建；非 macOS 环境可省略 `HCD_BROWSER_PATH`，使用 Playwright 的 Chromium。测试创建独立文档，不修改演示工作区的现有文件。

重点断言：

1. `Local pptx/pdf edits preserve nodes, scroll and canvas anchors`：放大到 150%、滚动到文档后部，连续两次通过 MCP 修改文字。iframe、Document 和已有内容节点保持相同对象；不发生 iframe load 和节点删除；滚动偏差小于 2 px；浏览器仅读取被修改分片。继续滚动后，箭头与实际节点的位置误差小于 3 px。
2. `Word remote edits patch paginated nodes without navigating or resetting scroll`：滚动 750 px 后连续修改两次，原有页面与内容节点仍连接在相同 Document 中，滚动位置不变。
3. `semantic MCP commits refresh the browser across collaboration epochs`：两次 Agent 提交后，EditorView 容器与未修改段落保持相同 DOM 对象。
4. `a clean semantic epoch keeps the editor writable and undo local to the new room`：版本切换后继续输入、撤销并保存；撤销不影响已提交的远端内容。
5. 原有连续运动、Rank 公式及定位、冻结区域、离线草稿、表格冲突、多文档、历史版本、导出与图片流程回归。

## 本次验证结果

- `npm run build` 通过，包含 TypeScript 检查、独立页面与嵌入构建；日志：`/tmp/hcd-local-dom-build-current.log`。
- Agent 完整回归：50 项通过，输出：`/tmp/hcd-local-dom-harness-verified`。
- 工作区完整回归：41 项通过，输出：`/tmp/hcd-local-dom-workspace-snapshot`。
- 最新页面结构下再次验证 Rank 定位、PPTX/XLSX 连续轨迹、PPTX/PDF 节点保留和三种格式的操作队列：8 项通过，输出：`/tmp/hcd-local-dom-agents-snapshot`。
- `git diff --check` 通过。

工作区并行有其他页面修改，直接对开发服务器执行的中间轮次受热更新和测试标题变化打断。因此，最终工作区与 8 项重点复测使用当前代码的隔离副本；完成后比对 `src/` 与工作区一致。主题表格测试使用独立样本文档，避免读取先前编辑用例已修改的数据。测试运行真实 HCD 服务、协同侧车和 MCP 客户端，Agent 模型回复使用确定性脚本；此处不代表线上模型推理质量验收。

## 截图

- [PPTX：放大、滚动后完成两次局部修改](hcd-local-preview-updates/pptx-scrolled.png)
- [PDF：放大、滚动后完成两次局部修改](hcd-local-preview-updates/pdf-scrolled.png)
- [Word：远端修改后保持在第 2–3 页](hcd-local-preview-updates/word-scrolled.png)

Word 仍可能在后台重新计算分页几何；可见画布只同步差异。跨页重排可能影响多个页面。整稿重做、删除节点或切换历史版本，本身需要相应的内容替换；本次并未承诺所有复杂文档的转换与编辑都已完全兼容。
