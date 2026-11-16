# OpenAI Agent、MCP 与多格式协同验收

本次交付为已有 HCD 工作区增加服务端 OpenAI Agent 执行器和文档级 MCP Streamable HTTP。人与 Agent、多个独立 Agent 使用同一版本、hash 和协同 epoch 检查；Agent 的定位与实际提交会出现在预览中。

## 使用与配置

```bash
cargo +1.90.0 build -p officecli
cd examples/hdoc/editor
npm ci
OFFICECLI_BIN="$PWD/../../../target/debug/officecli" npm run dev:agent
```

脚本仅导入仓库公开样例，使用临时目录、随机端口和临时签名密钥，并打印访问地址。关闭该脚本只停止它启动的服务。API 进程读取 `OPENAI_API_KEY` 或 `RAINY_OPENAI_API_KEY`；未提供时读取 `HCD_OPENAI_ENV_FILE` 指定的文件，默认 `~/.config/codex-api/api.env`。默认使用 `gpt-6.1-sol`，可通过 `HCD_OPENAI_MODEL` 修改。GPT-5 系列默认 `reasoning.effort=low`，可通过 `HCD_OPENAI_REASONING_EFFORT` 覆盖；其他模型默认不发送该字段。`HCD_OPENAI_BASE_URL` 支持 HTTPS 或 loopback HTTP。模型 Key 不进入浏览器、文档、模型提示或工具结果。

右侧协作抽屉可输入任务，并选择 1–4 位 Agent；同一 API 进程同时运行的任务共用最多 4 位成员的额度。每位成员使用独立身份、共享计划和受限的工作租约。PPTX 另有“整份 PPT 重做”，经过并行制作、整稿审核及原生导出验证后替换全部旧页。详见 [团队与整稿重建验收](hcd-agent-team-rebuild.zh.md)。右键可向任务传递当前段落、工作表选区或映射文字节点；语义编辑器在空白段落输入 `/` 可搜索插入和 Agent 命令。TXT 不提供无法保存的富文本命令。

任务接口：

| 请求 | 用途 |
|---|---|
| `GET /v1/documents/{id}/agent-runs` | 当前用户的任务及模型可用状态 |
| `POST /v1/documents/{id}/agent-runs` | 以 `{task, target?, name?, agentCount?, mode?}` 启动任务；人数 1–4，方式 auto/edit/rebuild |
| `GET /v1/documents/{id}/agent-runs/{run_id}` | 工具步骤、状态、结果、实际提交修订 |
| `DELETE /v1/documents/{id}/agent-runs/{run_id}` | 停止后续操作；保留已提交修订 |

任务只对发起者可见。每个任务限同一文档；单成员工具循环限 32 轮，任务总计最多 1200 秒。委托凭证不会超出发起者到期时间，且最多 30 分钟。取消由 4 秒心跳检查并停止执行，不回滚已提交内容。进程重启后不恢复任务。

## MCP 协议与协同方式

这里的 “2.0” 指 **JSON-RPC 2.0**。MCP 本身使用日期版本，本次 HTTP 端点协商 `2025-11-25`、`2025-06-18`、`2025-03-26`；stdio 同时保留旧版兼容。没有将其标记为官方名为 “MCP 2.0” 的规范。

连接 `/v1/documents/{id}/mcp` 时，官方 MCP SDK 的 `StreamableHTTPClientTransport` 在 `requestInit.headers.Authorization` 中提供文档短期 Bearer Token。初始化后按 SDK 发送会话和协议版本头。每个请求重新鉴权；会话绑定文档及身份，无用户 ID 的旧令牌使用令牌指纹隔离。同主机 Origin 检查、会话过期和容量限制均已启用；DELETE 可结束会话。POST 返回 JSON，未提供可选 GET SSE（返回 405）。

共用工具包括 `hcd_help`、`hcd_read`、`hcd_project`、`hcd_patch`、`hcd_activity`。HTTP 工具不暴露 stdio 本地文件操作或 `token_env`。新导入的语义文档可由 Agent 自行初始化编辑投影；无需先打开浏览器。源格式导出通过已鉴权的 HCD 导出 API 与页面完成。

| 类型 | 已验证的协同路径 |
|---|---|
| DOCX / HTML / MD / TXT | 人工通过 Yjs 同步语义内容并生成 checkpoint；Agent 以 block/hash 或映射节点提交修订 |
| XLSX | 原生表格预览、单元格文字节点修改、两 Agent 冲突与接续修改、预览和导出同步 |
| PPTX / PDF | 固定版式映射文字修改、两 Agent 冲突与接续修改、预览和导出同步 |

固定版式节点编辑采用乐观并发控制；同一旧 revision 的第二次写入会被拒绝，必须重新读取并规划。没有将任意 Office 对象的并发操作描述为字符级 CRDT 合并。

