# OfficeCLI 轻量网页编辑对标与实施目标

对标基线为当前工作区 `7916bb3`，参考编辑器以 2026-11-18 查阅的上游文档为准。OfficeCLI 的能力以当前 HCD 服务、参考编辑器和格式适配器为证据。WPS 的能力以官方网页、WebOffice SDK 示例和格式列表为证据。开源项目 README 涵盖桌面、Web 和 CLI，多端专属功能以其平台说明为准。

## 产品结论

OfficeCLI 现在适合在宿主应用中嵌入带版本的轻编辑，典型任务是改几处正文、修一张表、在 PDF 指定位置补字，随后下载。与 WPS 网页办公的最大差距落在三个任务上：**整理表格、审阅 Word、流转 PDF**。底层已有一部分对应能力，尚有工作要完成才能从浏览器选择对象、提交修改、撤销、下载原格式并重新打开验证。

| 用户与任务 | OfficeCLI 当前可用 | 优先补齐 |
| --- | --- | --- |
| 运营、教务或财务临时整理表格 | 跨工作表搜索、改值和区域粘贴、常见公式、受限行列操作、合并拆分及行列尺寸。可按列排序、按多列文本条件筛选、将条件保存到 XLSX、编辑 CSV/TSV 和按工作表下载 | 数值与日期筛选、支持含空洞和公式的排序、选区填充、日期金额等常用格式、工作表管理 |
| 写作者或审阅者修改 DOCX | 协作正文、字体字号、文字颜色、下划线、段落对齐、查找替换、撤销重做和历史版本。可新建普通表格、填写原有空白单元格、修改已有文字及增删行列。下载时按修订判断能否原包回写 | 合并拆分、列宽和表格样式、图片编辑、扩大格式回写、锚定批注及逐条接受或拒绝修订 |
| 文档经办人整理 PDF | 分页预览、全文检索、原位置文本修改、文字框增删与几何调整、页面重排与旋转、插入空白页、删除页面、视觉或原生页段另存 | 从文件导入页面、多文件合并与拆分、批注和表单填写、扫描页 OCR |
| 宿主开发者交付嵌入编辑器 | 文档令牌、只读或写权限、修订、HCD 打包、Yjs 正文协作、对象补丁及 DOCX/PDF 下载能力检查 | 宿主导入授权和文档打开贯通，扩大下载能力检查覆盖，完善同一区域并发冲突与端侧恢复 |

## 对标来源与平台差异

