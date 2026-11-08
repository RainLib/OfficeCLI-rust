# 删除块后的离线修改审阅

后续：[撤销创建后的迟到输入恢复](hcd-history-late-input-recovery.zh.md)已扩展到guarded创建/复制逆操作及引用包装恢复；以下保留本阶段显式删除的原始证据边界。

2026-10-25，接续[来源身份修复](hcd-source-identity-repair.zh.md)及[业务子树撤销保护](hcd-structural-undo-review.zh.md)。本批处理显式块删除之后才到达的修改；完整七阶段目标继续，管理平台与实际提醒发送后置。

## 行为与数据

块删除仍只隐藏永久共享子树，不销毁载体或资源。过去，离线成员在这个子树内写入，重新连接后文字虽然还在Yjs中，页面与规范导出却没有专门审阅入口。

现在显式块删除在同一自己的事务中，记录删除时的完整公开子树快照。共享字段 `hcd-semantic-deletions/1` 按稳定结构key保存 `{version:1,id,snapshot}`。快照包括类型、可见格式、文字、业务载荷/资源/导出快照、子块，以及关联节点/人员意图集合；排除内部来源绑定和规范回执。不是只比较可见文字，也不以正文中的人名证明作者身份。

- 删除时已观察到的内容不额外打扰；之后到达的文字、删字、格式、属性或新子块导致快照不同，打开右侧“删除内容审阅”。
- 页面展示“删除时的内容”和“保留的最新内容”，节点资料与附件可展开。未处理时可继续编辑其他正文，但不能提交或导出当前修改；协调器持久保留草稿并返回 `deletion-drafts-conflict`，不发送规范checkpoint。
- “恢复最新内容”恢复同一永久子树的可见性，保留后来合并的内容、业务/提及身份及资源；不从旧快照覆盖当前子树。
- “继续删除…”再进入确认，确认只认可这一份精确内容。提交时重验当前receipt与快照；新内容到达会使旧确认失效。确认之后才到达的修改仍会重新打开审阅。
- 恢复与继续删除并发时，继续删除只更新认可快照，不再写入隐藏状态，因此不能把并发恢复重新藏掉。不同快照的并发认可仍要与合并后的完整内容比较。
- 缺失codec时只能恢复只读内容，不能确认删除。已知内层不能绕过未加载的祖先codec；宿主命令在提交时重新检查当前注册表和祖先。
- 只读/历史/未就绪状态不能运行处理命令。`deletion.review`、`deletion.restore`、`deletion.confirm` 使用同一命令注册表，不通过UI可见性授予权限。

记录纳入自己的历史；撤销认可恢复未解决状态。已有历史保护继续检查隐藏同伴内容的逆操作，不能用撤销恢复来静默移除已经收到的同伴修改。低层store/Yjs接口不是权限或业务codec沙箱，完整宿主命令与原生鉴权仍是必要边界。

旧房间中已经隐藏、没有receipt的有效子树不会被猜测为安全删除，而是要求一次显式审阅。空文档占位、已合并到其他载体的流段及被隐藏祖先覆盖的子项不重复显示；恢复祖先后，仍有争议的独立子项可继续审阅。

## 保存、协议和离线边界

公开快照按稳定JSON精确比较，不用存在碰撞风险的短哈希。单条receipt最多1MiB，最多2048条；删除批量预检总条数与每条大小，在共享修改之前拒绝超限。后来到达的内容超过这个大小仍能审阅并恢复，不会因无法建立新认可快照而锁死恢复入口。整个协同文件仍受原8MiB持久上限约束；长期压缩/回收及超长文容量验收继续保留，未声称总容量已经解决。

写入方升级为 **wire5**：WebSocket要求 `hcdNodeEdits=5`，协商/状态要求 `nodeEditVersion:5`，原生持久要求 `X-HCD-Node-Edits-Version:5`。已有属性/迁移/引用意图保持读取，版本门槛单调保留，旧1–4协调者不能把审阅记录当无关字段覆盖。原生本地与可选远端适配器均识别5；编辑器、sidecar、native需一起升级，旧可写窗口需刷新。

结构协议仍3、coordinator仍4、portable envelope仍2、mention仍1；这些声明没有被混成同一个版本。HCD规范文件/离线归档模型不变。当前草稿的删除审阅记录属于共享草稿，不被误称为规范历史；只导出明确已保存版本时，文件只代表该版本。恢复并保存后的最新内容才进入规范HCD及Office/PDF/Markdown导出。确认删除不销毁历史版本和已归档资源，不执行实际提醒发送。

## 本地验证

573项前端测试通过。10项删除模型回归覆盖离线迟到输入、删字/格式、二次迟到、过期确认、并发恢复、Yjs重载、旧删除、非法共享记录、业务属性/新子块/资源、容量和未知祖先；另有协调器用例验证已保存删除之后的新修改被持久保留，且在审阅前不提交规范请求。TypeScript及standalone/embed构建通过。原生 `cargo test -p officecli hdoc_` 通过71项crate内测试与3项匹配CLI测试，Clippy/fmt/原生构建通过；不是全workspace测试或生产验收。

真实鉴权WebSocket、原生HTTP、浏览器与不可变文件链路：

