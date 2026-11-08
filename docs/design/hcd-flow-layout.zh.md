# Word 分节、页眉页脚与域：原生保存基础

2026-10-26。本增量承接 [Word 基础能力](hcd-document-basics.zh.md)，先建立能进入版本、还原和离线包的数据模型。**尚未开放页眉页脚的浏览器编辑，也未完成正文自动目录。** 管理平台和实际提醒发送仍后置。

后续进展：[模型 2 与区域结构保存](hcd-flow-regions.zh.md)已补显式 CLI 预览、分节正文及 story 分区、区域富文本/图片联合事务和跨模型历史。这份文档记录模型 1 阶段的保存基础，最新能力和边界以区域结构专题为准；普通导入仍默认关闭区域模式。

## 当前实现

`hcd-docx::ImportOptions.flow_layout` 是默认关闭的内部开关，CLI 和 HTTP 普通导入尚不启用。开启后：

- 顺序读取当前分节、最终节、纸张尺寸/方向、显式页边距、页眉页脚距边、分页方式、页码起始和格式；没有显式值时不猜默认值。
- 页眉页脚各自区分默认、首页、偶数页；引用指向稳定的独立 story，缺少引用表示链接同类型的前节内容。相同 story 不复制正文。
- 保留未启用的首页/偶数页内容、空 story、未引用的 `header*.xml/footer*.xml`，以及通过关系指向任意名称的合法 story。解析时校验命名空间、关系角色、路径和资源上限。
- 单独保留带命名空间的原始 `sectPr` XML，包括尚未建模的栏等属性与历史属性；不把 `sectPrChange` 里的历史设置作为当前节。

同类型前节继承、首页/偶数页缺失时留空的规则依据 [Microsoft HeaderReference](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.headerreference) 与 [EvenAndOddHeaders](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.evenandoddheaders)。对应的产品交互可参考 [Word 链接到前一节](https://support.microsoft.com/en-gb/word/link-to-previous)。这些是关系解析规则，不代表已经实现与 Word 一致的实际分页。

## 版本、保存与协议

新增必需能力标记 `capabilities.flowLayout: 1`。布局对象使用 `hcd-flow-layout/1`，以 `word/_hcd/flow-layout-v1.json` 资产记录进入现有内容寻址资产图；SHA-256、长度、声明和模型均校验。布局不放在不随版本变化的旁路文件中，因此现有版本根、历史、还原、资源保留和 HCDZ 离线打包可以携带它。

现阶段支持对已有映射文字进行正文/页眉/页脚联合修改：一批 precondition 或 revision 失败时不推进 head；重复请求使用原回执。带原稿的 DOCX 导出保留节属性、关系、未改动 story 和原始域 XML。离线 HCD 保留布局和文字，并能重开历史；这不等于无源 DOCX 已能重建分节。

原生 `/editor` 和映射文字写接口要求客户端声明 `X-HCD-Flow-Layout-Version: 1`，否则返回 426；声明不授予写权限。结构投影、结构补丁、修订改写和签名快照入口在区域感知协议完成前拒绝此模型，避免旧正文保存路径扁平化页眉页脚。旧 manifest 解码器会拒绝未知能力字段。普通导入不写该字段。

这批测试从 r0 就启用布局模型，未实现旧文档迁移或历史中途切换模型。后续迁移必须同时处理每个 revision 的能力声明，不能只修改 head。

## 页码和其他 Word 域

内部导入保留简单域、复杂域、跨段复杂域、无缓存结果的域及未知指令。域用稳定 ID、零宽开始/结束标记和 `hcd-word-field/1` 不透明指令定义关联；缓存文字单独记录所属域路径。校验涵盖跨分片身份完整性、重复/缺失定义、来源 part、只读缓存和模型版本。指令不执行。

PAGE、NUMPAGES、DATE 等计算域的结果不是普通可编辑文字，映射补丁会拒绝修改它们；超链接显示文字仍可编辑。带域的结构块暂时只读。普通文字的联合保存不会删除域定义，离线包保留其指令与缓存边界；源 DOCX 导出保持原域 XML。**尚未提供域节点编辑、插入页码、更新缓存或真实总页数计算。**

## 导出边界

| 路径 | 本增量状态 |
| --- | --- |
| 带原稿 DOCX，已有映射文字修改 | 可导出；原节/域 XML 保留 |
| HCDZ 无源离线包，当前与历史版本 | 可打包、重开、还原 |
| 无源语义 DOCX/PPTX/PDF/HTML/Markdown/文本 | 暂时拒绝此内部模型，避免静默丢失区域 |
| 页眉页脚新建、富文本结构、页面设置编辑 | 尚未开放 |
| 实际分页、页码更新、正文自动目录 | 尚未完成 |

CLI 拒绝语义导出时保持已有输出文件不变，并提示使用 `--source` 的 DOCX 或 HCDZ。HTTP `/export-options` 返回 `semanticExportSupported: false` 和 `WORD_REGION_LAYOUT_UNSUPPORTED`；格式下载入口同样拦截，包括 HTML 预览导出路径。前端公开开关仍未接入，不能只靠返回字段当作完整界面兼容。

## 验证与复现

新增测试在 Rust 源文件内，不使用新的 integration test 目录。独立测试夹具包含 2 节、6 个 story、空/未引用/自定义路径内容，以及单独的 PAGE/NUMPAGES/日期/超链接/未知域用例。

```sh
HCD_FLOW_LAYOUT_EVIDENCE="$PWD/target/hcd-preview-runtime/flow-layout-evidence" cargo test -p hcd-core -p hcd-docx -p hcd-formats -p officecli
cargo clippy -p hcd-core -p hcd-docx -p officecli --all-targets -- -D warnings
cargo fmt -- --check
cargo build -p officecli
python3 scripts/hcd-flow-layout-verify.py
```

原生/真实本机 HTTP 文件证据保存在 `docs/assets/hcd-flow-layout-2026-10-26/`。验证器只操作自己的临时副本和服务，凭证仅在内存中，不改当前用户预览文档。实际验收结果以该目录最终 `validation.json` 和 `file-evidence.json` 为准。未做浏览器区域编辑、真实协作房间、Office 桌面排版或跨平台验收。

本次结果：14 项新增用例；原生及现有 CLI 回归 602 项通过。随后补上源 DOCX 导出库入口的模型校验，相关 52 项测试再次通过，最终 clippy/fmt/构建和真实 CLI/HTTP 文件验证通过。实际文件覆盖 r0/r1/r2 离线历史、还原 r0 为新 r3、正文、页眉、页脚联合提交/幂等、只读/协议/前提拒绝，以及源 DOCX 的保留。未知模型/缺少必需声明在源导出时同样拒绝，新输出不创建、已有输出保持原样。

此前主动中断的检查、两次验证脚本断言错误和初次域标记使用不允许 HTML 属性的失败均单独记录，不计作通过。页眉页脚界面、完整协作/撤销和自动目录仍在继续范围内。

## 继续顺序

1. 区域感知的结构/保存协议和签名协作模型；绑定稳定 section/story 身份，并共同处理个人撤销、草稿恢复、权限及历史。
2. 页眉页脚编辑视图、默认/首页/奇偶页切换、链接前节与页面设置；普通导入和旧文档迁移在兼容门禁完成后开放。
3. 共享标题索引，补导航大纲的搜索/当前项，再实现正文自动目录节点、更新和导出。
4. 类型化页码域与真实分页，补齐无源 DOCX 和其他格式的区域导出。没有真实分页时不填猜测页码。

以上继续项不因原生保存基础通过而标记为完成。
