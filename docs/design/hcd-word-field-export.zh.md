# 区域 Word 页码域的语义 DOCX 保留（2026-10-30）

后续已增加可创建页码行内节点的原生模型及普通/区域语义 DOCX 适配，见[新建节点及未完成的前端接线](hcd-word-numeric-field-nodes.zh.md)。本页保留原有域导出批次的实际范围和证据，不将后续原生创建能力算作浏览器插入已经完成。

区域 Word `/2` 的语义 DOCX 导出现在保留受支持的 `PAGE`、`NUMPAGES`、`SECTIONPAGES` 指令和已保存结果，避免将这些内容全部展平为静态文字。本批不计算页码、不开放域插入或缓存编辑；分页、自动目录和其他格式完整能力继续推进，管理平台及实际提醒后置。

## 数据与导出

原生导入已将域指令保存为 `hcd-word-field/1`，在规范 HTML 中使用成对的零宽开始/结束标记，显示结果所在块受保护。导出先按源部件核对边界：允许正文跨节、跨块及跨段落，不允许重复、缺失、错序或错误部件的结束。原始规范包及 revision 不因导出改变。

转换器为段落和表格单元格记录结构化域事件，在文字修剪、格式拆分及分片表格重组时保留事件位置。`RichFieldControl` 输出原生 `w:fldChar` begin/separate/end 和 `w:instrText`，缓存结果作为独立 rich run 保留格式；没有以可见占位文字定位或执行指令。普通任意 HTML 转换不启用这条域通道。

支持无开关的三种指令，以及受限 `\*` 通用格式。允许的格式名称为 arabic、alphabetic、roman、ordinal、cardtext、ordtext、dollartext、hex、mergeformat、caps、firstcap、upper、lower，保留原始大小写。未知开关、格式、数字图片等不作为动态域输出。`CHARFORMAT` 依赖原始指令 run 格式，而现有 HCD 域元数据没有该格式，因此继续输出静态缓存；不能假装保留指令就已保留格式语义。其他指令同样保留可读结果并给出提示，原指令仍在 HCD 归档。

有受支持域时，生成的 DOCX 设置 `w:updateFields`，域带 dirty 标记，供支持计算的目标应用处理。这只是文件结构和更新请求；没有证明目标应用已经重算或与原稿分页一致。域边界及更新设置的规范说明见 [Microsoft FieldChar](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.fieldchar?view=openxml-3.0.1) 和 [UpdateFieldsOnOpen](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.updatefieldsonopen?view=openxml-3.0.1)。

## 界面与兼容

固定 revision 的服务端 `/export-options` 为区域 `/2` 声明 `semanticWordFields: "numeric-v1"`。客户端只对确切已知版本显示新的保留说明，仍使用现有的 revision/source-refresh 范围检查。旧服务没有声明、未知未来版本或过期结果不能使界面宣称该能力。

说明只在语义 DOCX 模式下切换，并避免与区域编辑器传入的说明重复。最终说明采用紧凑字号，可换行；HCDZ 仍单独说明完整资源及历史归档。预检、保存门禁、取消下载和文件下载前检查沿用既有实现。

本能力没有改变协同协议、保存请求或设备格式。规范模型仍保留全部原始域，包括本次语义导出静态化的域；重新导入生成 DOCX 后，受支持域再次识别为受保护内容。设备备份是同作用域草稿快照，不能替代保存指令、资源和规范历史的 HCDZ。

## 验证结果

- HTML 转换器 **54 项**、DOCX handler **41 项**通过。包含域白名单、嵌套/跨节/错序边界、Unicode 与格式拆分、空结果、跨段落、表格单元格及分片表格等；完整区域导出再导入测试同时检查规范 head 不变。
- 最终前端导出、范围门禁与快照专项 **27 项**通过，TypeScript、独立版和嵌入版构建通过。此前同批 22 项专项也保留；本批没有重新运行全部前端测试，先前 2036 项全量属于重连批次。
- 修改的 Rust 文件格式复查通过，原生构建及 `docx-handler` 严格 Clippy 通过。`officecli` 严格 Clippy 被本批未修改的 `hcd-core/src/structure/flow_regions.rs:242` 的 `nonminimal_bool` 阻断，不能称全部 lint 通过。
- 初次最终格式检查暴露不稳定排版，已简化构造并复查；设备 verifier 初次用 ProseMirror `textContent` 读取 opaque atom，无法读取属性中的缓存，改为读取生产捕获快照后通过。原始失败日志保留，未修改产品数据使检查通过。

## 普通浏览器与实际文件

全新隔离合成源包含六个域：格式化 PAGE、跨两段的 NUMPAGES、表格内 SECTIONPAGES、空 PAGE，以及静态回退的 DATE 和 PAGE CHARFORMAT。Alice/Bob 为写成员，Reader 只读，通过普通产品入口操作，没有注入编辑器或设备库。

| 版本 | 实际操作 |
| --- | --- |
| r1 | 导入及分区，两节、图片和全部六个域保留 |
| r2 | Alice 原位编辑普通页眉文字并保存，域缓存保持只读 |
| r3 | Bob 修改正文并保存，另一成员及只读成员接收结果 |
| r4 | Alice 撤销自己的页眉文字并保存，同伴正文保留 |
| r5 | Alice 重做并保存，双方文字各保留一次 |

实际浏览器下载 r3/r5 DOCX、r5 HCDZ 及 `/6` 设备备份；原生另导出固定 r4。三份 DOCX 都核对四个动态域、缓存结果、大写罗马缓存的粗体、NUMPAGES 跨段落、表格内位置和空结果，DATE/CHARFORMAT 不输出活动指令但可读结果保留；图片字节和两节尺寸保留。三个 DOCX 重新导入并 validate，四个域再次受保护。

实际 HCDZ 解包后 62 个规范文件与原包逐字节一致，r1–r5 内容完整回读、六个规范域定义始终不变；从解包后的无原文件包再导出的 DOCX 同样保留四个受支持域。所有导出不推进规范版本。设备备份通过生产 reader 隔离解码，与最终规范语义内容和布局一致；它未被自动合并或提交。

最后的紧凑样式调整触发开发热更新；上述协作、个人历史和实际下载在此之前已完成。热更新后重新读取 r5，最终截图检查说明只有一份、字号 11px 且由服务能力声明切换，不将开发热更新描述成原窗口无刷新验收。

证据：[浏览器观察](../assets/hcd-word-field-export-2026-10-30/browser.json)、[文件回读](../assets/hcd-word-field-export-2026-10-30/files.json)、[设备备份](../assets/hcd-word-field-export-2026-10-30/backup.json)、[最终界面](../assets/hcd-word-field-export-2026-10-30/final-export.png)、[验证汇总](../assets/hcd-word-field-export-2026-10-30/validation.json)。这些是本机合成文档、真实本机服务与文件结构验证，没有外部 Word/WPS 计算、真实断电、跨物理设备或生产验收。

## 复验和后续工作

```sh
cargo build -p officecli --bin officecli
python3 scripts/hcd-word-layout-browser.py --clean --draft-only --story-source --numeric-fields
# 用打印的普通入口按上表操作，另存实际下载并记录 browser.json。
python3 scripts/hcd-word-field-export-files.py /absolute/owned-root /absolute/output-directory
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-field-export-backup.mts /absolute/owned-root /absolute/output-directory
```

后续须继续实现页面布局/分页、结构化插入页码域、浏览器重算及自动目录，并将创建、协作、个人历史、保存恢复和各格式导出共同验收。更广域类型和复杂开关需要保留依赖与格式后再开放；本批不据数值域导出宣布 Word 基础或完整 HCD 目标完成。
