# 圆角停靠面板

当前方案位于 [officecli-workspace-v2.pen](../officecli-workspace-v2.pen) 的 81–86 号画板。75–78 号悬浮方案保留为 V1 归档。

保留原有圆角：中间文档内容舱 26px，左右面板和底部独立区域 16px，手机文档 20px。面板按正常布局占位，没有浮层定位、投影或画布遮罩；面板之间保留间距。

收起按钮靠近正文：左面板右上角，右面板左上角。面板展开时，窄工具轨隐藏重复的收起入口；面板收起后，通过两侧固定窄轨上的展开按钮恢复。右侧协作、历史、属性和设置入口继续位于文档区域内。

| 画板 | 场景 | 导出图 |
| --- | --- | --- |
| 81 | 左右停靠，正文独立占位 | [桌面展开](desktop-open.png) |
| 82 | 两侧收起，正文扩展 | [桌面收起](desktop-closed.png) |
| 83 | 手机文档与固定入口 | [手机文档](phone-document.png) |
| 84 | 手机面板使用内容区，关闭返回正文 | [手机设置](phone-settings.png) |
| 85–86 | 最新本机样例页面 | Pen 内桌面／手机 Browser 节点 |

桌面收起会释放编辑区宽度；恢复面板不重新创建编辑器，保留选择、聊天记录、草稿和画布缩放。手机一次显示一个面板，临时使用内容列；关闭后返回仍然挂载的正文。图片涂抹时可以先填写面板参数，再收起面板操作画布，重新展开后继续使用原有参数与蒙版。

共用实现为 [WorkspacePanel.tsx](../../../examples/hdoc/editor/src/WorkspacePanel.tsx)、[workspace-panels.css](../../../examples/hdoc/editor/src/workspace-panels.css)、[DocumentPanelTools.tsx](../../../examples/hdoc/editor/src/DocumentPanelTools.tsx) 与 [WorkspaceDrawers.tsx](../../../examples/hdoc/editor/src/WorkspaceDrawers.tsx)。顶部不显示“可编辑／可查看”，匿名分享与访客身份规则沿用原方案。

[实际页面与验收记录](../../acceptance/hcd-docked-panels-v2.zh.md)
