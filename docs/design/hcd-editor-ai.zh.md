# HCD 通用 AI 首版：私有建议与显式接受

日期：2026-10-24。当前能力为 `private-text-v1`。已实现共享核心、宿主 Provider/HTTP 流适配、统一命令、Word 选区改写/光标续写、私有预览与取消，以及接受后的原有撤销/协同/保存链路。停顿灰字补全已接入，列表/浮层更新循环已修复，设备及剩余交互仍待验收，详见 [E05 首版与缺口](hcd-ai-autocomplete.zh.md)。原生 AI 来源台账、结构化工具、PPT/PDF 编辑适配和真实模型服务尚未交付；管理平台和提醒发送不做。

## 宿主接入

```tsx
import {EmbeddedHcdEditor} from '@officecli/hcd-reference-editor/react'
import {createHttpAiProvider} from '@officecli/hcd-reference-editor/ai'

const aiExtensions = {
  provider: createHttpAiProvider({url: '/api/editor-ai'}),
  onAccepted: event => {
    // Optional host audit callback. This is not a native durable AI provenance receipt.
  },
}
<EmbeddedHcdEditor {...sessionProps} aiExtensions={aiExtensions}/>
```

`/api/editor-ai` 是宿主需实现的服务，不是新增的 OfficeCLI Rust 路由。宿主服务负责可信身份、文档访问、数据范围、模型凭证、配额和实际模型任务取消。默认请求使用同源 Cookie；Bearer 场景通过 `headers: () => ({Authorization: ...})` 注入宿主鉴权。HCD 文档令牌不会由编辑器自动转交给模型。没有 Provider 时显示未接入状态，手工编辑与本机备份继续可用。

也可直接实现 `AiProvider.generate(request, {signal})`，返回 `AsyncIterable<AiEvent>` 或其 Promise；可以连接自建服务或离线模型，不依赖 React、Tiptap、Yjs 或指定厂商 SDK。独立 `/ai` 构建入口仅导出 `AiSuggestionController`、`AiError`、`createHttpAiProvider` 和相应类型。PPT/PDF 后续实现各自 `AiAdapter<Target>`，无需重写流式任务核心。

`aiExtensions.actions` 可提供完整动作目录，最多 32 项；省略时内置 `rewrite`/`continue`。动作声明 id、国际化 label、`replace|insert`、默认 instruction 和 aliases。目录复制/冻结后自动生成 `ai.action.<id>`，复用工具栏、右键、选区浮层和命令面板。默认指令留在 Provider 请求内，用户输入框显示额外要求。尚未将异步 AI 生成放入 `/` 的原子插入阶段；不能在只产生预览时删除 `/` 触发串。

显式改写/续写不默认占用 Tab/空格。可选自动补全默认关闭；开启后的 Tab 仲裁、策略和未通过验收见 [E05](hcd-ai-autocomplete.zh.md)。宿主可通过统一 keymap 绑定动作。`commands.capabilities().ai` 在实际语义适配器和 Provider 可用时为 `private-text-v1`，其他情况下为 reserved。

## 流式协议与限制

请求为 `hcd-ai/1`，含 requestId、action、mode、instruction、documentId、format、revision、locale、source `{text,digest}` 和有界 before/after 文本。CRDT 位置、人员 id、权限对象、DOM、Y.Doc 和文档访问令牌不进入请求；权限通过服务端可信会话检查，不能相信请求中的文档 id 自行授权。

响应为 `application/x-ndjson`，每行一条：

```json
{"version":"hcd-ai/1","requestId":"request-uuid","seq":0,"type":"delta","text":"建议文字"}
{"version":"hcd-ai/1","requestId":"request-uuid","seq":1,"type":"done"}
```

错误事件采用相同 envelope，`type:error` 与安全 code：unavailable / invalid-target / stale / denied / network / rate-limited / protocol / limit / timeout / cancelled。requestId 必须匹配，seq 从 0 连续增长。只有收到 done、有非空且有效的完整 Unicode/XML 文字才可接受；缺 done、错序、不同请求、超限和未知事件均拒绝。网络/厂商原始诊断不显示，以免带出凭证。分片拆开的代理对在结束时统一验证。

当前选中正文上限 8,000 UTF-16 单位；同一段落前后各读取最多 1,200 单位，atom 只发送占位字符，避免携带其业务身份/载荷。默认输出上限 16,000 单位、20,000 事件、120 秒，宿主可在公共约束内调小或调大。HTTP 传输另限总响应 2 MB、每行 65,536 字符，严格 UTF-8 解码，拒绝重定向；默认拒绝跨源，仅宿主显式 allowCrossOrigin 才放行，跨源请求不携带 Cookie。Idempotency-Key 使用 requestId；客户端不自动重试模型生成，宿主需实现服务端去重与计费策略。

