# 停房 Word prepared 恢复与旧编号迁移验收

后续增量：停房两类原请求已共库原子准备，实际双窗口、旧库迁移及正常取消/续存验证见[原子设备准备](hcd-word-stopped-atomic.zh.md)。下文跨类型未原子的说明保留为本批当时边界。

日期：2026-10-30。此批延续[停房结构原请求](hcd-word-stopped-topology-device.zh.md)，补上服务器已准备但未提升的恢复，以及两个不同旧编号与重复副本的普通浏览器验收。整体各格式目标继续；管理平台与提醒发送后置。

## 这次补齐的行为

- 结构请求的确认或取消提示绑定原 transactionId。设备队列推进到另一条请求时，不再沿用上一条结果；队列清空后仍可以显示刚完成请求的结果。
- 确认提示说明“保存于版本 rN”，避免将原请求的固定确认版本描述为可能已经前进的当前 head。
- 原生故障代理可在提交前阻止发送，或在原生已提交后丢弃成功回执并暂时阻止恢复。仅自有本机夹具配置能启用；记录操作种类、编号、版本、请求摘要和结果，不记录凭证或认证头。
- 受控旧标签页入口通过可见按钮写入本批实际下载的旧编号，不补造参数。不同编号排队，相同编号去重；旧编号仍不能直接重试原 apply。

React 复核沿用 `vercel:react-best-practices`：结果显示直接按当前编号推导，不依赖 effect 清理的时序；保持异步操作中止、权限门禁和队列 CAS。没有更换 UI 技术栈或扩大服务端权限。

## 实际浏览器与服务结果

样本为本机普通嵌入入口、真实侧车/原生服务与签名合成 Bob 草稿。原始文档两节，含图片，初始规范版本 r1。使用新原生代理的隔离夹具，非线上数据。

| 场景 | 故障及操作 | 已核对结果 |
| --- | --- | --- |
| 页面已 prepared，原生尚未提交 | 第 1 节 Letter 改 A4；原生代理提交前阻断；关闭页、重启侧车后下载与检查 | 原始完整请求字节相同；检查不新建操作；按原编号恢复到 r2。阻断请求与成功请求的原生摘要相同，仅一次成功提交 |
| 页面恢复成功，最终回执丢失 | r2 恢复响应被 UI 代理丢弃，自动重试被阻断；关闭页、再重启侧车 | 原 layout/resume 动作链完整保留且下载相同；明确检查确认原 r2，未再次提交布局 |
| 原生页脚已提交，侧车未收到回执 | 第 2 节偶数页独立页脚原生提交 r3 后丢回执；关闭页、重启侧车 | 原始请求字节相同；按原编号检查 prepared 状态和影响后恢复。只读取签名回执，不再次发出原生 story 创建事务 |
| 未发送的页脚请求取消 | 第 1 节偶数页页脚在 UI 代理转发前被阻断；重开后取消 | head 仍 r3；迟到原 apply 返回 409 / `word-topology-cancelled`；未创建第 1 节偶数页页脚 |
| 两个旧编号和重复副本 | 分别迁入已确认 story 编号及已取消编号，再迁入 story 的重复副本 | 队列保留两条；重复不增量。原编号下载没有伪造原参数；确认首条只移除首条，明确取消处理第二条 |
| 下一条请求的状态 | 修复前实际复现上一条 r3 确认残留；修复后重新迁入并分别验证确认/取消后推进 | 下一条仍待核对时没有旧成功/取消提示；其他同账号窗口同步移除完成记录 |
| 协作者草稿续存 | 三次侧车重启与结构恢复后，新窗口比较并明确保存 | Bob 的 `Shared draft from Bob` 仍在，保存 r4，实际版本作者仍为 Bob；第 1 节 A4、第 2 节新页脚保留 |

原生元数据只记录一次成功 layout 和一次成功 story 提交。旧编号检查使用当前签名日志已知的原事务；不支持据此查询服务器任意历史编号。

