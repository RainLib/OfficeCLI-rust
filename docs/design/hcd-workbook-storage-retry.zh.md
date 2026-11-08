# 工作簿设备存储重试保留批量草稿（2026-10-30）

本批修复 Excel 批量输入尚未落盘时的一条实际丢稿路径，继续保存/恢复一致性。管理平台、字体后台及提醒投递不做；完整格式能力、性能和多设备目标保持开放。

## 因果路径及实现

空白格批量粘贴先由客户端同步接管为 `transient`，再异步写入独立设备日志。写入失败时保留内存输入；如果随后读取日志也失败，`problem` 会显示设备不可用提示。旧页面的提示“重试”通过 `setBatchRetry` 重建客户端，effect 清理随即 dispose 旧实例，而新实例只能读取尚未包含这份输入的设备库，内存草稿因而丢失。

现在页面直接调用原客户端的 `retryStorage`，不改变 effect 的所有者。已有 journal 时重读同一日志；初始化失败时在同一实例重新尝试打开。重试期间设置 loading/active 门禁，重复点击或正在写入时不另开操作；已销毁实例不重新打开。失败仍保留原内存输入、已读分支和备份入口。读取恢复仅解除存储错误，不自动落盘或提交正文；用户仍需明确重试批次备份，再按既有协议保存整组。

这不消除输入捕获到第一次设备提交之间的崩溃窗口。源身份或文档发生切换时的完整生命周期、设备永久损坏与系统断电仍需要分别处理，不把“原地重试”当成任意情况下的不丢稿保证。

## 受控测试和构建

新增三项实际产品客户端 + fake-indexeddb 测试：写入及随后读取失败、重复失败后重试成功、备份精确相同和日志重开；初始打开失败后恢复；正在写入和 dispose 后的门禁。网络调用在这些测试中直接拒绝，确保存储重试不偷偷提交。

批量日志、保存/恢复及合并备份相关 **30 项通过**。首次新增测试运行存在测试文件的括号语法错误，修正后重跑；`initial-test-syntax-error.log` 和 `initial-focused-syntax-error.log` 保留，不作为产品修复前失败证据。最终前端完整 **2008 项全部通过**，包含 TypeScript 的独立/嵌入构建通过，见 [validation.json](../assets/hcd-workbook-storage-retry-2026-10-30/validation.json)。

本批没有 Rust 修改，原生只执行实际文件解包、validate 和历史导出回读，不宣称重跑原生全量/严格 Clippy 或桌面 Excel/WPS 验收。

## 真实普通工作簿页面

隔离 workbook fixture 使用当前生产组件、网格及设备日志。可见测试按钮只让下一次批量日志写入和随后两次读取抛错；不注入单元格或设备草稿，不改变服务端存储。实际输入来自网格 B3/C3 的普通 TSV 粘贴：`重试保留甲😀`、`重试保留乙`。

1. 写入失败且第一次读取失败后，标题显示本机备份不可用，批量面板仍列出两格内存输入；下载实际 `.hcd-batch-draft`。
2. 点击设备错误提示中的“重试”，第二次读取仍失败，两格及下载能力继续存在；再次点击恢复读取，两次调用均属于原 owner。没有提交新规范版本，仍为 r0。
3. 再次下载，内容逐字节与第一次一致。点击批量面板内的“重试”落盘，出现“保存整组”。下载可见控件记录后关闭原标签；普通 `alice.html` 新标签读到同一批次，第三份实际下载仍与前两份完全相同。
4. 普通页面“保存整组”生成 r1。Bob 普通窗口读到两格，随后修改 A1 为 `Bob后续协作` 并保存 r2，Alice 无刷新收到 r2。下载实际 r1/r2 XLSX 和 r2 HCDZ。

事件记录 `storage-retry-observations.json` 包含一次写入失败、两次读取失败、同一 owner 的两次读取重试及最终落盘。它在原标签关闭前由可见按钮下载，不在关页后补造。首次打开标签导航观察超时后读取同一标签；协作者创建时未附加成功，先确认标签不存在后才另建，没有因观察超时重启服务。

[文件回读](../assets/hcd-workbook-storage-retry-2026-10-30/files.json) 验证三份真实备份字节相同，两版 XLSX 的两格新值、Bob 后续内容、原 C1 公式 `1+2` 和缓存 `3`、数值及离屏原文均正确。浏览器实际 HCDZ 经 CLI 解包和 validate，20 个规范文件与 live r2 目录相同；在**明确提供匹配原 XLSX**的条件下，离线目录 r0/r1/r2 源导出逐版回读一致。不能由此声称 HCDZ 自带原 XLSX 或应用可以完全离线冷启动。

截图：[失败重试仍保留](../assets/hcd-workbook-storage-retry-2026-10-30/failed-retry-retained.png)、[双方续存 r2](../assets/hcd-workbook-storage-retry-2026-10-30/saved-peer-r2.png)。

## 复验

```sh
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs --test examples/hdoc/editor/src/workbookBatchStorageRetry.test.ts
python3 scripts/hcd-workbook-recovery-preview.py --collaboration
# 使用新建、由自己拥有的 fixture root，准备可见存储故障按钮。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-workbook-storage-retry-fixture.mts /absolute/owned-root
# 完成上述真实 UI 操作并将下载独立保留到本批证据目录后：
python3 scripts/hcd-workbook-storage-retry-files.py /absolute/owned-root
```

不同轮次的任务身份/源文件/下载不能混用。私有配置只留在临时目录，清理记录和凭据扫描见本批 validation；不把测试令牌写入证据。

## 保持开放

尚未落盘内存的崩溃窗口、永久设备故障、跨账号或跨源切换、跨设备及真实输入法/物理断电继续验收。单格和批量多库仍没有跨库原子移动，工作簿图片任务恢复未完成；公式、结构和样式编辑不因这项修复开放。附件损坏提示、Word 分页/页码/自动目录、PPT/PDF 完整创作、字体国际化、真实 AI 和多实例等原清单继续。
