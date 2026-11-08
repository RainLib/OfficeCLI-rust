# 节点属性并发、冲突与保存（2026-10-24）

原子节点的属性修改已从“替换整个共享载荷”改为“保留独立修改记录，再投影正文”。本轮覆盖 Word 的行内/块扩展；管理平台、提醒发送和 AI 不在此阶段实施。

## 行为

| 情况 | 当前处理 |
|---|---|
| 两端离线从同一旧值修改不同顶层字段 | 合并字段；嵌套对象作为一个字段，不逐层猜测合并 |
| 同一字段改成相同值 | 收敛为相同内容；保留操作记录 |
| 同一字段改成不同值 | 两份候选都保留，右侧节点冲突入口逐字段选择；选择作为可撤销操作 |
| 字段删除 | 记录字段缺失，区别于 null 和空字符串 |
| 独立字段合并后不通过业务校验 | 不强制转换；保留草稿，兼容扩展可选择一份有效候选 |
| 收到同伴修改时还有未提交的属性表单 | 保留表单，要求重新载入；不覆盖当前正文 |
| 有冲突或缺少有效可读替代内容 | 服务端拒绝规范保存和依赖保存的导出；不显示已保存 |
| 撤销自己的字段修改 | 移除自己的修改记录，同伴字段继续保留；重做恢复自己的记录 |
| 撤销冲突选择 | 恢复候选冲突，重新阻止保存；重做重新解决 |
| 接受选择并保存后继续正文编辑 | 节点数据、身份和合并结果继续进入同一保存路径 |

预览值仅用于定位和审阅，不能作为自动接受候选的依据。用户明确应用选择后才允许规范提交。只读用户可查看，不能修改候选或生成可读替代内容。

## 共同模型与宿主代码的边界

`hcd-node-edits/1/intents` 按独立 ID 保存原始节点载荷、修改前后载荷、父记录和触及字段；`materialized` 保存与精确记录集合绑定的可读载荷。根载荷保持不变，字段投影不会重新插入行内 atom，因此并发属性修改不会制造第二个出现身份。普通文字编辑写回时仍使用根载荷，保留共享文字载体的位置。

共同层负责身份、JSON、因果关系、字段合并和候选保留；业务 `validate/fallback` 只在受信宿主中执行。多个字段合并后，兼容宿主重新生成与当前记录集合匹配的可读内容。协同服务不执行任意业务代码，也不凭某个旧候选的显示文字冒充完整合并结果。模型不授予外部业务权限。

记录进入既有 Yjs 撤销范围。派生显示更新不单独占撤销步骤；撤销自己的修改不回滚同伴字段。记录在保存后继续保留，以支持跨保存的撤销、迟到分支和恢复；本轮没有自动压缩历史。

宿主可从冻结的 `context.selection.nodeEdits` 读取 ids/conflicts/ready，再执行 `node.resolve`，输入为 `{instanceId, ids, choices}`。choices 以字段名映射到候选 intentId；服务端共享记录变化后，旧 ids 不能继续解决新冲突。内置属性面板复用该命令。当前 `NodeExtensionService.capabilities()` 声明 `collaboration: fields-v2`。跨 schema 迁移使用完整 envelope 候选，不按字段拼接，详见 [显式迁移契约](hcd-node-migrations.zh.md)。

## 兼容检查与持久化

当前非固定布局协同连接声明 URL 参数 `hcdNodeEdits=2`；协商和保存状态同时声明 `nodeEditVersion: 2`。v2 可读取已有 v1 intent 记录，新写入为 v2；客户端在上传结构化缓存前拒绝缺声明、仅字段 v1 或未知服务，新协同服务也在接收正文前拒绝旧客户端。原有本机草稿下载与旧代恢复入口继续保留。

原生存储另有独立限制：当前协同服务以 `X-HCD-Node-Edits-Version: 2` 持久化共享状态，epoch 元数据的 `nodeEdits` 要求单调提升至 2。此要求跨 reset/restore/协议迁移保留。达到 v2 后，共享读取、写入、完整 checkpoint 缺少声明、仅声明 v1 或未知模型均返回 426；普通规范文档读取/文件导出不依赖共享草稿模型。归档恢复副本仍可作为不透明数据保留。需同时升级嵌入包、sidecar 与原生服务并刷新旧可写窗口，不能用清空草稿降级。

本机在发布新共享状态之前先持久化模型要求；中断会保守地要求兼容服务，不允许旧服务退回普通正文。旧版本机原生元数据解析器会拒绝未知字段。可选 PostgreSQL 适配器增加 node_edits 列，并在共享状态 CAS 的行锁事务中重新核对/设置要求，防止检查与写入之间发生降级。该适配器本轮只有代码/编译证据，没有真实数据库或旧 PostgreSQL 二进制降级验收。

