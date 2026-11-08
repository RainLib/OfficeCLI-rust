# HCD 正文协议与迁移提交

状态：原生提交层已实现，118 项 officecli 单元测试、构建、Clippy 拒绝 warnings 和格式检查通过；真实 HTTP 迁移与 18 个实际文件回读通过。sidecar 已接入显式协商、消息排空和持久重试，333 项前端/服务测试及两种构建通过；默认 App 尚未调用新协商入口，浏览器未验收；本文件不是整个结构协同已完成的声明。文字模型见 [结构协同设计](hcd-semantic-structure.zh.md)。

## 协议与持久状态

| 协议 | 正文 | 客户端要求 |
|---|---|---|
| `hcd-default/1` | 现有 `default` XmlFragment | 兼容现有未传协议头的客户端，仍受 epoch 和保存协调器约束 |
| `hcd-semantic-blocks/3` | 永久块图与 `hcd-text-flow/1` | 必须显式传入匹配协议；不能交给旧 Tiptap default 绑定 |

`GET /v1/documents/{id}/auth` 返回 `collaborationEpoch` 与 `collaborationProtocol`。现行 epoch 数字文件按旧协议读取；结构协议使用包含 epoch、protocol、迁移回执的 JSON 描述符。未知协议和不合法回执拒绝读取，不默认为旧格式。正文重置保留协议、增加 epoch，清除前一迁移回执，避免旧请求重新激活旧代正文。

结构协议下读取/持久化协同正文、规范 checkpoint 均要求 `X-HCD-Collaboration-Epoch` 和 `X-HCD-Collaboration-Protocol` 匹配当前状态。旧 epoch 返回 409；当前 epoch 缺少或传错结构协议返回 426。服务身份的 `/project` 写入也受迁移后的 epoch/协议限制。旧连接仍可按既有授权归档恢复副本，不能据此写入当前正文。

## 迁移提交接口

`POST /v1/documents/{id}/collaboration/migrate` 仅接受受信任的 `hcd-collaboration` 保存服务；普通读/写用户和管理身份不能代替该服务调用。请求体是已完成转换的 Yjs 更新，长度为 1 至 8 MiB。Rust 层不解析 Yjs schema，转换、内容检查和旧房间排空由 sidecar 驱动负责。

| 请求头 | 含义 |
|---|---|
| `X-HCD-Coordinator-Version: 4` | 使用现行规范保存协议 |
| `X-HCD-Collaboration-Epoch` | 捕获旧状态时的 epoch |
| `X-HCD-Collaboration-Protocol` | 可省略旧协议；传入时须为 `hcd-default/1` |
| `X-HCD-State-Hash` | 捕获旧持久状态的哈希；不存在时为 `none` |
| `X-HCD-Base-Revision` | 转换依据的规范版本 |
| `X-HCD-Target-Protocol` | 当前仅支持 `hcd-semantic-blocks/3` |
| `X-HCD-Migration-Id` | 每次迁移的随机 32 位小写十六进制 ID；重试必须复用 |

接口比较旧 epoch、状态哈希和规范 head。文档版本或会话变化返回 409，源状态变化返回 412。只有匹配者能发布新代状态；竞争提交不会分别生成两个有效 epoch。提交不改规范文档版本，只切换其协同表示。

成功返回新的 epoch、protocol、migration 回执与 `idempotentReplay`。回执绑定迁移 ID、原 epoch、原状态哈希、规范版本及新状态哈希。同 ID 同内容的迟到重试返回原回执，即使新代正文后来已有输入，也不重新写入旧迁移正文。同 ID 不同内容拒绝。不能只在超时后重新生成迁移 ID并盲目重试。

## 文件存储的发布顺序

1. 在文档权限写锁与协同提交锁内检查授权、旧状态和规范版本。
2. 保存旧状态的恢复副本并同步到磁盘。
3. 将转换后的正文写入带迁移 ID 的独立文件，完成文件及父目录同步。
4. 原子替换 epoch/protocol 描述符，再同步父目录。

描述符是激活入口，发布前不会对外宣称新协议可用。迁移正文文件名带独立迁移 ID，尚未激活的文件不能被下一次普通 reset 的 epoch 文件名误中。原数字 epoch 文件仍保持旧协议兼容编码。

权限锁负责当前原生 API 实例内排斥其他文档请求，状态哈希和版本比较负责捕获已持久变化；这不是运行中 Hocuspocus 房间的迁移租约。当前 sidecar 驱动已经覆盖已接纳消息的异步鉴权与实际应用，在转换前排空、暂停自动保存并持久化；只在同一已配置的 sidecar 进程内提供这项排空保证，不是分布式房间租约。

