# 左右侧栏与 dark 配色补充验收

此处保留上一版的验收记录。收起后保留导航栏的方案已按最新要求改为完全释放空间，当前行为与截图见[侧栏收起释放空间](hcd-sidebar-space-reclaim.zh.md)。

设计依据：[officecli-workspace-v2.pen](../design/officecli-workspace-v2.pen) 的 `XNTdh`（全部收起）与 `HRzgj`（AI 工作台）。

## 本轮修正

- 顶栏提供独立的左侧栏、右侧栏开关；抽屉内保留收起按钮。收起后显示 52px 宽、与内容区等高的圆角导航栏，可直接进入目录、搜索、AI、历史和设置。
- 右侧 AI、设置、历史共用互斥的面板状态；关闭 AI 后保持收起，不会重新露出此前打开的设置或历史。展开时恢复最后使用的右侧面板，刷新后保留选择。
- 修复旧样式把收起栏强制设为白色、限制侧栏高度的问题。深色使用石墨灰背景、分层灰色面板、浅紫色强调色，覆盖收起栏、聊天输入、工具栏、菜单和弹窗。
- Markdown / TXT 编辑纸面、文字、代码与表格跟随 dark 配色；Office / PDF 文档内容保留源文件的颜色。
- 抽屉进入采用短距离位移和淡入，尊重减少动态效果的系统设置。切换侧栏或主题保留原画布、聊天草稿、历史定位和缩放。
- 修复焦点位于表格预览 iframe 时 Esc 无法关闭表格弹窗的问题；未提交修改仍经过原有的放弃确认。

## 效果截图

- [深色双侧展开](hcd-pen-drawers-v2/expanded-dark.png)
- [深色仅收起左侧](hcd-pen-drawers-v2/left-collapsed-dark.png)
- [深色双侧收起](hcd-pen-drawers-v2/both-collapsed-dark.png)
- [浅色双侧收起](hcd-pen-drawers-v2/both-collapsed-light.png)
- [XLSX 收起状态](hcd-pen-drawers-v2/xlsx-collapsed-dark.png)
- [PPTX 收起状态](hcd-pen-drawers-v2/pptx-collapsed-dark.png)
- [移动端深色抽屉](hcd-pen-drawers-v2/mobile-dark.png)
- [深色右键菜单](hcd-pen-drawers-v2/context-menu-dark.png)
- [深色表格弹窗](hcd-pen-drawers-v2/table-dialog-dark.png)

## 验证方式

在 `examples/hdoc/editor` 运行。`OFFICECLI_BIN` 指向已构建的 officecli，`HCD_BROWSER_PATH` 可指定本机 Chrome。

```bash
npm run build
npm run test:workspace -- e2e/workspace.spec.ts --grep 'both sidebar rails|appearance follows|dark workspace|context menu uses|mobile drawers dismiss|workspace drawers,|phone workspace|all seven formats|canvas zoom|workbook preview|document tabs retain|workspace reload restores|fixed history saves|history uses the selected|dark table dialog|agent commits preserve preview'
npm run test:workspace -- e2e/agent-harness.spec.ts --grep 'Pen chat drawer|Codex-style chat|chat composer handles|chat preserves history|right-click and slash'
```

结果：TypeScript、独立站和嵌入构建通过；16 项工作区回归、5 项聊天回归通过。日志：[构建](hcd-pen-drawers-v2/build.log)、[工作区 16 项](hcd-pen-drawers-v2/workspace-16.log)、[聊天 5 项](hcd-pen-drawers-v2/chat-5.log)。

验证涵盖桌面 1440px 与移动端 390px，三类编辑器的收起/恢复、七种格式的主题切换、画布实例保留、多标签与历史预览，以及聊天草稿和滚动位置保留。本记录只验收本轮界面和交互，格式转换一致性仍以对应格式的验收记录为准。