人工存在 pending 草稿时，Agent 写入会被拒绝。语义编辑器初次协同同步前不可编辑；启动内置 Agent 前先等待已确认的 checkpoint。离线草稿遇到 Agent 新 epoch 时保留在原编辑器中，提供本地/最新文本对照、无凭证 JSON 草稿下载，用户确认后再切换最新版本。

本次回归还修复了三个实际问题：旧 epoch 的 pending 上报不再以未处理 Promise rejection 终止整个 sidecar；PPTX/PDF 编辑器移入 iframe 后重新绑定选区根，并稳定 Tiptap 配置，避免全选替换期间被异步视图更新重置选区；斜杠菜单执行后同步返回编辑器焦点，避免立即输入的字符落在已关闭菜单中。

## 验证方法

```bash
cargo +1.90.0 test -p officecli --bin officecli
cargo +1.90.0 test -p hcd-core html::tests
cargo +1.90.0 clippy -p officecli --all-targets -- -D warnings
cargo +1.90.0 fmt --all -- --check
cd examples/hdoc/editor
export OFFICECLI_BIN="$PWD/../../../target/debug/officecli"
# 如需复用本机 Chrome：export HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
npm run test:workspace
HCD_TEST_REAL_OPENAI=1 npm run test:workspace -- agent-harness.spec.ts --grep 'OpenAI harness edits|two model agents|right-click'
npm run build
```

本次 CLI/服务端 132 项、CSS 5 项、完整浏览器/差异 51 项均通过；随后修改默认推理配置又通过 16 项 Agent 专项回归。最后的菜单焦点修复另通过 4 次重复浏览器用例和 1 次真实模型 UI 用例。Clippy、格式检查、TypeScript、应用和嵌入构建通过。

默认模型响应由测试脚本生成，实际 API、授权、工具、patch、协同网络和浏览器均使用真实服务。双 Agent 用例故意提前结束模型响应，以验证服务端会要求冲突后重新规划及写入后回读。`HCD_TEST_REAL_OPENAI=1` 才调用真实 OpenAI；两种结果分别记录在 [summary.json](hcd-openai-agent-harness/summary.json)。

真实模型验收仅使用仓库公开样例：7 种格式分别写入唯一标记、回读验证、检查修订作者并导出；两个真实 Agent 修改同一文档不同段落；浏览器通过右键和斜杠菜单启动任务并显示完成后的实际内容。最终 9 个场景分两次验证：7 格式与双 Agent 共 8 项通过后，菜单用例在调用模型前暴露焦点问题；修复后单独复验通过。未发送用户合同给模型。

调试期间实际遇到过模型在版本冲突后提前结束，以及一次推理输出耗尽 6000 token 预算。前者通过有限次数的强制重新读取/规划和回读检查修复；后者调整 GPT-5 默认推理强度。输出截断仍会明确标记为未完成，并保留实际提交修订；服务不会据此猜测或补造成功结果。

截图：[右键菜单](hcd-openai-agent-harness/context-menu.png)、[真实模型任务](hcd-openai-agent-harness/live-agent-completed.png)、[离线草稿对照](hcd-openai-agent-harness/human-agent-draft-conflict.png)、[XLSX 协同](hcd-openai-agent-harness/xlsx-multi-agent-preview.png)、[PPTX 协同](hcd-openai-agent-harness/pptx-multi-agent-preview.png)、[PDF 协同](hcd-openai-agent-harness/pdf-multi-agent-preview.png)。未将含临时访问令牌的 Playwright traces 放入仓库。

pen.dev 的 [原生设计稿](../design/officecli-workspace-v2.pen) 增加右键、斜杠、Agent 抽屉、XLSX/PPTX/PDF 菜单及断线草稿对照。画板和图片见 [设计清单](../design/officecli-agent-workspace/manifest.json)；另有桌面、手机实际 browser nodes。

## 支持边界

已验证的是 7 种格式的基础语义或映射文字编辑、协同守卫和导出链路。复杂 Word 浮动排版、空白表格单元格创建、行列/合并结构、Excel 图表/透视表、PPTX 母版/动画、PDF OCR 与任意复杂对象，仍需分别建设和原应用对照。旧 DOC/XLS/PPT、宏和 ODF 没有因此获得同等级支持。

尚未提供 IndexedDB 离线草稿恢复、跨实例持久协调、任务重启恢复、通用跨文档模型任务编排；多标签可同时保留各文档状态，每个任务仍绑定一个文档。MCP 可选 sampling、elicitation、tasks、SSE 重放也未实现。完整缺口继续记录在 [主要缺口进度](hcd-major-gaps-progress.zh.md)。