- **GridCraft** 提供公式栏、地址框、填充柄、选择性粘贴、格式面板、排序、AutoFilter、数据验证、图表、条件格式、数据透视表和打印布局。XLSX 是主要读写格式，CSV/TSV 可以交换数据，传统 XLS 和 XLSB/ODS 具备不同层次的导入能力。它的 Web 构建打开本地文件并通过下载保存，和 HCD 的服务端修订模式有不同的持久化边界。其文档还区分了 ODS/XLSB 中的已保存值与公式。 [GridCraft README](https://github.com/storytold/gridcraft/blob/00e8f4fae06d6db324ff551080edf9e0453ccd6e/README.md) · [ODS 导入](https://github.com/storytold/gridcraft/blob/00e8f4fae06d6db324ff551080edf9e0453ccd6e/docs/ods-import.md) · [XLSB 导入](https://github.com/storytold/gridcraft/blob/00e8f4fae06d6db324ff551080edf9e0453ccd6e/docs/xlsb-import.md)
- **PdfCraft** 的轻编辑重点是页面组织、原对象保留、合并与拆分、评注、表单和安全处理。其公开文档将已有文字编辑，特别是 CJK 和从右至左脚本，以及非拉丁 OCR 列为有限区域。OfficeCLI 的原页映射文本编辑值得继续保留，页面操作和表单仍有明显差距。 [PdfCraft README](https://github.com/storytold/pdfcraft/blob/a49a037db6040f50723c1768e0fd6818942c1b83/README.md)
- **WordCraft** 覆盖文本替换、样式库、表格、图片和浮动对象、页眉页脚、参考文献、批注及修订。其 DOCX 为原生读写，另有旧 DOC 导入和 ODT、RTF、HTML、Markdown、TeX、TXT 转换。完整清单还包含邮件合并等桌面文字处理场景，可用于安排后续优先级。 [WordCraft README](https://github.com/storytold/wordcraft/blob/64683a7d0b634d83985cd04b47d9d5a99c9d810e/README.md)
- **WPS 网页与 WebOffice** 官方明确展示字体段落、图片、表格、页码，以及电子表格公式、排序筛选、图表、评论、协作和历史。WebOffice 示例包含指定区域填充、内容控件、评论回复与文档修订。WPS Docs 官方将 PDF 在线能力列为查看、标注与签署，原生页面组织以 PdfCraft 为直接基准。WebOffice 格式试用列表表示可路由的文件家族，其转换和 OCR 是单独的服务能力。 [WPS 网页编辑](https://www.wps.cn/article/ban-gong-xiao-lv-yun-wen-dang-2026-dDfwDmtB.html) · [WebOffice 示例](https://solution.wps.cn/examples) · [WPS Docs](https://www.wps.com/wpsdocs/) · [WebOffice 试用格式](https://solution.wps.cn/provider-demo/preview/index.html) · [格式转换与 OCR](https://solution.wps.cn/format-converter/)

## 功能差距

### XLSX 与结构化数据

| 能力 | HCD Web 当前覆盖 | 差距与目标 |
| --- | --- | --- |
| 网格录入、跨区域粘贴 | 存在节点和空白单元格可写。常见值与公式可在有界范围内一次保存 | P1 支持填充柄、序列填充和选择性粘贴，补齐粘贴大范围的限制提示 |
| 公式、数字格式 | 公式栏、快捷函数、数值写入、普通公式及部分共享公式。部分数组公式和共享组仅可读，Excel 导出请求重算 | P1 支持货币、日期、百分比等常用持久格式。P2 增加跨表、结构化引用和数组公式回归样本，明确每类重算能力 |
| 排序与筛选 | 「数据」支持矩形选区、列选择、可选表头、稳定升降序和多列文本条件。XLSX 可保存原生 AutoFilter，排序和保存筛选分别写入修订 | P1 扩大稀疏、公式和行关联对象排序覆盖，增加同列组合条件、数值日期筛选和既有复杂筛选的编辑 |
| 工作表与视图 | 工作表切换、源冻结窗格和部分显示设置可读，部分行列尺寸可写 | P1 支持冻结和取消冻结、表的新增重命名及删除，导出回写工作簿视图、顺序与关系 |
| 合并及行列移动 | 基础操作已支持。复杂坐标关联需要检查公式、表、验证、图表等结构 | P1 扩大合并与行列操作的可迁移范围，针对有跨表引用、命名范围及验证规则的工作簿做往返验收 |
| 样式、图表、数据管理 | 可渲染部分单元格样式、图片和图表，条件格式等仍主要由源文件保管。CLI 已有图表、验证、条件格式和透视表能力 | P2 提供样式工具栏、创建基础图表、编辑已有图表数据、数据验证和条件格式。透视表编辑在公式兼容与保存稳定后实现 |
| 数据交换 | UTF-8 CSV/TSV 原生网格导入与下载。多表工作簿按当前工作表下载 | P1 提供分隔符、字段类型与编码选项。P2 ODS/XLSB 按值导入 |

本地依据见 [Univer 工作区](../../examples/hdoc/editor/src/UniverViewer.tsx)、[网格编辑验收](../../examples/hdoc/editor/README.md)、[XLSX 适配器](../../crates/hcd-formats/src/xlsx.rs)、[CLI 能力索引](../../schemas/help/xlsx)。

### DOCX 与文本

| 能力 | HCD Web 当前覆盖 | 差距与目标 |
| --- | --- | --- |
| 正文编辑 | Tiptap/Yjs 实时编辑、段落和标题、列表、链接、加粗斜体、字体字号、文字颜色、下划线、段落对齐、撤销重做与保存点 | P1 补清除格式与段落间距。扩展原包格式回写和更多 OOXML 往返样本 |
| 查找与替换 | 支持实时正文查找、单项或全部替换，并处理只读与受保护块 | P2 增加精确大小写、整词、范围选择，把搜索扩到表格和页眉页脚 |
| 表格和图片 | 可在正文中插入普通矩形表格。已有表格按源布局显示，可修改映射文字、填写普通空白单元格。未拆分为物理分片的普通矩形表格可增删行列并撤销重做。部分图片能力走 CLI、节点或单独资源补丁 | P1 合并拆分、列宽和样式、插图及调整大小。扩展带嵌套对象和物理分片的复杂表格 |
| 审阅与协作 | 实时正文、历史保存点与恢复，HCD 有节点注释协议。浏览器缺少面向批注线程和逐条修订的工作流 | P1 看见锚点、添加回复、解决批注。P2 DOCX 原生 `w:ins`、`w:del` 的保留、接受、拒绝并存档 |
| 版式和原格式交付 | 既有段落和表格的映射文字，以及符合条件的表格行列修改，可选「保留源 DOCX」。浏览器按修订展示导出检查结果 | P1 扩大结构和样式回写，增加带图表、脚注和多节分页的往返验收 |
| 引用和模板 | CLI 有书签等模板替换能力。参考网页支持正文语义编辑 | P2 补页面设置、页码和脚注。内容控件及书签定点编辑优先于引文、索引与邮件合并 |

本地依据见 [编辑器 schema](../../examples/hdoc/editor/src/schema.ts)、[DOCX 源包导出](../../crates/hcd-docx/src/exporter.rs)、[结构补丁](../../crates/hcd-core/src/structure.rs)、[DOCX 验收样本](../../examples/hdoc/docx-suite/README.md)。

### PDF

| 能力 | HCD Web 当前覆盖 | 差距与目标 |
| --- | --- | --- |
| 阅读、定位与改字 | 分块页预览、全文搜索、可定位文字修改。追加的文字框可移动调整大小、删除和撤销，已有原文位置受限 | P1 提升缩略图与导航交互、标明可编辑范围，验收旋转页、裁切框、混合字体和多分片页 |
| 组织页面 | 网页支持逐页移动、旋转、在选中页后插入 A4 空白页和删除页面，操作进入修订。可按调整后的页码视觉或原生另存连续页段 | P1 从文件导入页面、多文件合并、分组多选及按范围拆分 |
| 批注和签署 | 通用 HCD 注释协议、CLI 有部分 PDF 原生注释写入。网页 PDF 工具栏主要编辑文本 | P1 高亮、便签、划线及批注列表，使用 PDF 原生注释和外观流。P2 手写签注与数字签章分别建模 |
| 表单与 OCR | 可编辑文本来自原文件的可提取文本。源 PDF 内已有交互字段可随原包保留，网页填写及 OCR 尚需接入 | P1 AcroForm 文本框、复选框、单选框、下拉填值与外观回写。P2 扫描识别和可检索层、中日韩 OCR 样本、XFA 能力判定 |
| 交付与安全 | 视觉导出保留页外观。原生提取保留可选文字、矢量内容、常见批注及页段内的直接链接。源回写位置可能近似 | P1 扩大原生提取的书签、命名链接和表单覆盖。P2 再交付确实移除底层信息的涂黑能力 |

本地依据见 [固定版式编辑器](../../examples/hdoc/editor/src/FixedViewer.tsx)、[PDF HCD 适配器](../../crates/hcd-formats/src/pdf.rs)、[CLI PDF 处理器](../../crates/pdf-handler/src/handler.rs)。

## 格式覆盖与实施边界

| 家族 | 当前 HCD 网页入口和下载 | 下一步格式目标 |
| --- | --- | --- |
| `.docx` | 编辑正文及已有普通表格，支持重建下载、映射文字和符合条件的表格行列原包回写，以及其他目标的语义转换 | 扩大原包回写。旧 `.doc` 可经现有 CLI 转 `.docx`，RTF、ODT 可先做明示的导入转换 |
| `.xlsx` | 网格编辑，具备不可变源时支持源包回写 | 旧 `.xls` 可经 CLI 转 `.xlsx`，ODS/XLSB 先按值。`.xlsm` 单独定义宏保留和执行策略后再开放 |
| `.csv`、`.tsv` | 支持 UTF-8 网格导入、编辑、CSV/TSV 下载和另存 `.xlsx`。XLSX 可按工作表导出 CSV/TSV | BOM 可读，重新序列化后的引号及换行采用统一格式，完全空白的物理行按分隔记录读取规则跳过。文本字段保留前导零。公式表达式输出为字段文本，样式、对象和合并关系仅由工作簿格式表达 |
| `.pdf` | 固定版式网页编辑、页面重排旋转和增删、视觉或支持范围内的源回写，两种模式均可指定页段 | 从文件插入页面、AcroForm、标注编辑、OCR。OFD 优先评估预览与跨格式转换 |
| `.html/.htm`、`.md/.markdown`、`.txt` | HCD 语义编辑。Web HTML 下载使用当前修订的独立 HTML，CLI 同格式 HTML 可用不可变源 | 补文本编码与 Markdown 复杂块往返，保留 HTML 的安全导入模式 |
| `.pptx`、`.hcd` | PPTX 固定画布与有限文字框编辑。HCD 为包含可编辑内容及修订的可移植容器 | PPTX 的整套编辑与旧 `.ppt` 格式转换独立于本轮三项验收 |

## 首轮目标与验收

| 交付 | 用户操作 | 工件验收 |
| --- | --- | --- |
| DOCX 等语义文档查找替换 | 搜索普通文字，选中一个结果替换，或用「全部替换」。操作可撤销、重做和保存 | 检查包含中文、emoji 和 `A+B` 的正文。一次全部替换对应一个撤销步骤。只读及历史视图无替换操作。下载 DOCX 并确认目标段落已更新 |
| CSV/TSV 网格编辑 | 在工作台上传，使用文档访问令牌打开，在网格或公式栏改值，选择 CSV/TSV 下载 | 比对解析后的值、前导零、中文、引号、字段内换行和末尾空字段。相同字节的 CSV/TSV 上传读取各自分隔符。历史修订可重导 |
| PDF 页段另存 | 在「当前修订的页面视觉」下填 `2` 或 `2-5`，准备并预览下载。留空导出全部页面 | 重开实际 PDF，验证页数、顺序、尺寸及当前修订的新增文字。越界范围报错。页段视觉输出使用原页图像和重新绘制的修改文字 |

浏览器验收覆盖 DOCX 查找替换、撤销重做和只读入口，CSV 上传、编辑、保存、下载，以及 PDF 页段的实际预览。下载文件分别重开验证了正文、字段和页尺寸。 [DOCX 查找替换](../screenshots/hcd-light-edit-docx-replace.png) · [CSV 网格](../screenshots/hcd-light-edit-csv-grid.png) · [PDF 页段预览](../screenshots/hcd-light-edit-pdf-range.png)

## 第二阶段交付与验收

- **多表工作簿按表导出。** 在浏览器切换工作表，再选择 CSV 或 TSV。准备下载时会记录活动表和已保存的修订。切换到另一表时，前一表的下载链接会隐藏。CLI 用 `--sheet` 传入完整表名。单表工作簿可以省略，遇到多表歧义或找不到指定表时会报错。
- **PDF 原生页段提取。** 在浏览器选择「保留源 PDF」并填写页段，或在 CLI 中同时传入 `--source` 与 `--pdf-pages`。目录、搜索结果和导出使用一致的真实页码。选定页内的可回写修订、可选文字、矢量内容、裁切框、旋转、常见批注和指向所选页的直接链接会进入新文件。新文件单独组织页树，文档级书签、命名目标、附件、结构标签和签名留在原文件。含交互表单组件的所选页可用视觉模式另存。 [PDF 32000-1 页树和继承规则](https://udp.adobe.io/document-services/docs/assets/35e4369068f86065372c18787171a17e/PDF_ISO_32000-1.pdf)

浏览器测试在三表工作簿中分别下载了 `Transactions` 的 TSV 和 `Settings` 的 CSV，两个文件均与 CLI 选表结果逐字节一致。四页 PDF 的预览分为 55 个分片，目录仍显示四页。PDFKit 重新读取了原生导出的第 2–3 页，得到可选文字和原始的 500 × 550、600 × 550 pt 页面。 [按表下载](../screenshots/hcd-light-edit-sheet-export.png) · [原生页段与真实页码](../screenshots/hcd-light-edit-pdf-native-range.png)

## 第三阶段交付与验收

- **选区排序。** 在 XLSX、CSV 或 TSV 中选中整块数据，在「数据」中选择依据列、表头和升降序。数字按数值比较，文本按不区分大小写的 Unicode 字符顺序比较。同值行保持原先后顺序。选区中的值一起移动，样式和引用仍按单元格坐标应用。浏览器最多支持 500 行、100 列且 10,000 个数据单元格。服务拒绝含合并、公式、富文本、特殊类型或会把值移入或移出空洞的操作。早期导入且缺少类型信息的 XLSX 原始文本也受保护。
- **视图筛选。** 按所选列的文本包含关键词来显示匹配行，切换工作表或载入新修订后复位。筛选只作用于当前浏览器，清除筛选会恢复显示和原选区。只读用户也可筛选。下载使用已保存的完整工作表。

浏览器在 `budget-tracker.xlsx` 的 `Transactions` 表选择 `A1:G21`，按 E 列 Amount 升序得到 r1。重新读取网页实际下载的 XLSX，核对了 20 组完整记录、同金额记录顺序、表头和样式索引，其他两张工作表的 XML 相同。按 G 列筛选 `Pending` 显示 4 条记录，下载仍包含 20 条。撤销和重做后分别导出，逐个 OOXML 部件比对原始文件和排序文件。只读令牌在浏览器可筛选，服务返回 HTTP 403 拒绝其排序请求。 [排序](../screenshots/hcd-light-edit-grid-sort.png) · [视图筛选](../screenshots/hcd-light-edit-grid-filter.png)

## 第四阶段交付与验收

在 XLSX 的「数据」中选择带表头的连续区域，选文本列并输入关键词，点击「保存筛选到 XLSX」。条件按单列文本包含匹配，忽略大小写，`*`、`?` 和 `~` 作为字面字符。一个工作表可保存一个筛选，最大区域为含表头的 500 行和 100 列。保存或移除各生成一个修订。重开 HCD、切回工作表或恢复历史修订后，网页加载相应条件并重新计算匹配行。只读令牌可查看已保存筛选。CSV 和 TSV 继续使用会话内筛选。

带源导出的 XLSX 写入 SpreadsheetML `autoFilter`、条件和隐藏行状态，保留数据行和原本隐藏的行。源工作表同范围、无条件的筛选下拉可继续使用，移除保存的条件会恢复源筛选设置。源范围不同、已有条件、结构化表格、受保护或自定义视图的工作表会拒绝保存。保存需要可验证的原始 XLSX。源文件不可用时，语义 XLSX 仍可导出数据，保真报告会提示筛选条件未写入。 [SpreadsheetML AutoFilter](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.autofilter?view=openxml-3.0.1) · [Excel 文本筛选通配符](https://support.microsoft.com/en-au/excel/using-wildcard-characters-in-searches)

在 `budget-tracker.xlsx` 的 `Transactions!A1:G21` 中保存 G 列 `Pending`，验证 20 条记录中显示 4 条。复读网页实际下载的文件，核对 `ref="A1:G21"`、`colId="6"`、筛选条件、隐藏行和所有原始数据行。重新打包、解包 HCD 后的源包导出与网页下载的 OOXML 部件一致。另以只读令牌重开检查筛选，验证其修改请求返回 HTTP 403，并逐个比对撤销、重做和移除后的导出部件。 [已保存筛选](../screenshots/hcd-light-edit-xlsx-saved-filter.png)

## 第五阶段交付与验收

在「数据」中用「添加条件」选另一列，输入该列的文本关键词。每列可设置一个条件，筛选显示符合全部条件的行。可分别修改、移除条件。XLSX、CSV 和 TSV 均可在当前视图中筛选。XLSX 还可将整组条件保存为一个修订，每个条件写入对应的原生 `filterColumn`。原有单列保存记录仍可读取和导出。 [Excel 多列筛选](https://support.microsoft.com/en-gb/excel/get-started/filter-data-in-a-range-or-table-in-excel)

在 `Transactions!A1:G21` 组合 G 列 `Pending` 和 B 列 `Operations`，临时筛选、保存及只读重开均得到同一条记录。移除 G 列条件后显示 3 条，撤销后恢复两列筛选。核对网页下载的 XLSX 含两列原生条件，20 条记录的单元格内容和其他工作表保持完整。HCD 打包、解包后的源包导出与网页下载一致，历史单列修订的导出部件也与升级前一致。 [多列筛选截图](../screenshots/hcd-light-edit-xlsx-multi-filter.png)

同列组合条件、数值日期筛选以及含公式和稀疏数据的排序仍为 P1。

## 第六阶段交付与验收

- **DOCX 保留源文件下载。** 在正文改字或完成查找替换后，选择「保留源 DOCX」并准备下载。服务保存当前编辑，校验不可变源文件，再将兼容的文字修改回写到原 OOXML 文字运行。原有样式、表格、页眉页脚和其他包内容沿用原文件，文字长度改变后 Word 仍可重新分页。新增或移动段落、修改样式或超链接时选择「重建可编辑 DOCX」。
- **PDF 页面组织。** 在「视图」的「页面组织」中选择当前页码，向上或向下移动一页，或向左或向右旋转 90°。每次操作可撤销和重做。目录、搜索页码、视觉 PDF 和保留源 PDF 都使用该修订的页序。旋转后的页面可预览和导出，恢复原方向后可编辑页面文字。原生完整导出保留页面对象引用，页段另存仍使用原生页段提取支持的内容范围。

浏览器下载的 DOCX 经 ZIP 比对，9 个成员均保留，只有 `word/document.xml` 中指定标题的文字变化。四页 PDF 的原第 2 页上移后顺时针旋转 90°。PDFKit 重开两种模式下载的第 1–2 页，核对页序、旋转及页面尺寸，并在原生输出中读取可选文字和续片标记。网页撤销恢复上一步旋转，重做后恢复 90°。 [DOCX 原包下载](../screenshots/hcd-light-edit-docx-source.png) · [PDF 页面组织](../screenshots/hcd-light-edit-pdf-organize.png)

## 第七阶段交付与验收

在 PDF「视图 → 页面组织」选中页码。点击「在后面插入空白页」增加一张 A4 页面，或点击「删除本页」移除当前页。至少保留一页。插入的空白页可重排、旋转或删除，本轮仅编辑其页面位置和方向。删除及恢复影响当前修订的目录、搜索和 PDF 下载页码。HCD 包保留修订，源文件及历史修订可用于恢复。原生 PDF 删除页面时生成新的页树，输出支持的资源和批注。保留页含交互表单组件时使用视觉导出。

`hcd-patch/32` 使用有序的 `pages` 表达整个修订的页序。带 `sourcePage` 的项引用一张原始页，省略该属性时插入空白页，未列出的原始页从本修订的输出移除。`hcd-patch/31` 仍接受原来完整的页序置换。

验收在原第 2 页之后插入空白页，随后删除原第 2 页。浏览器预览和两种下载的 PDF 均显示 4 页，第 2 页为 A4 空白页。原生下载保留其余页面的可选文字。用原第 2 页的独有词核对了删除、撤销和重做后的搜索结果，并单独导出新第 2 页。超出当前修订页数的下载申请返回 HTTP 400。 [PDF 增删页截图](../screenshots/hcd-light-edit-pdf-insert-delete.png)

## 第八阶段交付与验收

DOCX 在「开始」工具栏支持对选中文字设置字体、字号、颜色和下划线，并设置段落的左对齐、居中、右对齐或两端对齐。格式进入协作状态和修订记录。选择「重建可编辑 DOCX」下载改过格式的文档，格式写入 Word 的文字运行和段落属性。纯正文改字可继续选择「保留源 DOCX」。

在项目提案样本中选中标题中的 `Digital Twin`，选择宋体、18 pt、颜色 `#A33555` 和下划线，将整段设为右对齐。保存并下载后，用 `unzip -p <下载的文件.docx> word/document.xml` 检查 `w:rFonts`、`w:sz`、`w:color`、`w:u` 和 `w:jc`。实际下载中只对目标文字应用字符格式，相邻两段文字运行保留了原样式。已比对本功能加入前保存的文字修订，原包导出部件逐个一致。 [DOCX 格式工具栏与下载截图](../screenshots/hcd-light-edit-docx-format.png)

## 第九阶段交付与验收

- 在已有 DOCX 的表格中点击可映射段落即可修改文字。普通矩形表格选中一个单元格后，可在它的下方或右侧插入行列，也可删除所在行列。新单元格支持输入纯文字。文字和行列操作均可在当前会话撤销、重做。合并、嵌套、含映射对象或拆成多个 HCD 分片的表格保留其结构。
- 「保留源 DOCX」会按修订判断已有文字或表格结构能否原包回写。源表格含域、合并、受保护范围或修订标记时，行列变更用「重建可编辑 DOCX」交付。PDF 的原生下载检查使用当前修订的页序和所填页码，范围越界时给出校验错误。
- 浏览器验收使用包含编号、页眉和页脚的 56 行项目提案长表。实测改字、在新增单元格输入、增删行列、撤销重做及原包下载。重新导入下载文件后逐格核对了 56 × 4 的结果。ZIP 只有 `word/document.xml` 变化，其他 9 个部件逐字节相同。带正文对齐变更的 DOCX 修订显示重建提示，它的原始修订仍可原包导出。 [表格编辑及下载截图](../screenshots/hcd-light-edit-docx-table.png)

## 第十阶段交付与验收

- 在已有普通表格的空白单元格中点「＋」，光标进入该单元格。补录文字进入协作编辑和保存点。符合原包条件时，导出将文字写入原单元格的段落。全空表格也可补录。单元格需包含一个普通空段落，表格需为未分片的矩形。
- 正文中选定段落后，从「插入 → 插入表格」设置行数和列数。新表格插在当前块之后，光标进入第一个单元格，可用「开始」中的撤销、重做验证结构变化。新表格最多 256 行、64 列和 1024 个单元格，使用「重建可编辑 DOCX」下载。
- 浏览器给原表格第 1 行第 2 列补录 `确认 甲 & 😀` 后实际下载并重开，文字位于原单元格，除 `word/document.xml` 外其他部件逐字节一致。新建 2 × 3 表格的验收覆盖插入、撤销、重做、单元格录入与重建下载。 [新建表格截图](../screenshots/hcd-light-edit-docx-insert-table.png)

## 复现命令

从仓库根目录运行 `cargo build -p officecli`。用项目提案样本验证 `table.edit`、原包导出及重开。

```bash
work=$(mktemp -d)
cli=target/debug/officecli
source_docx=assets/showcase/project-proposal.docx
"$cli" hdoc import "$source_docx" -o "$work/proposal.hcd" --document-id proposal
"$cli" hdoc project-editor "$work/proposal.hcd" --expected-revision 0
"$cli" hdoc editor-state "$work/proposal.hcd" --json |
  jq -c '.data as $d | first($d.blocks[] | select(.editableTableLayout)) as $b |
    {schemaVersion:"hcd-patch/4", documentId:$d.documentId, patchId:"insert-row",
     baseRevision:$d.revision, operations:[{op:"table.edit", blockId:$b.blockId,
     action:"insertRow", index:1, precondition:{blockHash:$b.blockHash}}]}' |
  "$cli" hdoc apply "$work/proposal.hcd" --expected-revision 1 --patch -
"$cli" hdoc validate "$work/proposal.hcd"
"$cli" hdoc export "$work/proposal.hcd" --source "$source_docx" -o "$work/proposal.docx"
"$cli" hdoc import "$work/proposal.docx" -o "$work/reopened.hcd"
"$cli" hdoc validate "$work/reopened.hcd"
```

在已开启编辑投影的 DOCX 上，`table.insert` 可用 `afterBlockId`、`rows` 和 `columns` 替代上述 `table.edit` 操作。空白单元格的 `table.cell.activate` 使用从 `editor-state` 返回的 `editableEmptyCells` 坐标和表格的 `blockHash`。行列坐标从 0 开始。运行 `cargo test -p hcd-docx filling_an_empty_table_targets_the_original_cell_without_a_text_anchor` 可核对两个相邻全空表格中只有目标格被写回。

在独立目录验证 CSV/TSV、网格分片与导出地址。

```bash
work=$(mktemp -d)
cli=target/debug/officecli
printf 'ID,城市,说明,\r\n00123,北京,"a,b",\r\n00456,上海,"第一行\r\n第二行",\r\n' > "$work/grid.csv"
"$cli" hdoc import "$work/grid.csv" -o "$work/grid.hcd" --chunk-blocks 1
"$cli" hdoc validate "$work/grid.hcd"
"$cli" hdoc export "$work/grid.hcd" -o "$work/grid.tsv"
"$cli" hdoc export "$work/grid.hcd" -o "$work/grid.xlsx"
unzip -p "$work/grid.xlsx" xl/worksheets/sheet1.xml
cargo test -p hcd-formats delimited_text_and_empty_fields_round_trip_after_grid_edit
cargo test -p officecli semantic_xlsx_preserves_addresses_and_text_across_grid_windows
cargo test -p hcd-formats grid_sort
cargo test -p hcd-formats saved_grid_filter
cargo test -p hcd-docx checkpoint_text_exports_through_the_original_docx_parts
cargo test -p pdf-handler extraction_preserves_inherited_geometry_text_and_links_between_retained_pages
```

PDF 输出可用不同尺寸的测试页确认范围和顺序。

```bash
cp examples/test.pdf "$work/packet.pdf"
"$cli" add "$work/packet.pdf" / --type page --prop width=500 --prop height=550
"$cli" add "$work/packet.pdf" / --type page --prop width=600 --prop height=550
"$cli" hdoc import "$work/packet.pdf" -o "$work/packet.hcd"
"$cli" hdoc export "$work/packet.hcd" -o "$work/selected.pdf" --pdf-pages 2-3
"$cli" view "$work/selected.pdf" stats
"$cli" raw "$work/selected.pdf" '/page[1]'
"$cli" raw "$work/selected.pdf" '/page[2]'
```

用同一个三页样本将原第 2 页移到最前并顺时针旋转 90°，然后按新页序导出前两页。

```bash
"$cli" hdoc import "$work/packet.pdf" -o "$work/organized.hcd" --document-id packet
"$cli" hdoc apply "$work/organized.hcd" --expected-revision 0 --patch - <<'JSON'
{"schemaVersion":"hcd-patch/31","documentId":"packet","patchId":"move-and-rotate","baseRevision":0,"operations":[{"op":"pdf.page-layout.set","pages":[{"sourcePage":2,"rotation":90},{"sourcePage":1,"rotation":0},{"sourcePage":3,"rotation":0}]}]}
JSON
"$cli" hdoc validate "$work/organized.hcd"
"$cli" hdoc export "$work/organized.hcd" --source "$work/packet.pdf" --pdf-pages 1-2 -o "$work/organized-native.pdf"
"$cli" hdoc export "$work/organized.hcd" --pdf-pages 1-2 -o "$work/organized-visual.pdf"
swift -e 'import Foundation; import PDFKit
for path in CommandLine.arguments.dropFirst() {
  let pdf = PDFDocument(url: URL(fileURLWithPath: path))!
  let first = pdf.page(at: 0)!
  print(pdf.pageCount, first.rotation, first.bounds(for: .mediaBox).size)
}' "$work/organized-native.pdf" "$work/organized-visual.pdf"
```

macOS 上两行均应显示 2 页，第一页旋转 90°，媒体框 500 × 550 pt。

在同一个三页样本中替换第 2 页为空白页，再分别检查两种 PDF 输出。

```bash
"$cli" hdoc import "$work/packet.pdf" -o "$work/page-edits.hcd" --document-id packet-edit
"$cli" hdoc apply "$work/page-edits.hcd" --expected-revision 0 --patch - <<'JSON'
{"schemaVersion":"hcd-patch/32","documentId":"packet-edit","patchId":"replace-with-blank","baseRevision":0,"operations":[{"op":"pdf.page-layout.set","pages":[{"sourcePage":1,"rotation":0},{"rotation":0},{"sourcePage":3,"rotation":0}]}]}
JSON
"$cli" hdoc validate "$work/page-edits.hcd"
"$cli" hdoc export "$work/page-edits.hcd" --source "$work/packet.pdf" --pdf-pages 2 -o "$work/blank-native.pdf"
"$cli" hdoc export "$work/page-edits.hcd" --pdf-pages 2 -o "$work/blank-visual.pdf"
```

两个文件均应有一张 A4 空白页。浏览器复现可用可选文字 PDF，先插入空白页，再删除一张能用关键词唯一定位的原始页。

参考编辑器可使用 [本地运行步骤](../../examples/hdoc/editor/README.md#local-run)。DOCX 用查找面板替换后，分别操作撤销、重做、保存和下载，再用 `officecli view 下载文件.docx text` 检查目标段落。网格上传使用 `hdoc issue-token --document-id '*' --scope upload`，导入完成后按返回的文档 ID 签发 `write` 令牌。

按表输出可用仓库里的三工作表示例验证。PDF 原生提取可用任何含可选文字且至少三页的 PDF 验证。

```bash
"$cli" hdoc import assets/showcase/budget-tracker.xlsx -o "$work/budget.hcd"
"$cli" hdoc export "$work/budget.hcd" --sheet Settings -o "$work/settings.csv"
"$cli" hdoc export "$work/budget.hcd" --sheet Transactions -o "$work/transactions.tsv"
"$cli" hdoc export "$work/packet.hcd" --source "$work/packet.pdf" --pdf-pages 2-3 -o "$work/native-pages.pdf"
cargo test -p pdf-handler extraction_preserves_inherited_geometry_text_and_links_between_retained_pages
```