## 真实验证

1. 两个真实 WebSocket 客户端先同步 r3，再等待两个连接实际断开；各自离线修改。任务名 Alice/Bob 形成冲突，提示块名称/确认状态分别修改后合并。
2. 重新连接后四个出现身份各一个；任务候选完整保留，提示块显示合并后的名称和确认状态；规范保存被拦截，head 仍 r3。未声明模型的有效写令牌客户端被拒绝加入。
3. 页面保存同样被拦截；在属性面板选择 Bob 并应用，保存 r4。撤销选择恢复冲突，保存仍拒绝且 head 不变；重做后正常，未重复增加版本。
4. 继续输入正文并保存 r5；重开后节点和正文保留。自有 native/sidecar/Vite 重启后，候选、选择、合并和匹配显示记录均可从持久共享状态读取。
5. 实际 DOCX/PDF/Markdown 各含最终候选、合并提示、继续输入及两处未知替代内容一次；未接受的 Alice 候选不导出，原图媒体字节不变。离线 HCD 保留已接受节点数据；另存的 HCD draft 保留未接受候选记录。
6. 原生 API 实测：旧共享读取、重发相同字节的旧写入、旧完整 checkpoint、未知模型均为 426；共享字节和规范 head 不变。单元测试另验证模型要求跨 reset 保留。

证据：

- [离线双 socket](../assets/hcd-extensions-2026-10-24/node-conflict-socket-evidence.json)
- [页面处理与撤销/重做](../assets/hcd-extensions-2026-10-24/node-conflict-browser-evidence.json)
- [重启恢复](../assets/hcd-extensions-2026-10-24/node-conflict-recovery-evidence.json)
- [实际文件与离线包](../assets/hcd-extensions-2026-10-24/node-conflict-file-evidence.json)
- [原生模型限制](../assets/hcd-extensions-2026-10-24/node-model-fence-evidence.json)
- [逐字段候选界面](../assets/hcd-extensions-2026-10-24/node-conflict-choices.png)
- [重启后 r5](../assets/hcd-extensions-2026-10-24/node-conflict-resolved-r5.png)

复验入口：`scripts/hcd-mention-preview.py --extension-nodes --node-sdk --node-conflicts --pages-prefix .hcd-node-conflicts`，再运行 `scripts/hcd-node-conflicts.mts <private.json>`；处理页面选择、撤销/重做、继续编辑到 r5 后，运行 `hcd-node-conflicts-readback.mts`、`hcd-node-conflicts-verify.py` 和 `hcd-node-model-fence.py`。私有配置不进入证据，不打印令牌。socket 脚本与文件脚本不冒充页面点击证据。

可直接执行的命令（仓库根目录）：

```bash
python3 scripts/hcd-mention-preview.py --extension-nodes --node-sdk --node-conflicts --pages-prefix .hcd-node-conflicts
```

保留上述服务运行，在另一终端把路径改为输出的私有测试目录；先跑 socket 用例，再按第 3/4 步完成页面操作。重启自有服务后执行恢复与文件检查：

```bash
conflict_config="/path/to/printed-fixture/private.json"
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-node-conflicts.mts "$conflict_config"
# 页面完成选择、撤销/重做、继续编辑到 r5；重启同一自有预览服务。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-node-conflicts-readback.mts "$conflict_config"
python3 scripts/hcd-node-conflicts-verify.py "$conflict_config"
python3 scripts/hcd-node-model-fence.py "$conflict_config"
npm --prefix examples/hdoc/editor test
cargo test -p hcd-core -p officecli
```

本轮 415 项前端、440 项原生测试，构建、clippy/fmt 与差异检查通过。实际文件回读不等于新增 PDF 视觉版面验收；没有生产、远端多实例、容量、完整设备输入法验收。

## 明确剩余

- 当前每节点保留最多 128 条记录、文档最多 2048 条，记录 JSON 总字符数最多 16000000；达到限制前拒绝新修改，不写入半条记录，普通正文与已有撤销继续可用。原生共享状态 8 MiB 和 WebSocket 单帧限制仍独立存在，尚未验证所有极限组合。历史压缩、长时间编辑和生产容量仍需完成。
- [显式业务版本迁移](hcd-node-migrations.zh.md)已增加预览、确认、完整 schema 候选及文件/离线验证；节点删除与同伴更新、富文本容器/custom marks、跨类型修改和资源引用仍需要分别验收，不能以字段合并代替。
- 人员 occurrence 改目标冲突、旧 epoch 离线语义恢复仍在原清单。
- 业务导入导出 adapters、PPT/PDF 完整编辑适配及生产规模仍需继续。通用导出预检、AI 建议/自动补全已有独立阶段证据，参见总清单，不以此页较早的字段实验代替全目标验收；管理平台和实际提醒发送后置。
