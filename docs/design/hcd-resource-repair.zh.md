# 损坏附件副本的明确确认与恢复（2026-10-30）

普通语义及 inline1 恢复面板现在可以检查并明确修复同编号、同元数据但字节损坏的本机待处理附件。接续[完整性拒绝](hcd-resource-import-integrity.zh.md)，本批不再需要测试控件还原字节才能继续正常恢复。管理平台和实际提醒继续后置，完整 HCD 目标保持开放。

## 产品交互

1. 导入因附件完整性失败时，显示“本机已有附件副本未通过完整性校验，文档尚未合并”，保留候选下载并提供“检查附件副本”。不再只展示含糊的“复制可能已经完成”。
2. 检查以当前鉴权、文档比较基线和确定性恢复任务编号读取设备日志；只有元数据完全相同且本机摘要错误的任务会进入修复列表。内容正确、任务消失或描述变化均不会被强行覆盖。
3. 独立确认区域显示文件名及恢复包/本机摘要，可先下载 `.corrupt-copy` 原始损坏副本。默认焦点在取消；取消不写入。
4. “确认替换本机附件副本”只替换被核对过的设备任务字节，恢复为 chosen，保持编号、目标及资源身份。不会上传、关联节点、应用恢复正文或生成规范版本。
5. 成功后仍需用户检查待处理任务、单独确认合并；任务在正常关联前继续阻止将文档误报为完整保存。若结果不能确认，保留候选并要求重新检查，不自动重复替换或声称正文已合并。

英文、简体和繁体有对应文案。界面 locale 与附件内容无关，切换语言不改变字节。

## 存储与协同保护

`repairNodeResources` 是独立、明确的操作，不改变普通重复导入“拒绝损坏”的规则。它在等待前捕获完整原任务和替换快照，校验替换摘要正确、原摘要确实错误；随后在同一 IndexedDB 写事务内逐项核对原元数据、阶段和实际字节，全部符合才写入整批。任务取消、已关联、阶段推进或其他字节变化都会拒绝旧确认，不能复活终态或部分修复其他项。

发布沿用同源文档文件锁和客户端通知；最终事务内再执行同步可用性、权限和取消门禁。正文 update 观察器会使正在等待的确认失效。服务端鉴权与本机事务并非一个分布式原子事务，但此操作没有规范正文或远端资源写入。

设备提交后的通知、flush 或最终观察可能失败，因此未知结果仍按“请重新检查”处理。当前保守提示也覆盖已明确发生的任务竞争；尚未为每类本机事务拒绝提供独立用户文案。无 Web Locks 时仍依赖设备事务的比较替换保护，不能据此扩展为所有文件操作的完整跨窗口保证。

## 测试与构建

- 新增 12 项真实产品 journal/恢复 helper 的受控测试，覆盖普通语义和 inline1、正确修复、普通去重、元数据变化、错误输入、整批拒绝、终态、阶段推进、最终 guard、摘要等待期间取消、正文/权限变化和提交后通知失败。使用 fake-indexeddb，不冒充物理设备。
- 相关 **92 项通过**；完整前端 **2020 项全部通过**。含 TypeScript 的独立版/嵌入版构建通过。
- 首次类型检查发现新测试使用了过窄的普通节点 journal 类型；测试改为通过生产 `openEditor` 按协议选择有效模型，保留 `typecheck-initial.log`。没有放宽生产载荷校验。最终源码的类型检查由完整 build 覆盖。
- 按 React 检查清单复核取消默认焦点、组件清理、异步状态及权限/旧计划门禁。没有 Rust 源码变更，不宣称重跑原生全量或严格 Clippy。

最终结果见 [validation.json](../assets/hcd-resource-repair-2026-10-30/validation.json)。

## 实际普通浏览器和文件

本机独立 r8 fixture 的生产编辑页导出含一份 6 MiB 合成附件的恢复包。首次普通恢复生成确定性任务，再由可见测试按钮注入同长度零字节损坏；之后的字节还原完全使用产品“确认替换”按钮，**没有点击测试还原控件**。

实际页面验证明确完整性提示、检查及摘要、下载损坏副本、默认取消焦点、取消保持原损坏字节、再次检查与确认、产品任务下载、单独正常合并和修复后的恢复包导出。任务始终只有一份，先前取消的初始选择没有复活。然后再次注入损坏，第一窗口打开确认时由同账号第二普通窗口取消任务；第一窗口的旧确认被拒绝，任务保持不存在，规范 head 仍为 r8。

`repair-observations.json` 是可见核对控件的实际下载，含创建恢复、损坏、取消确认、产品修复、正常合并及跨窗口终态的九次观测。两次故障注入均有明确测试标签，既不生成正文，也不伪造 UI 步骤。

[独立文件回读](../assets/hcd-resource-repair-2026-10-30/files.json) 确认损坏下载为原 6 MiB 零字节，产品“下载原文件”与原恢复包及修复后导出的资源字节一致。修复前后两份恢复包的 canonical HCDZ 均可解包和 validate，38 个规范文件逐字节等于 live r8，正文、历史和资源没有被附件修复改写。本例附件目标是合成占位，仅验证私有任务修复，不冒充真实节点关联或 Office 附件导出验收；第二场景最后明确取消该任务，不把最终任务数零误报为修复丢失。

截图：[替换确认](../assets/hcd-resource-repair-2026-10-30/repair-confirm.png)、[修复后尚未合并](../assets/hcd-resource-repair-2026-10-30/repaired-before-merge.png)、[另一窗口取消后拒绝](../assets/hcd-resource-repair-2026-10-30/cross-window-cancel-refused.png)。

## 复验与边界

```sh
python3 scripts/hcd-inline-editor-preview.py --enable-native-field
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-resource-import-integrity-fixture.mts /absolute/owned-root
# 在普通 UI 导出本轮 original.hcd-recovery 后：
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-resource-import-repeat-fixture.mts /absolute/owned-root /absolute/original.hcd-recovery
# 完成上述实际 UI 步骤并独立保存本轮下载后：
python3 scripts/hcd-resource-repair-files.py /absolute/owned-root
```

回读脚本仅检查本批命名的合成文件及实际记录，不能用于任意用户文档或混用不同 fixture 的证据。私有配置和临时服务清理记录、凭据扫描见 validation。

任务结构/长度本身损坏而无法读取设备日志的情况、区域 Word 设备库、跨文档/跨设备、永久存储故障及长文件性能继续开放。该流程仍需要当前服务验证恢复包；文件可离线读取不等于应用完整离线启动。Excel 首次落盘崩溃窗口、Word 分页/目录、PPT/PDF 完整创作、字体国际化、真实 AI 和多实例等原清单保持。
