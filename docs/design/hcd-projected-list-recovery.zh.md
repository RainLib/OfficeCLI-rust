# 列表恢复的可见保存目标与永久空载体

2026-10-26（本批证据目录沿用 10-25 的开始日期），继续[创建撤销后的迟到输入恢复](hcd-history-late-input-recovery.zh.md)。完整七阶段目标保持；管理平台和实际提醒发送继续后置。

## 已复现的缺口

把段落包装成列表后撤销，段落回到根层；原列表和列表项保留永久载体，供离线修改回到原位置。若离线成员在旧列表追加另一项，恢复后的列表只显示新项，旧项因没有子段而被投影裁剪。

修复前，保存和来源映射按原始活动子项遍历，把这个空项也计入目标。有序、无序两个反例均出现“可见快照 2 项，保存目标 3 项”，原有七个历史测试仍通过。目标与实际提交内容错位，可能在提交后产生 block/source identity 冲突。修复前的 [RED 记录](../assets/hcd-list-recovery-2026-10-25/red-before-fix.log)保留。

## 修复契约

- `childKeys` 保持永久拓扑语义；空项、文本载体、位置引用和可见性记录继续保留。
- 新增 `projectedChildren(key, node)`，从已经投影的父节点取得实际显示的子项，并校验其永久位置。复用父节点，逐层遍历，不为每个子项重新投影完整子树。
- 规范 owner 唯一性检查、保存目标、文本来源遍历和历史保护都按实际投影取节点。空列表项不会占用规范保存槽位、接收别人的回执或提前获得另一个列表项的 ID。
- 恢复时，以可见项构建已占用 owner 集合，同时为恢复子树的永久列表项预留独立 owner。日后空项收到离线新段，可以正常重现为独立列表项，不与已经移出的原段落共用规范身份。
- 正常列表项中的空段落仍然可见并参与保存；这里只裁剪既有投影规则认定没有合法子内容的空包装。非空 schema 错误、循环和真正可见的重复 owner 继续拒绝。

没有新增共享字段：wire5、结构3、coordinator4、deletion receipt1、envelope2、mention1 不变。编辑器与 sidecar 应一同更新实现；本批没有 Rust 修改，native 二进制与上一阶段哈希相同。旧协调器已经产生的错误捕获记录、任意并发 owner 转移及历史数据自动修复仍需单独验证，不以本批预防修复替代。

## 实际验证

595 项前端测试、TypeScript、standalone/embed 构建通过。新增四项覆盖有序／无序列表的投影数量，以及假 API 协调器持久重载、恢复保存、空项二次收到离线输入后的保存。假协调器重载不等于真实服务重启验收。

真实本机 native/sidecar、鉴权 socket 与浏览器验证：

| 阶段 | 结果 |
|---|---|
| r1→r2 | Alice 用生产块命令把原段落变成无序列表并保存 |
| r2 离线 | 两个 Bob 客户端各自保留旧列表；一个追加带 `@Bob 李`、业务行内节点和归档图片的新项，另一个在原列表项追加新段 |
| r3 | Alice 同窗口撤销包装并保存；第一个离线客户端重连，新项进入删除审阅，规范保存被拦在 checkpoint 之前 |
| r4 | 新 Bob 浏览器没有旧撤销历史，恢复最新内容并保存成功；永久旧项仍在，规范 ID 为 null；可见列表一项，保存目标与快照一致 |
| r5 | 交付第二份更早的离线修改，原空项重新显示并获得独立规范 ID；原文、新项、旧项新段各一次，提及与业务节点身份不变 |
| r5 历史 | 恢复窗口撤销会隐藏后来收到的同伴内容，保护提示正确出现；取消后正文、历史和 head 保留 |
| r5 新窗口 | 未注册节点 codec 的 reader 重开，列表和人员名正常，未知业务节点显示文字替代与只读保留提示，保存不可用 |

原生首次 checkpoint r2/r3/r4/r5 均 200，无纠错重试；r3 冲突保存未进入 checkpoint。原生实际持久 Yjs 文件分别在 r3/r4/r5 载入全新 Y.Doc，投影、目标数量、审阅和永久旧项均验证。没有重启服务或以浏览器观察超时推断失败。

