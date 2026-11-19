# 分享与匿名访问设计

设计源文件：[officecli-workspace-v2.pen](../officecli-workspace-v2.pen)。沿用工作空间的 Soft Canvas 组件、颜色及字体，移除原有编辑/预览切换。分享设置决定访问权限；文档顶部不显示“可编辑／可查看”，访客编号移至底部。面板入口与容器以 [圆角停靠面板 V2](../officecli-docked-panels-v2/README.md) 为准，下表截图保留分享场景的早期界面。

| 画板 | 场景 | 导出图 |
| --- | --- | --- |
| 66 | 负责人设置访问范围、访客权限和有效期 | [分享面板](share-owner.png) |
| 67 | 无需登录，直接查看文档 | [匿名查看](guest-read.png) |
| 68 | 临时访客直接编辑，自动保存 | [匿名编辑](guest-edit.png) |
| 69 | 无需登录的公开文档目录 | [公开文档](public-library.png) |
| 70 | 分享关闭、过期或无权访问 | [访问受限](share-unavailable.png) |
| 71 | 手机公开目录 | [手机目录](public-phone.png) |
| 72 | 手机匿名编辑 | [手机编辑](guest-phone.png) |
| 73–74 | 桌面与手机实际页面 | Pen 内 Browser 画板 |

访问范围分为“仅受邀成员”“持链接的人”“公开访问”。后两者分别设置“可查看”或“可编辑”。访客由服务器分配临时身份，同一浏览器保留 24 小时。公开文档出现在公开目录；仅通过链接分享的文档不出现在目录中。

Browser 画板绑定独立的本机样例服务。实际实现位于 `apps/workspace`、`examples/hdoc/admin-app` 和 `examples/hdoc/editor`；重新启动不同端口的样例时，应同步修改 Browser 的 URL。

[实现与接口说明](../../../apps/workspace/README.zh.md) · [验收记录](../../acceptance/hcd-sharing-v1.zh.md)
