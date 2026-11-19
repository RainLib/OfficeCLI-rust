# OfficeCLI 工作空间 · 墨色、纸白与陶土

2026-11-17。最新交付为 **V3 Triangle**。通过 FigCraft MCP 生成、重新打开并检查原生稿，保留已有文档、表格、图片、演示、PDF 与资源白板流程。

- [最新 FigCraft 可编辑稿](officecli-office-workspace-v3-triangle.figcraft)
- [白板总览](previews/01-board.png) · [全局 AI 欢迎页](previews/34-welcome.png)
- [角角形象与六种状态](previews/32-symbol.png) · [动效规范](previews/33-motion.png)
- [SVG 接入说明](svg-integration.zh.md)
- [当前 Excalidraw、Yjs 与跨资源 AI 实现](whiteboard-collaboration.zh.md)
- [白板与文档双向生成设计](whiteboard-collaboration.zh.md#白板与文档双向生成)
- [颜色变量](ink-clay.tokens.css) · [画板清单](manifest.json) · [结构验证](validation.json)

**原生稿展示完整目标设计。** 现已在独立多 Tab 编辑工作台接入文档/表格资源卡、源文件定位、共享 AI 输入目标和任务记录，以及 V3 配色与角角 SVG。全局连续模型上下文及其余新增 Office 工具入口仍不能视为全部落地。详见 [实现边界](whiteboard-collaboration.zh.md) 和 [验收](../../acceptance/hcd-resource-workspace-v1.zh.md)。

## 配色与统一样式

采用暖灰背景、纸白内容、深墨色导航选中态与 AI 任务卡，陶土色用于品牌和关键提示，低饱和蓝保留给选区及定位。通过明暗层次增强对比，避免把所有区域都做成浅灰色。

| 用途 | 色值 |
| --- | --- |
| 页面背景 / 白板 | #EDEEE9 / #F4F5F0 |
| 导航 / AI 面板 | #E2E4DE / #F8F8F3 |
| 内容卡片 | #FFFFFF |
| 正文 / 次要文字 | #252722 / #61655C |
| 深色选中与任务卡 | #282B25 |
| 陶土强调 | #B75F42 |
| 选区蓝 / 选区底色 | #46628E / #E5ECF5 |
| 边框 | #CACEC6 |

继续使用主工作区 26px、资源卡片和 AI 面板 16px、按钮 10px 圆角。主内容与右侧 AI 保持间隔，AI 使用共享组件贯穿各格式。

设计参考的是 Claude 的温暖底色、清晰排版与克制强调，角角为本次原创符号。风格资料：[Geist 的 Anthropic 设计介绍](https://geist.co/work/anthropic)、[Anthropic 的 Claude 品牌介绍](https://www.anthropic.com/news/claude-is-a-space-to-think)。

## 角角

圆角三角轮廓、两只小眼睛、一点墨色斜刘海，搭配轻微腮红与微笑。轮廓保持符号化，使用眨眼、歪头、轻跳和弹性伸缩表达状态。

| 状态 | 动作 | 用途 |
| --- | --- | --- |
| idle | 轻呼吸、自然眨眼 | 等待输入 |
| thinking | 轻歪头、视线上移、思考点 | 整理上下文 |
| working | 弹性轻跳、视线移动 | 正在执行 |
| complete | 单次轻跳、眯眼、勾线 | 结果就绪 |
| waiting | 主体静止、眨眼与暂停标记 | 等待用户选择 |
| attention | 轻歪两次后停止 | 来源或选区需核对 |

32px 与 24px 静态版本已用于共享 AI 组件；大尺寸用于欢迎页和状态说明。小图标默认静止，避免每条回复同时运动。

## 原生稿与验证范围

- 35 张画板，719 个原型连接，全部目标存在。
- 29 个共享 AI 组件实例；缺失字体为 0。
- 18 个可独立使用的 SVG，包括 6 个动态状态、静态姿态及资源流转动效。
- 最新原生文件已通过 MCP 重新打开；形象规范与欢迎页已查看渲染结果。
- 圆角三角版本已查看浏览器中的待机效果；其余状态有静态姿态与脚本检查，尚未逐一完成浏览器动态验收。
- FigCraft 内保留可编辑的静态姿态与时序说明；动画由 SVG/CSS 在浏览器播放。
- V2 原生文件保持不变。此前未采用的形象稿收在 superseded 目录，不作为本版入口。

## 复现

SVG 生成只依赖 Python 标准库，默认读取本目录的 master SVG，不依赖原作者的会话目录。

~~~sh
python3 docs/design/officecli-resource-workspace-v3/prepare_svg_assets.py
python3 docs/design/officecli-resource-workspace-v3/build_contrast_motion.py --rebuild
~~~

第二条需要本机 FigCraft MCP CLI，并会覆盖本版原生稿。具体连接方式沿用 V1 的 figcraft_mcp.py；源文件为 V2 原生稿。
