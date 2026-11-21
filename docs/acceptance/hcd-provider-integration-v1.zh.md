# 宿主接入阶段 A · 运行时验收

日期：2026-11-15。状态：**宿主会话、权限、精确版本导入、手动回写与提交事件已实现并实测。本文记录阶段 A 范围；默认业务 Provider 后续已完成，见[阶段 B 验收](hcd-default-workspace-v1.zh.md)，完整断网发行包仍未完成。**

这一阶段复用现有 Rust 引擎、HCD、V2 编辑器、图片工作台与协作 sidecar。接入测试中的宿主服务是故障注入 fixture，不能作为正式默认应用交付。

## 数据职责

使用方保存用户、权限、源文档和最终业务版本；OfficeCLI 保存 HCD、协作状态、导入基线、宿主映射、会话记录、发布产物、提交回执和事件 outbox。`root/integration` 是持久业务状态，不能作为缓存清理。

HCD 原始 `source.sha256/importBaseVersion` 始终指向首次导入的精确源版本。回写仅推进 `externalVersion/lastPublishedRevision`，不会用新业务文件替换 HCD 原始基线。使用方需要保留可供校验/恢复的原始版本。

## 已实现入口

| 方法与路径 | 使用方及作用 |
| --- | --- |
| `POST /integration/v1/sessions` | 宿主后端兑换一次性凭证，精确导入文档并获取短期编辑 token |
| `POST /integration/v1/sessions/{sessionId}/refresh` | 宿主后端凭新 launchCode/exchangeId 续期，同一用户/文档绑定 |
| `DELETE /integration/v1/sessions/{sessionId}` | 宿主后端关闭会话，旧 JWT 和后续下载立即失效 |
| `GET /v1/documents/{id}/integration` | 编辑会话查看源基线、业务版本、HCD 修订、有效权限和本用户待恢复发布 |
| `POST /v1/documents/{id}/publications` | 固定 HCD 修订回写；不确定时复用原 publicationId 重试 |
| `GET /v1/documents/{id}/publications/{publicationId}` | 同一用户查看原发布状态、回执、保真说明和事件投递状态 |

宿主后端入口要求独立 service secret，拒绝带 Origin 的浏览器兑换请求。编辑 token 最长 5 分钟，宿主应在到期前续期并更新嵌入组件 token。关闭会话不可重新打开，应创建新会话。Provider 的用户资料目前来自 session resolve；独立 users/resolve 接口保留在草案中，本阶段不调用。

统一鉴权覆盖现有文档路由及下载票据。宿主 token 不能访问其他文档、全局管理 API，旧 read/write token 不能绕过宿主管理文档的鉴权。支持 `document.view/edit/publish/download/export/print/copy`、`history.view/restore`、`theme.assign`；未知托管操作拒绝。下载原格式和跨格式导出分别授权，导出 HCD 全历史另需 history.view。复制与打印还会在编辑器中限制对应操作；查看权限不代表浏览器内容防截取。

协作 sidecar 在认证、收消息及每 30 秒复验权限；界面每 15 秒刷新业务状态。Provider 故障时暂停提交，保留已挂载草稿。宿主模式尚未开放 AI/MCP 委托和新文件副本，入口隐藏且服务端拒绝；图片元数据不会加载个人 AI 配置。

## 启动与接入

配置模板：[integration.example.json](../contracts/examples/integration.example.json)。模板域名应替换为实际内网 HTTPS 地址；开发可使用 loopback HTTP。Provider base URL、传输 origin 和事件目的地址都由服务端配置，禁止重定向和隐式代理。

分别注入四个**不同**的至少 32 字节密钥，配置文件只保存环境变量名。Provider 签名密钥、会话服务密钥、事件签名密钥不得复用。JWT 密钥也应独立保存，重启时保持一致。

```bash
cargo build -p officecli --bin officecli --offline
# HCD_TOKEN_SECRET、HCD_PROVIDER_SECRET、HCD_INTEGRATION_SERVICE_SECRET、
# HCD_EVENT_SECRET 由部署环境注入，不要放到前端或提交到仓库。
target/debug/officecli hdoc serve \
  --root /srv/officecli/engine \
  --bind 127.0.0.1:7400 \
  --integration-config /etc/officecli/integration.json
```

宿主后端用 service secret 调用 sessions，正文如下。UUID 每个逻辑动作生成一次；网络重试保留同一 exchangeId/launchCode。

```json
{
  "sessionId": "4e00c73c-4827-4c09-96bc-bcb1d30c16ab",
  "exchangeId": "78e24374-472e-40cc-82c5-01d1c0454e1b",
  "externalFileId": "business-file-42",
  "launchCode": "由宿主签发的一次性凭证"
}
```