逐份实际 r3/r4/r5 DOCX、浏览器 r5 DOCX、无源 HCD 解包与离线 DOCX/PPTX/PDF/MD 回读通过。原段落和原图片的完整规范块在 r3/r4/r5 精确相等；新列表项 r4/r5 的完整规范块相等，重新出现的旧项获得独立 ID。归档资源 hash/字节数相同，实际 DOCX 含两处图片。引用创建 actor 为 Bob，r5 不再产生重复关联事件，提醒仍 disabled。离线包的 r1–r5 投影与原文档精确相等，回读后 head 仍 5。PDF 一页渲染已检查中文、项目符号、姓名、节点导出文字和两处夹具图片，无裁剪或重叠。

- [socket 准备与拦截](../assets/hcd-list-recovery-2026-10-25/blocked-r3.json)、[旧项迟到后的保存](../assets/hcd-list-recovery-2026-10-25/later-r5.json)
- 实际持久文件回读：[r3](../assets/hcd-list-recovery-2026-10-25/persisted-r3.json)、[r4](../assets/hcd-list-recovery-2026-10-25/persisted-r4.json)、[r5](../assets/hcd-list-recovery-2026-10-25/persisted-r5.json)
- [浏览器删除审阅](../assets/hcd-list-recovery-2026-10-25/review-r3.png)、[恢复并保存](../assets/hcd-list-recovery-2026-10-25/restored-r4.png)、[撤销保护](../assets/hcd-list-recovery-2026-10-25/protected-undo-r5.png)、[无 codec 只读重开](../assets/hcd-list-recovery-2026-10-25/reader-no-codec-r5.png)
- [实际文件与身份](../assets/hcd-list-recovery-2026-10-25/file-evidence.json)、[首次 checkpoint](../assets/hcd-list-recovery-2026-10-25/checkpoint-evidence.json)、[浏览器下载](../assets/hcd-list-recovery-2026-10-25/browser-r5.docx)、[离线包](../assets/hcd-list-recovery-2026-10-25/list-r5.hcdz)、[PDF 整页](../assets/hcd-list-recovery-2026-10-25/offline-r5-1.png)
- [完整检查摘要](../assets/hcd-list-recovery-2026-10-25/validation.json)

## 复现

先在一个终端启动自有夹具，保留打印出的 root 与浏览器地址：

```sh
python3 scripts/hcd-mention-preview.py --node-portable --checkpoint-probe \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-list-recovery
```

在另一终端执行（`<root>` 是上述私有夹具路径）：

```sh
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-list-recovery.mts <root>/private.json prepare
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-list-persistence.mts <root>/private.json 3
# 在新 Bob 浏览器恢复、保存到 r4，然后再检查和交付另一份离线输入。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-list-persistence.mts <root>/private.json 4
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-list-recovery.mts <root>/private.json later
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-list-persistence.mts <root>/private.json 5
# 实际浏览器下载 DOCX 后执行：
python3 scripts/hcd-list-recovery-files.py <root>/private.json <actual-download.docx>
```

脚本限制为具名自有版本顺序，不是迁移任意用户文档的工具。凭证和原始持久二进制只留私有夹具，公开证据不含 bearer/secret。

## 完整目标继续

本批没有验证任意跨树转换／并发 owner 争用、同段行内元素删除竞争、旧错误 pending 捕获自动修复、长文容量／压缩／GC、任意 custom mark／可编辑行内容器或全部设备／真实 Office／生产多实例。其余保存、命令、扩展、国际化、AI 和格式适配仍按完整交付清单推进。

后续补充：同一原段落并发转成引用／列表时的 owner 争用、自己的撤销位置及 native 列表容器，见 [2026-10-26 专项](hcd-concurrent-canonical-owners.zh.md)。本页 595 项和无 Rust 修改均是本批历史记录；后续批次为 606 项并修改 native，不覆盖本页原始证据。