取消、关闭/切换面板、卸载、换 Provider、只读/代次变化及任务替换中止当前任务。即使 Provider 忽略 AbortSignal 或 iterator.return 永不结束，UI 也会及时结束等待并忽略迟到结果。HTTP abort 不等于真实模型已经停止计费，宿主需将断连/取消继续传递给模型后端。

## 选区、权限与事务

首版适用于同一 paragraph/heading 内的纯文本选区或空光标，支持普通文字格式及软换行。受保护 atom、code/link、跨段落范围明确拒绝；不让模型创建任意节点、人员身份、HTML 或脚本。模型输出当纯文本处理，换行编码为 hardBreak，继承当前位置可支持的文字样式。

适配器先捕获已有结构载体的 CRDT 相对位置，保存原始片段/格式指纹及父块身份，再即时读取原生 `/auth` 核对 scope、userId、collaborationEpoch 和协议。发送前重验目标；接受时再次鉴权、定位、核对指纹与当前可写状态，最后同步提交。其他位置的同伴输入会映射并保留；目标文字/格式变化、删除或拆段失效。空光标另核对前后各 32 个字符，避免在同伴正在输入的位置插入旧续写。相对位置只负责定位，不能替代内容前置条件。

空段落接受以 Tiptap 的实际 root transaction 回执判断，允许来源身份/字体默认值的附加修复，不以 tr.doc 的逐字相等误报失败。空的来源段落已实际验证接受和独立撤销。

预览仅在当前控制器内存中，不写入 Yjs、IndexedDB、checkpoint 或导出。接受成为一次自己的事务，前后隔离历史捕获，走普通结构绑定、联合保存、重开和格式导出。重复接受同一 requestId 复用同一 Promise/结果；旧请求 id 不能接受。校验结束与实际提交之间不再 await；接受回调失败不会把已经应用的内容伪装成失败并重复插入。

实际贡献人继续使用现有用户历史。`onAccepted` 给宿主 requestId/action/mode/sourceDigest/output，供宿主审计接入；它不是原生已持久化、可跨保存者转交的 AI 来源回执。原生 AI 来源和共享审阅对象仍需实现，不能宣称已完成完整 AI 审计。

## 验证与兼容边界

本机样例使用 `scripts/hcd-ai-fixture-server.py` 的确定性模拟流，通过真实 HTTP、原生 API、WebSocket 和 CUA 页面。没有调用真实模型、发送生产内容或部署外部服务。

- 接受前 r1，另一成员正文及实际 DOCX/PDF/MD 均无建议文字。
- Bob 在另一段落输入后仍可接受；r4 的改写、r5 的单次撤销和 r6 的重做保留 Bob 输入。
- r7 接受续写；正文、双端、重开和三种实际文件内容一致，AI 输出各一次。
- 流式取消后正文不变；同伴修改选区后立即失效并禁用接受；只读会话拒绝写动作；重开不恢复未接受私有状态。
- 12 份实际文件没有运行时光标姓名；DOCX 原媒体字节保留。原生离线目录副本回读固定版本一致，这不等于完整自包含打包验收。
- r7 PDF 已渲染核对新增中文正文。该最小源样例的 drawing 在语义模型中是 opaque 占位，语义 PDF 未重现该图片；不能将正文视觉检查称为原稿图像/版式保真。源格式 DOCX 的媒体保留独立验证，opaque 的静态表达和导出提示继续列入 F 阶段。

证据：[浏览器](../assets/hcd-ai-2026-10-24/ai-browser-evidence.json)、[请求字段](../assets/hcd-ai-2026-10-24/request-privacy-evidence.json)、[接受前](../assets/hcd-ai-2026-10-24/before-file-evidence.json)、[改写](../assets/hcd-ai-2026-10-24/accepted-file-evidence.json)、[撤销](../assets/hcd-ai-2026-10-24/undone-file-evidence.json)、[续写](../assets/hcd-ai-2026-10-24/continued-file-evidence.json)、[PDF 文字视觉](../assets/hcd-ai-2026-10-24/continued-r7-pdf-text-preview.png)。432 项前端测试、TypeScript、standalone/embed 构建与独立 AI 构建入口导入通过；本轮无 Rust 修改，没有重跑全量原生测试。

复现入口：`python3 scripts/hcd-mention-preview.py --ai --pages-prefix .hcd-ai-docx` 创建新隔离根，打印 writer/peer/reader URL。补充要求含“慢速”时模拟逐字流，便于检查取消。`python3 scripts/hcd-ai-verify.py <private.json> --phase before|accepted|undone|continued` 在对应 UI 步骤保存后核对当前固定版本实际文件；它不伪造浏览器步骤。凭据仅留在本机权限 0600 的临时文件。

尚待：灰字补全未覆盖交互与长文/设备复查、真实 IME/设备/RTL、原生 AI 来源、结构化白名单工具、真实服务配额/取消/幂等、PPT/PDF 选区与容纳适配、生产权限/网络与规模。自定义 marks/容器、资源/迁移/各格式 adapters、引用并发/旧代恢复等原清单继续有效。
