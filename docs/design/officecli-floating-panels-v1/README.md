# 画布悬浮面板

此方案已归档。当前方案为 [圆角停靠面板 V2](../officecli-docked-panels-v2/README.md)：保留圆角，面板正常占位，取消浮层覆盖。

设计源文件：[officecli-workspace-v2.pen](../officecli-workspace-v2.pen)，画板 75–80。沿用现有工作空间的字体、颜色和面板内容。

顶部移除“可编辑／可查看”和左右侧栏入口，保留文档信息、保存状态、分享及文档操作。权限由分享设置与服务端会话决定；临时访客编号显示在底部状态栏。

左右工具入口悬浮在画布边缘，面板从边缘展开，始终位于格式工具栏下方，定位范围限于当前编辑器。展开和收起不改变画布尺寸，不重新创建编辑器；大纲、协作消息与输入草稿保留。手机端一次展开一侧，支持遮罩关闭、Escape 和焦点返回。

| 画板 | 场景 | 导出图 |
| --- | --- | --- |
| 75 | 桌面左右展开 | [展开状态](desktop-open.png) |
| 76 | 桌面左右收起，画布保持原尺寸 | [收起状态](desktop-closed.png) |
| 77 | 手机边缘入口与底部访客编号 | [手机收起](phone-closed.png) |
| 78 | 手机右侧设置面板 | [手机展开](phone-settings.png) |
| 79–80 | 本机匿名样例的桌面／手机实际页面 | Pen 内 Browser 节点 |

Pen 复用组件为“浮动面板容器”和“边缘图标按钮”。代码通过 [WorkspacePanel.tsx](../../../examples/hdoc/editor/src/WorkspacePanel.tsx)、[DocumentPanelTools.tsx](../../../examples/hdoc/editor/src/DocumentPanelTools.tsx) 与 [WorkspaceDrawers.tsx](../../../examples/hdoc/editor/src/WorkspaceDrawers.tsx) 统一容器、入口、画布定位和关闭行为；大纲、Agent、历史、属性、设置与图片工具提供各自内容。面板不挂到宿主页的顶层容器，嵌入管理台时不会覆盖宿主菜单。

实际截图与验证见 [验收记录](../../acceptance/hcd-floating-panels-v1.zh.md)。Browser 节点使用独立临时样例服务；它不是默认业务服务或线上部署。
