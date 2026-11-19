# 圆角停靠面板验收

日期：2026-11-16。当前设计为 [圆角停靠面板 V2](../design/officecli-docked-panels-v2/README.md)。本轮取消左右面板的浮层定位和遮罩，并保留原有圆角、面板间距及独立底部区域。

| 检查 | 结果 |
| --- | --- |
| 七种格式、停靠边界、收起位置、圆角、主题、手机和 PPTX 属性 | 9 通过 |
| 图片工作台、未提交输入、蒙版、浏览器与 API 崩溃恢复 | 9 通过 |
| Word 读者与格式保留、Agent 草稿及阅读位置保留 | 2 通过，脚本化模型 |
| 编辑器单测 | 26 通过 |
| Workspace 单测 | 11 通过 |
| 管理台、编辑器、嵌入包与 sidecar 构建 | 通过 |
| 默认 Workspace 与匿名分享端到端验收 | 18 项通过 |

主要断言：

- 左右面板使用正常布局，投影为 `none`；面板边界不会与中央正文重叠。
- 左栏收起按钮位于右上角，右栏位于左上角；展开时不显示重复的恢复按钮。
- 收起后正文宽度增加，恢复后返回原宽度；原编辑器 DOM 实例、未提交输入和画布缩放保留。
- 七种格式的导航与协作内容卡片均保留 16px 圆角，文档内容舱保留 26px 圆角。
- 手机面板使用内容列，不创建遮罩；关闭与 Escape 返回正文并恢复入口焦点。
- 图片窄屏先收起参数面板再涂抹，展开后保留参数与蒙版；浏览器强制退出后可以恢复，恢复过程不提交生成。
- 匿名查看、编辑、临时身份、协作保存、权限降级、链接重置、公开目录和匿名图片保存均继续通过。

[实际桌面](hcd-docked-panels-v2/desktop-live.png) · [七格式共用面板](hcd-docked-panels-v2/document-panels.png) · [手机面板](hcd-docked-panels-v2/phone-panel.png)

复跑界面检查（在 `examples/hdoc/editor` 执行）：

```bash
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:workspace -- workspace.spec.ts \
  --grep 'docked panels never|shared side panels match|mobile docked panels|PPT shape properties|all seven formats use|workspace drawers, focus|workspace reload restores|appearance follows|dark workspace keeps'
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:workspace -- image-workspace.spec.ts
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:workspace -- agent-harness.spec.ts \
  --grep 'Word mixed inline edits preserve|Pen chat drawer preserves draft'
node --import tsx --test src/*.test.ts
```

构建和匿名分享验收命令见 [分享验收](hcd-sharing-v1.zh.md)。本轮日志与结果位于 [hcd-docked-panels-v2](hcd-docked-panels-v2/)。完整前端 E2E 套件未全部运行。本轮没有修改 Rust；全工作区测试与严格检查的最近记录见 [分享验收](hcd-sharing-v1.zh.md)。
