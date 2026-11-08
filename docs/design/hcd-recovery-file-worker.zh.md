# 附件恢复：不可变文件直接交由 Worker 解析

2026-10-30。接续保存/恢复一致性和大附件卡顿清单，改进普通语义/inline1 的恢复包文件输入。管理平台和实际提醒继续后置；全部文档格式目标保持开放。

## 实现

原主页面先调用 `File.arrayBuffer()`，比较函数复制完整字节，再为 Worker 传输复制一次。现在 `RecoveryArchivePanel` 直接传递所选 File：Worker 读取文件、计算原始包 SHA-256、解析 JSON 和解码 Base64，仅把解码后的 canonical、协作状态和附件缓冲传回。包摘要继续用于既有文件恢复身份，不改变幂等规则。

程序调用的 Uint8Array 入口保持独立副本语义；两类输入共用 Worker 的创建、30 秒等待、取消、迟到结果忽略和终止。恢复包版本、保存协议和规范结构均不改变。

Worker 输出不是授权证明。主线程仍检查 envelope/scope/数量/大小、每份 binary 的独立摘要、当前服务权限和真实 canonical HCDZ、隔离 Yjs/schema 与资源清单、当前文档变化，最后进入明确比较/确认和个人撤销/协作保存。

取消不会触发稍后的回退读取或发布候选。Worker 不存在、启动/传输故障时保留兼容路径；数据无效、摘要缺失或错误不回退。**无 Worker 的兼容路径仍可能同步解析大 JSON；本次没有解决所有主线程长任务。**

## 验证与边界

- 最终相关前端 **104 项通过**，覆盖包解析、比较/确认/个人撤销、文件-only 恢复、资源完整性和修复、传输及取消；初版 62 项另留日志。首次类型检查发现摘要联合类型未收窄，修复后含 TypeScript 的独立/嵌入双入口构建终态为 0；初次失败保留，未跑完整前端套件。
- 两份各 6 MiB 文件、16,828,344 字节实际恢复包，经真实本机 canonical 检查和真实 Node Worker 线程执行生产 codec：包摘要、附件字节/摘要一致，解析期间调用方整包读取为零，线程终止，规范 head 保持 r8。将一个资源的 Base64 字节改坏后，Worker 解码仍由主线程独立摘要拒绝。见[实际线程/文件](../assets/hcd-recovery-file-worker-2026-10-30/worker-readback.json)。**不是浏览器 Worker、普通文件选择、浏览器性能或生产验收。**
- 普通 Chrome 嵌入页打开了恢复面板并加载隔离副本的最终代码。文件选择接口因扩展本地文件权限不足拒绝 `setFiles`，原生选择器又因屏幕捕获服务失败未启动；没有更改权限或通过浏览器脚本写入存储/注入候选。文件选择、比较、导入、下载和重开未算通过。见[面板状态](../assets/hcd-recovery-file-worker-2026-10-30/browser-panel.png)。观察超时后盘点并接续已创建标签页，没有盲目重复创建。
- 精确源码摘要、测试/构建及开放项见[验证汇总](../assets/hcd-recovery-file-worker-2026-10-30/validation.json)。本批没有 Rust 变更。

## 复验

```sh
# 仓库根，启动独立本机服务，先在打印出的正常 writer 页完成 inline1 协商。
python3 scripts/hcd-inline-editor-preview.py --enable-native-field
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-recovery-file-fixture.mts /absolute/owned/hcd-inline-editor-example
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-recovery-file-worker-readback.mts \
  /absolute/owned/hcd-inline-editor-example /absolute/owned/output
```

构造器只读取该隔离服务的 HCDZ/auth，写私有合成包，不提交文档、不写浏览器存储；目录断言和 private.json 身份检查限制到自建 fixture。Node 线程验证执行打包后的同一生产 Worker，并独立回读实际文件。不得将用户文档/凭证作为样例。

`scripts/hcd-recovery-file-profile.mts` 可向该自建预览副本安装可见诊断，记录 Worker 输入类型、主线程大文件读取和长任务；不改生产页面或文档/存储。未取得正常文件输入时，不能将空诊断或 Node 线程结果当作浏览器性能改善。

## 继续开放

正常浏览器大附件完整交互与性能、无 Worker 路径、Yjs 比较/序列化长任务、跨窗口/设备/身份恢复、区域设备库、全部格式保存/导出兼容。文件大小仍限 96 MiB、附件总量仍限 16 MiB；没有扩大资源上限或替代确认流程。
