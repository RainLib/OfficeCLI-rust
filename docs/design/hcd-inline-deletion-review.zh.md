# 行内删除后的迟到属性、人员改目标与恢复

2026-10-26。继续[并发转换与规范身份](hcd-concurrent-canonical-owners.zh.md)。本批补齐人员提及和自定义行内 atom 的删除审阅；完整七阶段目标继续，管理平台与提醒发送后置。

后续[结构来源保留](hcd-structural-source-retention.zh.md)已修复下文记录的 Replace 来源再分配缺口，并在新独立夹具证明 r4.blocks == r6.blocks、段落拆合／迟到文字及来源身份保留。本文621项测试和旧夹具结果保留原状，未重写成后续版本的验收。

## 已复现与修复

删除整个块已有永久子树和删除回执，但删除段落内部的一个 atom 会删除其 XmlText embed。业务字段／人员改目标的并发 intent 虽然保留，投影只检查仍然可见的节点，因此迟到修改不会进入审阅。四个初始反例修改前均失败。撤销刚插入的 atom 也有相同问题，另两个反例失败。见 [初始 RED](../assets/hcd-inline-deletion-2026-10-26/red-before-fix.log)、[历史 RED](../assets/hcd-inline-deletion-2026-10-26/history-red-before-fix.log)。

现在 `hcd-semantic-inline-deletions/1` 为被删除的 occurrence 保留原始存储载荷、永久文字相对位置、相邻 atom 身份和精确审阅快照。人员使用 mentionId，业务节点使用 instanceId；移动不算删除，删除整块仍只使用块子树回执。保留当前可见内容时继续确认不会把节点重新隐藏。

| 行为 | 结果 |
|---|---|
| 已知行内节点属性修改，或人员提及改目标迟到 | 对保留 root 应用当前 intent，和删除基线比较；重新进入右侧审阅 |
| 删除已知 atom，之后没有新修改 | 不额外打扰，不阻止正常保存 |
| 继续删除 | 二次确认；只更新这一份精确基线；旧确认拒绝，之后的新 intent 再次提示 |
| 恢复 | 保留 occurrence、当前属性／目标和资源身份；根据永久位置插入，不靠当前字符串搜索 |
| 相邻多个 atom 分批恢复 | 用保留的邻居链保持原顺序，不因点击顺序颠倒 |
| 原文字块已移除／位置不可用 | 明确显示“恢复到文档末尾”，新建段落；不静默移动到不相关内容中 |
| 缺少匹配 codec | 可恢复为只读替代内容；节点或祖先未知时禁止确认删除 |
| 原位置关系已经冲突 | 不猜测不一致的邻居边界；使用明确的末尾恢复方式 |

回执限 2048 项、单份快照 1 MiB、行内记录合计 16 MB；达到限制时在内容事务前拒绝本次删除。RoomProtocolGuard 在影子文档验证新字段和位置／身份数据，不先污染共享正文。恢复大内容沿用原有安全边界，不把这些限制当作长文容量验收。

## 恢复由协调器处理

普通段落输入仍是 Yjs 本地协同事务。行内删除的“恢复”使用侧车接口 `POST /v1/documents/{id}/collaboration/inline-restore`，输入 epoch 和精确审阅 key／receipt／snapshot。侧车重新检查鉴权写权限、wire、epoch 和当前房间；进入迁移门禁，由该房间协调器与保存共用串行队列。

协调器先校验 head 和持久状态 CAS，再用系统 origin 插入一次，随后将这次恢复以**实际请求用户**记入贡献／引用作者账本并持久化。另一请求发现相同删除代已恢复时为幂等成功，不重复插入、不借用第二个请求者作为关联作者。过期删除代或已变化内容继续拒绝。请求超时后可重试同一审阅，不能新造 occurrence 来掩盖未知结果。

这是当前房间所有者的串行恢复，不是 PostgreSQL 多实例验收。恢复需要在线协调器；本批没有把该系统事务加入浏览器个人撤销栈。普通插入／删除的自己的 undo／redo 继续保留，服务器恢复的个人撤销适配仍是明确开放项。

## 历史与文字载体

