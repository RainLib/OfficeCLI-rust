# 结构编辑：重复字符输入的真实位置与协同锚点

2026-10-26。完整七阶段目标继续，管理平台和实际提醒发送仍后置。本批修复当前活动结构编辑器的普通文字事务位置，不启用尚未完成的可编辑行内容器房间/SDK。

## 问题与修改

原来的文字流通过最终文本的公共前后缀推断修改范围。例如原文 `P😀`，在开头插入 `PREFIX`，最后显示为 `PREFIXP😀`：整段 diff 可以保留最前面的旧 `P`，在它后面插入 `REFIXP`。可见文字相同，但原字符身份从应在偏移6的位置误留在偏移0；原光标、迟到同伴输入和保存中的来源回执会跟到错误位置。

现在活动 PM 结构绑定从单个、关闭 slice、同一段落的 ReplaceStep 提取 `{key,from,to,insertedSize}`，并允许配套的格式/来源 mark 修复。结构计划在分配和修改任何共享数据前验证根归属、UTF-16边界、目标长度及范围外的保留值；写入组合文字流时按真实区间修改，来源与光标继续绑定原 Yjs item。

提示是进程内的事务信息，不写入文档、不充当权限、不增加协同 wire 字段。普通文本、emoji和已合并的多载体文字流可以保留真实位置；独立的格式变更仍按现有差异处理，不重发未修改格式。

校验只能证明某个操作可生成当前目标文本；在重复字符中，两个不同操作本来就可能得到同样文本。因此不能用最终文本猜测提示是否是用户的真实操作，真实位置必须来自 PM 事务。负例测试明确区分非法边界/过期目标和另一个同样合法的插入位置。

## 当前覆盖与保留路径

| 情况 | 行为 |
| --- | --- |
| 单个同段关闭 ReplaceStep，删除范围仅普通文字 | 使用真实区间，支持插入/删除/替换及格式修复 |
| 非法位置、半个 surrogate、目标不符、重复根提示 | 预检拒绝，原共享字节不变，不先分配新块 |
| 已合并的多个永久载体 | 在组合文字流的实际区间写入，原 carrier、书签保留 |
| 多次 ReplaceStep、拆段合并、开放 slice、结构变更 | 保留既有结构/文字流处理，不猜测为一次替换 |
| 删除范围包含 atom | 保留既有 atom 删除/字符保留逻辑 |
| 未来可编辑行内容器模式 | 不接受此平面位置提示；须先补正文内位置与结构预分配等配套逻辑 |

来源回执的真实字符范围测试直接检查 `sourceLeafActions`；完整编辑器随后可以按该段落自己的规范默认来源补写新输入，这是原有编辑行为，不能把它误当作旧字符范围已包含新输入。

## 验证

新增13项回归，相关结构绑定/文字流共57项，完整前端720项通过，TypeScript和独立/嵌入构建通过。覆盖：

- 保留旧整段 diff 的可复现歧义负例，对照真实插入/重复删除/替换的原始 item ID。
- UTF-16/emoji、合并载体和相对书签、独立格式、非法提示/目标不符不改字节。
- 两种 client ID/update 顺序下，真实 PM 绑定将离线同伴输入放到原 `P` 后面，双方收敛；自己的撤销/重做保留对方内容。
- 保存途中到达的来源回执仍绑定旧字符；错误提示在另一个新块分配前拒绝。
- 多步事务、拆分和结构操作不误用平面提示。

实际本机验证使用配套 Rust API 和 Hocuspocus sidecar（wire7），不是模拟网络：

