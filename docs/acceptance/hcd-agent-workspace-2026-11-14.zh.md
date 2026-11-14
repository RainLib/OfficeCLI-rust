# HCD 多 Agent、多文档与预览一致性验收

日期：2026-11-14。分支：`feature/hcd-font-format-integration`；基础合并提交：`60207d8`。本报告对应其后的工作区改动。

已落地可供外部 AI Agent 使用的 HCD MCP 工具、多文档标签，以及预览中的 Agent 定位、移动、提交和冲突反馈。复杂 Word 块展示 canonical HTML；资源索引、HTML 导出与幻灯片 PDF 页尺寸的已知一致性问题已修复。当前仍不能宣称任意 Office/WPS 文件都能逐像素预览、任意对象编辑或无损跨格式转换。

## 已实现行为

| 能力 | 行为与边界 |
|---|---|
| 多文档 | 多个 Workspace 同时保留，切换标签或返回文档库不卸载编辑器；各文档独立保留草稿、选区、Y.Doc/provider 和令牌。隐藏标签不处理应用的全文查找、撤销/重做快捷键。关闭标签有确认；刷新浏览器不恢复全部标签和未保存草稿 |
| MCP | 新增 `hcd_help`、`hcd_read`、`hcd_patch`、`hcd_activity`、`hcd_export`，与既有文件工具一起提供。修复 `inputSchema`、通知、ping、JSON-RPC 错误和 EOF stdout；标准 MCP SDK 实际连接并提交修改 |
| 多 Agent | 每个 Agent 使用独立签名身份；写入带 documentId、baseRevision、epoch 与内容 hash。两个 Agent 对相同修订提交时，一个成功，另一个收到 409；后者重读并重新规划后可继续提交 |
| 可视活动 | Agent 主动报告定位/阅读/编辑；预览显示名字、颜色、区域边框与移动过渡。服务端提交后显示 applied/conflict；成功修改优先定位首个带 nodeId/blockId 的操作。批次其他目标不逐一播放；新增/删除对象可能只显示活动卡片 |
| XLSX 定位 | 使用 Univer 原生 range highlight 与 popup，跟随单元格；不改变本地活动单元格。不在当前已加载工作表窗口内的目标保留动态卡片，不强制滚动用户视口 |
| 人工草稿保护 | sidecar 报告 semantic Yjs 尚未 checkpoint 的 dirty 状态；MCP 写入遇到 dirty 返回 409。序列号防止旧请求覆盖新状态；checkpoint 期间又发生输入时保留 dirty |
| 复杂 Word 内容 | 只读块以 canonical HTML 展示表格和图片，并加载所选修订样式、主题字体；iframe 禁脚本和网络访问。块仍然只读，不把复杂结构转成可编辑纯文本。单块高度上限 2400px |
| 资产与导出 | DOCX/PPTX/XLSX 资源按 hash 规范排序去重，保留源 part 别名；CLI 与 HTTP 共用有界 standalone HTML 导出并内嵌图片；有 HTML 原始 source 时保留原 source-backed 路径 |
| 幻灯片 PDF | 固定幻灯片使用 EMU 换算的物理页尺寸、零页边距和逐页分页。两张 16:9 幻灯片输出两页 960×540pt；不同尺寸的混合页面明确拒绝 |

Agent 活动通过鉴权 HTTP 轮询获取（750ms），15 秒不更新自动过期，`idle` 主动移除。建议 Agent 每 10 秒以内报告一次心跳。动态不构成文档锁，不模拟不存在的按键或鼠标轨迹。历史视图不叠加当前光标。PDF 使用同一固定页面光标实现，本次新增浏览器光标用例重点覆盖 PPTX、DOCX 和 XLSX。

## 接入和操作

