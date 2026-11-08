# HCD 列表导出：原生编号、Markdown 层级与读取边界

日期：2026-10-24。语义导出已支持 DOCX 原生多级编号、列表续段、起始号及独立重启；Markdown 保留列表缩进和显式换行。规范保存后的独立 li 片段在临时导出副本补容器，既有共享文档及历史字节不变。此项推进 F 阶段，不代表完整编辑器、全部导入或格式保真已完成。

## 实现与边界

转换器为每个列表容器记录身份、深度、起始/当前编号及每个条目是否已输出首段。li 内的 p 不再丢掉首段项目符号；后续段落只按内容位置缩进，不增加编号。列表在混合的有序/无序子列表之后恢复原编号；独立列表和显式编号跳转使用不同的原生 num 实例。链接、粗体和字体等沿用已有富文本运行转换，编号不再混入 w:t。

DOCX 复用现有 L2 numbering 和 RichParagraph API，维护 numbering.xml、document.xml 的 numPr/numId/ilvl，以及 relationship/content-type。相同类型复用编号模板，每个逻辑列表有独立实例。Word 原生九级以外保留第八级编号并显式缩进，转换报告给出提示；现有 handler 的起始号受有符号 32 位上限约束，超出时停止导出，不发布临时文件。表格/图片等复杂列表子节点、超多列表容量与原稿字号/符号形状的完整保真仍需单独验收。

部分历史规范块为独立的 `<li data-hcd-editor-kind="list_item">`。导出临时副本根据已声明 level/list-start 补回 ul/ol；正常已有容器保持原样，脚本、样式和注释中的 li 文本不参与改写。跨分块且编号连续的独立项复用编号实例，普通正文和重启编号分开。转换供 DOCX/Markdown 和 CSS/PDF 使用，不改写规范 HCD。协作样例固定 r10 导出前后 manifest 哈希一致。

Word HTML 预览另修正了编号实例的计数存活期：嵌套列表切换 numId 后，父列表/子列表恢复各自计数，不再次使用 startOverride。样例实际显示父项 4→5、子项 7→8、独立列表从 10 开始。它是 OfficeCLI 自有读取器的预览，不等于 Microsoft Office/WPS 实机验收。

Markdown 按父项目标记的真实宽度确定缩进，例如 `100.` 后续内容使用五格。多段列表项不会重复加标记；空父项与子列表之间不插入会拆散结构的空段落。HTML 解析后保留的显式换行使用 Markdown 硬换行表示，代码块原文继续使用代码围栏。首批实际比较树结构、起始号和文字；Markdown 的完整格式 mark、超九位有序标记及复杂容器仍需后续能力声明/适配。

## 本机实际证据

- 新增覆盖原生编号 wiring、三层混合列表、续段不编号、样式/链接、独立重启、空父项、跨块规范 li、MD 再导入及恢复预览计数的回归。
- 139 项 officecli bin、39 项 docx-handler lib 测试通过；构建、两个变更 crate 的 all-targets clippy、workspace fmt、diff 检查通过。本轮未改前端，没有重复前端测试。
- 独立 Markdown 来源导入/投影后，实际导出 DOCX/MD/PDF。原生 DOCX 检查完整编号引用、depth 0/1/2 和 start 4/7/10；所有测试正文各一次。
- MD 再导入的规范块树、起始号和正文与源模型一致；该比较不包含粗体等格式 mark。
- 上一轮真实协作 r10 的 First/Second/Third 在新 DOCX 内为原生 depth 0/1/1，已接受 AI 文字及 Bob 段落均各一次，规范 manifest 未变。
- 实际 PDF 经 Poppler 渲染核对三层缩进、4/5、7/8、10 与全部中英文正文；实际 DOCX 经自有 Word reader + CUA 预览核对续号。未验证整篇原稿分页、所有字体或 Office/WPS 应用。

证据：[文件、编号与再导入模型](../assets/hcd-lists-2026-10-24/native-list-file-evidence.json)、[Word 原生预览](../assets/hcd-lists-2026-10-24/native-docx-preview.png)、[实际 PDF](../assets/hcd-lists-2026-10-24/native-list-pdf.png)。