1. Bob离线，Alice通过同一 PM 结构绑定在 `P😀` 前输入 `PREFIX`，保存r2；原 `P` 保留身份并位于偏移6。
2. Bob在旧文档的原 `P` 后输入 `Peer`，重连保存r3，结果为 `PREFIXPPeer😀`。
3. Alice自己的undo/redo保存r4/r5；Bob自己的undo/redo保存r6/r7。一直恰好两个根、顺序/原字符身份不变。
4. 每次从真实 native 持久 Yjs 文件创建新 Doc，验证字符位置、HMAC回执和规范摘要。r2–r7六次首次 checkpoint 均200。
5. 带输入事件记录的两个浏览器窗口加入r7，没有输入事件、没有自动新段落或提交。显式选择目标段落后，Alice再插入一个重复 `P`，保存r9；undo r10；redo r11。第二个窗口同步可见。持久原 `P` 偏移分别7/6/7，签名和规范一致。
6. 原生严格比较 `r3.blocks == r5.blocks == r7.blocks == r10.blocks`、`r9.blocks == r11.blocks`，包括来源ID；浏览器实际下载r11 DOCX并回读正确。
7. 无源HCDZ打包/解包逐份r1–r11精确；实际DOCX/PPTX/PDF/Markdown文件回读文字正确。含浏览器准备修正r8在内，十条native checkpoint全部200。

证据见[验证摘要](../assets/hcd-text-splice-2026-10-26/validation.json)、[真实双端连接](../assets/hcd-text-splice-2026-10-26/socket-evidence.json)、[实际文件](../assets/hcd-text-splice-2026-10-26/file-evidence.json)。

```bash
cd examples/hdoc/editor
node --import tsx --test src/semanticTextSplice.test.ts src/semanticStructureBinding.test.ts src/semanticTextFlow.test.ts
npm test
npm run build
cd ../../..
# 先创建独立预览，并保持进程运行；脚本只打印root和无凭证地址：
python3 scripts/hcd-mention-preview.py --runtime-dir target/hcd-preview-runtime --source-html target/hcd-preview-runtime/text-splice-input/source.html --pages-prefix .hcd-splice-socket --checkpoint-probe
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-text-splice-socket.mts <该预览root>/private.json
# 当前文件审计包含浏览器r8-r11及实际下载，仅在对应流程完成后运行：
python3 scripts/hcd-text-splice-files.py <该预览root>/private.json
```

复现用HTML内容为 `<p>P😀</p><p>协同位置验证</p>`。浏览器下载需置于证据目录的 `browser-r11.docx`。输入事件记录仅用于自有临时测试页面，未引入生产监控或读取编辑器内部状态。

## 测试修正与仍待查明的记录

首轮测试把另一个合法的重复字符插入位置误当成非法提示，并将完整来源默认值修复与纯字符范围绑定混在一个断言中。修正测试前提后通过，没有更改冻结签名规则。

第一份浏览器QA夹具中，选区/键盘定位试验曾把前缀加到文末；还观察到一次段落移位和两个额外空段落。该夹具r1–r5已保留为[排除记录](../assets/hcd-text-splice-2026-10-26/excluded-browser-attempt.json)，未记录事件来源，不能归因产品、工具或用户，也不计入无干扰协同验收。独立真实socket运行和新带事件记录的双浏览器加入未复现这些结构变更。原因仍未证实，不宣称已修复该额外现象。

最终浏览器复测中，准备定位时在第二段输入的一个 `P` 形成r8，随后撤销，再明确点击首段完成r9；r8保留，没有当作目标插入成功。事件记录与规范版本分开核对。首次文件审计把 `.hcd-write-lock` 也纳入“文档字节不变”，但每次获取互斥锁会写入PID/时间戳；现明确排除此运行时文件，manifest、全部版本与内容对象仍逐字节检查。

## 后续

多步/IME事务的精确位置、非叶行内正文提示、结构预分配、完整来源清理/签名回执、属性/复制/删除与配套协作继续。大段落每次输入仍有全文扫描，尚未做本轮长文本延迟/容量验收；不把懒加载框架或本次短段落测试当作容量通过。未修改Rust，不重复计入旧native单元测试。实际Office应用、PDF视觉布局、生产/服务重启、管理平台与提醒投递均未据此完成。


后续更新：活动模型的多步纯文字事务、程序化组合输入和相同可见文本的身份替换已在[多步文字操作](hcd-multi-step-text-edits.zh.md)补齐并做真实socket/native及实际文件验证。上文的多步回退和未验收说明记录本批当时的范围；实际操作系统输入法和可编辑行内容器仍未据此完成。
