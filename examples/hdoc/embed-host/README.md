# 在业务系统嵌入文档与白板

“折页 · 项目工作台”是一个独立的 React 应用。业务页面负责登录、选文件、开关聊天与连接 Agent。`EmbeddedHcdEditor` 根据短期会话中的文件类型挂载原生文档编辑器或 Excalidraw 白板，编辑保存在同一份 HCD 文件的修订中。

## 多标签工作台

登录业务工作空间即进入 `/workbench/`。首页可以新建 Word 文档、Excel 表格、演示和白板，或从同一文件库打开 PDF、图片等已有文件。标签可拖拽排序、分组和批量关闭。「管理标签」提供最近关闭的文件。传入 `?file=<业务文件 UUID>` 可直达文件，`?ai=1` 或 `?ai=0` 指定初始聊天栏状态。

1. 从首页打开一份文档、一份表格和一块白板。在文档中选一句话，在表格中选中目标范围；保持白板无选中对象，可以在空白处追加。
2. 在「全局 AI → 任务文件」勾选三份文件，输入「把文档选区同步到其他文件」。源文档会显示已读取，表格和白板各自返回保存修订。点击回执可定位对应的标签。页面支持同时提交目标互不重叠的任务。
3. 需要外部 Agent 时，点击「复制所选范围的 MCP 配置」。配置按文件提供短期 Streamable HTTP 连接。每份连接都绑定该文件、授权范围、访问者和修订。关闭聊天栏后，真实写入仍通过工作区事件流更新标签。含凭据的配置只在用户点击复制时进入剪贴板。
4. 无模型时可用「读取选区」「写入：内容」「追加：内容」「把文档选区同步到其他文件」等本地指令。启动演示时设置 `OFFICECLI_DEMO_OLLAMA_MODEL` 和可选的 `OFFICECLI_DEMO_OLLAMA_URL` 即可切换自然语言规划。单租户服务对应使用 `OFFICECLI_WORKBENCH_OLLAMA_MODEL` 和 `OFFICECLI_WORKBENCH_OLLAMA_URL`，并在初始化时启用 `--selection-mcp`。模型只能为明确选中的文件和范围返回工具调用。

`rN` 是 HCD 的持久编辑修订。业务文件需要新的发布版本时，仍可使用文件详情里的回写操作。运行 `npm run test:workbench --prefix apps/workspace` 可以用真实浏览器、引擎、MCP 和隔离的业务数据复验。

右侧的对话区与输入框各有 16px 圆角，两者相隔 10px。收起 AI 后，文件库会占用释放的宽度。Pen 稿的 00M 和 00N 对应首页与跨文件写入状态。[Pen 设计稿](../../../docs/design/officecli-canvas-journal-v1/officecli-figjam.pen) · [首页](../../../docs/acceptance/hcd-office-workbench-v1/home.png) · [收起 AI](../../../docs/acceptance/hcd-office-workbench-v1/home-closed.png) · [跨文件写入](../../../docs/acceptance/hcd-office-workbench-v1/multi-tab.png) · [手机端 AI](../../../docs/acceptance/hcd-office-workbench-v1/mobile-ai.png)


## 运行示例

在仓库根目录执行下列命令。需要 Node.js 24.13+ 与 Rust 工具链。

```bash
npm ci --prefix examples/hdoc/admin-app
npm ci --prefix examples/hdoc/editor
npm ci --prefix examples/hdoc/xlsx-univer-viewer
npm ci --prefix examples/hdoc/embed-host
cargo build -p officecli --bin officecli
OFFICECLI_BIN="$PWD/target/debug/officecli" npm run build --prefix apps/workspace
npm run demo --prefix examples/hdoc/embed-host
```