## PostgreSQL 路径

`hcd_collaboration_meta` 增加 `protocol` 与 `migration_receipt` 列，现有行默认旧协议。迁移事务锁定协同元数据及规范文档 head，比较状态、保存旧恢复副本、替换正文和 epoch/协议/回执后一起提交。重置保留 protocol 并清除迁移回执。

这条路径已编译检查，尚未进行本轮真实 PostgreSQL/对象存储验收；现有 RemoteStore 本身仍声明为单实例存储路径。旧客户端的协议限制由新版核心 API 执行；本轮未验证混跑更早原生服务版本。不能以文件模式测试宣称远端部署或多实例上线完成。

## 已有证据与剩余工作

原生测试覆盖：旧数字描述符兼容、未知协议拒绝、普通用户不能迁移、空请求拒绝、规范版本和状态变化拒绝、并发迁移只有一方成功、旧 epoch 与缺失/错误协议不能写入、精确恢复副本、丢响应重试保留更新后的正文、同 ID 不同内容拒绝、reset 保留协议并使旧回执失效、未激活文件不被后续 reset 采用。

复验命令：

```bash
cargo test -p officecli --bin officecli
cargo build -p officecli
cargo clippy -p officecli --all-targets -- -D warnings
python3 scripts/hcd-structural-save.py
```

HTTP 探针从隔离、与规范投影一致的旧 Yjs 状态开始，提交转换后的结构状态，再执行规范保存、编辑、撤销重做和导出。本轮实际验证旧恢复副本字节一致、旧 epoch 被拒绝、新 epoch 下缺少协议的 state/checkpoint/project 写入被拒绝、迟到重试不覆盖后续正文；再执行持久状态重启与 18 个实际导出文件回读。它不替代带脏草稿、图片冲突或未知保存回执的自动迁移，不包含浏览器或 Hocuspocus 房间排空。最新实际范围见 [API/文件证据](../assets/hcd-workbench-2026-10-23/structural-save-api-evidence.json)。

## Sidecar 显式协商与恢复

`POST http://<sidecar>/v1/documents/{id}/collaboration/negotiate` 使用普通文档 Bearer token，不接受客户端提交正文、迁移 ID 或目标快照。sidecar 重新检查调用者读/写权限，以自己的受信任服务身份转换和提交，返回 `collaborationEpoch/collaborationProtocol`。当前对流式文档格式开放；PPT/PDF 固定画布继续走其原有适配。

| 阶段 | 行为 |
|---|---|
| 暂停 | 同一文档只运行一个协商任务；同步拒绝新消息/房间加载，暂停自动保存，给旧客户端发送过渡状态 |
| 排空 | 每条已接纳消息从异步鉴权开始到应用/处理完成都计入在途计数，等全部退出后再转换 |
| 冻结 | 等待已有规范保存和二进制持久化；未知规范保存结果复用原 checkpoint ID 确认，不新建一次保存 |
| 转换 | 从当前冻结的协同正文读取，保留未保存正文、图片意图/冲突候选和来源；不拿当前规范正文替换草稿 |
| 准备 | 服务端重新签发新 epoch 的基线和作者账本；持久化迁移 ID、旧/新二进制、哈希与规范版本后才能发请求 |
| 发布 | 提交原生 CAS；完整回执核验并记为 committed 后，归档旧房间、关闭旧连接，才允许新协议房间加入 |
| 结果未知 | 请求超时、5xx、回执不完整或提交后日志写入失败时保持暂停；之后从原 journal 复用 ID 和字节确认，不能因一次 `/auth` 失败就恢复旧写入 |
| 明确失败 | 确认未发布后保留失败任务的源/目标副本，再恢复旧房间；未知扩展、来源/基线冲突等不会自动清空正文 |

房间名区分 `id:epoch:typography2:save4` 与 `id:epoch:structure3:save4`，epoch 只接受一种数字写法，避免同一代重复开多个逻辑房间。新协议 onLoad 读取结构投影与保存适配，旧协议仍兼容既有客户端。`beforeSync` 的增量影子校验会拒绝把 default 正文送入结构房间，也拒绝把结构协议送入旧房间；拒绝发生在实际正文应用前。影子副本增量更新，不逐键复制完整文档；它不代替未来节点 codec 的 schema/导出能力协商。

