# 未知业务容器的来源身份修复与保存取证

2026-10-25，接续[扩展卸载历史保护](hcd-extension-history-guard.zh.md)。本批解释此前首次保存400的失败类别，修正探针输入路径，并修复未知容器阻断来源标记补写的真实编辑问题。管理平台和实际提醒发送不做；完整交付目标继续保留。

## 原400的取证结论

使用新的独立本地夹具和透明loopback代理，保留原生checkpoint请求/响应，**不记录Authorization头**。重放复制r7→卸载/重载→undo保存r8→redo保存r9后，分别测试：

| 输入方式 | 原生响应与结果 |
|---|---|
| 直接 `schema.text`/Fragment 追加并调用底层store | 首次400：`source-aware text is missing its identity; retain the draft and reload the editor`；持续拒绝，规范head仍r9，真实持久Yjs仍保留被拒绝的新字 |
| 仅创建PM事务，未运行编辑器append插件 | 同样400，head仍r9；只有PM事务不等于执行了完整编辑器输入流程 |
| PM事务 + `applyTransaction` + 来源补写及扩展保护插件 | 首次200，正常保存r10，`saveMode: source-runs`，没有依赖后续重试 |

负例的实时尾段原先只有规范blockId和段落来源默认值，字符run没有 `nodeId`。裸追加不会执行编辑器插件，新增文字因此仍没有来源身份；native的来源回写检查正确拒绝。原生校验保持不变，没有通过放松来源所属/顺序校验来让探针通过。

`hcd-codec-history-peer.mts` 已改为运行真实PM输入和来源补写插件；完整重放探针也运行当前registry的保护插件。原探针exit1和旧native400记录仍保留，**没有把稍后自动重试的r10改称原请求成功**。旧请求原始body未捕获，当前证据是同代码路径的独立重现，不能宣称重建了旧请求逐字节现场。后续故障必须继续按确切请求与回执核对。

## 实际修复：来源补写不能被未知容器阻断

取证进一步构造出真实插件反例：未知富文本容器和外部普通段落都有规范来源默认值，字符尚未补上来源mark。正常打字触发核心 `sourceIdentityPlugin` 全文补写，但未知容器的保护规则把来源mark当作子树内容变化，拒绝整条append事务，连外部普通段落的来源也无法补齐。修复前回归实际失败：只有原打字事务，补写事务被过滤。

现在仅当事务明确标记为核心 `hcd-source-defaults` 修复，并且未知节点树的**所有内容除内部 `hcdSource` mark外完全相同**时，允许这项补写。

- type、attrs、业务envelope、资源、fallback、可见marks、文字和全部子树都精确比较。
- 同一修复标记不能授权改文字、加粗/其他格式、改业务data或删除未知出现。
- 普通本地事务不能借此修改未知内容的来源mark；可信宿主直接操纵编辑器仍不是安全沙箱。
- 历史保护也只忽略这个内部来源mark，避免“外部正常打字附带来源修复”之后，undo因未知容器的非业务回执而被误拦。未知业务内容仍不能被历史改写或删除。

`sameNodeExceptSourceMarks` 由普通事务保护和历史检查共用；没有新增自定义业务mark能力。修复不会为每次打字复制Y.Doc，既有结构历史的64MB试算上限与失败保留策略不变。

没有修改native代码、保存协议或portable载荷：wire仍4、envelope仍2。原生证据是本地真实HTTP/文件，不把历史Rust单测重复计入本批。

## 验证链路

**562项前端测试**、TypeScript和standalone/embed构建通过。4个新用例覆盖实际插件反例、伪装修复仍不能改语义、普通来源mark编辑受保护，以及附带全局来源修复的外部打字undo保留未知业务内容。既有codec卸载和同伴修改保护回归均继续通过。

最终同一夹具的原生代理记录：

