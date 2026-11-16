**整体功能核查 · 2026-11-15**

> 本文保留修复前核查及原始失败证据。随后已修复其中 5 项公式错误、加入操作级能力协商/PR 工作流，并验证一项真实服务崩溃恢复。最新支持范围、剩余缺口和新发现的公式画布显示问题见[当前整体功能状态](hcd-capability-status-2026-11-15.zh.md)；请勿将本文下方的修复前“当前”描述当作最新状态。

当前还没有完成“所有格式、所有复杂对象、无损预览/编辑/转换、人和多 Agent 同等协同”的目标。DOCX、XLSX、PPTX、PDF、HTML、Markdown、TXT 已有统一工作区与基础操作链路，静态 PNG/JPEG/WebP 也有独立图片工作区；复杂对象、计算正确性、持久协同和原应用一致性仍有明确缺口。不能用已通过的样例数量推算整体完成百分比。

核查基于 `feature/hcd-font-format-integration` 当前工作区，HEAD `ccb5fd5`，包含未提交修改。本次做了代码核对、7 类公开样本文档的只读接口探测，以及新建临时 XLSX 的原生 CLI 计算检查。未改动现有文档，未调用模型或向供应商发送文档。前一轮的悬停专项 2 项浏览器回归和前端构建结果不替代本次全功能认证；本次没有重新执行完整工作区测试或 Office/WPS 全量对照。

**格式支持范围**

| 类型 | 已实现的主要能力 | 仍未完整覆盖 |
| --- | --- | --- |
| DOCX | 正文语义编辑、基本格式、分页预览、映射表格直接输入、插表和增删行列、20 步本地历史、协同与 Agent 工具、图片插入和导出 | Word 级物理分页、复杂浮动绕排/多栏、公式与域的完整编辑、完整审阅流程；表格合并/拆分、复杂单元格格式与分片表格结构操作；部分异构字体块受保护；结构变化后 DOCX 走语义重建，不能保证源排版不变 |
| XLSX | 单元格值/数字/受支持公式编辑、基础格式、行列与工作表操作、合并/拆分、冻结窗格、Agent 列分工、版本化提交与导出 | 所有公式的正确计算、任意数组/共享公式写入、完整条件格式、图表/透视表及外部数据编辑；UI、原生 CLI 与 Agent 回读计算的支持集合不同 |
| PPTX | 映射文字、部分形状/图片操作、页面增删复制排序、整稿重建、页数约束、图片槽位与生成态、多 Agent 制作及原生导出预检 | 完整母版/布局继承、组合变换、SmartArt、原生图表编辑、动画和高级效果；现有图文模板不等于任意商业演示稿设计能力 |
| PDF | 页面视觉预览、可提取文字编辑、新建文本框、部分新增对象几何操作、按页插图与导出 | 扫描页自动 OCR、原生任意矢量对象编辑、通用文本重流；默认视觉 PDF 导出可能栅格化文字与矢量，编辑遮罩/字体位置近似，不能承诺保留全部可搜索性或无损对象结构 |
| Markdown | 基本语义内容、部分扩展预览、表格直接输入与结构操作、协同、Agent 和转换 | 任意 Markdown AST 的结构编辑与源码往返保真；代码块、任务列表、嵌套结构等预览能力不能直接算作同等级结构编辑；不自动加载远程图片 |
| HTML | 安全语义结构、基本编辑、表格操作、协同、Agent 和转换 | 任意 CSS/DOM 的还原和编辑；脚本、事件等活动内容会过滤，浏览器网页完整行为不在文档编辑范围内 |
| TXT | 纯文本编辑、换行显示、搜索、协同、Agent 与格式转换 | 无样式/表格等原生语义；转成复杂格式只是生成新结构，无法恢复原本没有的信息 |
| PNG/JPEG/WebP | 静态图片预览、裁剪/旋转/翻转/缩放/调色、格式转换、蒙版局部重绘、候选对比、区域租约与版本守卫 | GIF/APNG/动态 WebP、SVG/HEIC/TIFF/PSD 等不属于此独立图片编辑链路；不是图层编辑器，也不是像素级 CRDT 协同；图片任务和候选任务记录仍有进程内存边界 |
| DOC/XLS/PPT、CSV 等 | CLI 有旧格式转换和 CSV/TSV 导入 Excel 的独立路径 | 不等于原文件直接进入统一工作区并获得同等级编辑/协同；宏格式、ODF、RTF 等不能标记为全部支持 |