响应中的 documentId/token 传给现有 `EmbeddedHcdEditor`；apiUrl/collabUrl 指向部署内网或同源反代。Provider 实现见 [OpenAPI 草案](../contracts/officecli-provider-v1.openapi.yaml)，请求签名包含原始 path/query、时间戳、nonce 和原始 body hash。宿主应校验签名、时间偏差和 nonce 去重，并在最终 commit 再验权限、输出 hash 与 expectedVersion CAS。

回写正文：

```json
{
  "publicationId": "8c4fc852-e0b0-4ed0-8b97-2ebfed177b0d",
  "expectedRevision": 3,
  "exportMode": "source-backed"
}
```

POST 还需要编辑 token 和当前 `X-HCD-Collaboration-Epoch`。`semantic` 明确重建内容；`visual` 仅 PDF。禁止在源格式无法导出时偷偷改用其他格式。V2 保存面板区分 HCD 修订、最近回写修订和业务版本，并展示本次导出说明。

## 验收与证据

```bash
cargo test -p officecli --bin officecli hdoc_server:: --offline
cd examples/hdoc/editor
npm run build
# 使用已安装的兼容 Chromium；也可使用 Playwright 自带浏览器。
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:provider
```

Rust 服务端相关测试 **81 项通过**，其中新增宿主接入测试 6 项。编辑器 standalone 与 embed 生产构建通过。构建保留依赖的 use-client/chunk size 提示和本机既有 linker unwind 提示。`cargo clippy -p officecli --bin officecli --offline -- -D warnings` 未通过：当前工作区的 oxml 排序、pdf-handler chunks_exact 和 hcd-core collapsible_match 既有告警被视为错误，本轮未改动这些无关实现。`--no-deps` 检查另受到既有 commands/query.rs unnecessary_unwrap 与 watch.rs result_large_err 阻挡；本次 integration 模块告警已修正。

真实联调结果：[validation.json](hcd-provider-integration-v1/validation.json)，构建/测试汇总：[checks.json](hcd-provider-integration-v1/checks.json)。脚本使用隔离临时 root、随机端口和随机密钥，启动真实 API、sidecar、V2 页面、Chrome 和可注入故障的宿主服务，并清理自有进程。覆盖：

- S2S 身份兑换、重试幂等、文档隔离、旧 token 绕过拒绝、全局 API 隔离及会话关闭。
- view/edit/download/export/AI/MCP 分离，旧下载 URL 在撤权后不可继续使用，协作连接停止接收撤权后的编辑。
- 源版本 hash 校验、传输 origin 校验、真实节点编辑、业务版本 CAS 冲突保留两边数据。
- 宿主已提交但响应丢失，API 被 SIGKILL 后用同一发布 ID 查询恢复，未产生重复业务版本。
- 返回 HTTP 202 即使带 receipt 也不显示保存成功，须再次查询确认。
- 签名事件失败重试与 API 重启恢复；所有请求使用新 nonce。
- 浏览器正文编辑、保存与业务回写；图片调整、保存与回写；AI/下载/历史按授权隐藏。
- 托管 root 未带 integration config 重启时拒绝运行。

页面证据：[桌面保存](hcd-provider-integration-v1/host-publication-desktop.png)、[移动端保存](hcd-provider-integration-v1/host-publication-mobile.png)、[深色主题](hcd-provider-integration-v1/host-publication-dark.png)、[图片回写](hcd-provider-integration-v1/host-image-publication.png)。浏览器仅允许 loopback 请求，TXT/PNG 验收未请求公网资源；这不等于全格式断网发行验收完成。

## 当前范围与后续建设

- 每个 root 只绑定一个 Provider、tenant、app；单实例由现有进程锁保护。HCD 可继续使用既有存储后端，但 integration 状态必须随 root 一并备份；没有多实例共享发布状态或租户管理能力。
- 发布意图持久化，浏览器断开后已启动动作继续执行。进程重启或不确定结果需要用户/宿主**重试同一发布 ID**，尚无自动发布恢复 worker。会话失效后须取得同主体的新会话再恢复。外部业务版本变更目前拒绝覆盖，尚无可视化合并/重建基线流程。
- 本阶段仅发 `publication.committed` 事件，回执与 outbox 同记录持久化，至少一次投递。当前每 5 秒扫描、指数退避、24 小时/不可重试 4xx 死信；Retry-After、抖动、目的端暂停及人工重放界面尚未实现。
- 当前用户/权限/文件由外部 Provider 提供。正式默认 Provider、账号/角色/业务文件后台、免手填 token 入口及已收事件页面后续已在阶段 B 实现，见[默认 Workspace](../../apps/workspace/README.zh.md)；本测试 fixture 仍仅用于外部接入故障注入。
- 阶段 B 已加入同源静态/API/WebSocket 入口、sidecar 打包、显式初始化与关闭 AI 的策略；运行时分发、字体资源清单、内网模型委托、升级/备份恢复工具及全格式断网发行验收仍属阶段 C。当前宿主模式关闭 AI；尚未实现内网模型的完整宿主委托能力。
