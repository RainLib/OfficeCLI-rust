# 行内容器文档的协同版本还原（2026-10-27）

行内容器主编辑页沿用已有的历史正文、递归文本差异与确认对话框，开放本机 `inline1` 房间的整文档版本还原。还原追加新版本，保留之前全部历史和资源；不把文档模型降回旧的 structure3。管理平台与提醒发送继续暂缓。

## 事务边界

- 还原请求、私有侧车日志、原生持久意图和成功回执共同记录 `fromProtocol`。早期没有该字段的日志仍只解释为 structure3，不能根据当前模型推测成 inline1。同一请求 ID 改变模型或 epoch 会被拒绝。
- 行内容器还原及协商恢复要求显式声明 inline1、extension3、node-edit7、custom-marks1。原生回执重放也检查声明；客户端核对目标版本、请求 ID、新版本、新 epoch 和协议，错误成功回执按结果未知保留。
- 先冻结各写入窗口，等待本机日志和上传状态就绪，允许最后的协同包提交；再关闭房间入口、排空已接收包与写入、核对已保存版本和待处理状态，最后持久记录精确请求。房间必须与请求的模型、epoch 一致。
- 同伴忙碌时释放已准备的窗口。审阅后有新输入、版本变化或未保存候选时拒绝还原并保留内容。持久意图后的通信失败保留封锁，不重新生成另一个请求。
- 原生按目标不可变根追加一次版本，轮换 epoch 时保留 inline1 和 wire7；重试恢复 head/epoch 两次发布之间的崩溃。准备中的旧模型意图不能在新模型下写入。确认成功关闭旧房间，新连接从还原的规范版本重新初始化。
- UI 保留差异审阅和显式确认，默认聚焦取消。确认前再次保存、核对比较基线；未知结果只能查询同一请求结果。只读成员可查看历史，不能还原。

## 已完成的实际验证

前端新增 4 项测试，完整 1082 项通过；TypeScript、独立及嵌入构建通过。原生还原专项 3 项及服务端 49 项通过，Clippy 拒绝警告与相关 Rust 格式检查通过。

真实本地原生服务、生产侧车、两名 WebSocket 成员和 TCP 丢响应代理使用原始 r8 HCDZ 的独立副本：

1. r9 保存普通段落与行内容器内部修改；忙碌同伴拒绝还原。
2. 同伴在准备期间输入使原比较失效；保留后保存 r10。
3. 将目标 r8 追加为 r11，丢失原生成功响应，侧车保留准备日志。
4. 重启侧车，经 inline 协商恢复，原生重放完全相同的请求，没有追加额外版本。旧 epoch 请求返回 409，新房间的规范快照与 r8 完全一致，包括嵌套节点和内部正文。
5. 新房间继续输入、保存 r12。实际读回 9 份文件，包含还原前后历史 DOCX，以及还原后的 DOCX/PDF/PPTX/Markdown；HCDZ 离线 r8–r12 投影逐版本一致，归档附件字节和 SHA256 相同。

实际 CUA 浏览器另克隆这份归档：r8 与 r12 差异在文档区显示，确认对话框可取消；确认后生成 r13，并重新进入可编辑房间。继续输入“还原后继续编辑😀”保存为 r14。原生回读证明 r13 根和全部块与 r8 一致，r14 原三个块不变，仅新增测试段落；四种格式和 HCDZ 逐版本回读通过。缺少 `example.inline_field v77` codec 时，未知数据和嵌套内容仍完整保留。另一只读窗口读到 r14，历史还原按钮不可用。

截图、文件、日志、源码摘要和分层证据在 [验证目录](../assets/hcd-inline-revision-restore-2026-10-27/validation.json)。首次真实服务校验直接比较 PM JSON，因新房间临时结构键与纯规范投影不同失败；改为比较保存协议使用的完整规范快照后重新运行整个链路，失败日志保留。浏览器逐字输入曾中断，检查实际草稿后只补入剩余文字，最终 r14 原生回读通过。

## 复核命令

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
cargo test -p officecli --bin officecli hdoc_server::tests
cargo clippy -p officecli --all-targets -- -D warnings
cargo build -p officecli
python3 scripts/hcd-inline-revision-restore.py
python3 scripts/hcd-inline-editor-preview.py --bundle docs/assets/hcd-inline-revision-restore-2026-10-27/restored-history.hcdz
# 对上一步自己的浏览器副本完成 r13 还原和 r14 输入保存后：
python3 scripts/hcd-inline-restore-ui-files.py target/hcd-preview-runtime/hcd-inline-editor-qlhj7qrd
```

## 保持开放的范围

本轮只实现本机单侧车的行内容器版本还原。远程数据库/对象存储的共享还原事务仍返回不支持，未宣称多侧车、跨设备或生产验收。侧车恢复日志没有被包装成普通规范 HCDZ；离线候选、旧 epoch 草稿、跨文档资源/迁移仍沿用各自明确边界。

七阶段总体仍未完成。区域 Word 的完整排版、长文内部虚拟化、区域创建/设置/目录、其他模型恢复包和旧模型迁移，行内容器迁移提交、跨文档/跨设备流转，尚未完成的主页面资源/删除审阅与拖动/键盘/中文输入法场景，以及 AI 的实际服务验收等仍须逐项推进。此增量不能替代这些验收；管理平台与真实提醒继续不做。