先按 [reference editor README](../../examples/hdoc/editor/README.md#local-run) 启动 API、sidecar 和页面。API 与 sidecar 使用相同的私密 `HCD_TOKEN_SECRET`。在管理终端签发两个不同身份的短期令牌：

```bash
export HCD_AGENT_A_TOKEN="$(officecli hdoc issue-token --document-id demo-docx \
  --scope write --user-id agent-a --display-name 'Agent A' --json | jq -r '.data.token')"
export HCD_AGENT_B_TOKEN="$(officecli hdoc issue-token --document-id demo-docx \
  --scope write --user-id agent-b --display-name 'Agent B' --json | jq -r '.data.token')"
```

两个 MCP 宿主分别启动一个 stdio 子进程，向进程环境注入相应令牌；Agent 子进程只需要文档令牌：

```bash
# Agent A 的 MCP 进程
env -u HCD_TOKEN_SECRET HCD_API_URL=http://127.0.0.1:8766 \
  HCD_MCP_TOKEN="$HCD_AGENT_A_TOKEN" officecli mcp
# Agent B 的 MCP 进程使用 HCD_AGENT_B_TOKEN
```

一个进程处理多个文档时，可在环境中分别注入 `HCD_DOC_A_TOKEN`、`HCD_DOC_B_TOKEN`，每次调用使用 `token_env` 选择；令牌签名的 documentId 必须与参数匹配。工具参数中不传令牌原文。远程 `HCD_API_URL` 使用 HTTPS；HTTP 仅限 loopback，不跟随重定向。

推荐工具序列：

1. `hcd_help {}`；读取协议、偏移单位和结构示例。
2. `hcd_read {"document_id":"demo-docx","resource":"manifest"}` 和 `resource:"auth"`，获取当前 revision、epoch。
3. 语义文档读取 `resource:"editor"`，定位 `blockId`、`blockHash`、完整 `content`；固定页/表格读取 `index`、`chunk` 或 `node` 获取节点和 hash。`search` 支持全文查找。
4. `hcd_activity` 发送 `status:"locating"/"reading"/"editing"`、实际 `node_id` 或 `block_id`，以及刚读到的 `expected_revision`、`collaboration_epoch`。可附 160 字以内的 `message`。
5. `hcd_patch` 提交 `mode:"structure"` 或 `"node"`。`expected_revision` 与 patch 的 `baseRevision` 必须一致；patch 的 `documentId` 必须与显式参数一致。完整样例由 `hcd_help` 返回；`block.replace` 应复制原 block，仅修改用户要求的字段。
6. 409 时重读 revision、epoch、目标内容和 hash，保留其他协作者的修改后重新规划。dirty 提示应等待 checkpoint，不能通过猜测 revision 重试。语义结构提交会更新 epoch。
7. `hcd_export {"document_id":"demo-docx","format":"html","revision":2,"output":"/tmp/review-r2.html"}` 导出指定不可变修订；文件已存在时拒绝覆盖。
8. 完成后发送 `hcd_activity` 的 `status:"idle"`；先读取最新 revision/epoch。

`text.splice` 的 `start/deleteCount` 按 Unicode scalar value 计数，不按 UTF-8 字节或 JavaScript UTF-16 单元计数。

底层 API：`GET/POST /v1/documents/{id}/agents`；POST 使用 camelCase 的 `nodeId/blockId/chunkSequence/expectedRevision`，并带 `X-HCD-Collaboration-Epoch`。身份来自令牌 `sub/name`，请求体不能指定其他 Agent 身份。`GET /nodes/{nodeId}` 返回当前文本节点及 hash。MCP 写入另带 `X-HCD-Agent-Edit: true`，触发草稿检查。`/collaboration/pending` 仅供身份为 `hcd-collaboration` 的 sidecar 使用。

## 实际验证

| 检查 | 结果 |
|---|---|
| Rust workspace 测试 | 952 通过，0 失败 |
| 格式与 lint | `cargo +1.90.0 fmt -- --check`、严格 Clippy 通过 |
| Office 文件级套件 | DOCX 8/8、XLSX 20/20、PPTX 54/54，共 82/82；缺报告/缺文件不会算成功 |
| 7 输入 × 7 输出 | 49/49 导出、重导入、HCD validate 通过；另有 7 次同格式 source-backed 导出成功 |
| 前端 | editor `npm ci`、应用和嵌入包构建、themeCss/blockFont 检查通过；独立 xlsx-univer-viewer 构建通过 |
| 浏览器 | 6/6：多标签草稿/搜索隔离；两真实 MCP Agent 移动、竞争409、重读后提交及导出；非空复杂 Word 表格；XLSX 光标移动不抢选区/不创建修订；人工草稿拒绝覆盖；语义 MCP 连续提交跨 epoch 后浏览器刷新 |

机器结果：[DOCX](hcd-agent-workspace-2026-11-14/docx-summary.json)、[XLSX](hcd-agent-workspace-2026-11-14/xlsx-summary.json)、[PPTX](hcd-agent-workspace-2026-11-14/pptx-summary.json)、[转换矩阵](hcd-agent-workspace-2026-11-14/conversion-matrix.json)、[转换输入](hcd-agent-workspace-2026-11-14/conversion-sources.json)。日志：[Rust](hcd-agent-workspace-2026-11-14/rust-tests.txt)、[Clippy](hcd-agent-workspace-2026-11-14/clippy.txt)、[浏览器](hcd-agent-workspace-2026-11-14/browser-tests.txt)。文件套件中原始 XML 已有问题的样本仍明确记录 sourceValid=false；套件通过不代表已修好原文件。49 条转换是语义结构和流程检查，不是 WPS/Office 逐页视觉认证。

浏览器证据：[多标签](hcd-agent-workspace-2026-11-14/multiple-documents.png)、[Word 表格](hcd-agent-workspace-2026-11-14/complex-word-preview.png)、[移动前](hcd-agent-workspace-2026-11-14/agents-before-move.png)、[移动后](hcd-agent-workspace-2026-11-14/agents-after-move.png)、[提交效果](hcd-agent-workspace-2026-11-14/agents-committed.png)、[XLSX 定位](hcd-agent-workspace-2026-11-14/grid-agent-focus.png)、[语义修改](hcd-agent-workspace-2026-11-14/semantic-agent-committed.png)。

复现基础门禁（从仓库根执行）：

```bash
cargo +1.90.0 build -p officecli
cargo +1.90.0 test --workspace
cargo +1.90.0 clippy --all-targets -- -D warnings
cargo +1.90.0 fmt -- --check
DOCX_SUITE_SKIP_BUILD=1 DOCX_SUITE_BIN="$PWD/target/debug/officecli" \
  bash examples/hdoc/docx-suite/run.sh /tmp/hcd-docx-agent-check
XLSX_SUITE_SKIP_BUILD=1 XLSX_SUITE_BIN="$PWD/target/debug/officecli" \
  bash examples/hdoc/xlsx-suite/run.sh /tmp/hcd-xlsx-agent-check
PPTX_SUITE_SKIP_BUILD=1 PPTX_SUITE_BIN="$PWD/target/debug/officecli" \
  bash examples/hdoc/pptx-suite/run.sh /tmp/hcd-pptx-agent-check
cd examples/hdoc/editor
npm ci
npm run build
npx tsx src/themeCss.test.ts
npx tsx src/blockFont.test.ts
npx playwright install chromium
OFFICECLI_BIN="$PWD/../../../target/debug/officecli" npm run test:workspace
```

本次 macOS 使用 `HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'` 复用已安装 Chrome。测试自行创建临时文档、密钥和随机端口，启动/关闭测试服务；源码位于 [workspace.spec.ts](../../examples/hdoc/editor/e2e/workspace.spec.ts)。不保留含访问令牌的 Playwright trace 到报告目录。

HTML 回归可复现为：导入任一样本后执行 `officecli hdoc export <bundle> --to html --output /tmp/review.html --fidelity-report /tmp/review-fidelity.json`，再导入该 HTML 并 `hdoc validate`。重复媒体回归使用 [duplicate-media.docx](../reviews/hcd-runtime-audit-2026-11-14/duplicate-media.docx)，导入后校验应成功；Rust 另覆盖两个图片关系共享同一资产时两个图片节点都被保留。

## 剩余建设边界

- DOCX 仍为语义流，不是 Word 物理分页引擎；浮动对象碰撞、多栏、公式及复杂块编辑需继续逐类建设。只读预览保留表格不代表这些结构都可编辑。
- PPTX 的母版/布局继承、组合变换、SmartArt、动画及高级效果不完整。XLSX 的复杂公式、条件格式、图表、透视表不等于完整 Excel；PDF 扫描页无 OCR 闭环，视觉导出可能栅格化文字/矢量。
- HCD 通用链路本次验证 DOCX、XLSX、PPTX、PDF、HTML、MD、TXT。旧 DOC/XLS/PPT、宏格式、ODF、RTF、CSV 未被本报告认证为同等预览/编辑/协同能力。
- 活动存在单 API 进程内存，最多 1024 条；多实例不共享光标。pending marker 依赖单 sidecar 和服务根，不是跨 Yjs/HTTP 的严格事务：输入到 dirty 上报仍有竞态窗口；离线重连、进程崩溃恢复、PostgreSQL/S3 多实例和长期压力仍需专项验收。
- 多文档提交彼此独立，没有跨文档原子事务。AI 由外部 MCP Agent 执行，本次未增加模型聊天面板，也未连接真实模型供应商验证任务规划质量。

后续优先建立真实 Office/WPS 参考渲染与逐页差异基准，覆盖 Word 分页/浮动对象、PPTX 继承/组合、XLSX 公式/图表；再将人工草稿与 Agent 提交统一到可恢复的服务端写入协调协议，并补多实例和断线验收。
