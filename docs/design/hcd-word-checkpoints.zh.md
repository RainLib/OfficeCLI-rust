# 区域 Word checkpoint 服务端契约（2026-10-26）

新增 `POST /v1/documents/{id}/word/checkpoints`，为后续区域富文本协作准备显式协议。它不自动启用浏览器 CRDT 房间。既有 `/checkpoints` 对 flow 文档的拒绝仍保留。

请求必须使用 collaboration service 写令牌、当前协作 epoch、`X-HCD-Flow-Layout-Version: 2` 和 `coordinatorVersion: 5`。携带 coordinator/checkpoint/digest、expectedRevision、layoutHash、全部区域的 blocks/images、contributors 以及可选 typography/reference/extension 模型声明。所有 DTO 拒绝未知字段；每个正文节和 story 必须恰好提交一次，不能用遗漏区域表达删除。

服务端验证布局摘要、区域身份、节点/文本来源/图片归属、当前人员写权限和已有内联/扩展/资源协议，再产生原生 `hcd-patch/6` 分组补丁，一次提交所有区域。区域替换所有旧根时先建立新插入锚点。结构顺序规划共用已有 snapshot 逻辑，保留旧格式校验；重排使用索引链避免每步线性查找。

签名 `hcdsave5` 绑定规范化后的全部已接受请求字段、文档、基线版本与 epoch，不能以相同 client digest 隐藏正文、图片、布局或作者变化。精确重放可返回已提交收据，包括后续显式 restore 之后；不会回退当前 head。旧 epoch 仍拒绝。

验证范围：6 个区域 checkpoint 相关测试通过，全部 67 个 `hdoc_server` 测试通过，`cargo fmt --all -- --check` 与 officecli clippy 通过。证据在 `docs/assets/hcd-word-checkpoints-2026-10-26/`。这些是源码/原生测试证据，不是已启用的浏览器富文本协作或生产验收。

后续仍需实现 regional room 协议、Yjs 区域序列化、sidecar coordinator5、浏览器 hcdsave5 收据识别与恢复、真实并发网络及故障测试，再接入富文本节点、菜单和 AI。现有映射文本纸张编辑继续使用已验证的保存控制器。


后续进展：已完成 [区域富文本模型、事务绑定与提交准备日志](hcd-word-regional-collaboration.zh.md)，并以真实断流和两个 Node 进程验证原请求恢复及原生导出。该验证尚未启用 Hocuspocus 区域房间；完整 coordinator5、房间迁移及浏览器接入仍待完成。


协调器进展：已实现 [区域保存协调器核心](hcd-word-save-coordinator.zh.md)，真实接口验证签名 patch 核验、未知结果的原请求重放、作者代次和人员引用。Hocuspocus/浏览器 regional room 尚未激活，现有链路继续使用原协议。
