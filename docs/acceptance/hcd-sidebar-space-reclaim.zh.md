# 侧栏收起释放空间

按最新交互要求调整：左右侧栏收起后完全退出布局，移除原有的 52px 导航条，内容区获得对应侧栏和间距的全部宽度。展开入口保留在顶栏；右侧开关位于“导出”右侧。此行为替代[上一版收起栏方案](hcd-pen-drawers-v2.zh.md)。

- 分别检查左侧收起、右侧收起和同时收起：同时收起时内容区与工作区左右边界重合，无占位列或残留间距。
- 文本、表格、演示文稿三类编辑器共用此行为；切换侧栏不重建画布，右侧恢复最后使用的面板，保留聊天草稿与滚动位置。
- 移动端关闭抽屉后，键盘焦点回到对应的顶栏开关。无导航条时仍可展开侧栏。
- 保留 dark 配色，浅色与深色均检查空间回收。1440px 桌面，以及 1024 / 820 / 390px 窄屏检查按钮顺序、可见性和页面溢出。

截图：[双侧收起（深色）](hcd-sidebar-space-reclaim/both-collapsed-dark.png)、[仅左侧收起](hcd-sidebar-space-reclaim/left-collapsed-dark.png)、[仅右侧收起](hcd-sidebar-space-reclaim/right-collapsed-dark.png)、[双侧收起（浅色）](hcd-sidebar-space-reclaim/both-collapsed-light.png)、[XLSX](hcd-sidebar-space-reclaim/xlsx-collapsed-dark.png)、[PPTX](hcd-sidebar-space-reclaim/pptx-collapsed-dark.png)、[手机](hcd-sidebar-space-reclaim/mobile-collapsed-dark.png)。

在 `examples/hdoc/editor` 运行以下检查；`OFFICECLI_BIN` 指向已构建的 officecli，`HCD_BROWSER_PATH` 可指定本机 Chrome。

```bash
npm run build
npm run test:workspace -- e2e/workspace.spec.ts --grep 'collapsed sidebars|appearance follows|dark workspace|context menu uses|mobile drawers dismiss|workspace drawers,|phone workspace|all seven formats|canvas zoom|workbook preview|document tabs retain|workspace reload restores|fixed history saves|history uses the selected|dark table dialog|agent commits preserve preview'
npm run test:workspace -- e2e/agent-harness.spec.ts --grep 'Pen chat drawer|Codex-style chat|chat composer handles|chat preserves history|right-click and slash'
```

结果：TypeScript、独立站与嵌入构建通过；16 项工作区回归、5 项聊天回归通过。日志：[构建](hcd-sidebar-space-reclaim/build.log)、[工作区](hcd-sidebar-space-reclaim/workspace-16.log)、[聊天](hcd-sidebar-space-reclaim/chat-5.log)。