复现：`cargo test -p officecli --bin officecli`、`cargo test -p docx-handler --lib`、`cargo build -p officecli`；再运行 `python3 scripts/hcd-native-list-verify.py`。可用 `--bundle <owned-fixture.hcd> --revision 10` 额外检查本轮命名的协作列表样例；脚本不会生成模型输出或修改原规范版本。

## DOCX 重新导入修复

后续实际回转已修复普通标题/列表被识别为段落的问题。导入器按直接大纲级别、basedOn 继承、内置 Heading 样式 ID/名称识别标题 1–6；大纲级别 9 明确取消标题。列表使用真实 numId/ilvl/计数值重建根项及嵌套 ol/ul，保留起始号、混合子列表、续号、独立重启和空父项。原文字节点 ID、来源位置和格式运行不从编号文字猜回。

仅缓存一个根条目及其子树，完成后即可按既有分块规则输出；300 个顶层条目在小分块配置下产生至少 150 个分块。一个根项子树超过规范 2 MiB 块上限时明确失败，不拆掉其层级或丢掉节点。没有显式归属声明的普通 DOCX 段落不会仅凭缩进被猜为前一列表项的续段，复杂表格/图片子节点仍在待完成范围。

可视编号标记保留于来源 HTML，但带有装饰声明；再次语义导出时不会重复加入正文。相同 Word 列表实例的连续根项可在再次导出的原生 DOCX 中继续使用同一 numId，独立实例保持分开。嵌套条目的有序类型由父容器表达，其冗余条目标记与前端规范编码保持一致，避免纯文字保存被误判为结构修改。静态高级编号不作为这种装饰删除。标题的来源 CSS 继承原字体大小/字重，避免仅更换语义标签就采用浏览器默认标题字体。

目前编辑模型支持普通十进制与项目符号、标题 1–6。罗马/字母/复合编号、十进制 1–1000000 以外、编号标题、七至九级标题和带可视对象的编号组保留原可读内容，以只读块显示，并在导入报告中声明 `WORD_SEMANTIC_EDITING_LIMIT`。这属于明确限制，不等于这些类型已经支持完整结构编辑。

64 项 hcd-core lib、40 项 hcd-docx lib 和 140 项 officecli bin 测试通过。新增回归核对三层树、继承/直接覆盖、空父项、来源节点集合、修改子项后回写原 DOCX、原 numbering 不变、历史版本不变，以及实际文件重开。构建与三个 crate 的 all-targets clippy 通过。前端另修正投影给无序子列表附加 start=1 的问题，避免 Tiptap 去掉无效属性后误判来源冲突；444 项前端测试和 standalone/embed 构建通过。

实际 `HCD → DOCX → HCD → DOCX/Markdown → HCD` 的标题、列表树、起始号、正文均与最初模型一致，DOCX 再次导出仍有原生 depth 0/1/2 和父/子实例续号；这次树比较不包含完整格式 marks。见 [最新文件与模型证据](../assets/hcd-lists-2026-10-24/native-list-file-evidence.json)。[修复前 DOCX 失败证据](../assets/hcd-lists-2026-10-24/docx-reimport-before-evidence.json) 继续保留，取代“当前 importer 全部丢失列表/标题”的旧状态描述。

真实双端页面另验证了原文件导入后完成协同迁移、Alice 修改嵌套子项、Bob 修改另一段、联合保存 r2，以及自己的撤销 r3/重做 r4；Bob 内容始终保留。三个版本都保持来源节点集合，未标记 structuralChange，源 DOCX 导出为 HIGH。实际包比较确认除了 document.xml 外全部部件字节不变；document.xml 去掉 w:t 正文后，元素/属性/运行格式也一致。各版本实际文件再导入的树与保存模型一致。可写页重开 r4 正常，右侧“在线协作”仍有姓名、操作摘要和跟随；跟随未增加规范版本。见 [页面证据](../assets/hcd-lists-2026-10-24/docx-reimport-browser-evidence.json) 和 [截图](../assets/hcd-lists-2026-10-24/docx-reimport-editor.png)。

