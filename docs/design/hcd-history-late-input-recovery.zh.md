# 撤销创建后的迟到输入恢复

2026-10-25，接续[显式删除审阅](hcd-deletion-conflict-review.zh.md)。完整七阶段目标保持，管理平台和实际提醒发送后置。

## 缺口与修复

原有历史保护能拒绝隐藏当前窗口已经收到的同伴修改，但无法覆盖尚未到达的输入。Yjs默认撤销首次创建时移除第一份可见性、位置和顺序引用；底层文字仍在，迟到子段却缺少完整拓扑供投影/恢复。新增反例实际4项中3项失败：没有审阅，也不能在无历史的新Y.Doc中恢复。

`prepareUndoneCreations` 在既有隔离试算之后识别本次逆操作移除首次可见性的节点，为消失根准备精确删除receipt。在**真实逆操作的同一个Yjs事务内**，只把根隐藏，保留永久位置/顺序引用及子块拓扑、可见性，并写入既有 `hcd-semantic-deletions/1`。迟到内容继续进入同一载体，复用删除审阅和协调器保存门禁。

实现只在这次逆操作期间包装 `UndoManager.deleteFilter`，保留原过滤器并在finally恢复。receipt/隐藏状态进入同一个相反方向历史项，不增加独立用户操作。打包的顺序Item可能保留其他失活引用，但placement的唯一reference仍决定真正可见位置；多块复制合并移动及5轮撤销/重做均未重复投影。已经合并回其他载体的文本流段不作为独立丢失创建。普通打字不因此克隆Y.Doc，继续使用既有64MB结构试算和1MiB/2048条receipt预检；长期容量/压缩仍未完成。

完整Word使用guarded语义历史。`undoManager(false)`只用于低层隔离试算/负例，不自动获得宿主codec和权限保证。既有同伴修改、未知codec/祖先、取消与精确跳过保护继续适用。恢复读取当前永久子树，不从旧快照覆盖后来收到的文字、资源、提及或子块，也不依赖当前窗口的撤销栈。

## 包装块的规范身份

引用/列表包装可能借用原段落的canonical owner。撤销包装后，原段落已正常显示；离线成员又在旧包装中新增子段时，恢复包装不能占用该原段落的身份。

`restoredOwners` 在恢复根/顶层列表项时核对可见owner，只为缺失或冲突槽位分配独立、确定性的临时owner，并清空其规范绑定，要求native生成独立根ID。已经显示的段落不改ID/来源run，业务及提及身份不重建；嵌套恢复不擅自新增顶层owner。

实际验证“尾段转引用→保存→撤销包装→离线新子段迟到→恢复”：原尾段r11/r12的完整规范内容及ID相等，恢复引用使用另一ID，旧尾段和新子段各出现一次。不是仅靠没有异常来推断身份正确。

## 兼容与验证

没有新增共享字段/载荷版本：wire5、结构3、coordinator4、deletion receipt1、portable envelope2、mention1不变。wire5服务已能读取有效receipt和永久拓扑；这是guarded客户端历史的行为修复。旧可写编辑器需要更新/刷新，不能宣称旧版已损坏的拓扑自动重建。HCD规范格式不变。本轮没有Rust修改，沿用上轮native二进制，未重复计入历史原生测试。

共享隐藏receipt属于草稿，不是规范历史。未处理迟到修改仍阻止当前保存/导出；恢复并保存后才进入规范HCD及离线导出。已保存版本可按其历史读取。未接受AI建议、协作光标/查看位置和实际提醒发送不进入这条链路。

**581项前端测试、TypeScript及standalone/embed构建通过**。新增7项模型回归覆盖深层复制/资源/提及、无窗口历史重载、重做后保护、普通块迟到格式、多块复制合并移动、重复历史和包装owner；另有假API协调器重启用例，验证失败保存持久保留、重载审阅及恢复后规范保存。后者不是实际服务重启验收。

| 版本/动作 | 真实本机鉴权socket、浏览器和文件证据 |
|---|---|
| r6/r7 | 原6个业务envelope/资源/提及；原浏览器块菜单执行一次复制并保存，新增3个独立业务身份 |
| 离线准备 | Bob收到r7，在副本中离线写入，尚未发送 |
| r8 | 原浏览器窗口撤销复制并保存；Bob交付离线草稿后，协调器拒绝规范保存；native实际持久文件载入新Y.Doc仍有完整审阅 |
| r9 | Bob新窗口最初无撤销/重做历史，仍可恢复并保存；原创建窗口随后重做不重复插入或覆盖同伴恢复，head仍9 |
| r10/r11 | 真实socket使用生产命令将尾段包成引用并保存，同一客户端历史撤销/保存；离线新子段交付后保留在隐藏包装中 |
| r11持久文件 | 独立载入native实际文件，保留新子段和审阅，当前可见根owner唯一 |
| r12 | 浏览器恢复/保存，native分配独立包装ID；实际浏览器DOCX下载、新只读窗口重开和当前持久文件独立回读通过 |

