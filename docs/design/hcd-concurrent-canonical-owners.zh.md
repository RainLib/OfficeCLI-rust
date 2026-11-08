# 并发转换后的保存身份、撤销与列表容器

2026-10-26。继续[拖动与写作交互](hcd-notion-writing-and-drag.zh.md)和[列表可见投影](hcd-projected-list-recovery.zh.md)的保存／协同验收。完整七阶段目标继续，管理平台和实际提醒发送后置。

## 复现的问题

Alice 和离线的 Bob 同时包装同一个原段落：Alice 转成引用并追加自己的段落，Bob 转成列表并追加自己的内容。重连后原文只有一个有效位置，但两个仍有内容的包装都借用了原文的规范 owner。过去会因重复 owner 拒绝投影和保存，双方新增内容无法正常显示。

有序／无序、两种 client ID 大小、两种更新交付顺序共八个反例在修改前全部失败，保留 [RED 记录](../assets/hcd-owner-race-2026-10-26/red-before-fix.log)。进一步验证发现两个独立问题：Yjs 逆操作可能无法找回已 GC 的同伴位置；native 重写其他块时可能把未改动的根列表项丢掉外层 `ol`，造成编号变为项目符号。

## 保存身份

- 按实际可见的根块／顶层列表项收集保存槽位。借用身份发生竞争时，包含永久原文载体的槽位继续保留原规范 ID，其他槽位从永久 key 推导 `branch_…` owner，并按稳定顺序消除冲突。
- 已知原文载体暂时不在任何可见槽位时，各分支获得独立身份；无法识别身份来源的损坏记录继续报错，不猜测归属。
- 新抬升到规范层的显式 null owner 可使用自身 key；缺失 owner 字段仍是非法结构。派生 owner 尚未收到规范回执时使用临时 ID，不能继承包装里残留的原文 ID。
- 这是纯读取投影：打开文档不会偷偷改共享状态。保存来源捕获、普通后续编辑、规范回执和删除恢复都使用同一个有效身份。普通编辑真正持久化派生 owner 时明确写入暂存绑定。
- 每个 Y.Doc／schema 缓存已完成的原始投影；任何事务开始即失效，活动事务内不缓存。因此远端只有删除、没有新时钟的更新也不会读到旧结果；多个 store 共用缓存和一个监听器。

原文的规范 ID 随原文保留。其他包装槽位可能因归属变化获得新的规范块 ID，不能将这些包装 ID 当成跨转换业务身份；业务节点 `instanceId`、人员 `mentionId` 和归档资源另有稳定身份。

## 撤销的精确位置与删除审阅

Yjs 撤销本人的获胜位置时，之前的并发位置值可能已被 GC。先在隔离副本中找出缺失位置，只从同伴历史 map 项与仍然存在的永久序列锚点恢复其精确 parent/reference。若 map 内容已回收，只有紧邻同伴 placement 时钟的普通序列锚点能证明位置才恢复；缺失 split／boundary 信息的复杂结构不猜测，继续由历史保护拒绝。

真正逆操作通过临时 deleteFilter 在**同一事务**写入该位置。撤销创建仍保留永久拓扑与既有删除 receipt；额外一次保留拓扑的隔离试算，捕获逆操作完成后的隐藏子树快照，避免把同一逆操作已经移走的原段误报为新同伴输入。两次投影必须一致；filter 在 finally 中还原，用户历史仍只有一条 undo／redo。原有同伴修改与未知 codec 保护继续执行。沿用 64 MB 逆操作预检上限，不把该流程作为长文容量验收。

## native 列表容器

实际文件严格比较暴露了原生错误：r4 的 `<ol><li data-hcd-editor-level="1">…` 在只编辑 Alice 引用后，r5 变成脱离外层列表的 `li`，解析器又把它标成无序。没有放宽文件比较来掩盖它。

现在解析器区分“确实处在有序／无序列表内”和“没有外层列表”：外层类型优先；旧的独立规范 li 则保留显式 level。写块时为独立根 li 重建相应 ol／ul 及 start，计入 chunk 字节限制，保留未改动文本来源。两个原生测试修改前失败的日志分别保留：[容器](../assets/hcd-owner-race-2026-10-26/native-list-container-red.log)、[显式编号标记](../assets/hcd-owner-race-2026-10-26/native-list-flag-red.log)。

本轮修改 Rust 并重建了 native。wire5、结构3、coordinator4、envelope2、mention1 不变；编辑器、sidecar 和 native 应配套更新。本轮没有自动修复旧客户端已经写坏的 pending 捕获或丢失拓扑。

## 实际验收

606 项前端测试通过，包括八种合流、投影纯读取、新 Y.Doc、回执／后续编辑，以及两种身份大小各三轮自己的 undo／redo。hcd-core 78、hcd-docx 43、hcd-formats 49 项通过；TypeScript、standalone／embed、native 构建、相关 all-targets Clippy 和全仓 Rust fmt／diff 检查通过。

最终独立夹具使用更新后的 native，未重启服务恢复异常：