页面复现：`python3 scripts/hcd-mention-preview.py --source-docx /path/to/owned-fixture.docx --pages-prefix .hcd-docx-reimport`。按上述命名样例完成双方输入/保存/撤销/重做后，用 `python3 scripts/hcd-native-list-verify.py --browser-root /path/to/hcd-mention-preview-root` 检查 r2/r3/r4 的实际文件。脚本仅用于本机隔离样例，不清理浏览器缓存、改写规范历史或连接真实模型。

本次修复对新导入/重新导入生效。旧 HCD 已保存为普通段落的列表不会在读取时被原地改写；带既有编辑历史的旧文档语义升级仍需独立迁移方案。

## 当前能力与剩余导入修复

| 路径 | 当前证据 | 待完成 |
|---|---|---|
| HCD → DOCX | 原生编号/层级及文字已验证 | 复杂列表容器、字体/符号和 Office/WPS 实机 |
| HCD → Markdown → HCD | 本轮列表树/起始号/正文一致，含硬换行单测 | 完整格式 marks、超大编号与更多容器 |
| HCD → PDF | 本轮列表正文、编号和子列表缩进可读 | 原稿图像、分页和完整字体保真；续段内容边缘已修复，见下文 |
| DOCX → HCD | 普通标题、三层混合列表、起始/续号/重启；新导出文件的显式续段归属、硬换行及来源保存已验证 | 无标记续段不猜归属；高级编号/深层标题只读；复杂容器、完整 marks 与 Office/WPS 实机 |
| HTML → HCD | 新导入保留父项、多段、混合子列表、起始号、换行及来源锚点 | 旧段落型 HCD 的历史迁移、复杂容器、图片资源与 CSS 保真 |

[HTML 修复前失败证据](../assets/hcd-lists-2026-10-24/html-import-gap-evidence.json) 继续保留，现状由下述修复证据更新，不能称完整跨格式回转。DOCX 高级类型及其余导入/保真缺口继续实施；管理平台和实际提醒后置，完整节点/AI/字体/国际化/PPT/PDF 原清单保持有效。

## HTML 层级与来源保存修复

StructuredHtmlCanonicalizer 现在保留一个根条目及其子树，父项内的多段、混合子列表、子列表后的续段不再被拆为顶层块；支持 ol start、li value、跨块续号、空父项、显式换行、引用和代码。粗体、斜体、下划线、删除线、行内代码和安全链接随叶段保留，跨块行内作用域正确闭合和重开；危险链接只保留可读标签。title 等非正文元数据不会进入正文，NBSP 等可见空白不会被当作缩进删除。文字仍映射到原始 HTML 字节位置，空段/空父项也有实际插入锚点。

根项完成后即可分块，300 个省略 li 结束标签的同级条目通过小块测试；单根子树约 2 MiB、语义深度及行内作用域都有明确上限，超限停止且不发布 manifest。整个来源 HTML 仍按既有 64 MiB 上限整份读入并先规划表格，因此不能称全文件流式导入。含表格的复合列表/引用保留原顺序但只读；图片/资源、任意 CSS 和嵌套表格不在完整可编辑承诺中。

新导入的可编辑 HTML 树显式标记 `data-hcd-html-tree="1"`。核心仅对这些新声明块启用引用、代码和硬换行解析，未声明的旧快照保持原解释；旧 HCD 中已经拆散的层级不会自动重写，历史迁移另行实现。

48 项 hcd-formats、64 项 hcd-core、40 项 hcd-docx、140 项 officecli 测试，共 292 项通过；原生构建、四个 crate 的 all-targets clippy、workspace fmt 和 diff 检查通过。本轮没有前端代码改动，未重复前端测试/构建。实际检查 HTML、MD、DOCX、PDF 的中英文标签各一次，HTML 检视文件和 Markdown 再导入的树、起始号、换行及正文一致（比较不含完整 marks）。DOCX 原生 depth 0/1/2 和父子实例续号保留；多段条目再导入 DOCX 时仍无法恢复无编号续段的归属，首次检查还发现样例硬换行丢失和 PDF 续段/尾段缩进差异，现已修复。首次完整 DOCX 树比较为 false；本页末尾的归属协议修复将新导出文件的该比较改为通过。