| 版本/阶段 | 实际结果 |
|---|---|
| r6 | 准备6个业务节点、嵌套富文本、原图/资源、提及、双端离线子段文字 |
| r7 | Alice删除整个团队记录并保存；Bob离线输入后连接，双方保留隐藏内容，显式保存被协调器拒绝，head不变 |
| r8 | 浏览器卸载codec，继续删除禁用；恢复最新内容为只读并保存，包含Bob第一次离线输入 |
| r9 | 再次删除并保存；第二次离线输入触发审阅；确认层打开时第三次输入到达，旧确认消失 |
| r9不增版本 | 浏览器重新审阅并确认继续删除，保存显示已保存，未创建多余规范版本 |
| r9再次审阅 | 第四次输入在认可后才到达，再次拒绝保存；只读成员能查看对照但处理按钮禁用 |
| r10 | 浏览器恢复并保存全部四次输入；撤销恢复触发同伴内容保护，取消后内容/head保持；实际下载DOCX及Bob新窗口重开一致 |

原生透明代理共8条checkpoint，r3–r10第一条均200；四次冲突保存停在协调器之前。当前native持久Yjs文件直接载入新Y.Doc，保留全部四次输入、认可receipt与恢复可见性；四份失败时的客户端二进制快照分别重载仍能审阅。**这不等于实际重启服务或生产断电恢复验收**。

本轮开发期间补充未知祖先检查引起Vite页面重载；同窗撤销保护是在重载前实际点击验证的，不把刷新后空历史误称为历史迁移成功。最后改动后再次下载实际r10文件并核验。热更新/跨设备持久历史仍未验收。

原生wire5门禁实际验证缺失/1/2/3/4的共享读取、相同字节写入及checkpoint均426，未知6亦拒绝，字节/head不变。旧wire4 WebSocket在同步前拒绝；可选PostgreSQL路径已编译，没有实际数据库/多实例部署证据。

逐份r6–r10规范与实际DOCX回读验证：可见业务envelope不变，删除/恢复保留同一mentionId；四次引用新增/删除事件actor均为实际恢复/删除者Alice，reminders仍disabled。无源HCD解包后每个历史投影与原规范精确相等，资源和原图字节保留。无源DOCX/PPTX/PDF/MD及最后浏览器DOCX都包含全部四次输入、提及和嵌套正文；PDF整页图已检查。回读/导出后head仍10。没有真实Office应用往返验收。

- [浏览器动作及证据边界](../assets/hcd-deletion-review-2026-10-25/browser-evidence.json)
- [未知codec的审阅页面](../assets/hcd-deletion-review-2026-10-25/unloaded-review-r7.png)
- [继续删除确认](../assets/hcd-deletion-review-2026-10-25/confirm-r9.png)
- [只读审阅](../assets/hcd-deletion-review-2026-10-25/readonly-review-r9.png)
- [原生checkpoint](../assets/hcd-deletion-review-2026-10-25/checkpoint-evidence.json)
- [原生门禁](../assets/hcd-deletion-review-2026-10-25/native-model-fence.json)与[WebSocket门禁](../assets/hcd-deletion-review-2026-10-25/socket-model-fence.json)
- [持久文件回读](../assets/hcd-deletion-review-2026-10-25/persistence-evidence.json)
- [实际文件与身份](../assets/hcd-deletion-review-2026-10-25/file-evidence.json)、[浏览器DOCX](../assets/hcd-deletion-review-2026-10-25/browser-r10.docx)、[离线HCD](../assets/hcd-deletion-review-2026-10-25/deletion-r10.hcdz)
- [验证、源码与日志摘要](../assets/hcd-deletion-review-2026-10-25/validation.json)

## 复现与继续范围

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
cargo test -p officecli hdoc_
cargo clippy -p officecli --all-targets -- -D warnings
cargo fmt -- --check
cargo build -p officecli
python3 scripts/hcd-mention-preview.py --extension-nodes --node-history --checkpoint-probe \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-deletion-review
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-business-blocks.mts /absolute/owned-root/private.json
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-deletion-review.mts /absolute/owned-root/private.json prepare
# 浏览器卸载codec并恢复/保存r8；再运行second，得到r9审阅。
# 打开继续删除确认后运行late；重新审阅、确认并保存，head仍r9。
# 运行late-again，浏览器/只读端审阅，恢复/保存r10，实际下载。
python3 scripts/hcd-deletion-review-files.py /absolute/owned-root/private.json \
  /absolute/actual-browser-download.docx
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-deletion-persistence.mts /absolute/owned-root/private.json
```

探针只适用于上述具名夹具和版本顺序，不写凭证到公开证据目录。不自动重启服务来掩盖观察超时。

此批覆盖**显式永久块/容器删除的隐藏子树**，不是完整任意删除竞争：同段行内atom/提及删除、撤销创建后才到达的离线输入、复杂转换/跨树移动与删除组合、旧epoch恢复、压缩/GC及生产容量仍需继续。任意custom mark/可编辑行内容器、其余统一命令/国际化/AI/Office往返/设备验收仍按完整计划推进，不能用本批替代全目标完成审计。
