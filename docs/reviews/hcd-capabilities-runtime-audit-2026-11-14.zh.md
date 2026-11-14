# OfficeCLI 预览、转换、AI 与协同本地运行审计

> 此文保留 `60207d8` 时的历史观察。后续已修复资源去重/排序、CLI HTML 导出、幻灯片 PDF 尺寸和 MCP 协议问题，并加入多 Agent 与多标签能力；最新结果见 [后续实现与验收](../acceptance/hcd-agent-workspace-2026-11-14.zh.md)。以下数字不代表后续工作区状态。

日期：2026-11-14。分支：`feature/hcd-font-format-integration`。代码提交：`60207d8`。

**结论：当前已有可运行的多格式预览、转换和协同基础，但尚未完全支持所有文档格式，也不能保证所有预览和转换都正确或与 Office/WPS 一致。AI 工具接入已有基础，编辑器尚无内置 AI 助手闭环，MCP 还有协议兼容问题。**

本次实际启动 Rust API、Hocuspocus sidecar 和编辑器，在 Google Chrome 无头浏览器中检查 7 类格式；运行仓库全部 82 个 DOCX/XLSX/PPTX 样本、49 条语义导出尝试和 14 条 HTTP 下载链路。没有在真实 WPS/Microsoft Office 中对照打开文件，浏览器截图也不能替代独立版式基准。

## 本地运行入口与证据

