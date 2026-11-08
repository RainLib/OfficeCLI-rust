# 行内容器内人员提及的改绑与冲突处理

2026-10-27。继续原七阶段目标。管理平台不做；关联事件仍只保留协议，不投递提醒。

## 本轮修复

主页面已能在行内容器内插入人员，但 `reference.retarget` 的动作状态仍只允许 structure3，导致新版 inline1 页面看得到“更换人员”入口却无法完成执行。同时，旧引用权限检查仅识别富文本块容器，直接调用冲突命令可能绕过未知行内容器的保护。

- inline1 与 structure3 共用人员改绑命令；人员候选继续来自服务端。
- 改绑、选择完整冲突候选和保留规范版本目标，都检查提及所在位置的全部外层容器。普通富文本块使用普通 registry；每层行内容器使用当前 inline registry。
- 任意一层缺少 codec、codec 注销、只读或提及类型不是人员时拒绝写入。不能只检查最内层，或用全局已选中的节点作为该提及的授权。
- “保留已保存目标”在每次异步读取后再次检查外层 codec，注销后不能接受迟到的规范值。
- 保留原 `mentionId`、永久正文载体和来源身份；目标与姓名快照仍作为一个完整值参与因果合并，不将不同人的 ID 与姓名拼接。

接口新增的 inline registry 参数是可选的，旧普通结构调用保持兼容；没有提供 inline registry 时，嵌套行内容器默认不能被修改。

## 检查与真实服务

新增 4 项针对嵌套正文、同伴编辑、个人历史、缺少任意外层 codec、注销、过期期望值、完整候选及异步规范恢复门禁的测试。相关专项 27 项、最终全量 **1087 项**前端测试通过；TypeScript、普通构建和嵌入构建全部终态成功。构建有既有依赖的 `use client`/包体积提示，不影响退出状态。没有原生 Rust 代码改动。

独立复制已有 r26 测试 HCDZ，创建 `hcd-inline-editor-riw31kza`，没有操作原先仍有待处理附件的 `qlhj7qrd` 房间。通过实际原生服务、生产 sidecar 和双鉴权 WebSocket：

1. Alice 与 Bob 离线改绑同一个二层嵌套提及，分别选择 Alice 和 Carol；Bob 同时增加正文 `Socket peer `。
2. 重连保留两个完整候选和同伴正文；协调保存返回 `reference-drafts-conflict`，head 保持 r26。
3. Alice 明确选择 Carol 后保存 r27。保存的路径仍为 `[0,1]`，同一 `mentionId` 只有一次 `reference.retargeted` 事件，可信执行人是实际解决冲突的 Alice。
4. 个人撤销只撤销解决动作，重新打开候选并阻止保存，head 不变。重做解决后保存仍为 r27，没有多建版本；同伴正文保留。
5. 独立新连接读取与已提交投影一致。该 Socket 驱动使用生产引用命令和模型协调，没有浏览器 DOM，不能替代页面交互验收。

## 实际主页面与文件

浏览器在独立房间打开 @Carol 人员详情 → 文档引用 → 更换人员。已知二层行内容器的入口可用；四处未知 v77 容器内的入口禁用。候选由服务端返回 Alice、Bob、Carol。

实际选择 Alice 时控制工具回报超时，未重复点击。原生已经保存 r28；新页面重开明确显示“已保存 r28”，提及为 @Alice，`Socket peer `、原加粗 `es`、同伴段落和其他节点保留。r27 → r28 的规范差异仅为该提及的目标、姓名快照与派生显示文字，事件执行人仍为 Alice。

实际导出 r27/r28 的 DOCX、PPTX、PDF、Markdown，检查可读目标和正文。HCDZ 重开 r26/r27/r28 投影逐一一致，容器 envelope、已有资源与原始字节保留。语义输出保留可读内容，业务关联和不透明附件仍以 HCD 为准，降级警告已归档。验证没有改变源 bundle。

证据、构建/测试日志及文件位于 `docs/assets/hcd-inline-reference-retarget-2026-10-27/`，包括 `socket-evidence.json`、`references-r27.json`、`references-r28.json`、两份文件回读记录和 `reopened-r28.png`。

可重复的只读文件验证：

```bash
python3 scripts/hcd-inline-reference-files.py target/hcd-preview-runtime/hcd-inline-editor-riw31kza
python3 scripts/hcd-inline-reference-files.py target/hcd-preview-runtime/hcd-inline-editor-riw31kza --browser-revision 28
```

Socket 驱动 `scripts/hcd-inline-reference-retarget.mts` 为明确的一次性隔离验收，起点必须为 r26；已完成的 r28 房间不要再次作为写入起点。

## 仍未完成

旧附件恢复房间的明确关联/复存、主页面删除审阅与迁移、完整 IME/键盘可访问性、跨文档/跨物理设备、长文/分页、区域 Word 追加基础能力及原七阶段其他开放项继续。该房间的浏览器个人撤销与实际侧栏冲突选择尚未单独点击验收，当前个人历史/冲突证据来自组件及真实双人 Socket。控制超时后的页面响应问题还需继续调查，不能仅凭本轮改绑成功推断所有交互流畅。