| 版本 | 实际行为与结果 |
|---|---|
| r1→r2 | 两个鉴权离线 socket 分别引用／有序列表包装，共同保存；原文一次、双方新增各一次、规范目标唯一 |
| r3 | Alice 撤销自己的转换；原文回到 Bob 的精确位置，Bob 新增保留，无假删除审阅 |
| r4 | Alice 重做；双方新增各一次，业务载荷、人员提及和资源身份不变 |
| r5 | Bob 通过实际 PM append 插件在 Alice 新段中输入并保存；Alice 此时撤销创建被同伴保护拦截，正文与历史不变 |
| r6 | CUA 在浏览器一次粘贴“浏览器追加”并保存 |
| r7 | 同一窗口撤销并保存；完整规范块与 r5 精确相等 |
| r8 | 同一窗口重做并保存；完整规范块与 r6 精确相等；实际下载 DOCX |
| r8 重开 | 新 reader 未注册业务 codec，仍显示姓名和节点文字替代，保留原载荷并只读，保存禁用 |

七条首次 native checkpoint 全部 200，没有纠错重试。r2–r5 已确认客户端快照及实际 native r5／r8 文件分别载入全新 Y.Doc，验证 owner／来源目标、纯读取及零未处理审阅；native 清洁回执的签名、共享快照与不可变规范投影 digest 一致。实际持久文件回读不等于服务重启验收。

逐份 r2–r8 的 DOCX、实际浏览器 r8 下载、无源 HCD 解包的全部 r1–r8 精确投影，以及离线 DOCX／PPTX／PDF／MD 回读通过。原文规范 ID、原图片完整块、双方业务载荷及资源字节保留；DOCX 有三处图片。关联创建 actor 来自实际作者，撤销／重做只产生 Alice 的移除／创建事件，r5 后普通输入没有重复事件，提醒发送仍 disabled。PDF 为一页 A4，整页已检查中文、编号、姓名、节点导出文字和三处蓝色夹具图片，无页面裁剪；不代表真实 Office 排版验收。

证据：

- [真实 socket 与保存](../assets/hcd-owner-race-2026-10-26/socket-evidence.json)、[首次 checkpoint](../assets/hcd-owner-race-2026-10-26/checkpoint-evidence.json)
- [实际持久 r5](../assets/hcd-owner-race-2026-10-26/persisted-r5.json)、[实际持久 r8](../assets/hcd-owner-race-2026-10-26/persisted-r8.json)
- [浏览器追加](../assets/hcd-owner-race-2026-10-26/browser-paste-r6.png)、[撤销](../assets/hcd-owner-race-2026-10-26/browser-undo-r7.png)、[重做](../assets/hcd-owner-race-2026-10-26/browser-redo-r8.png)、[无 codec 重开](../assets/hcd-owner-race-2026-10-26/reader-no-codec-r8.png)
- [实际文件证据](../assets/hcd-owner-race-2026-10-26/file-evidence.json)、[浏览器 DOCX](../assets/hcd-owner-race-2026-10-26/browser-r8.docx)、[离线包](../assets/hcd-owner-race-2026-10-26/owner-r8.hcdz)、[PDF 整页](../assets/hcd-owner-race-2026-10-26/offline-r8-1.png)
- [完整检查摘要](../assets/hcd-owner-race-2026-10-26/validation.json)

两个失败夹具没有混入上述通过结论。第一个早期探针绕过 PM source 插件，native 400 且草稿留存，见[负例](../assets/hcd-owner-race-2026-10-26/harness-negative-control.json)；第二个用旧 native 暴露真实列表容器错误，见[负例](../assets/hcd-owner-race-2026-10-26/native-list-negative-control.json)及 negative-native-list 子目录。最终夹具使用完整 PM 插件和新 native。UI 导出导航曾观察超时，重新读取 AX 已切到导出页，未重复点击或重启服务。

## 复现与开放项

先启动独立自有夹具，保留打印的 root 和浏览器地址：

```sh
python3 scripts/hcd-mention-preview.py --node-portable --checkpoint-probe \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-owner-final
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-owner-race.mts <root>/private.json
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-owner-persistence.mts <root>/private.json 5
# 浏览器一次粘贴、保存到 r6；撤销／保存到 r7；重做／保存到 r8；下载 DOCX。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-owner-persistence.mts <root>/private.json 8
python3 scripts/hcd-owner-race-files.py <root>/private.json <actual-download.docx> 8
```

脚本限具名自有夹具顺序；凭证／原始持久二进制只在私有 runtime，公开证据扫描含 ZIP／gzip 内部。当前范围不等于任意跨树转换、移动／分段／删除复合竞争均已解决。同段行内节点删除、任意 custom mark／可编辑行内容器、旧错误 pending 自动迁移、容量／压缩／GC、长文设备、真实 Office／模型／生产多实例和原七阶段其他验收仍开放。

后续补充：人员／自定义 atom 单独删除后的迟到属性和改目标，见[行内删除审阅与 wire6](hcd-inline-deletion-review.zh.md)。本页 wire5、606 项及完整规范相等是本批特定路径的历史证据；后续批次采用 wire6、621 项，并明确结构 Replace 的文字来源 ID 边界。