全部10条首次native checkpoint（r3–r12）均200；两个冲突保存停在协调器，不进入checkpoint。复制/撤销actor为Alice，副本和新包装恢复actor为Bob；同mentionId的创建/删除/恢复身份保留，包装操作不额外产生引用事件，reminders继续disabled。

浏览器操作工具多次超时，逐次核对AX/native head，有些动作已经执行，不能据超时重复提交。复制菜单仅选中时head仍6，随后Enter实际执行一次；原窗口26保留复制、撤销和重做，新窗口27专门验证无历史恢复。没有因观察超时重启服务或重建原窗口。这不等于设备/浏览器故障、热更新或跨设备历史迁移已全面验收。

逐份r6–r12规范/实际DOCX验证6个原载荷及3个副本载荷不变、身份稳定、actor正确；无源HCD解包后7份历史投影与原规范精确相等，资源/原图字节保持。无源DOCX/PPTX/PDF/MD及浏览器DOCX包含副本迟到文字、独立包装新段、两处提及和4处图片，PDF整页已检查。回读/导出后head仍12。没有实际Office往返、生产、真实数据库/多实例或服务断电/重启验收。

- [浏览器与超时边界](../assets/hcd-history-late-2026-10-25/browser-evidence.json)、[无历史新窗口](../assets/hcd-history-late-2026-10-25/fresh-window-review-r8.png)
- native实际持久文件重载：[r8](../assets/hcd-history-late-2026-10-25/persisted-r8.json)、[r11](../assets/hcd-history-late-2026-10-25/persisted-r11.json)、[r12](../assets/hcd-history-late-2026-10-25/persisted-r12.json)
- [首次checkpoint](../assets/hcd-history-late-2026-10-25/checkpoint-evidence.json)、[实际文件/来源/身份](../assets/hcd-history-late-2026-10-25/file-evidence.json)
- [浏览器DOCX](../assets/hcd-history-late-2026-10-25/browser-r12.docx)、[无源HCD](../assets/hcd-history-late-2026-10-25/history-r12.hcdz)、[PDF整页](../assets/hcd-history-late-2026-10-25/history-offline-r12-1.png)
- [源码、日志与检查摘要](../assets/hcd-history-late-2026-10-25/validation.json)

## 复现与剩余范围

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-mention-preview.py --extension-nodes --node-history --checkpoint-probe \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-history-late
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-business-blocks.mts /absolute/owned-root/private.json
# 浏览器复制/保存r7，再准备Bob离线输入。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-history-late.mts /absolute/owned-root/private.json prepare
# 原窗口撤销复制/保存r8，然后交付离线草稿。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-history-late.mts /absolute/owned-root/private.json late
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-history-late-persistence.mts /absolute/owned-root/private.json 8
# 新Bob窗口恢复/保存r9，原窗口重做验证不重复。包装与撤销到r11。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-history-late.mts /absolute/owned-root/private.json wrapper
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-history-late-persistence.mts /absolute/owned-root/private.json 11
# 浏览器恢复包装/保存r12，实际下载。
python3 scripts/hcd-history-late-files.py /absolute/owned-root/private.json \
  /absolute/actual-browser-download.docx
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-history-late-persistence.mts /absolute/owned-root/private.json 12
```

探针只验证上述具名版本顺序；凭证和原始Yjs二进制只留在私有夹具目录。同段行内atom/提及删除竞争、旧版缺失拓扑恢复、复杂跨树移动/转换/并发owner转移、容量/压缩/GC和旧epoch仍需继续；任意custom mark/可编辑行内容器及其余统一命令、国际化、AI、Office往返、设备/生产门槛也保持完整范围，不能以本批替代全目标审计。


2026-10-26 后续：有序/无序列表中的永久空项与可见保存目标已单独修复，并验证另一份更早离线输入在恢复后重现旧项、独立保存；见[列表投影恢复](hcd-projected-list-recovery.zh.md)。本页原581项及r6–r12证据保持原范围。
