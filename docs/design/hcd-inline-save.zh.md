# 可编辑行内正文：内部签名保存与恢复（2026-10-27）

承接[精确 PM 事务绑定](hcd-inline-binding.zh.md)，本批接通 `SemanticSaveCoordinator` 的显式行内容器模式，并以真实鉴权 HTTP、断 TCP 响应和两个 Node 进程验证保存/恢复。它不是活动 Hocuspocus 房间、公开节点 SDK 或全部七阶段目标已经完成的声明。管理平台、提醒发送仍后置。

## 显式模式与兼容

内部宿主必须同时提供已初始化、属于同一 Y.Doc 的 body-aware `SemanticBlockStore` 和 `inlineContainers: 1`。仅提供新 schema 或载体不能隐式启用；未来/不匹配模型、旧模型签名基线拒绝。模式选择在构造时捕获，不能由后续宿主选项变化切换。

```ts
new SemanticSaveCoordinator({
  ...ownerOptions,
  structure: bodyAwareStore,
  inlineContainers: 1,
})
```

使用已有原生 checkpoint v4/HMAC 请求协议；没有伪造新的 native/room 版本。服务端原有 `X-HCD-Inline-Containers-Version: 1` 和 envelope 3 读写门禁仍有效，内部协调器在 checkpoint、草稿和恢复投影请求中明确声明对应能力。请求体 `extensionVersion: 1` 仍表示通用扩展感知能力，与 HTTP envelope 版本不是同一字段。

签名基线和已捕获 attempt 增加 `inlineContainers: 1`，`hcdSchema` 保留相同模式。没有启用时不增加这些字段，旧回执算法和序列化保持。新模式不能经旧 typography/sourceIdentity 迁移推测正文；未绑定草稿必须精确对应规范基线，否则保留为冲突/恢复内容。

公开 SDK、默认 schema、wire7 和 sidecar 初始化没有启用此选项；旧房间继续拒绝新模型。此配置仅用于内部接入与本批独立验收，不能据此把旧用户文档迁移视为完成。

## 保存正确性

- 快照编解码和语义摘要显式包含嵌套/空行内正文；业务冲突检查使用正确作用域的结构实例。
- 保存前将原请求身份、捕获内容、来源树、作者代次和图片意图写入带 CAS 的持久草稿；持久化失败不提交规范版本。
- attempt 在发布前必须能通过恢复读取器的同一边界检查。过大的来源捕获在原生提交前拒绝，不留下一个无法恢复却已提交的请求；正文保留，调整内容后可重新捕获。
- 捕获后的输入继续保留在永久正文载体中。成功或重开的来源回执只绑定捕获的字符，不把迟到字符伪装成旧来源；确认旧作者代次不会清掉后续作者。
- 提交后丢响应时，重开按原生不可变版本上的 HMAC 请求链核对原 attempt，再恢复递归来源。原请求重放返回原版本，不新增 head。
- 已有 wrapper 删除审阅尚未扩展，因此新模式下的通用行内恢复操作明确不可用，不复用一个缺少正文适配的旧恢复入口。

## 嵌套人员提及

修复 `hasInlineReferences` 和 `ReferenceAuthorLedger` 只遍历块子树的问题。现在遍历行内正文，独立约束块/行内深度，检查全篇 occurrence 唯一性。嵌套提及新增、改目标和删除依旧由实际已认证动作绑定作者，不把点击保存的人当作提及作者。

签名作者证明和正常保存链路继续复用：已有 occurrence 移动或普通文字输入不新增关联事件。原生服务仍校验当前文档权限和候选范围；提及不授予文档访问。关联事件只保留协议，`reminders.enabled` 仍为 false，没有发送提醒。

## 验收证据

新增 9 项专项，完整 939 项前端测试通过；TypeScript、独立/嵌入构建通过。专项覆盖模式/签名不匹配、递归来源、保存中继续输入、丢响应后新 Doc、持久失败不提交、真实作者与嵌套改目标、外部 head 拒绝和过大捕获修正后重试。

真实文件脚本从自有无源 r8 归档创建新副本：

1. 内部 owner 通过真实 PM 事务写入“保存捕获😀”，在行内正文新增 `@Bob 李`，作者为 Alice。
2. 原生 API 提交 r9 后，HTTP 代理暂扣响应。此时 Bob 继续输入“迟到输入😀”，草稿实际写盘，再断开 TCP。
3. 原进程退出，另一个 Node 进程读取原生保存的 Yjs 字节、签名基线和来源树，核对 r9 的 HMAC；迟到输入仍待保存，最终提交为 r10。
4. r10 的完整规范快照（含来源 ID）与协调器投影经同一 codec 后精确相等。原请求重放返回 r9，head 保持 r10；缺模型声明为 426，只读写入为 403。
5. 五个 occurrence 保持独立，新增提及的 target 为 Bob，拥有真实 `inlinePath`；r9 仅一个 created 事件且作者 Alice，r10 普通文字保存没有新事件，提醒关闭。
6. r8/r9/r10 经 HCDZ 打包解包精确重开，重复引用的资源按内容哈希核对；原输入归档不变。r9/r10 的 DOCX/PPTX/PDF/Markdown 共 8 个实际文件核对捕获/迟到文字、五处人员显示名和原有嵌套正文。

首轮文件核验已完成 HTTP/恢复/导出，但对同一资源两次下载到同名目标被 CLI 正常拒绝。验证脚本改为只下载一次，仍对每次资源声明核对长度/哈希；随后完整链路重跑通过。没有将脚本失败解释为业务保存失败，也未覆盖已有用户文件。

证据位于 `docs/assets/hcd-inline-save-2026-10-27/`：分开的准备/恢复 PID、请求体、来源/作者回执、关联结果、Yjs 文件、原生归档和导出文件。私有 token/secret 配置不复制到证据目录。PDF/Office 本批是实际文件内容回读，未声称桌面视觉排版或生产验收。

```bash
cd examples/hdoc/editor
node --import tsx --test src/semanticInlineSave.test.ts src/semanticSaveCoordinator.test.ts
npm test
npm run build
cd ../../..
python3 scripts/hcd-inline-save-files.py
```

## 剩余工作

下一步仍须配套活动房间逐包校验/模型协商、属性候选与迁移、删除审阅/恢复、复制/剪贴板新身份、缺 codec 的只读节点视图及公开 SDK/菜单；不能单凭保存核心已验证就向旧房间开放新节点。跨设备和旧 epoch 转移、容量/GC、长文、其他格式深度保真与完整原目标继续。真实 OS 输入法、设备、多实例/远端与生产也仍需单独验收。
