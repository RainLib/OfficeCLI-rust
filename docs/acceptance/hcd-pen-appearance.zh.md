# Pen 工作区样式与深色模式验收

最新收起行为与截图见[侧栏收起释放空间](hcd-sidebar-space-reclaim.zh.md)，深色配色修正见[左右侧栏与 dark 配色补充验收](hcd-pen-drawers-v2.zh.md)。

设计依据：[officecli-workspace-v2.pen](../design/officecli-workspace-v2.pen) 中的 `HRzgj`（AI 工作台）、`QGj0f`（右键菜单）和收起侧栏页面。此轮直接使用仓库保存的设计文件和参考截图完成实现。

- 聊天抽屉采用统一背景、圆角输入区、用户消息气泡、可展开执行过程和图片资源标签。
- 左右侧栏收起后保留组件、聊天草稿、协同人数、展开状态与阅读位置。侧栏和主题切换均不重建文档编辑器或协同连接。
- 窄屏抽屉提供遮罩、Esc 关闭、焦点返回和键盘焦点循环；后台文档不会响应前台抽屉的关闭按键。
- 右键菜单统一图标、分组、圆角和键盘提示。次要格式操作收在“更多编辑操作”；菜单可滚动，支持方向键、Home / End、Esc 和点击外部关闭。浮层挂到视口，避免画布缩放和裁剪影响菜单位置。
- 提供跟随系统、浅色、深色三种主题。独立工作台记住选择；嵌入组件支持独立控制主题。Office / PDF 文档纸面和表格单元格保留原配色，外围工具使用深色主题；后续修正使 Markdown / TXT 纸面跟随主题。
- 深色样式覆盖文档库、编辑工具栏、侧栏、聊天、图片资源、右键菜单及复杂表格编辑弹窗。

截图：[浅色](hcd-pen-appearance/workspace-light.png)、[深色](hcd-pen-appearance/workspace-dark.png)、[聊天](hcd-pen-appearance/chat-dark.png)、[右键菜单](hcd-pen-appearance/context-menu-dark.png)、[移动端](hcd-pen-appearance/mobile-dark.png)、[文档库](hcd-pen-appearance/library-dark.png)、[图片资源](hcd-pen-appearance/image-studio-dark.png)、[表格弹窗](hcd-pen-appearance/table-dialog-dark.png)。同目录保存了 DOCX / XLSX / PPTX / PDF / Markdown / HTML / TXT 深色工作区截图。

可复现检查（在 `examples/hdoc/editor` 运行；设置 `OFFICECLI_BIN` 指向已构建的 officecli，本机 Chrome 可通过 `HCD_BROWSER_PATH` 指定）：

```bash
npm run build
npm run test:workspace -- e2e/workspace.spec.ts --grep 'appearance follows|dark workspace|context menu uses|mobile drawers dismiss|workspace drawers,|phone workspace|all seven formats|canvas zoom|workbook preview|document tabs retain|workspace reload restores|fixed history saves|history uses the selected|browser storage'
npm run test:workspace -- e2e/agent-harness.spec.ts --grep 'Pen chat drawer|Codex-style chat|chat composer handles|chat preserves history|right-click and slash'
npm run test:workspace -- e2e/workspace.spec.ts --grep 'dark table dialog'
```

结果：TypeScript、独立站及嵌入构建通过；15 项工作区测试、5 项聊天测试和表格弹窗测试通过，最终样式补充后另重跑了主题持久化检查。日志见同目录 `workspace-15.log`、`chat-5.log`、`polish-2.log`、`build.log`。

手动验证：打开工作台，在右上方切换主题；滚动聊天历史并输入未发送内容，收起再展开右侧栏；切换专注模式；在文档中右键并展开更多操作；将窗口缩窄后验证遮罩与 Esc。此轮检查界面交互及各格式画布保留，不替代各格式的完整导入、编辑、转换一致性验收。
