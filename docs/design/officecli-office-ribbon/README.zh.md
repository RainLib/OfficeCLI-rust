# Office 风格功能区设计

本轮先完成 **23 张 Pen 画板**，再接入当前编辑器。覆盖 Word、Excel、PPT、PDF、Markdown、HTML、纯文本、CSV／TSV、图片及白板的操作区和交互规范。文档现已包含“开始、插入、布局、引用、审阅、视图”六个功能区的设计。以 Office / WPS 的选项卡、功能分组和命令层级为参考，延续折页现有的圆角、浅灰底色与绿色选中态。

源文件：[officecli-office-ribbon.pen](../officecli-office-ribbon.pen) · [完整 PDF](officecli-office-ribbon.pdf) · [校验记录](validation.json)

应用已接入当前可用能力：[实测功能区](implementation/word-ribbon-detail.png) · [浏览器与文件验证记录](implementation/verification.json)。42 项工作台回归及新增功能区场景均已通过。

![功能区细节](previews/ribbon-detail.png)

## 画板

| 画板 | 设计重点 | 预览 |
| --- | --- | --- |
| 00 功能区规范 | 字体、段落、样式、编辑分组；通用控件和色彩 | [查看](previews/00-foundations.png) |
| 01 文档单行模式 | 默认单行、选区反馈、可选的全局 AI 面板 | [查看](previews/01-word-compact.png) |
| 02 文档展开模式 | 剪贴板、字体、段落、样式、编辑；两行命令和分组名称 | [查看](previews/02-word-expanded.png) |
| 03 表格 | 字体、单元格水平/垂直对齐、换行、数字格式、公式栏 | [查看](previews/03-sheet.png) |
| 04 演示 | 幻灯片、文字格式、段落、绘图、对象排列 | [查看](previews/04-slides.png) |
| 05 窄屏 | 813px 宽度，核心命令保留，更多命令锚定展开 | [查看](previews/05-narrow.png) |
| 06 交互规范 | 默认、悬停、选中、禁用、混合、键盘聚焦和深色模式 | [查看](previews/06-interaction-states.png) |
| 07 插入 | 页面、表格、插图、链接、页眉页脚、文本、符号；表格网格选择 | [查看](previews/07-word-insert.png) |
| 08 布局 | 页面设置、缩进、段间距、行距、页面背景、对象排列；页边距预设与应用范围 | [查看](previews/08-word-layout.png) |
| 09 引用 | 目录、脚注尾注、引文书目、题注、索引、工作台资源引用；目录样式面板 | [查看](previews/09-word-references.png) |
| 10 审阅 | 校对、批注、修订、更改、比较历史、保护；正文旁的人员批注与 AI 建议 | [查看](previews/10-word-review.png) |
| 11 视图 | 文档视图、显示、缩放、窗口、专注、工作区；导航窗格与缩放面板 | [查看](previews/11-word-view.png) |
| 12 五个标签单行模式 | 各标签默认命令排布、资源引用选择器、修订作者筛选、权限和空选区状态 | [查看](previews/12-tab-compact.png) |
| 13 五个标签展开总览 | 五个完整功能区并排对照，核对命令层级与密度 | [查看](previews/13-tab-overview.png) |


| 14 Excel 插入与布局 | 图表、数据透视、插入对象、页面布局的能力门控 | [查看](previews/14-excel-insert-layout.png) |
| 15 Excel 公式与数据 | 函数、计算、排序与筛选、数据工具 | [查看](previews/15-excel-formulas-data.png) |
| 16 Excel 工作表、审阅与视图 | 工作表管理、冻结、选区与显示 | [查看](previews/16-excel-sheet-review-view.png) |
| 17 PPT 插入与设计 | 对象插入、版式、母版与背景 | [查看](previews/17-ppt-insert-design.png) |
| 18 PPT 动画与放映 | 动画顺序、播放、预览；切换为待接能力 | [查看](previews/18-ppt-transitions-animations-show.png) |
| 19 PPT 审阅与视图 | 备注、版本、属性、幻灯片导航 | [查看](previews/19-ppt-review-view.png) |
| 20 PDF 与文本 | 页面组织、文字识别、轻量文本命令 | [查看](previews/20-pdf-text.png) |
| 21 图片与白板 | 图片专用操作；白板保留 FigJam 工具条 | [查看](previews/21-image-canvas.png) |
| 22 格式覆盖与接线 | 当前能力、设计目标与底层支持的边界 | [查看](previews/22-format-coverage.png) |