插入 atom 的历史捕获过去检查 YTextEvent.changes.added，但此事件的集合可能为空，实际 embed 位于 delta。现在检查对象 insert delta，并把行内删除记录纳入结构保护范围。收到同伴属性后撤销自己的插入会被既有同伴保护拦住；未收到时正常撤销，并在同一逆事务写入可供更晚修改恢复的基线。不新增一条用户历史，连续三轮 undo／redo 仍只有一个动作。整块撤销继续使用块永久拓扑流程。

真实双端第一夹具还暴露了底层 prefix／suffix splice 的问题：一次移除两个 atom 时，中间未删除的分隔符也被重建，恢复第二个节点会落在分隔符前。没有把它算作通过，失败截图和 socket 记录保留在 [negative-separator](../assets/hcd-inline-deletion-2026-10-26/negative-separator/boundary.json)。新增带 emoji／分隔符的反例先 RED，再修复。

`writeSemanticInline` 现在先以线性扫描证明是纯 atom 移除，完整保留中间每个文字／embed，只删除已证明移除的 atom；不采用无界文本 LCS。其他文本修改仍走既有路径。新建段落的分配也使用节点／引用存储 root 规范化，避免恢复到末尾时把已合并载荷当成旧 root，产生 node-edit-base-changed。

## wire6 与离线兼容

行内回执不能被旧协调器忽略后继续保存，因此升级为 wire6，frontend／sidecar 共用 `nodeEditWireVersion`。native 本地和远端元数据接受版本 6，房间一旦持久化为 6，旧版本不能读取覆盖共享草稿或发 checkpoint；reset 后门禁仍保留。未知 7 拒绝。应配套更新编辑器、sidecar、native，不以热更新替代旧窗口迁移。

结构3、coordinator4、envelope2、mention1 和 HCD 规范／离线包格式不变。HCD 离线归档包含已提交正文和历史，不携带服务器 Yjs 审阅草稿；当前内容导出在未处理审阅时被保存门禁拦截，直接打包某个已提交版本仍只打包该版本。已恢复且保存的人员／节点、导出适配和资源在无源离线包中正常读取，不依赖在线目录或浏览器扩展。

## 实际验证

621 项前端测试通过，新增 13 项模型及 2 项协调器用例。TypeScript、standalone／embed 构建、native 构建、3 项相关 native 门禁测试、officecli all-targets Clippy／deny warnings 和全仓 Rust fmt／diff 检查通过。React 组件复核包含异步取消、实际权限重检、派生 UI 状态、无新增全局监听及翻译／只读按钮。

最终独立夹具使用修复后的代码和新 native：

| 版本 | 真实操作与结果 |
|---|---|
| r2 | Alice 插入含 @Alice、资源 badge 和周围文字的新段并保存；原文、原图片保留 |
| r3 | Alice 只删除两个行内元素并保存；离线 Bob 改人员为 Bob、改 badge 资料后重连，出现两条审阅，保存被拦在 checkpoint 前 |
| r3 审阅 | 新浏览器恢复人员；两位成员并发 HTTP 恢复同一个 badge，只出现一份，分隔符仍在正确位置 |
| r4 | 全部审阅处理后自动保存；关联重新创建 actor 为实际浏览器 Alice，普通后续编辑无重复事件 |
| r5 | Alice 插入另一个 badge 并保存 |
| r6 | 同一 Node 客户端使用生产 guarded undo 撤销插入并保存；更晚 Bob 属性到达，仍能审阅，保存被拦 |
| r6→r7 | CUA 打开继续删除的二次确认并取消，再恢复最新 badge、明确点击保存，实际下载 r7 DOCX |
| r7 重开 | 新无 codec reader 只读重开，@Bob 和两处 badge 替代文字可读，原始数据保留，保存禁用 |

六条首次 native checkpoint 都是 200，无纠错重试。实际原生持久文件在 r3／r6／r7 载入全新 Y.Doc，分别保留 2／1／0 条待处理审阅；r7 签名清洁回执与共享快照、不可变规范 digest 一致。实际旧 wire5 socket 在同步前拒绝；原生缺失／1–5／未知7 的 GET／PUT／checkpoint 共21次均426，字节和 head 不变。侧车只读恢复403、旧wire恢复426、错误epoch409。协议探针最初缺 epoch 得到400，补齐请求头后才作为门禁验收，不把请求构造错误当成产品回归。