- 编辑器：[http://127.0.0.1:8767/?locale=zh-CN](http://127.0.0.1:8767/?locale=zh-CN)，本次审计结束时服务继续运行，可直接打开本地样本卡片。
- API：`http://127.0.0.1:8766`；健康检查：`GET /health`。
- 协同：`ws://127.0.0.1:8768`。
- 临时数据与完整日志产物：`/var/folders/k6/xb6x7dcn60z1bwxvmqyls7hr0000gn/T/officecli-capability-ad6oakbr`，也可读取 `/tmp/officecli-capability-current` 获取位置。
- 仓库内保留的[机器可读结果](hcd-runtime-audit-2026-11-14/summary.json)和截图不包含签名密钥或访问令牌。本地运行数据与原始样本分开，浏览器编辑只作用于临时副本。

运行环境为 macOS arm64、Rust 1.90.0、Google Chrome。开始审计时重新构建了二进制。此前合并阶段的 946 项 Rust 测试、严格 Clippy、格式检查及三个前端构建已通过，本次没有重复这些门禁；文件级审计暴露了它们没有覆盖到的问题。

## 格式支持的实际边界

| 格式 | 当前预览和编辑入口 | 转换及保真边界 |
|---|---|---|
| DOCX | HCD 语义流；正文、基础富文本、列表及主题字体；源格式另有 HTML renderer | 不复现 Word 物理分页；编辑投影中复杂表格等区域会变成只读内容。部分原生对象依赖原始文件保留；当前存在重复资源导致导入产物无效的问题 |
| XLSX | Univer Canvas；映射单元格值、公式、格式、布局，以及受支持的行列/工作表操作 | 不等于完整 Excel 计算与排版引擎；复杂公式、条件格式、数据透视及图表等需逐类验收。节点 `text.font` pin 的 source-backed 导出仍明确拒绝，clear 后可恢复 |
| PPTX | 固定画布；文字、形状、图片、部分缓存图表与表格；字体/格式/对齐、受限的页面增删移复制 | 母版/布局继承、组合变换、SmartArt、动画、媒体和高级效果没有完整浏览器复现；复制已编辑页及页专有关系仍有限制。15 个样本修改后重导入的根哈希不一致 |
| PDF | 页面栅格背景加可提取文字映射；部分文字修改与新增文本框 | 页面图像可看不等于对象可编辑；扫描页无自动 OCR 闭环。默认视觉 PDF 导出使用页面图像，原始文字和矢量结构不随之保留；保留源文件的修改仍有位置/字体近似 |
| HTML / HTM | 经清理的语义内容，使用通用编辑器 | 活动内容被移除，不能当作任意网页完整运行环境；CLI 与 HTTP 的 HTML 导出能力目前不统一 |
| Markdown | 语义预览和基础块编辑 | 引用、代码、表格等结构在编辑投影中可能作为只读块保留；支持显示不代表支持任意结构编辑或原样格式回写 |
| TXT | 按文本行映射，进入通用编辑器并可导出 | 纯文本格式不保存富文本和原生 Office 结构；跨格式输出属于重建 |

路由也有差异：[普通 CLI handler](../../crates/officecli/src/main.rs)接受 DOCM/XLSM/PPTM；[HCD 导入路由](../../crates/hcd-formats/src/lib.rs)只接纳上表的 7 类及其扩展名别名，不直接接受这些宏格式。DOC/XLS/PPT 走单独的 `convert` 引擎；默认 LibreOffice 需要外部安装，也可选择能力不同的引擎。本次没有旧二进制 Office、宏格式、ODF、RTF 或 CSV 的完整验收样本，不能据此声称这些格式也已获得通用预览、转换、AI、协同支持。

## 实测结果

| 检查 | 结果及解释 |
|---|---|
| 7 类代表样本导入、HCD 校验、HTML 生成 | 7/7 通过 |
| 浏览器打开 7 类样本 | 7/7 可显示：语义编辑器 4 类、固定页面 2 类、Univer 1 类 |
| 7 输入 × 7 语义导出目标 | 49 次尝试；42 次成功导出、重导入并校验；7 次 HTML 目标被 CLI 明确拒绝 |
| 7 类输入的 HTTP HTML 下载 | 7/7 成功，下载后重新导入及校验通过 |
| TXT 经 HTTP 下载为 DOCX/XLSX/PPTX/PDF/MD/TXT/HCD | 7/7 成功，重新导入或解包及校验通过 |
| 同格式 source-backed 无修改导出 | 7/7 成功；3 个 Office ZIP 的部件内容全部相同，4 个非 ZIP 文件字节相同。Office ZIP 的容器字节可因重打包变化 |
| 实际导出 PDF 的 PDF.js 预览 | 已等到页面渲染结束，显示 4 页中的第 1 页，画布有实际内容；没有把初始空画布算作通过 |
| 仓库保真审核器 | 返回 1，结论 `PARTIAL_HIGH_FIDELITY`；可编辑 HTML 的 1:1 认证为 false |

42 次语义转换中，35 次报告 `SEMANTIC`、6 次报告 `HIGH`、1 次报告 `VISUAL`。这些等级针对各自报告的保留范围，不能统一解释为“转出文件完全等价”。

两个可量化的例子：

- 样本 PPTX 为 `12192000 × 6858000 EMU`，宽高比 16:9；默认导出 PDF 是 `595.28 × 841.89 pt` 的 A4 纵向页，并非按幻灯片物理尺寸输出。需要明确产品要的是打印排版还是保持原页尺寸。
- PDF 样本原有 52 个映射文字节点；无源视觉 PDF 导出后重导入得到 0 个映射文字节点。图像预览链路成立，但原有可选择、可检索文字结构已转成页面图像。

### 文件级套件暴露的问题

| 套件 | 原始输出 | 复核后的判断 |
|---|---|---|
| DOCX，8 个文件 | 汇总称 7/7 通过 | 实际 7 个通过，1 个失败被漏记。`inlinedparts-hosts.docx` 导入产物有 `DUPLICATE_ASSET`，render 失败；汇总读取不存在的 `patched-fidelity.json` 出错，没有把此用例写入结果 |
| XLSX，20 个文件 | 0/20 通过 | 全部失败项只有 `sheet_count`、`grid_random_access_index`。脚本用文本搜索读取 gzip chunk，又只查找旧的 `*.json` 索引。按压缩格式解码后，20/20 的工作表数量及索引检查通过；其余原套件检查未报告失败。这不是 20 个工作簿都无法预览或导出 |
| PPTX，54 个文件 | 39 通过、15 失败 | 15 个均为 `patched_reimport_root_hash`。逐个比较，正文/映射描述符、样式及排序后的资源记录都相同，资源索引顺序全部不同。属于资源规范化和根哈希一致性问题，不能把它描述为已证实的正文丢失 |

DOCX 原样本另外带有源 XML 命名空间问题。为排除这个干扰，本次还创建了一个最小文件：空白 DOCX 中加入两个内容相同的 PNG media 部件并声明 PNG content type。该文件通过本项目的源格式校验；HCD 导入返回成功，但 HCD 校验报 `DUPLICATE_ASSET`，HTML 渲染被拒绝。此复现不依赖原样本的命名空间错误。

最小文件已保留为 [duplicate-media.docx](hcd-runtime-audit-2026-11-14/duplicate-media.docx)。可用以下命令复现；先选择一个尚不存在的输出目录：

```bash
officecli validate docs/reviews/hcd-runtime-audit-2026-11-14/duplicate-media.docx --json
officecli hdoc import docs/reviews/hcd-runtime-audit-2026-11-14/duplicate-media.docx \
  --output /tmp/hcd-duplicate-media-repro.hcd --document-id duplicate-media-repro
officecli hdoc validate /tmp/hcd-duplicate-media-repro.hcd --json
officecli hdoc render-html /tmp/hcd-duplicate-media-repro.hcd --output /tmp/hcd-duplicate-media-repro.html
```

对应代码：DOCX 的 `write_asset_index` 直接写全部资源记录；PPTX 导入按发现顺序去重，而 core patch 按 hash 排序；根哈希又纳入资源索引文件字节。修复时应一起明确资源别名、去重、排序和存储编码的规范，覆盖“同一字节被多个源 part 引用”及“修改后重导入”等路径。

## 通用预览能力

当前已形成共用的文档标识、鉴权、搜索、下载、历史修订、恢复、主题字体、在线人员和基本界面设置；DOCX/HTML/MD/TXT 共用 Tiptap，PDF/PPTX 共用固定页面文字编辑核心，XLSX 使用单独的 Univer 适配器。

本次验证了全文搜索返回映射节点、实际下载及 PDF 打印预览、只读控制和修订恢复。格式特有的操作仍由不同 schema、API 分支和前端适配器承担，没有一个能代表全部格式操作的完整能力契约。例如导入 manifest 的通用 `stylePatch`/`structurePatch` 标志不足以列出 PPTX/XLSX 的专属格式及结构操作，不能只靠几个布尔值决定整个工具栏。

浏览器还观察到界面问题：在 1440 像素宽的 XLSX 页面中，工具栏过密，多个中文按钮竖排换行，右侧操作溢出；PPTX 左侧页面动作也有裁切。DOCX 编辑投影的复杂表格显示为只读文本区域。因而“共用外壳已有”与“所有格式体验一致”仍有距离。

截图：[DOCX](hcd-runtime-audit-2026-11-14/docx.png)、[XLSX](hcd-runtime-audit-2026-11-14/xlsx.png)、[PPTX](hcd-runtime-audit-2026-11-14/pptx.png)、[PDF](hcd-runtime-audit-2026-11-14/pdf.png)、[HTML](hcd-runtime-audit-2026-11-14/html.png)、[Markdown](hcd-runtime-audit-2026-11-14/md.png)、[TXT](hcd-runtime-audit-2026-11-14/txt.png)、[实际导出 PDF 预览](hcd-runtime-audit-2026-11-14/exported-pdf-preview.png)。

## AI 能力

已具备外部 Agent 使用的基础：结构化 CLI/JSON、字符偏移到路径的映射、HCD nodeId 与 hash 前置条件、patch、修订及 fidelity report；MCP 实际列出 **14 个工具**，本次通过 JSON-RPC 成功调用了 DOCX/XLSX/PPTX/PDF 的 `extract_text`。

但当前不能认定 AI 集成已完整完成：

- 编辑器没有内置聊天、模型供应商接入、摘要、翻译、问答或 AI 改写工作流；本次也没有配置外部模型进行端到端任务验收。
- [MCP 工具定义](../../crates/officecli/src/mcp.rs)序列化为 `input_schema`，MCP Tool 结构要求的字段是 `inputSchema`。实测 14 个工具都缺少后者，严格客户端存在工具发现兼容问题。另有通知收到空响应、EOF 时 stdout 输出 `MCP server stopped` 的协议问题。本次没有连接标准 SDK 客户端完成兼容认证。
- MCP 工具主要操作传统文件 handler，没有暴露 HCD import/search/patch/revision/theme/协同等专用工具。Agent 可以另行调用 CLI 或 HTTP，但还缺统一的 HCD 工具入口。
- 直接改磁盘源 Office 文件不会自动成为当前 HCD/Yjs 文档中的一次协同修订。AI 要参与协同，需通过对应 HCD API、预期修订及 hash 前置条件提交；语义结构修改还要遵循 collaboration epoch。

## 协同能力

| 模式 | 本次实际验证 | 当前边界 |
|---|---|---|
| DOCX/HTML/MD/TXT 语义协同 | 在 TXT 上开启两名写用户和一名读用户，真实浏览器输入双向实时同步；读用户收到修改且 `contenteditable=false`；最终 HCD 修订 2 中确认两名写用户的内容均已保存 | 共用 Yjs 实现，但本次没有逐格式重复全部协同场景。侧车定时 checkpoint，尚未持久化的最新状态有故障窗口 |
| PDF/PPTX/XLSX 修订协同 | 三类各开两浏览器；经 API 提交 patch 并经 sidecar 广播后，两窗口均显示新内容。只读写入 403，不同 patch 使用旧修订返回 409，相同 patch 重放返回 200 | 同步已提交修订；未保存的按键不做 CRDT 合并。同位置并发修改需要处理冲突。本次提交通过 API 驱动，没有声称逐项覆盖所有 UI 保存按钮 |
| 历史恢复与协同隔离 | PPTX 恢复成功，epoch 从 0 变为 1；旧房间持久化写入返回 409 | 本次未覆盖断网重连、侧车崩溃、多实例、长期压力或 PostgreSQL/S3 故障恢复 |

当前设计以一个 Hocuspocus sidecar 为前提。固定格式还有 15 秒 manifest 轮询兜底；本次验证了 WebSocket 广播路径，没有断开 sidecar 重测兜底路径。

截图：[语义文档双写一读](hcd-runtime-audit-2026-11-14/semantic-collaboration.png)、[固定页面修订同步](hcd-runtime-audit-2026-11-14/fixed-collaboration.png)。

## 后续建设顺序

1. **P0：先让文件级验证可信。** 修复 DOCX 重复资源；让批量脚本对缺失结果、遗漏用例和失败日志返回失败；适配 gzip 和内容寻址索引。将重复资源与带图片/图表的修改后重导入纳入回归。
2. **P1：统一内容身份与导出契约。** 统一资源索引规范化及 root hash 语义；对齐 CLI/HTTP HTML 导出；为 PDF 明确原页尺寸、纸张方向、视觉图像与可检索文字的输出模式，并展示转换损失。
3. **P1：补完整的 AI 工具接口。** 修正 MCP schema/通知/stdout 行为，用标准 SDK 验证；围绕 HCD 搜索、定位、patch、预览、导出和历史建立工具，接入修订冲突及协同 epoch。再建设模型接入和具体 AI 产品任务。
4. **P1：完善通用界面。** 根据格式和实际能力分组工具栏、处理窄屏/溢出，清晰显示只读块及导出拒绝原因；保持各格式搜索、历史、字体和下载行为一致。
5. **P2：建立独立保真与协同验收。** 使用真实 Word/WPS/Excel/PowerPoint 或可信独立渲染结果做基准，逐类扩展复杂文档；增加断网、并发同节点编辑、恢复后重连和持久化故障测试。

本次仅新增审计记录、结果快照与截图，未修改实现。发现的问题在当前集成分支上复现，尚未逐个对照 main 和来源分支确定首次引入的提交。

## 复验入口

仓库根目录运行，使用新的输出目录：

```bash
cargo +1.90.0 build -p officecli
HCD_AUDIT_ROOT="$(mktemp -d /tmp/hcd-runtime-audit.XXXXXX)"
DOCX_SUITE_SKIP_BUILD=1 DOCX_SUITE_BIN="$PWD/target/debug/officecli" \
  bash examples/hdoc/docx-suite/run.sh "$HCD_AUDIT_ROOT/docx"
XLSX_SUITE_SKIP_BUILD=1 XLSX_SUITE_BIN="$PWD/target/debug/officecli" \
  bash examples/hdoc/xlsx-suite/run.sh "$HCD_AUDIT_ROOT/xlsx"
PPTX_SUITE_SKIP_BUILD=1 PPTX_SUITE_BIN="$PWD/target/debug/officecli" \
  bash examples/hdoc/pptx-suite/run.sh "$HCD_AUDIT_ROOT/pptx"
```

上述脚本包含已记录的缺陷，必须同时查看日志、每个用例的 `failures.txt` 和汇总数量。完整逐命令输出保留在本次临时产物目录；临时探针入口为 `/tmp/hcd-capability-probe.py`、`/tmp/hcd-capability-http.py`、`/tmp/hcd-capability-browser.mjs`、`/tmp/hcd-capability-extra.mjs`、`/tmp/hcd-capability-finish.mjs`，这些本机脚本不属于仓库交付接口。

浏览器启动和嵌入方式见 [编辑器 README](../../examples/hdoc/editor/README.md)。真实协同、权限、PDF 页面大小和资源重复等复验应同时检查可见内容、保存后的 HCD 内容以及导出后重开的文件，避免仅凭 HTTP 200、空画布或测试汇总判断成功。