直接证据：[格式路由](../../crates/hcd-formats/src/lib.rs:32)、[静态图片解码与限制](../../crates/hcd-formats/src/images.rs:22)、[语义编辑数据模型](../../examples/hdoc/editor/src/schema.ts:12)、[复杂块保护](../../crates/hcd-core/src/structure.rs:620)、[表格分片限制](../../crates/hcd-core/src/structure/table.rs:541)、[PPTX 视觉保真声明](../../crates/hcd-formats/src/pptx.rs:479)、[XLSX 视觉与公式边界](../../crates/hcd-formats/src/xlsx.rs:2169)、[PDF 栅格与 OCR 边界](../../crates/hcd-formats/src/pdf.rs:755)。

DOCX/Markdown/HTML 的当前新增插图位置仍限定为文档末尾行内添加。映射图片可显示、部分新增图片可改尺寸，不意味着任意源图片、任意锚点和浮动图文绕排都能改。完整制作管道当前针对 PPTX，其他格式的 AI 编辑不能等同于完整的整稿重建。见[文档制作范围](hcd-document-production.zh.md:29)。

**已实测的计算错误：优先修复**

以下均在新建临时工作簿内，通过当前 `target/debug/officecli` 设置原生公式并重新读取结果。输入为 `A1=1`、`A2=2`、`A3` 留空。

| 公式 | 按 Excel 语义应为 | 当前原生 CLI 结果 |
| --- | --- | --- |
| `LEN("中文")` | 2 | 6 |
| `COUNTBLANK(A1:A3)` | 1 | 0 |
| `COUNTA(A1:A3)` | 2 | 1 |
| `ROUNDUP(-1.21,1)` | -1.3 | -1.2 |
| `ROUNDDOWN(-1.21,1)` | -1.2 | -1.3 |

代码分别使用了 UTF-8 字节长度、固定空白计数、参数个数和不区分正负的 ceil/floor。证据：[计数与取整](../../crates/xlsx-handler/src/formula/functions.rs:64)、[LEN](../../crates/xlsx-handler/src/formula/functions.rs:285)。

这 5 项结果属于原生 XLSX/CLI 计算器，不能直接说浏览器所有公式都算错。当前 Agent 的 HCD 工作表回读另有守卫，只允许 `SUM`、`AVERAGE`、`MIN`、`MAX`、`COUNT`、`ABS`、`ROUND`、`RANK`、`RANK_EQ`、`RANK_AVG` 共 10 个函数，其余返回 `unavailable`。这能避免把部分不可靠结果报告为成功，但也会拒绝常见复杂公式计算。公式表达式可编辑、浏览器显示结果、服务端可重新计算，是三个不同能力。证据：[工作表计算白名单](../../crates/officecli/src/hdoc_server/spreadsheet.rs:58)。

复现：

```bash
python3 docs/acceptance/hcd-capability-audit-2026-11-15/probe_formulas.py
```

存在不一致时脚本退出码为 1；当前 5 项均不一致。它只创建临时工作簿，不接触用户文件。机器记录：[formula-results.json](hcd-capability-audit-2026-11-15/formula-results.json)。本轮仅记录问题，未修改公式实现。

**协同、多文档与历史的边界**