## 补齐的五个文档标签

![五个标签的完整功能区](previews/13-tab-overview.png)

| 标签 | 常用命令与二级设置 | 本轮画出的关键交互 |
| --- | --- | --- |
| 插入 | 空白页、分页、表格、图片、形状、图表、链接、书签、页眉/页脚/页码、文本框、公式和符号 | 表格尺寸网格悬停预览，点击插入；大表格通过行列数设置进入 |
| 布局 | 页边距、方向、纸张、分栏、分隔符、左右缩进、段前/段后、行距、页面背景、对象排列 | 页边距缩略预设、自定义入口，以及“应用于本节/整篇”的范围选择 |
| 引用 | 自动目录、脚注/尾注、引文与书目、题注/交叉引用、索引、文档/表格/白板资源引用 | 目录样式预览；资源类型筛选、精确区域预览、跟随源内容/引用快照两种方式 |
| 审阅 | 拼写语法、字数、批注导航、解决、修订开关、作者筛选、接受/拒绝、比较、版本历史和保护 | 批注贴近关联正文；人员与 Agent 身份区分；当前一处建议的接受/拒绝；作者筛选 |
| 视图 | 打印布局、阅读/连续视图、导航窗格、标尺、网格线、批注显示、缩放、窗口、专注和可选全局 AI | 大纲定位、比例输入与滑杆、常用比例、页宽/一页/多页，侧栏开关集中在功能区 |

上表是设计覆盖范围。各命令的实际可用状态仍需在产品接线时按底层能力和权限决定。

## 布局决定

- **默认单行，按需展开。** 单行按使用频率保留撤销/重做、字体、字号、B/I/U 和四种对齐。右侧“更多”打开分组命令面板，下拉箭头切换为完整功能区，上拉箭头恢复单行。记住用户选择的密度。
- **字体与段落分开。** 字体名和字号放在一行，加粗、斜体、下划线改用熟悉的图标；展开时第二行放字符格式。左对齐、居中、右对齐、两端对齐并排，显示当前段落的状态。
- **核心优先，整组收纳。** 按编辑内容区实际可用宽度测量；打开 AI 或侧栏后也重新计算。常用格式留在原位，次要命令按组进入“更多”，不出现横向滚动条，也不把一组命令拆散到不同位置。长字体名截断显示并保留完整提示。
- **保留编辑空间。** 不恢复顶部大文件名区域；全局文件标签承担文件识别。功能区外层保持 14px 圆角，命令按钮 6px 圆角，更多面板 12px 圆角。桌面图标点击区域 32×32px、图标 17px。
- **AI 仍是全局能力。** 右侧面板可关闭；也允许外部 Agent 接管。普通格式命令不改变 AI 已固定的文件目标和上下文。

## 三类对齐的语义

| 编辑类型 | 对齐目标 | 设计要求 |
| --- | --- | --- |
| 文档 | 光标所在段落或选中的多个段落 | 四个互斥按钮；不同段落格式不同时显示混合态 |
| 表格 | 当前单元格或矩形区域 | 水平与垂直对齐分两行；换行、合并放在同一功能组 |
| 演示 | 段落、文字框内文字、画布对象 | “段落对齐”“文字框内垂直对齐”“对象排列”使用独立命令，不能互相替代 |

## 交互约定

