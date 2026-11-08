# 停房 Word 草稿与结构请求的原子设备准备

日期：2026-10-30。延续[prepared 恢复验收](hcd-word-prepared-recovery.zh.md)，处理两类原请求在不同设备库内“先检查另一类、再写入自己”导致的跨窗口竞争。整体格式目标、Excel/附件剩余保障和其他运行条件继续；管理平台与提醒发送不做。

## 行为与迁移

- 停房草稿保存与页面/页眉页脚请求使用同一 IndexedDB 数据库的两个槽。新保存、重基准及新结构准备在同一个 readwrite 事务中核对自己的 CAS 和另一槽；同时竞争只允许一类完整原请求落盘，落盘完成后调用方才能提交网络操作。
- 保留两类已有原请求时，签名核对、resume、取消及完成仍可逐条进行。原请求是证据，不是服务端结果或提交授权；原生版本和签名回执仍为权威。不在网络等待期间占用设备事务。
- 打开新库前，将两个旧库提升到版本 2，触发旧连接关闭。使用旧版本 1 的客户端后续打开失败，防止其继续写入已迁出的独立槽；不理解新库的旧页应更新/重开，不能默默继续提交。
- 旧库完整字节保留，不删除原件。新库在一次事务内写入两类原请求和旧字节摘要标记；取消/确认后重开时，匹配的旧标记避免已处理请求再次导入。
- 迁移失败时不发布部分新槽；旧连接拒绝关闭、配额失败、摘要变化均拒绝开放新操作。损坏但有界的旧证据仍可保留下载；它会阻止新的对侧请求。令牌不进入原请求或迁移标记。
- 原有 actor、文档、API/协作端点和 epoch 验证继续生效。这里没有提供跨账号、旧 epoch 自动合并或跨来源锁。

源码：[共用设备存储](../../examples/hdoc/editor/src/wordStoppedRequestStore.ts)、[草稿接线](../../examples/hdoc/editor/src/wordDraftAttempt.ts)、[结构接线](../../examples/hdoc/editor/src/wordLayoutAttempt.ts)。普通编辑页的页面/story/link 等其他队列没有因本批自动变成共库事务。

## 实际浏览器与文件证据

夹具为本机真实原生服务、实际侧车、普通内嵌恢复页及合成签名 Bob 草稿。竞争发起页为专用可见测试界面：两个独立浏览器窗口使用产品默认存储实现和服务端实际审阅参数，同时调用准备。它不冒充普通产品中的两个同时点击步骤，也不发送 apply/save。

| 场景 | 已验结果 |
| --- | --- |
| 两个真实窗口同时准备 | 草稿获准，页脚得到 `word-layout-other-request-pending`；仅一条完整原请求，规范 head 仍 r1 |
| 普通入口读取 | 下载的草稿原请求与竞争窗口完全相同；新的页面/页脚操作被禁用 |
| 关闭重开、侧车重启 | 新窗口下载原请求字节不变；重启不触发自动提交 |
| 普通入口取消 | 原编号取消后释放槽；迟到原保存被 HTTP 409 拒绝，head 仍 r1。HTTP 实际错误码为 `restore-or-migration-rejected`，不是内部 `word-checkpoint-cancelled`；核对了取消封存文件 |
| 后续两种操作 | 普通界面创建第 1 节偶数页独立页脚到 r2，再明确保存 Bob 草稿到 r3；两类槽均可正常释放和复用 |
| 旧库真实迁移 | 另一成员范围中保留两类实际审阅的旧请求，保持两个旧连接打开；当前产品迁移后原请求逐字节一致，两个旧连接均不能再读写 |
| 迁移后恢复 | 普通恢复页同时显示两类旧请求；可逐个取消。关闭重开两类请求面板均为零，新结构操作可用；head 仍 r3，未重新导入旧请求 |

旧库样本是受控存储与旧存储适配器，不是旧生产客户端的完整运行验收。迁移后取消/重开证明已完成标记不会复活原请求，不证明浏览器驱逐或物理设备损坏后的恢复。

实际文件检查见 [`file-readback.json`](../assets/hcd-word-stopped-atomic-2026-10-30/file-readback.json)：DOCX r1/r2/r3、页脚 part/关系、纸张字段、Bob 正文及作者、原图片字节；HCDZ 解包校验与 r1–r3 editor-state 完全相同；r3 DOCX 再导入保留正文及页脚。竞争与迁移的原请求均未伪装成规范版本。

![两个真实窗口竞争，仅一类完整原请求获准](../assets/hcd-word-stopped-atomic-2026-10-30/two-window-race.png)

## 验证与复现

完整前端 **1997 项**、相关 **32 项**与含 TypeScript 的独立版/嵌入版构建通过。新增九项设备事务回归覆盖竞争、两类旧队列、旧版本写入拒绝、迁移和准备配额失败、损坏原件、同类 CAS、旧摘要变化及旧连接拒绝关闭。原有第三方 `use client` 和大包警告保持。

```bash
python3 scripts/hcd-word-layout-browser.py --story-source --stopped --draft-only --allow-restart
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-stopped-atomic-fixture.mts <隔离样本目录>
```

打开输出的控制页和两类窗口，等待两者就绪后点击同时准备；下载结果和获准原请求。从普通恢复页下载、关闭重开、通过夹具控制文件重启侧车，再下载/取消。正常创建页脚并保存协作者草稿。旧库入口使用另一成员范围，在迁移前保留两类请求和连接，下载迁移结果后从普通页逐条处理；重开核对无请求复活。

```bash
python3 scripts/hcd-word-stopped-atomic-files.py <隔离样本目录> docs/assets/hcd-word-stopped-atomic-2026-10-30
```

文件脚本读取实际下载、版本及文件，不制造浏览器步骤。首次迟到保存探针错误地期待内部错误码，已按实际 HTTP 包装码修正；两次调用均被拒绝，没有规范版本变更。

最终记录：[validation.json](../assets/hcd-word-stopped-atomic-2026-10-30/validation.json)、[全量测试](../assets/hcd-word-stopped-atomic-2026-10-30/frontend-tests.log)、[专项](../assets/hcd-word-stopped-atomic-2026-10-30/focused-tests.log)、[构建](../assets/hcd-word-stopped-atomic-2026-10-30/build.log)、[迁移原件对照](../assets/hcd-word-stopped-atomic-2026-10-30/legacy-migration.json)。

## 保留的边界

这只协调同一来源、成员、文档和端点范围内的停房请求，不构成跨设备或分布式锁，也未统一所有正常编辑队列。旧数据库原件仍占用设备空间；超大损坏数据、系统配额/驱逐、真实断电、未知旧客户端及外部写入仍需单独验收。测试中的 quota/blocked 为受控模拟。

历史私有草稿合并、结构自身撤销、复杂资源复制、原稿混合导出、分页/页码/动态目录、正文分段及完整 PPT/PDF/Excel 能力继续。Excel/附件、字体/国际化、真实 AI、跨设备和多实例不因本批而完成。

本批没有 Rust 修改或原生重建，未重跑 Rust 全工作区/Clippy；使用记录摘要的既有二进制。没有生产、远端 PostgreSQL/S3、物理设备或外部 Office/WPS 验收。

本批验证窗口已关闭，自有服务及端口停止，唯一夹具私有根和凭证已移除。证据及 ZIP/gzip 内部字节的五项当前凭证扫描无命中，见[清理记录](../assets/hcd-word-stopped-atomic-2026-10-30/cleanup.json)。
