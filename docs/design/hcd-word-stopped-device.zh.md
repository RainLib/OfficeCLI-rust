# Word 停房草稿原请求与本机恢复

后续增量：停房页面与区域结构请求现也已替换为完整设备记录，详见[结构请求与最新边界](hcd-word-stopped-topology-device.zh.md)。下方“仍仅保存标签页编号”是本批当时的状态，不覆盖后续结果。

2026-10-30。接续[正常页面设备请求](hcd-word-page-device.zh.md)，将兼容性恢复页的停房草稿操作从标签页编号改为 IndexedDB 完整操作记录。本文只描述本批增量；各格式创作、Word 排版、字体、真实 AI、多实例等完整目标保持开放，管理平台和提醒仍后置。

## 当前实现

- `WordDraftAttempts` 按文档、成员、服务端点、协议及 epoch 隔离，保存检查点编号、执行人和用户明确确认过的 save / resume / cancel / rebase-stale 操作及原参数。记录不含 token，不赋予服务端提交权限；原生签名和私有日志仍是权威。
- 保存先等待 IndexedDB 事务提交，再发送原请求；跨窗口比较替换不允许覆盖另一未知请求。完整队列最多 16 条、1 MiB，单条最多 64 KiB、16 个动作；超限和存储失败保留原记录并阻止新操作。
- 旧 sessionStorage key 仍可识别：有效编号迁入 `legacy` 动作，不伪造旧版没有保存的 reviewHash、版本或取消意图。不同编号分别排队，完全相同的原记录去重；成功提交且旧值未变化时才清理旧值。损坏证据可下载，不能据此发起新保存或自行丢弃。
- 本机操作记录可实际下载；同源窗口通过通知重新读取，完成或取消只有在核对同一编号和有效响应后才移除。关闭重开不自动执行保存、恢复或取消。
- 成功保存响应现在携带 checkpointId，浏览器核对确切编号、版本及 saved 字段。检查旧保存仍核对服务端签名回执，不把本机记录当作完成证明。
- 页面初次加载设备日志时，保存和页面/区域结构操作保持禁用，不把“仍在加载”显示成“身份损坏”。取消结果未知时显示专用文案，明确重试同一取消，不重新保存。

设备队列的有界解析、迁移和 CAS 已抽成共享模块，正常页面请求沿用原 schema 和边界。Hook 在卸载时关闭日志、取消后续步骤，迟到的已提交设备写入仍保留供重开核对。

## 实际浏览器与文件证据

使用 `hcd-word-layout-browser.py --stopped` 停用布局房间，通过普通 `EmbeddedHcdEditor` 的鉴权/协商失败进入兼容恢复页，没有直接挂载内部恢复组件。原生服务、sidecar、IndexedDB、下载及文件导出均为实际实现；文档、成员和故障由隔离夹具构造，浏览器操作使用 CUA。

1. **保存成功丢响应**：比较 Bob 的签名保留草稿并明确确认；服务端提交 r2 后代理丢弃成功响应。浏览器自行重发同一 POST，被旧 reviewHash 拒绝，没有产生第二个版本。原请求可下载。
2. **关闭与重启**：关闭原标签页、重启 sidecar，再用新标签页打开。下载文件与原件逐字节一致；未自动发起保存。手动检查原请求后确认原 r2，并清除本机待确认记录。
3. **取消成功丢响应**：无竞争归档的样本在转发前阻止保存。两个同成员窗口看到同一编号；取消意图先保存至设备，再由服务端封存编号。代理丢弃成功响应并阻止浏览器自动重试。
4. **重启后继续取消**：关闭两个窗口并重启 sidecar，新窗口仍显示原保存和取消动作，下载与重启前逐字节一致，版本仍 r1。显式重试原取消成功，另一同成员窗口也清除记录并解除门禁。
5. **拒绝迟到保存**：用下载记录中的原参数直接重放原保存，sidecar 返回 409，规范版本仍 r1。重新比较、确认后以新编号正常保存 r2；双方窗口不再显示待确认请求。
6. **实际文件**：两条成功样本分别导出 DOCX，正文中 Bob 的文字恰好一次，原图片字节及页面几何保留；r2 原生记录仍归属 Bob。HCDZ 实际打包/解包、r1/r2 编辑投影精确比较、原生校验及 DOCX 再导入均通过。