1. DOCX/Markdown/HTML/TXT 正文和已映射表格文字走 Yjs 字符协同。PDF/PPTX/XLSX 的固定/网格链路主要同步在线状态与已提交修订，不同步未提交的每个按键；同节点并发由 revision/hash/epoch 冲突守卫处理。独立图片采用候选、区域锁和整图版本提交，也不是多人逐像素合并。不能将这些模式统一宣称为所有对象的实时共同输入。
2. 多标签可保留独立编辑与界面状态，并能恢复标签；缓存的主要是会话和视图，不是 IndexedDB 离线内容日志。浏览器关闭/崩溃前尚未传出的输入没有完整持久恢复闭环。
3. 本地撤销默认 20 步，关闭重开不保留撤销栈。结构撤销会检查表格 hash；外部 epoch 变化不会把旧 Yjs 房间的文字撤销重放到新版本。文档历史版本仍可读取和恢复，但这与持续的本地 undo 栈不同。
4. 当前任务绑定一个 documentId；多个文档可以各自操作，还没有通用的跨文档任务计划、共享引用更新与原子提交。不能承诺一次任务同步修改 Word、Excel、PPT 后全部成功或全部回滚。
5. 多 Agent 的共享计划、范围认领、续租、冲突重读与锁释放已经实现；团队、活动和锁仍依赖单个 API 进程。语义协同依赖单 sidecar，缺少完整的多实例共享协调、崩溃接管和长期并发压力验收。

证据：[固定版式协同定义](../../examples/hdoc/editor/src/fixedCollaboration.tsx:31)、[sidecar 加载/保存](../../examples/hdoc/editor/sidecar.ts:193)、[工作区缓存](../../examples/hdoc/editor/src/workspaceSession.ts:44)、[本地历史](../../examples/hdoc/editor/src/editHistory.ts:1)、[图片提交守卫](../../crates/officecli/src/hdoc_server/image_workspace.rs:118)、[任务/锁现有限制](hcd-agent-team-rebuild.zh.md:53)。

**AI 与 MCP 的边界**

- 默认文本模型是 `gpt-6.1-sol`，默认图片模型是 `gpt-image-2`；右键、命令菜单、工具读写、生成图片、独立指针与操作过程已有实现。本次运行接口也返回这两个模型名，但 `available=true` 表示服务配置存在，本轮没有调用供应商来认证可用性、生成质量或失败率。
- 人数可设置 1–4，但服务端检查的是当前 API 进程所有运行任务的 Agent 总数，当前全局最多 4 个。它不是“每份文档都可以各开 4 个且互不影响”的资源配额系统。证据：[全局并发检查](../../crates/officecli/src/hdoc_server/agent_runs.rs:304)。
- 整稿重建只对 PPTX 开放，其他格式继续按各自工具做局部编辑。图片局部重绘有独立的规划、生成、核对流程，不能与通用文档 Agent 编排混为一个能力。
- Agent 运行记录、图片任务和 MCP 会话保存在进程内存。已提交修订会保留，但服务重启不能恢复完整任务现场并继续执行；任务记录还受保留时间/容量限制。PPT 整稿替换是多次修订提交，取消或中途失败会保留已提交部分，不是跨进程原子事务。
- 文档 HTTP MCP 使用 JSON-RPC 2.0，协商的是 `2025-11-25`、`2025-06-18`、`2025-03-26` 这些 MCP 日期版本。不能把 JSON-RPC 2.0 称为 MCP 全能力已完成。现有文档端点主要提供工具；GET SSE、sampling、elicitation、MCP tasks 和 SSE 重放尚未实现。这些有可选扩展，未提供不等于已实现工具传输不合规。
- 现有不少 Agent 浏览器用例使用确定性模型响应，主要验证实际服务、工具调用、冲突和 UI。已有真实模型样例能证明部分流程可用；不能据此承诺任意真实任务的规划、复杂排版和图文生成质量。

证据：[RunStore](../../crates/officecli/src/hdoc_server/agent_runs.rs:6)、[PPTX rebuild 限制](../../crates/officecli/src/hdoc_server/agent_runs.rs:247)、[MCP 版本](../../crates/officecli/src/hdoc_server/mcp_http.rs:15)、[GET SSE 未提供](../../crates/officecli/src/hdoc_server/mcp_http.rs:111)、[MCP 方法分发](../../crates/officecli/src/hdoc_server/mcp_http.rs:226)、[真实/脚本模型验收区别](hcd-openai-agent-harness.zh.md:66)。