HTML 无来源语义 `export` 尚不支持，本轮使用官方 `hdoc render-html` 生成独立检视文件，不将它冒充原稿 HTML 导出。来源回写则已单独验证：双端 Alice/Bob 输入后保存 r2、自己的撤销 r3、重做 r4，均保留 Bob、来源 ID 和原层级，不触发结构重建；三份实际 source-backed HTML 为 HIGH，字节仅改变预期文字，重新导入等于保存模型。可写页重开 r4，右侧在线协作有双方姓名、Bob 的操作摘要、定位和跟随；点击跟随后原生 head 仍为 r4，没有产生内容版本。仅为本机隔离 API、WebSocket、真实浏览器和文件证据，未验证生产或 Office/WPS 应用。

证据：[实际文件与模型](../assets/hcd-lists-2026-10-24/html-list-file-evidence.json)、[双端页面](../assets/hcd-lists-2026-10-24/html-list-browser-evidence.json)、[协作截图](../assets/hcd-lists-2026-10-24/html-list-editor.png)、[PDF 渲染](../assets/hcd-lists-2026-10-24/html-list-pdf.png)。复现：`python3 scripts/hcd-html-list-verify.py`；页面用 `python3 scripts/hcd-mention-preview.py --source-html /path/to/owned-source.html --pages-prefix .hcd-html-hierarchy`。按验收样例完成双方输入及 r2/r3/r4 后，再运行 `python3 scripts/hcd-html-list-verify.py --browser-root /path/to/hcd-mention-preview-root` 检查实际来源文件。


## 列表续段缩进与 DOCX 硬换行修复

2026-10-24：PDF 排版器对 li 首段和子列表正确累计缩进，但把其余块内容按页面坐标和宽度展开，导致续段向左退。本轮修复共享排版路径：普通块内容使用 li 内容宽度，并把累计列表缩进与 li 内边距带到输出主框；固定/绝对定位仍使用其原定位坐标。实际几何回归从首段换行 x≈76、续段 x≈40 变为对齐，同时覆盖嵌套续段、块容器、长行宽度和固定定位。原始样例 PDF 的父项/续段/换行下一行/尾段均 x≈70，子项 x≈100，叶项 x≈130；一页完整渲染已核对。此为已复现问题的修复，不称任意 CSS 或完整 Chromium 排版保真。

普通 DOCX p/h 的投影以前只拼接来源文字节点，忽略节点之间的 br。本轮对新导入的可编辑普通段落/标题显式声明 `data-hcd-word-tree="1"`，按树解析普通换行；w:br/w:cr 的空元素和配对写法均处理。未声明的旧 HCD 快照保持原解释。实际 DOCX 再导入已保留正文和硬换行；修改换行后文字再来源回写为 HIGH，整个包仅目标文字字节变化，换行元素/其他部件和历史保持不变。此项没有新认证分页/分栏 break、原稿分页或复杂容器。

本轮 64 项 hcd-core、41 项 hcd-docx、48 项 hcd-formats、141 项 officecli，共 294 项通过；原生构建、四个 crate all-targets clippy、直接 ironpress lib clippy、fmt/diff 通过。没有前端改动，未重复 UI 操作/前端构建。本机双端历史 r2/r3/r4 的实际来源回写继续通过，但本轮新检查是 CLI/文件/排版检查，不能替代新的浏览器或 Office/WPS 应用验收。

[本轮证据](../assets/hcd-lists-2026-10-24/list-paragraphs-evidence.json)、[修复后实际文件与模型](../assets/hcd-lists-2026-10-24/html-list-file-evidence.json)、[修复前文件边界](../assets/hcd-lists-2026-10-24/list-paragraphs-before-evidence.json)、[渲染页](../assets/hcd-lists-2026-10-24/list-paragraphs-pdf-after.png)。复现：`cargo test -p officecli --bin officecli css_pdf_list_continuations_keep_their_parent_content_edge`、`cargo test -p hcd-docx --lib plain_and_heading_line_breaks_survive_projection_and_source_text_edits`，再运行 `python3 scripts/hcd-html-list-verify.py`（几何检查需要 Poppler 的 pdftotext）。