- [打开业务工作台](http://fold.localhost:4417/embed-example/) 可以在两种资源间切换。右上角可打开或收起宿主自己的聊天栏。
- [单独打开文档](http://fold.localhost:4417/embed-example/?view=document&standalone=1) 后，在正文中拖选“访谈”，点击「读取选区」，再输入“田野记录”并点击「替换选中文字」。刷新后可以看到新内容。
- [单独打开白板](http://fold.localhost:4417/embed-example/?view=board&standalone=1) 后，点击浅蓝卡片的空白处，再点击「向右移动 24」或「改为紫色」。要改卡片上的字，选中对应文字对象。

示例在 `fold.localhost` 提供业务前端和宿主服务，并在另一个回环地址启动真正的 Workspace。它在临时目录创建一个只有这两个文件编辑权限的成员，自动完成示例登录。重新启动会建立新的示例数据。可用 `OFFICECLI_EMBED_PORT` 指定业务端口。把同一组件接到自己的账号系统时，使用真实成员或已配置的身份接入。

## 宿主接入

业务页面使用 `POST /workspace/api/files/{fileId}/editor-session` 兑换会话。请求使用当前业务登录、`X-Workspace-CSRF` 和 JSON `{ "sessionId": "<UUID>" }`。在同一编辑器实例内保留 `sessionId`，按返回的 `expiresAt` 续期。传 `chatPanel={false}` 可只嵌入编辑器，传入 React 节点可提供自己的聊天栏，省略该 prop 则使用编辑器原有的界面。聊天开关独立于文件权限和 MCP。

```tsx
import { EmbeddedHcdEditor } from '@officecli/hcd-reference-editor/react'
import '@officecli/hcd-reference-editor/style.css'

<EmbeddedHcdEditor
  documentId={session.documentId}
  token={session.token}
  apiUrl="/v1/documents"
  collabUrl={collaborationWebSocketUrl}
  locale="zh-CN"
  chatPanel={showChat ? <BusinessChat /> : false}
  onSelectionChange={handleSelectionChange}
/>
```

在宿主域名下转发 `/workspace/api/`、`/workspace/mcp/selection`、`/v1/`、`/canvas-assets/` 和 `/collaboration`，协作路径需要 WebSocket 升级。固定上游租户并校验请求的 Host 和 Origin。示例的宿主代理在 `demo.mjs`，`src/main.tsx` 包含会话续期、选区生命周期和两种单文件入口。加 `file=<业务文件 UUID>` 可固定打开某一文件。

## 外部 Agent 的授权与实际调用

在 Workspace 初始化时加 `--selection-mcp`，或在既有工作区的 `config.json` 设置 `"selectionMcp": true` 后重启。成员应具备目标文件的 `document.view`、`document.edit`、`document.ai`。内置模型单独配置。文件列表的 `canDelegateSelection` 可用于展示授权入口。

1. 从 `onSelectionChange` 接收当前 `documentId`、`revision`、`collaborationEpoch` 和 `target`。文档使用正文段落 ID、Unicode 码点偏移和所选文字的 SHA-256。白板使用实际选中的原生对象 ID。
2. 用户要求读取或编辑时，宿主带登录与 CSRF 调用 `PUT /workspace/api/embed/selection`，提交 `{instanceId, generation, fileId, launchId, selection}`。`launchId` 就是上面兑换会话的 `sessionId`。每个挂载实例生成一个 UUID，`generation` 在选区生命周期内递增。
3. 将响应的 `endpoint` 和短期 `token` 交给外部 Agent。它以 `Authorization: Bearer <token>` 访问 Streamable HTTP MCP。Agent 无需浏览器 Cookie、编辑器令牌或管理密钥。[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
4. 选区变化、切换文件或卸载时，以更大的 `generation` 发送 `{instanceId, generation, selection: null}` 撤销旧授权。示例在 `pagehide` 也发起撤销。网络中断时凭据最长五分钟过期，并受原登录和编辑会话的有效期限制。每次调用会重新检查文件权限。旧修订或协作代次冲突时，重新选择并授权。

| 目标 | MCP 工具 | 写入范围 |
| --- | --- | --- |
| 文档正文 | `read_selection`、`replace_selected_text` | 至多 64 个已保存的正文段落，按读取顺序每段提供一个替换值。保留段落前后文及样式 |
| 白板 | `read_selection`、`edit_canvas_selection` | 至多 128 个已选原生对象。可移动、改边框或填充色、替换文字对象内容 |

一次授权可读取并提交一批修改。写入使用 `requestId`，成功回执含文件 ID、修订号和修改处数。`src/agent.ts` 示范了浏览器工具按钮，`agent.mjs` 是能在独立进程运行的客户端。在页面点击「连接当前选区 → 外部连接信息」取得地址和短期凭据，将凭据注入终端环境变量 `OFFICECLI_SELECTION_TOKEN` 后运行以下命令。`MCP_ENDPOINT` 取面板显示的地址。

```bash
node examples/hdoc/embed-host/agent.mjs "$MCP_ENDPOINT" '读取选区'
node examples/hdoc/embed-host/agent.mjs "$MCP_ENDPOINT" '替换为 田野记录'
unset OFFICECLI_SELECTION_TOKEN
```

示例默认以本地指令演示真实 MCP 调用。要让宿主聊天理解自由文本，可在启动 `demo` 前设置 `OFFICECLI_DEMO_OLLAMA_MODEL` 为已安装的 Ollama 模型，必要时设置 `OFFICECLI_DEMO_OLLAMA_URL`，默认使用 `http://127.0.0.1:11434`。宿主只将当前选区、文件标识与用户指令发送给指定模型，实际修改仍由 MCP 校验并写入。[Ollama 聊天接口](https://docs.ollama.com/api/chat)

## 验收与原令牌示例

`npm run test:embed --prefix apps/workspace` 启动独立临时工作区，用真实浏览器拖选文字、点选白板，再用第二个 Node MCP 客户端读写、验证越界拒绝和刷新持久化。可用 `HCD_BROWSER_PATH` 指定 Chromium 可执行文件，`OFFICECLI_EMBED_ARTIFACTS` 指定截图及结果目录。

设计稿中的 00K 和 00L 分别展示宿主聊天与无聊天的白板，下方预览可直接操作正在运行的本机示例。[Pen 设计稿](../../../docs/design/officecli-canvas-journal-v1/officecli-figjam.pen) · [文档实测截图](../../../docs/acceptance/hcd-saas-embed-v1/document-chat.png) · [白板实测截图](../../../docs/acceptance/hcd-saas-embed-v1/board-agent.png) · [验收结果](../../../docs/acceptance/hcd-saas-embed-v1/validation.json)

已运行独立 HCD 引擎及协作 sidecar 时，执行 `npm run dev --prefix examples/hdoc/embed-host`，打开 `http://127.0.0.1:8771/embed-example/?manual=1`，可继续使用已有文件 ID、短期令牌和语言选择器。
