# 附件恢复导入的字节完整性（2026-10-30）

后续已接通普通恢复面板的独立检查、下载损坏副本及明确确认替换，实际产品按钮与跨窗口取消验收见[附件确认修复](hcd-resource-repair.zh.md)。下文本批“测试控件还原”保留为当时证据，不再代表唯一恢复路径。

本批继续保存和恢复一致性。普通语义及 inline1 的私有附件导入现核对实际字节，避免同长度损坏被当成重复恢复成功。管理平台、字体后台和实际提醒继续后置；本批不代表完整 HCD 目标完成。

## 缺陷和处理

原 `NodeResourceMetadata.importNodeResources` 只校验描述结构和同编号元数据。输入字节与声明摘要不一致，或设备内已有同编号、同长度但内容损坏的任务时，仍可能通过导入或去重。

现在先限制批次数量和总大小，同步捕获全部元数据及独立字节快照，再在 IndexedDB 写事务外核对 SHA-256。全部输入核验通过后，在同一写事务内读取当前任务并检查重复项的实际字节；任何不一致拒绝整批，不先插入其他新任务。已经取消或关联的终态继续优先，摘要等待期间的取消不能被迟到导入复活。没有自动覆盖或删除损坏的设备副本。

附件摘要共用 `recoveryDigest`：普通 ArrayBuffer 的精确视图可直接交给 WebCrypto，SharedArrayBuffer 先复制。导入仍需保留独立输入快照；WebCrypto 内部也可能复制，因此这不是零拷贝或端到端性能改善承诺。现有 16 个任务、总计 64 MiB 的限制不变。

## 验证及首次失败

- 新增 8 项普通语义/inline1 真实设备存储 API 的受控测试，覆盖错误输入、已损坏的重复项、整批拒绝、幂等、终态、调用者修改和并发取消。这里使用 fake-indexeddb，不冒充浏览器或区域 Word 的独立设备库。
- 首次测试误把区域设备库当成支持 `importNodeResources`，留下 `initial-test-scope-error.log`；修正测试范围后，修复前的 6 项用例有 4 项失败，见 `before-tests.log`。
- 修复后首次全前端为 2005 项、2000 通过、5 失败。旧恢复测试的 `file(n)` 使用伪摘要，新增校验使场景在进入预期取消/并发路径之前被拒绝。改为计算真实摘要，未放宽生产校验或测试断言。恢复、设备日志、摘要及完整性相关 90 项通过，见 `transfer-tests.log`；最终完整前端 **2005 项全部通过**，TypeScript 检查通过，见本目录 `validation.json`。不使用旧 1997 项结果代表本批。
- 包含 TypeScript 的独立/嵌入构建成功，见 `build.log`。其后只修正上述 Node 测试 helper；最终类型检查另记 `typecheck-final.log`。本批没有 Rust 源码变更，不宣称重新执行原生全量或严格 Clippy。

## 实际普通浏览器与文件

使用原 r8 合成归档的独立副本和实际生产编辑器入口。先经普通恢复包导出下载含 6 MiB 未关联附件的 `original.hcd-recovery`，首次恢复建立产品生成的确定性任务编号。可见测试控件仅操作该附件任务，不提交正文或上传资源。

实际重复恢复按以下顺序验证：

1. 读取已恢复任务，只有一份且摘要正确。
2. 可见测试控件把这份任务改为同长度零字节；普通页面确认合并被拒绝，候选保留，设备内仍只有原损坏任务。提示为“附件复制可能已经完成，请先检查待处理文件再重试；文档尚未合并”。该通用提示尚未细分完整性原因。
3. 候选中的原始附件仍可下载，独立回读与原恢复包字节完全一致。
4. 仅通过测试控件还原注入的损坏字节，再由普通页面重试同一恢复包，显示操作完成；任务仍只有一份、摘要正确，取消的最初文件选择没有复活。**这是测试修复故障后验证正常重试，不是产品自动修复损坏文件。**

上一轮标签页在结束后已关闭，本批从同源持久设备库重新打开，重新完整记录上述重复恢复、拒绝和重试；没有把遗失的页面内存记录补造为证据。浏览器偶发输入派发超时后检查同一标签实际状态，未因观察超时重启服务或重复已经完成的操作。

`repeat-resource-observations.json` 为可见控件下载的五次实际观测。`scripts/hcd-resource-import-integrity-files.py` 读取这些记录及真实下载，验证附件 SHA-256、确定性恢复编号、拒绝后字节不变和成功后数量不变。恢复包内 canonical HCDZ 经 CLI 解包/校验，38 个规范文件逐字节等于服务端目录；manifest、root 和 head 均保持 r8。附件仍为未关联私有任务，不能宣称已进入正文或 Office 文件。

证据目录：[实际结果](../assets/hcd-resource-import-integrity-2026-10-30/files.json)、[拒绝界面](../assets/hcd-resource-import-integrity-2026-10-30/corrupt-repeat-refused-final.png)、[正常重试](../assets/hcd-resource-import-integrity-2026-10-30/retry-success.png)。复验需要该脚本限定的独立测试根仍在；清理后应新建 fixture 和重复浏览器操作，不能对任意文档直接运行。

```sh
python3 scripts/hcd-inline-editor-preview.py --enable-native-field
# 以下 root 为上一步打印的本次独立目录，不使用已清理的旧目录。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-resource-import-integrity-fixture.mts /absolute/owned-root
# 在普通 UI 下载原恢复包后，建立重复恢复的可见故障控件。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-resource-import-repeat-fixture.mts /absolute/owned-root /absolute/original.hcd-recovery
# 完成上述实际操作并保存下载和五次观测记录后回读。
python3 scripts/hcd-resource-import-integrity-files.py /absolute/owned-root
```

文件回读默认读取本批证据目录；新一轮应先独立保留原证据，再明确选择新下载，不可把不同 fixture 的任务记录混用。此次实际回读时脚本的根目录为固定本批路径，随后仅将根目录改为显式参数，并补充校验结果布尔断言；实际结果已为 valid。清理记录见 `cleanup.json`，不保留临时 token 或测试服务。

## 继续开放

大附件比较及最终逐字节重复核对仍可能形成主线程长任务。本机高负载和本次正确性样本不能证明性能收益。损坏错误的具体说明和安全处理交互、不同源/跨文档/跨设备恢复、无 Web Locks 窗口竞争、区域 Word 的资源覆盖、系统断电、多实例及完整离线应用继续验收。Word 分页/目录、PPT 对象创作、Excel 公式与结构、PDF 属性、字体国际化和真实 AI 等总体清单保持开放。