1. 点击格式图标时保留选区和滚动位置，执行后返回原编辑位置。仅图标命令阻止鼠标按下夺焦；输入框、下拉框仍正常获得键盘焦点。
2. 字体和样式选择后应用；字号输入按 Enter 确认、Esc 还原。颜色调整可预览，连续调整应合并为一次可撤销操作，避免每次滑动都产生一条历史。
3. “更多”始终锚定触发按钮；点击外部或 Esc 关闭，并将键盘焦点返回触发按钮。弹层不丢失原文档选区。
4. 按钮有功能名称和悬停提示，开关类命令回显选中态。混合格式不假装成全部关闭；只读、保存中或目标无效时显示适当的禁用态。
5. 人员和 AI 协同更新后重新读取当前选区的格式状态；不使用工具栏旧状态覆盖其他人刚写入的内容。一次格式修改的撤销仍由原编辑器的协同历史负责。
6. 展开和收起采用 160–200ms 的高度/透明度过渡，支持减少动态效果的系统设置；布局完成后重新测量编辑区，不通过整体缩放制造文字模糊。
7. 插入面板的悬停只预览，点击才生成内容；保留面板打开前的插入点。布局预设先预览，取消还原，提交时明确作用于本节或整篇。
8. 作者筛选仅改变修订显示，不等于接受、拒绝或删除更改。接受/拒绝默认处理当前一处；版本历史与文字修订使用不同的入口和语义。
9. 页边批注跟随正文锚点排列，解决后收起到对应位置。人员与 AI 的名称、头像及建议状态分别回显；筛选修订不会改动全局 AI 的目标。
10. “视图”中的导航、缩放和布局显示在只读时仍可操作；插入、页面设置等写入命令按权限禁用。视图比例应接入编辑器的清晰渲染机制。

## 与当前实现的衔接

共用功能区已接入当前文档、表格、演示、PDF 和图片编辑器；白板继续使用原 FigJam 工具条。画板包含完整目标设计，产品只呈现当前底层可用的命令。Word 页边距、目录和脚注，Excel 打印布局，以及 PPT 转场均已接入对应选项卡与原生 Office 文件写入。

| 当前代码入口 | 可复用的能力 | 实施重点 |
| --- | --- | --- |
| `DocumentRibbon.tsx` | 基于内容宽度检测溢出、展开/收起 | 有语义的功能分组、单行/完整两种密度、更多面板；搬移同一个命令节点，保留输入状态 |
| `WordFormatTools.tsx`、`App.tsx` | 字体、字号、颜色、B/I/U、列表、段落对齐 | 图标化、格式状态回显、四个对齐按钮、保持选区 |
| `UniverViewer.tsx` | 单元格字符格式、对齐、换行、填充、边框、数字格式 | 常用格式集中到“开始”；使用紧凑的确认图标保留明确提交动作和未应用输入 |
| `FixedViewer.tsx` | 演示文字格式、文字框对齐和幻灯片操作 | 文字与对象命令分组；按选择类型显示上下文功能区 |
| `EditorChrome.tsx` | 功能选项卡、文件菜单、视图和工具栏开关 | 使用同一套图标、菜单与密度控制 |

布局、引用、设计、公式、放映等选项卡已连接当前可用命令。页面设置集中在统一的圆角设置面板中，长内容独立滚动、确认按钮固定可见。Word 的 typed 字体／段落格式修改使用“内容转换”导出 DOCX；引擎会禁用该修订的“保留原结构”导出。

## 原生页面能力与验收