首次取消样本包含另一份未处理的签名恢复归档，服务端拒绝取消并保留请求；没有把它计为取消成功。该拒绝证据单独保留，之后的成功样本使用 `--draft-only`，不绕过归档检查。正常创建/链接/页面请求之前的浏览器证据仍属各自批次，本批没有重跑所有格式交互。

证据目录：[实际请求、网络与文件回读](../assets/hcd-word-stopped-device-2026-10-30/validation.json)。

## 验证命令

```bash
cd examples/hdoc/editor
node --import tsx --test src/wordDraftAttempt.test.ts src/wordPageTransaction.test.ts src/wordStoppedDraftRecoveryClient.test.ts src/wordCheckpointRecoveryClient.test.ts
node --import tsx --test --test-concurrency=4 src/*.test.ts
npm run build
```

最终相关专项 35 项、完整前端 **1975 项**通过，包含设备存储拒绝、并发窗口 CAS、旧编号迁移/配额失败/迁移期间变化、异步刷新竞态、关闭后提交保留、动作上限和初始加载门禁。含 TypeScript 的独立/嵌入构建通过；仍有大包体积提示。

浏览器复现分别启动：

```bash
python3 scripts/hcd-word-layout-browser.py --story-source --stopped --allow-restart --topology-ui-proxy
python3 scripts/hcd-word-layout-browser.py --story-source --stopped --draft-only --allow-restart --topology-ui-proxy
```

仅操作脚本创建的隔离目录。该目录中的 `draft-ui-proxy-control` 可设置 `drop-success`、`drop-success-block-retry` 或 `block-submit`；写操作控制不拦截只读 inspect。侧车重启通过该目录的 `restart-sidecar` 文件触发。成功样本的实际下载件放入证据目录后，分别运行：

```bash
python3 scripts/hcd-word-stopped-device-files.py <保存样本隔离目录> docs/assets/hcd-word-stopped-device-2026-10-30 save
python3 scripts/hcd-word-stopped-device-files.py <取消样本隔离目录> docs/assets/hcd-word-stopped-device-2026-10-30 cancel
```

文件脚本只验证已发生的浏览器操作和实际文件，不替代交互步骤。恢复页的 React 复核使用既有 `vercel:react-best-practices`，重点检查设备异步加载、卸载、原请求门禁、外部订阅及取消结果。

## 仍未完成的范围

- 停房**页面及区域结构**操作的 `wordLayoutAttempt.ts` 仍只在 sessionStorage 保存编号；不能由本批草稿操作推断其已支持完整跨标签页持久化。
- resume 和 rebase-stale 已记录完整动作且有受控测试；本批没有实际浏览器故障注入其恢复链路，不声称关闭重开后的历史草稿重基准已全面验收。
- 旧版仅有编号时不能重建原比较参数；服务器当前检查点身份接口也不是任意历史编号查询接口。无法核对的历史证据保留，不自动合并或丢弃。
- 下载原请求不是包含正文/附件的完整恢复包，也不能凭它跨账号、服务、文档或旧 epoch 自动提交。浏览器清理、真实断电、不同物理设备、真实网络和生产多实例均未由这些样本证明。
- 本批未改 Rust、未重建原生二进制，未重跑完整 Rust/Clippy；使用验证记录中有摘要的已有本机二进制。此前的 Clippy 未通过项继续开放。
- 精确分页、连续排版、自动目录、区域结构历史、复杂原稿混合导出和各格式完整创作等原目标继续推进。