仅靠原生 Word 编号与缩进不能确定无编号续段的父条目；无声明文件仍不猜回归属。新导出文件通过下述显式协议恢复多段列表。旧历史迁移、完整 marks/资源/字体/分页、节点 SDK、AI/引用/协同及 PPT/PDF/国际化原清单继续实施；管理平台和实际提醒后置。


## DOCX 列表归属协议与多段列表回转

2026-10-24：原生 numPr 表达编号，不能单独说明无编号段落属于哪个条目。导出继续使用正常 Word 编号/段落，另在支持的 p 上写入 `urn:officecli:semantic-lists:1` 命名空间的 `list` 属性，值为 `1:<item-id>:<depth>:start|continue`。ID 为本次文件内独立条目身份（1–1000000），不依赖会重复的显示编号；depth 为 0–8。首段保留原生 numPr，续段不重复编号，不增加第二份正文。每个带标记段落局部声明 mc:Ignorable 与 mc:PreserveAttributes。采用 [Open XML 标记兼容机制](https://learn.microsoft.com/en-us/office/open-xml/general/introduction-to-markup-compatibility)，实际应用是否保留扩展仍须 Office/WPS 实机验收，不能据文件声明保证第三方保存后标记不丢。

公共 L2 RichParagraph 的可选 list_ownership 使用共享、有界且带版本的类型。导入按实际命名空间 URI 识别属性，不信任前缀名称；校验版本、字段、ID、深度、角色、重复身份及首段的真实原生编号层级。续段只能加入当前仍开放、身份和层级都匹配的条目，必要时先闭合其子列表，因此子列表之后的尾段可正确回到父项。无声明的普通缩进段落保持正文；失效/损坏声明回退为可读原生内容，给出 WORD_LIST_OWNERSHIP_IGNORED，不从缩进猜测或跨正文追溯旧条目。每个根项仍按既有大小上限分块，不缓存整份列表。

实际多段样例 `HTML → HCD → DOCX → HCD` 的树、父/子列表起始号、硬换行和正文现已一致；先前未带归属标记的真实 DOCX 在当前 reader 中仍可复现完整树不相等，作为修复前证据保留。此次比较不包含完整 marks。原生编号实例及 4→5、7→8、10 保留；导出前后原 HCD manifest 不变。

新的双端 DOCX 页在续段中插入“已验证”，Bob 修改正文，保存 r2、自己的撤销 r3/重做 r4。三份实际来源 DOCX 回写均 HIGH，来源文字 ID 不变、未触发结构重建，其他 OOXML 部件字节及 document.xml 非正文结构/运行属性不变，重新导入等于各自保存树。可写重开 r4，在线协作姓名、摘要、跟随通过，跟随之后 head 仍 r4。同伴窗口初次本机备份读取未成功，重试仍提示不可用，使用页面提供的继续入口后完成联机验收；这不构成本机恢复通过，原因与恢复需继续追查。

31 项 oxml、39 项 docx-handler、64 项 hcd-core、43 项 hcd-docx、48 项 hcd-formats、141 项 officecli，共 366 项通过；原生构建、六个 crate all-targets clippy、fmt/diff 通过。没有前端改动，未重复前端测试/构建。见 [归属协议与页面证据](../assets/hcd-lists-2026-10-24/docx-ownership-evidence.json)、[实际格式回转](../assets/hcd-lists-2026-10-24/html-list-file-evidence.json)、[双端来源文件](../assets/hcd-lists-2026-10-24/native-list-file-evidence.json)、[修复前文件](../assets/hcd-lists-2026-10-24/docx-ownership-before-evidence.json) 和 [画面](../assets/hcd-lists-2026-10-24/docx-owned-editor.png)。复现 `python3 scripts/hcd-html-list-verify.py`；页面用 `scripts/hcd-mention-preview.py --source-docx <该样例 exported.docx> --pages-prefix .hcd-docx-owned`，按上述双方操作保存后运行 `scripts/hcd-native-list-verify.py --browser-root <隔离样例目录>`。

此项支持新导出文件的常见多段列表；旧 HCD 历史、第三方无标记归属、复杂块/图片/资源、全部 marks、原稿字体/分页与实机仍有独立边界。原清单的完整 SDK、AI、引用/协同、国际化/PPT/PDF 与生产范围继续，管理平台和实际提醒发送后置。