`HCD_SIDECAR_STATE_DIR` 指定 journal 根目录，默认用户目录下 `.officecli/hcd-sidecar`。按核心 API 地址哈希与文档 ID 分开存储，目录权限 0700、任务文件 0600；原子替换并同步磁盘。日志包含源/目标正文和资源引用，不写入服务配置的 token 或 secret。同一 sidecar 进程使用消息屏障，原生 CAS 仍是发布权威；多实例共享 journal/跨机器房间租约尚未验收。

未保存内容新增签名作者账本，绑定文档、epoch、谱系、规范基线和正文/图片摘要。重启只接纳签名及摘要一致的作者信息，迁移时重新绑定新 epoch。复制来的、被改过的或与正文不一致的作者字段不能作为来源证明。旧存量草稿缺少可靠作者证明时仍保留原文和恢复副本，当前驱动拒绝自动发布，需要后续恢复界面明确处理。

本轮实际 socket 证据覆盖：两位旧房间用户、延迟的消息鉴权、并发协商只提交一次、迁移成功后丢回执、sidecar 重启复用原 ID、未保存正文与换图/冲突候选保留、错误 default payload 不进入结构房间、离线输入与段落拆分收敛、显式保存和发布后重启。另一个真实案例在规范保存已提交但回执丢失后发起迁移，确认复用原 checkpoint ID，规范版本没有多增一次。四份实际导出通过独立回读，作者仍为 alice/bob。见 [sidecar 迁移证据](../assets/hcd-workbench-2026-10-23/sidecar-migration-api-evidence.json)。

```bash
python3 scripts/hcd-sidecar-migration.py
python3 scripts/hcd-semantic-history.py
```

后一个用例另回读九份真实 DOCX，复验旧模式自己的文字/图片撤销重做、重连和同伴修改，见 [旧模式回归证据](../assets/hcd-workbench-2026-10-23/legacy-history-regression-evidence.json)。原 18 文件结构保存探针本轮也通过。以上 PM 视图为 headless，包含真实 Hocuspocus socket，但不是浏览器/输入法、真实 PostgreSQL 或部署验收。

默认页面接入状态：

1. App 已在同代设备草稿核对后进入无编辑/上传交接页，同步完成、落盘并确认 readiness 后协商；未交接的旧可写连接拒绝升级。并发打开遇到切代会重新核对权威协议。已是结构协议且没有不确定任务时无需冻结活跃房间。
2. 新旧协议设备副本隔离、同代合并以服务端基线/规范身份为准，错误协议不当作空文档继续；旧代离线草稿保留下载，语义恢复尚未完成。
3. 默认结构绑定、Awareness 和文字/图片共同历史已接通。344 项测试与两种构建通过，真实页面及两份下载文件已有证据；设备 IME、复杂混合结构、多实例、旧代恢复和完整跨格式仍需验收。最新 sidecar 探针回读 7 份文件，包含提交后撤销/重做。
4. 新增视口 Awareness 不进入正文。活动姓名/段落和视口跟随已在 60 段页面验证；历史版本与确认还原还需要独立的消息排空和未知结果协议，见 [历史与还原设计](hcd-revision-review-and-restore.zh.md)。

服务端 @人员、节点 SDK、AI、跨格式与长文目标保持原范围。管理平台、字体后台及实际提醒发送继续后置。


### 在线协作入口与多窗口跟随（2026-10-24）

在线成员入口打开右侧“在线协作”，在成员行显示姓名、窗口数、浏览位置和本地解析的操作段落摘要，提供“定位”“跟随/停止跟随”。正文边缘保留位置标记；滚动位置与选区均是临时 Awareness，不作为正文保存或导出。

语义编辑器现在按成员合并多个窗口时优先保留正在跟随的连接。新窗口上线不能替换当前目标；目标连接离开后停止跟随，用户可再次选择。可能形成直接或间接循环的跟随入口禁用，并给出说明；点击时再次核对最新状态。本机滚动或输入退出跟随，一次性定位与持续跟随分别处理。

本轮真实 CUA 页面在 80 段文档中验证：右侧入口、操作摘要、多窗口固定目标、互相跟随保护、手动退出后不被对方继续滚动拉走。原窗口 scrollTop=1464，跟随者=1463，新窗口=0；手动退出前后跟随者均=1146。导航前后规范 r2 和 manifest 字节不变。新增连接选择回归测试，前端合计 454 项通过，独立页与嵌入构建通过。见 [浏览器证据](../assets/hcd-workbench-2026-10-24/online-collaboration-follow-evidence.json) 与 [右侧面板截图](../assets/hcd-workbench-2026-10-24/online-collaboration-follow.png)。本轮未重新进行 PPT/PDF 浏览器验收，也不代表多实例或生产验收。