| 入口 | 已接入的操作 | 写入的文件内容 |
| --- | --- | --- |
| Word → 布局 → 页边距 | 普通/窄/宽预设、自定义边距、纸张、方向、页眉页脚距离、装订线、本节或整篇 | `sectPr/pgSz`、`pgMar` |
| Word → 引用 → 目录 | 按标题级别生成目录、点击定位、更新和删除 | 原生 TOC 域、标题书签与目录链接；当前为无页码目录，不虚构排版页数 |
| Word → 引用 → 插入脚注 | 正文锚点和编号、多行脚注、编辑及删除 | 原生 `footnoteReference`、`footnotes.xml`、关系与内容类型 |
| Excel → 页面布局 → 打印布局 | 纸张与方向、缩放/适应页数、打印范围、重复标题行列、页边距、网格线与居中 | `pageSetup`、`pageMargins`、`printOptions`、工作簿定义名称；保留其他打印机标记与关系 |
| PPT → 切换 → 转场效果 | 无/淡化/推进/擦除/切换、方向、时长、鼠标或定时换片、应用到全部 | 原生 `p:transition` 与换片计时，保留原有对象动画；放映中预览与自动换片 |

统一服务为 `GET/POST /office-features`，协议为 `office-features/1`；外部 Agent 可调用 `hcd_office_features`。写入检查文档权限、协同版本、未提交正文和 Agent 资源租约，设置进入修订历史，不重建正文。发生并发冲突时拒绝旧版本写入。

复验命令：

```bash
cargo test -p hcd-formats office_features::tests
cargo test -p officecli planning_never_grants_write_permissions
cargo clippy --all-targets -- -D warnings
OFFICECLI_WORKSPACE_DIST=/path/to/built/workspace node examples/hdoc/embed-host/verify-office-features.mjs
```

真实工作台验收使用同一份原件执行编辑、下载、重新上传打开；Word 额外修改正文并回读脚注，PPT 实际观察自动换片。专项结果及截图位于 `implementation/office-features/`。此处验证的是原生 DOCX/XLSX/PPTX 的导出与重新导入，不代表在 Microsoft Office 桌面程序中做过人工验收。

## 参考

- [Microsoft：单行功能区、更多命令与展开/收起](https://support.microsoft.com/en-gb/word/using-the-simplified-ribbon-in-word-for-the-web)
- [Microsoft：段落左对齐、居中、右对齐和两端对齐](https://support.microsoft.com/en-gb/word/align-or-justify-text-in-word)
- [Microsoft：演示中的段落对齐与间距](https://support.microsoft.com/en-us/powerpoint/change-text-alignment-indentation-and-spacing-in-powerpoint)
- [WPS：开始选项卡下的字体、段落与样式设置](https://www.wps.com/academy/design-the-article-layout-in-the-home-settings/1862932/)
- [Microsoft：插入表格和图片](https://support.microsoft.com/en-us/office/graphics-visuals/officeweb/insert-tables-and-pictures)
- [Microsoft：页面布局、页边距和方向](https://support.microsoft.com/en-us/word/training/change-document-layout)
- [Microsoft：文档选项卡与常用功能](https://support.microsoft.com/en-gb/word/training/get-to-know-word-for-the-web)
- [Microsoft：修订显示、作者及接受/拒绝](https://support.microsoft.com/en-gb/word/training/track-changes-in-word?nochrome=true)
- [Microsoft：上下文批注与列表批注视图](https://support.microsoft.com/en-us/accessibility/word/use-a-screen-reader-to-add-read-and-delete-comments-in-word)
- [Microsoft：查看、审阅与编辑模式](https://support.microsoft.com/en-us/word/document-modes-in-word)

设计交付包括 23 张画板、24 张原生 PNG、23 页 PDF。7 张新增 Word 功能区画板的结构检查均无裁切、溢出或循环尺寸依赖；主文字、次要文字、选中态和修订文字的对比度均大于 4.5:1。原有 8 张预览的迁移校验记录保留在校验文件中。另 9 张格式画板已核对原生导出效果；其 Pen flex visitor 坐标与导出渲染存在差异，校验记录明确分开标注。独立 Pen 文件已保存，当前文档路径已核对；应用端的实测结果与截图单独记录在 implementation 目录；结构检查与应用操作验证分开记录。
