# 行内容器实际协作与保存（2026-10-27）

可编辑行内容器现已接入实际 `sidecar.ts`：独立正文、并发输入、个人撤销、签名保存、进程重启和规范导出共用现有结构保存协调器。仍按显式能力启用，主编辑页接入、已有草稿的审阅迁移和远端多实例验收继续推进。管理平台与提醒发送保持后置。

## 协议与初始化

- 原子节点、普通富文本块继续使用 wire 7；行内容器另外使用 `hcd-semantic-inline/1`，房间名为 `{documentId}:{epoch}:inlinecontainers1:save4`，不能作为普通 `structure3` 房间连接。
- sidecar 需要 `HCD_INLINE_ROOMS=1`。WebSocket URL 通过 `inlineCollaborationUrl` 显式带上 `hcdNodeEdits=7&hcdInlineContainers=1`。HTTP 协商带 `X-HCD-Inline-Containers-Version: 1`；完整规范读写同时确认 `X-HCD-Extension-Version: 3` 和 wire 7。
- 首次协商仅接受规范文档明确声明 `extensionNodes: 3`、没有区域布局、没有已有持久协作状态、没有仍在线的旧协议房间的情况。读取和转换真实 canonical projection；不推测、覆盖或隐式迁移已有离线草稿。
- 初始化复用原生 `/collaboration/migrate` 的服务身份、head/epoch/source CAS 和迁移回执。此目标必须声明空来源 `sourceHash: none`，新状态落盘后才发布新 epoch。迁移日志记录目标协议、精确字节和唯一请求 ID；响应丢失后按同一请求重试，未知结果继续冻结旧房间。
- 已运行的同协议房间允许第二位成员正常协商加入。普通旧客户端缺少模型确认时被拒绝；不能退回默认协议写入。原生 Inline1 metadata 必须同时保留 nodeEdits 7。
- 当前只启用本机原生协调器，远端初始化明确拒绝。全版本还原暂不标为支持：`coordinatedRestore` 对此协议返回 false，避免误用尚未适配的旧还原链路。

## 服务端保存与校验

接收房间在加载持久 Yjs 状态之前就设置 `gc: false`，保留已删除字符、正文身份和个人撤销所需的永久载体。逐包增量 shadow guard 在实际应用前校验：

- immutable 节点定义、现有正文 XmlText 的 Yjs 身份及来源属性不能被客户端替换；定义和正文表必须对应，数量有界。
- 已有 canonical ID 不能重写，新分配不能伪造规范来源。新增内容与隐藏正文也必须满足结构、嵌套和 schema 边界。
- `hcdSchema`、`hcdSave`、结构/文字流模型元数据及图片回执由服务端维护。客户端伪造保存回执、默认 fragment 或额外共享数据不会进入权威正文。
- 普通正文、行内正文、属性候选、材料化结果、删除和撤销可通过校验；保存回执产生的可信来源更新被镜像为下一次校验基线。
- 旧结构、默认和区域协议继续拒绝这些未来模型载体。缺少扩展时的只读保全仍由 SDK 的注册表与 preservation 插件负责，协议不能替代客户端扩展权限判断。

保存状态显式包含 `inlineContainers: 1`，递归来源、图片、业务资源与原作者账本沿用现有协调器。保存/重连不会将仍未确认的内容误报为规范版本。

## 实际验证

命令：

```sh
cargo test -p officecli --bin officecli inline_bootstrap
cargo test -p officecli --bin officecli hdoc_collaboration::tests
cargo build -p officecli
python3 scripts/hcd-inline-room-files.py
```

脚本从已有 r8 行内嵌套归档复制独立测试文档，启动实际原生服务与 `sidecar.ts`，通过真实 Hocuspocus 客户端和生产 PM binding 编辑。r9 保存双方输入；sidecar 进程退出再启动后从签名状态恢复并继续保存 r10。

已验证：缺少确认的客户端被拒绝、第二次在线协商成功、Bob 离线输入迟到后合并、Alice 撤销保留 Bob 输入、重做收敛、只读保存被拒绝、伪造定义的数据包断开且其他成员正文不变、保存回执 HMAC 与原生版本对应。正文重开后与规范 snapshot 摘要一致。

实际 DOCX/PDF/PPTX/Markdown 回读包含双方输入与重启后新增文字；HCDZ 离线 unpack 后规范内容一致并通过 validate；原始 r8 归档未改变。这是语义导出证据，业务数据、资源与动态关联完整保全仍使用 HCDZ，不代表 Office 原生业务控件或原稿精确排版。

文件、哈希和作用域记录位于 `docs/assets/hcd-inline-room-2026-10-27/`。单元测试还覆盖新增正文、属性材料化、删除/撤销、隐藏正文校验、无损拒绝和响应丢失后重试。

当前前端 1022 项测试、TypeScript 与独立/嵌入构建通过；原生 2 项初始化测试、5 项协作 metadata 测试、构建、officecli bin 的 Clippy `-D warnings` 和所改 Rust 模块的格式检查通过。验证记录另存于同目录 `validation.json`，不据此宣称真实浏览器输入法或生产部署已验收。

## 后续接入边界

主编辑页暂时对已协商的 Inline1 显示明确的升级提示，保留旧设备草稿的协议命名空间，避免旧宿主误写新模型。下一步需要把 SDK schema/注册表、HTTP 协商、本机恢复、来源回执、节点属性/资源面板与 UI 能力一起接入；不能只移除提示就宣称支持。

已有活跃或持久旧协议草稿仍需可审阅的迁移；原生整版本还原、跨文档附件字节转移、真实浏览器输入法与长期断网/多实例规模验收不在本轮完成范围。原有行内容器属性冲突和删除审阅在独立内核已有验证，主 UI 接入仍需真实交互与导出复验。