**预览、导出与验证还需补齐的环节**

7 类公开样本的 `/export-capabilities` 均返回 DOCX/XLSX/PPTX/PDF/HTML/MD/TXT/HCD 可用输出项，默认格式能识别源格式；同时实际 manifest 明确包含 `PPTX_PARTIAL_VISUAL_LAYOUT`、`XLSX_ADVANCED_VISUALS_EXTERNAL`、`PDF_SOURCE_VISUAL_LAYER_READ_ONLY` 等警告。接口声明有导出路径，不能替代实际导出、重新打开及逐页视觉对照。本次探测记录：[runtime-summary.json](hcd-capability-audit-2026-11-15/runtime-summary.json)。

同格式源文件保留导出与跨格式语义重建需要分别验收。尤其表格结构编辑后的 DOCX、PDF 视觉导出、XLSX 转其他格式，不能因为成功产出文件就视为源格式全部对象和版式保真。字体替换、缺字、分页、表格跨页、图片锚点及复杂公式应有独立比对样例。现有“49 条转换通过”记录也明确只验证语义流程，不是 Office/WPS 逐页视觉认证。

前后端仍缺少完整的操作级能力和构建版本协商。之前 `table.edit` 的 422 就是新前端连接旧后端的实际案例；`/health` 只有 `ok`，单靠服务存活无法识别操作协议差异。能力应分别声明读取、可视编辑、Agent 写入、计算和各类导出，不应只有几个通用布尔项。证据：[健康接口](../../crates/officecli/src/hdoc_server.rs:198)、[当前能力字段](../../crates/hcd-core/src/types.rs:23)。

检查到的 GitHub 工作流只有 `build.yml`，目前仅 v* tag 触发；有 Rust lint/test 和跨平台二进制构建，没有将编辑器构建、浏览器回归和文档对照套件接入 PR 门禁。历史测试通过不能防止下一次修改回归。证据：[工作流](../../.github/workflows/build.yml:3)。

**建议建设顺序与验收标准**

| 优先级 | 工作 | 完成的判断标准 |
| --- | --- | --- |
| P0 | 先修已复现计算错误，整理浏览器/CLI/Agent 的公式支持集合 | 上述 5 例正确；Unicode、空白、负数等边界有回归；不支持的计算明确返回不可用，避免将缓存当成已重算结果 |
| P0 | 离线草稿、任务/事件与租约持久化及恢复协议 | 输入后断网/关闭窗口、API/sidecar 重启、锁过期与接管均有恢复验收；已提交与未提交状态可核对 |
| P0 | 操作级能力协商、构建版本检查、PR 自动回归 | 旧服务不能接收的操作在执行前明确识别；前端与 Agent 使用相同能力定义；相关 PR 自动跑 Rust、前端及关键浏览器检查 |
| P1 | 建立 Office/WPS 参考文件与逐页/对象差异基准 | DOCX/PPTX/PDF 页面、字体、表格和图片有可追溯参考；XLSX 对公式、样式和对象分别判定，不只看 validate 或截图 |
| P1 | 按对象补齐复杂编辑，先 Word 表格/排版，再演示稿复杂对象与 PDF OCR | 每类操作均覆盖人工 UI、Agent、同步、撤销、保存重开、原生导出和回读；避免只接通某一入口 |
| P1 | 跨文档 Agent 编排与可恢复的提交策略 | 一个任务可明确列出各文档目标、共享事实、依赖和权限；失败时能说明哪些已提交，并能安全继续或回滚 |
| 按需求 | MCP 可选扩展、更多图片/旧格式与高级审阅 | 单项声明支持范围，使用对应标准客户端和真实样本验证；不将可选扩展缺失误报为核心协议失败 |

本轮交付为支持范围核查与可复现问题记录；没有将未验证内容标记为完成，也未开始修复上述新发现。
