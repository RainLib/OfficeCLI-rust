# 人员引用改绑、完整候选与保存边界

日期：2026-10-25。接续 [人员与引用](hcd-people-and-references.zh.md) 以及 [节点资源与富文本](hcd-node-resources-and-rich-content.zh.md)。本阶段补齐结构化正文中已有 `@人员` 的改绑与离线竞争；不新增管理平台，不发送提醒。

## 现在可以怎样操作

右侧“文档引用”中的“更换人员”打开人员搜索框，查询既有鉴权目录，支持分页、同名辅助信息、键盘选择、中文输入法期间抑制提交、Escape 取消和焦点恢复。搜索切换、关闭、卸载会取消过期请求，等待上限 15 秒；迟到结果不能提交到另一个搜索会话。实际改绑仍走统一命令，而非在弹窗内直接写编辑器。

一次改绑保留原 `mentionId`，把目标和显示快照作为一个值修改。只读、已失效的原文、正在冲突的 occurrence、未知业务容器、保留的 task/date/document 类型不能通过该人员入口改写。缺少容器 codec 时子树仍可读，直接调用候选选择命令也不能绕过保护。人员目录返回的候选不授予文档访问；正式 checkpoint 仍由原生服务按实际执行人重新检查当前授权。

冲突时，引用面板在已保存列表之前展示完整候选，包含保存的姓名以及当前可见的人员资料。用户明确选择“保留此目标”后才产生解决事务。候选集合已经改变则拒绝陈旧选择。自己的撤销重新打开冲突，重做恢复选择；两个人离线各自解决成不同目标，重连后继续保留两个候选。

## 协同模型

`referenceEdits.ts` 将 `hcd-reference-edits/1/intents` 纳入同一 Y.Doc 和自己的 undo scope。记录有固定版本、随机 ID、共同 root、before/after 完整引用以及已观察的 parents；每次 retarget 和 resolution 都是普通鉴权连接上的事务。

- 原始正文载体中的提及 atom 保持 root，投影读取因果末端的完整值。因此两端改绑不会变成两个提及，也不会把 Alice 的目标与 Bob 的显示姓名拼成一个值。
- 不同末端具有相同完整值时可收敛；不同值则标为 conflict，正文暂时展示共同 root，候选不丢失。**这个 root 只是冲突占位，不承诺等于最新已保存版本。**
- 插入、删除仍用正文 CRDT 的出现/可见性；历史记录不会使已删除的 atom 自动复活。自己的删除与对方改绑并发时，当前删除后不显示；撤销自己的删除会恢复同一出现并投影对方保留的值，已有结构副本测试。
- 每个出现最多 128 条、全局最多 2048 条/8 MB JSON；单记录 16 KB，候选/父引用和 DAG 均校验。载荷和读回值脱离对象别名，调用方不能原地修改已发布记录。超限拒绝新操作，不能静默截断历史。

完整删除竞争审阅、长期历史压缩/GC、任意 mark 和行内可编辑业务容器仍未因此完成。本批最初没有“一键保留规范值”的冲突选项；随后已补 [已保存值恢复](hcd-reference-saved-recovery.zh.md)，由服务端读取用户看到的版本并核对前后head。候选在目录变更后不可授权时，仍由原生拒绝提交并保留草稿；不能把陈旧root当成当前规范值绕过授权。

## 保存、作者与旧客户端

协调器把完整引用意图纳入观察指纹，签名作者台账绑定精确草稿。未解决的**活跃出现**返回 `reference-drafts-conflict`，先持久化草稿，不创建规范版本。最终候选由哪个已鉴权连接选择，就由哪个执行人承担改绑授权；浏览器中的姓名和 raw actor 字段不能代替身份。

`businessDraftProblem` 同时用于协调器和客户端。冲突占位可能与过去的正文逐字相同，因此正文摘要、图片摘要和编辑器 generation 都匹配仍不充分。客户端在异步保存回执、只读当前内容导出、显式保存和本机 flush 后再次检查最新元数据；活跃引用冲突、业务字段冲突及尚未 materialize 的节点均不能被旧回执标成“已保存”。已删除出现留下的历史不会阻止保存删除。

当前协同声明升级为 **4**，各版本并不混为一谈：

| 声明 | 当前值 |
|---|---|
| WebSocket 参数 | `hcdNodeEdits=4` |
| 协商及保存状态 | `nodeEditVersion: 4` |
| native 共享状态 HTTP | `X-HCD-Node-Edits-Version: 4` |
| 结构协议 | `hcd-semantic-blocks/3` |
| 协调服务版本 | `4` |
| 规范引用模型 | `hcd.mention/1`，`inlineReferences=1` |