| 版本 | 观察到的动作 |
|---|---|
| r6 | 两个真实鉴权socket准备资源、未知v77、富文本/嵌套容器、提及及双端离线子段文字 |
| r7/r8/r9 | 生产复制转换、当前registry历史检查、重载后undo及redo；真实socket/协调保存，原件与副本身份保持 |
| r10 | Bob在完整PM插件路径输入；第一条base9 checkpoint直接200 |
| r11 | CUA在业务codec卸载状态输入普通尾段；工具连接中断前实际输入到“页面输入”，随后正常保存，第一条base10 checkpoint为200 |
| r12 | 浏览器恢复后绑定同一个窗口，只补齐未执行的“验证”并保存；未重复输入整句 |
| r13 | 实际点击自己的undo，仅撤销最后这次补齐，保留Bob正文、较早输入及未知节点；保存200 |
| r14 | 实际redo恢复补齐并保存200，实际浏览器下载DOCX，Bob新窗口重开一致 |

base9–13各只有**一条**对应checkpoint且均200/`source-runs`，不是先失败再用更晚head冒充成功。r10 actor为Bob，r11–r14为Alice；尾段来源ID不变。Chrome临时只读窗口没有本地操作历史，不拿它替代原IAB窗口的undo/redo。

浏览器输入观察曾超时并使连接暂时不可用。先核对实际规范和请求记录，发现部分输入已执行；恢复后继续同一个IAB tab。没有因观察超时重启文档服务，也没有重开窗口丢弃历史来规避验证。临时Chrome回退遇到其他界面操作时停止了原生键盘输入，连接恢复后仅清理本轮创建的那一页，未操作无关内容。此取证不证明所有设备输入法或浏览器故障场景已验收。

实际r6–r14逐份DOCX与规范回读：原6个envelope不变，副本3个ID及提及身份在复制/删除/恢复后稳定；引用创建/删除/恢复actor均为Alice，普通文字及反复查询不产生新关联事件，reminders仍disabled。自己的撤销没有移除Bob文字。无源HCD解包后的每个规范投影与原版本精确相等，资源hash和原图字节保持。

实际无源DOCX/PPTX/PDF/MD及浏览器DOCX均包含原件/副本、提及姓名、Bob正文和最终页面输入。DOCX4处图片，PDF整页渲染检查通过。所有回读/导出后head仍r14。Office/PDF输出仍按适配器语义转换/静态化，业务载荷及可编辑关联保留在HCD中，没有真实Office应用往返验收。

- [原生拒绝与首次成功对照](../assets/hcd-source-repair-2026-10-25/checkpoint-evidence.json)
- [被拒绝的草稿仍在、head未变](../assets/hcd-source-repair-2026-10-25/rejected-draft-retained.json)
- [完整PM路径首次r10响应](../assets/hcd-source-repair-2026-10-25/first-save-r10.json)
- [浏览器与中断边界](../assets/hcd-source-repair-2026-10-25/browser-evidence.json)
- [保存后的页面](../assets/hcd-source-repair-2026-10-25/source-saved-r14.png)
- [实际文件和身份](../assets/hcd-source-repair-2026-10-25/file-evidence.json)
- [浏览器DOCX](../assets/hcd-source-repair-2026-10-25/browser-r14.docx)
- [离线HCD归档](../assets/hcd-source-repair-2026-10-25/source-r14.hcdz)
- [源码/日志检查摘要](../assets/hcd-source-repair-2026-10-25/validation.json)

## 复现

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-mention-preview.py --extension-nodes --node-history --checkpoint-probe \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-checkpoint-typed
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-business-blocks.mts /absolute/owned-root/private.json
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-checkpoint-repro.mts /absolute/owned-root/private.json pm
# r10后：浏览器卸载codec，普通尾段输入；保存、自己的undo/redo，实际下载。
# 此次中断/续写产生了r11–r14；文件探针仅验证这一具名版本序列。
python3 scripts/hcd-source-repair-files.py /absolute/owned-root/private.json \
  /absolute/actual-browser-download.docx
```

负例必须用独立新夹具，同样准备r6后运行 `hcd-checkpoint-repro.mts ... bare`，预期探针exit1、原生400且head9。仅PM事务但未调用append插件的早期负例原始捕获也保留；当前 `pm` 模式已代表完整插件路径。代理只监听127.0.0.1，私有夹具目录有权限限制，捕获有大小上限，凭证不写入证据目录。

完整删除/离线输入竞争、任意custom mark、可编辑行内容器、复杂业务/Office往返、资源容量与历史压缩、生产/多实例/旧epoch/设备等原计划门槛仍继续。此批关闭已复现的来源修复问题及保存失败类别取证，不能替代完整目标验收。