## 实际文件回读

[`file-readback.json`](../assets/hcd-word-prepared-recovery-2026-10-30/file-readback.json) 来自实际文件校验脚本，核对：

- DOCX r2/r3/r4 的两节纸张字段、独立偶数页页脚关系及原图片字节。
- Bob 正文仅从 r4 出现，版本作者为 Bob；r2/r3 为 Alice 的原结构编号，取消编号未提交。
- HCDZ 解包、校验及 r1–r4 的 editor-state 完全一致。
- r4 DOCX 再导入后保留 Bob 正文及第 2 节偶数页页脚。

本批逐字节重开比较覆盖 layout、story 和追加 resume；取消下载重开一致性使用前一批的独立样本，不将本批未做的第三组比较标成通过。

## 验证与复现

最终结果见 [`validation.json`](../assets/hcd-word-prepared-recovery-2026-10-30/validation.json)、[前端测试](../assets/hcd-word-prepared-recovery-2026-10-30/frontend-tests.log)、[构建](../assets/hcd-word-prepared-recovery-2026-10-30/build.log)和[30 项专项](../assets/hcd-word-prepared-recovery-2026-10-30/focused-tests.log)。首次全量测试/构建因上轮执行中断未产生终态，单独保存为 interrupted 日志，不计作通过；随后检查原进程和句柄均已消失才重新执行。

```bash
python3 scripts/hcd-word-layout-browser.py --story-source --stopped --draft-only --allow-restart --topology-ui-proxy --native-topology-proxy
```

在夹具私有根使用 `native-topology-control`：`{"kind":"layout","mode":"block-submit"}` 或 `{"kind":"story","mode":"drop-success-block-recovery"}`。UI 代理的 `topology-ui-proxy-control` 可设 `drop-success-block-retry`。按上表在普通页面明确预览、确认、下载、关闭重开与重启；解除相应故障控制后继续原请求恢复。

```bash
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-topology-legacy-fixture.mts <隔离样本目录> docs/assets/hcd-word-prepared-recovery-2026-10-30
python3 scripts/hcd-word-stopped-topology-device-files.py <隔离样本目录> docs/assets/hcd-word-prepared-recovery-2026-10-30 --prepared
```

旧编号入口必须在本批实际 story/cancel 请求下载后生成，使用可见按钮逐个迁入。文件校验器读取已经发生的交互和文件，不制造浏览器过程。未传 `--prepared` 时保留前一批的校验方式。

![处理第一条后，第二条仍需独立核对，没有旧成功提示](../assets/hcd-word-prepared-recovery-2026-10-30/legacy-next-request-after.png)

归档完成后已确认本批服务进程消失、五个端口关闭，并移除唯一自有夹具根及私有凭证；证据含 ZIP/gzip 内部字节的当前凭证扫描无命中。中断后残留的三个失败本机标签页因工具获取句柄时触发内部错误页 URL 限制，未能由本轮显式关闭；没有绕过该限制。见[清理记录](../assets/hcd-word-prepared-recovery-2026-10-30/cleanup.json)。

## 继续开放

- 跨类型请求日志并非原子预留；真正同时发生的草稿/结构请求仍需独立浏览器验收。
- 历史私有草稿比较合并、结构/页面字段自身撤销、复杂区域资源复制、链接与正文混合的原稿保留导出、旧协议与旧 epoch 迁移。
- 精确分页、跨节连续排版、页码/自动目录、正文真实数据分段；完整 PPT/PDF/Excel 创作、字体/国际化、真实 AI 和多实例。
- IndexedDB 配额/驱逐、物理设备断电、跨来源/跨设备恢复、远端存储、生产部署和真实 Word/PowerPoint/WPS 均未由本机样本证明。受控旧存储不等于旧生产客户端验收。
- 本批未修改 Rust 或重建原生二进制；使用摘要记录的已有二进制。Rust 全工作区与 Clippy 未重跑，既有未通过项保持开放。