前端、sidecar、原生服务应一起升级，并刷新旧可写窗口。native 的 durable model 要求跨 epoch/reset 保持单调；文档要求 4 后，缺声明、1/2/3 和未知版本的共享读写及 checkpoint 返回 426，不覆盖共享字节。旧节点意图仍能被新客户端理解，不代表旧客户端可以写回新版房间。带引用意图的旧正文迁移不擅自压平记录，而是保留恢复数据。规范历史读取/导出与共享草稿协议分开，不需要在离线 Office 文件中执行 Yjs 或宿主 JS。

PostgreSQL 适配代码接受到 4 并通过编译检查，**没有真实数据库/多实例验收**。本阶段也没有旧 epoch 离线恢复、热更新客户端迁移或崩溃恢复验收。

## 实际验证

本机隔离 native + sidecar + Vite、两个真实鉴权 WebSocket 和 IAB 页面，使用合成人员及 DOCX：

| 阶段 | 已观察结果 |
|---|---|
| r2 离线竞争 | Alice/Bob 分别改绑同一出现，Bob 另加正文；重连后出现仍唯一、两个完整候选保留，保存拒绝且 head 不变 |
| 页面选择 r3 | 选择 Alice 候选；自己的 undo 恢复冲突，redo 恢复 Alice，同伴正文保留 |
| 人员搜索 r4 | 同名张三区分产品/设计组；Escape 不写入；重新搜索 Bob，Enter 改绑并保存，同一出现 ID |
| 删除/恢复 r5/r6 | 定位选中提及、Backspace 删除并保存；自己的 undo 恢复原 occurrence 和 Bob 目标，保存 r6 |
| 只读与语言 | reader 正文不可编辑，更换人员禁用；英文界面仍可读姓名和资料，不授予新增权限 |
| 可信事件 | r3/r4 retargeted、r5 removed、r6 created 的执行人均是实际 resolver Alice；重复查询 eventId 不变 |
| 实际文件 | r2–r6 DOCX、r6 无源解包后的 DOCX/PPTX/PDF/MD 及浏览器实际下载 r6 DOCX 回读通过；原图字节 hash、双姓名和同伴正文保留 |

源文件和目录不是无源 HCD 解包后导出的前提。离线包中保留规范引用与历史，导出通用文件保留可读 `@姓名`；不宣称它变成 Office 的原生人员控件。PDF 整页渲染已人工检查，文字/图片没有裁切。浏览器从 source image 的既有占位展示与离线 PDF 的真实图片是不同路径，不借此声称浏览器图片渲染已完全对齐。

前端 **512 项测试**，TypeScript、standalone/embed 构建；CLI **157 项单元测试**、相关 all-targets Clippy、native 构建、fmt/diff 通过。新增回归覆盖双端结构副本、并发解决、相同值收敛、删除撤销、记录反别名、错误模型/循环、未知容器/保留 kind 及正文不变的元数据冲突保存门禁。单元模拟持久重启检查了草稿冲突仍在、选择后可信 resolver 可以 checkpoint；不称为进程崩溃验收。

native HTTP fence 使用不透明合成字节验证版本拒绝和字节/head 不变，不冒充真实 Yjs 路径；真实协同语义另由 socket/浏览器链路验证。一次只读文件复验因夹具的 1 小时凭证过期返回 401，刷新同权限、同时长的隔离 token 后通过，没有重启服务或重建文档。最后回读后 head 仍 r6。

- [两个真实 socket](../assets/hcd-reference-intents-2026-10-25/socket-evidence.json)
- [浏览器操作和限定范围](../assets/hcd-reference-intents-2026-10-25/browser-evidence.json)
- [版本、事件及实际导出文件](../assets/hcd-reference-intents-2026-10-25/file-evidence.json)
- [原生协议拒绝](../assets/hcd-reference-intents-2026-10-25/native-fence-evidence.json)
- [源码/检查摘要](../assets/hcd-reference-intents-2026-10-25/validation.json)
- [冲突候选画面](../assets/hcd-reference-intents-2026-10-25/reference-conflict-candidates.png)
- [实际浏览器 DOCX](../assets/hcd-reference-intents-2026-10-25/browser-r6.docx)
- [离线 PDF](../assets/hcd-reference-intents-2026-10-25/retarget-offline-r6.pdf)

## 复现

```sh
cargo test -p officecli --bin officecli
cargo clippy -p officecli --all-targets -- -D warnings
cargo build -p officecli
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-reference-model-fence.py
python3 scripts/hcd-mention-preview.py --short-references \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-reference-retarget
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-reference-retarget.mts /absolute/owned-root/private.json
```

脚本在 r2 留下未解决冲突，浏览器执行表中的 r3→r6 步骤。然后只读检查具体命名夹具：

```sh
python3 scripts/hcd-reference-retarget-files.py /absolute/owned-root/private.json
```

文件探针不适用于任意生产文档，不记录凭证，不改变文档 head；每次创建独立解包目录。提醒协议仍返回 `enabled=false, delivery=disabled`，管理平台仍不做。原完整目标中的其余自定义节点/格式/AI/设备/生产范围继续推进。