逐份实际 r2–r7 DOCX、浏览器下载、无源 HCD 解包全部 r1–r7 精确投影和离线 DOCX／PPTX／PDF／MD 回读通过。原有初始块完整精确不变；提及和两个业务节点保持原 occurrence／资源，实际 DOCX 有三处图片，资源 hash 和字节数相同。引用事件 r2 创建／r3 删除／r4 恢复均绑定 Alice，r5–r7 无重复事件，提醒仍 disabled。PDF 一页 A4 整页已检查，中文、姓名、资料、分隔文字和三处蓝色夹具图片无页面裁剪。

**来源 ID 边界**：r4 与 r6 的正文、格式、业务／人员载荷和 blockId 精确相等，但规范全文比较并不相等。检查实际差异及 native 实现确认，既有 StructureOperation::Replace 会保留首段文字 ID、为后续文字源重新分配 ID；blockHash 也随之改变。本轮不把这个差异写成“完整规范还原”，见 [来源边界证据](../assets/hcd-inline-deletion-2026-10-26/source-identity-boundary.json)。最终签名与规范映射一致，也不等于原稿无损导出。

- [真实准备／拦截](../assets/hcd-inline-deletion-2026-10-26/socket-prepare.json)、[并发恢复与拒绝请求](../assets/hcd-inline-deletion-2026-10-26/socket-race.json)、[撤销后迟到修改](../assets/hcd-inline-deletion-2026-10-26/socket-history.json)
- [持久 r3](../assets/hcd-inline-deletion-2026-10-26/persisted-r3.json)、[持久 r6](../assets/hcd-inline-deletion-2026-10-26/persisted-r6.json)、[持久 r7](../assets/hcd-inline-deletion-2026-10-26/persisted-r7.json)、[旧 socket](../assets/hcd-inline-deletion-2026-10-26/old-socket-fence.json)
- [实际审阅](../assets/hcd-inline-deletion-2026-10-26/review-r3.png)、[正确恢复](../assets/hcd-inline-deletion-2026-10-26/restored-r4.png)、[二次确认](../assets/hcd-inline-deletion-2026-10-26/confirmation-r6.png)、[最终保存](../assets/hcd-inline-deletion-2026-10-26/restored-r7.png)、[无 codec 重开](../assets/hcd-inline-deletion-2026-10-26/reader-no-codec-r7.png)
- [实际文件](../assets/hcd-inline-deletion-2026-10-26/file-evidence.json)、[DOCX](../assets/hcd-inline-deletion-2026-10-26/browser-r7.docx)、[离线包](../assets/hcd-inline-deletion-2026-10-26/inline-r7.hcdz)、[PDF 整页](../assets/hcd-inline-deletion-2026-10-26/offline-r7-1.png)、[检查摘要](../assets/hcd-inline-deletion-2026-10-26/validation.json)

## 复现

```sh
python3 scripts/hcd-mention-preview.py --node-portable --checkpoint-probe \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-inline-delete-final
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-inline-deletion.mts <root>/private.json prepare
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-inline-deletion-persistence.mts <root>/private.json 3
# 浏览器恢复人员，保留 badge 审阅；下面请求两个成员并发恢复该 badge。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-inline-deletion.mts <root>/private.json race
# 待自动／手动保存到 r4，再执行：
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-inline-deletion.mts <root>/private.json history
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-inline-deletion-persistence.mts <root>/private.json 6
# 浏览器确认／取消、恢复最新内容，保存到 r7 并下载 DOCX。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-inline-deletion-persistence.mts <root>/private.json 7
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-inline-deletion-fence.mts <root>/private.json
python3 scripts/hcd-inline-deletion-files.py <root>/private.json <actual-download.docx>
```

脚本限具名自有夹具顺序；凭证及原始共享二进制只留私有 runtime，公开证据含 ZIP／gzip 内部扫描。UI 收起侧栏观察曾超时，重新读取 AX 已关闭，未重复点击、改数据或重启服务。

## 剩余完整目标

本批解决已持久 intent 的业务属性和人员改目标删除冲突。普通行内格式、custom mark／可编辑行内容器、旧版本已经丢失的 atom／pending 记录自动恢复、结构重建的文字来源 ID 保留、恢复动作接入个人撤销、原稿深度保真、容量／压缩／GC、真实设备／模型／Office、多实例与生产仍需后续实施／验收。没有把上述内容改写成已完成；管理平台、字体运营后台及实际提醒发送继续后置。
