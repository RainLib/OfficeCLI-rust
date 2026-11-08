# 冲突中保留已保存人员值

2026-10-25，接续 [引用改绑与完整候选](hcd-reference-retarget-conflicts.zh.md)。当前可在右侧冲突面板明确选择“保留已保存版本”，修复目录停用/权限变化后，两个新候选都无法提交时的恢复缺口。管理平台与提醒发送仍不做。

## 交互与安全边界

冲突占位是因果记录的共同 root，可能比当前规范版本旧。面板将已保存版本号、规范姓名快照与候选分开展示；不把 root 假定为规范值，也不把当前目录的新名字偷偷写回旧快照。

`reference.keepSaved({mentionId, ids, revision})` 不接受调用方传入的姓名或目标。命令使用当前鉴权会话读 head、对应不可变版本的引用列表、再次读 head，两次 head 都必须等于用户看到的 revision。校验文档、版本、唯一出现及 person kind 后，才将该规范值追加为一个普通解决意图。它仍用既有版本1引用意图，协同声明保持4，本轮无需升级原生程序。

每次 await 后重新检查取消、生命周期、可写性、容器 codec、组合输入状态以及完整候选集合；任一改变拒绝应用，不删除旧意图。请求等待上限15秒，原生 checkpoint 的 expectedRevision/CAS继续防止最终读取后 head 再推进时覆盖新规范。该边界没有宣称“客户端 HTTP 读取与本地事务是服务端原子操作”。权限变更仍以服务端为准，旧 token 的最终发布不能越过原生授权。

恢复到同一已保存目标不需要把已停用人员当作新提及重新授权。若其他正文有改动，保留该目标后可正常保存正文；不会凭空创建新的关联事件。若最新规范版本没有该 occurrence，不显示值恢复按钮，不在此入口隐式恢复删除或删除正文；完整删除竞争审阅仍待做。

应用前后各切自己的 undo 边界。撤销恢复冲突及原候选，重做恢复规范目标；peer 正文不受影响。只读、历史、未知容器和保留 kind 没有写入权限，直接调用命令也重新校验。失败显示本地化的刷新/复核提示；不是假成功或自动切到另一个人。

## 证据

合成 DOCX、本机真实 native/sidecar、两个鉴权 WebSocket 和 IAB：

1. r2 的旧 root 是设计组张三；先将同一出现改绑 Alice，保存 r3。
2. 双端离线分别改到 Bob 和设计组张三，并保留另一端新增“保存恢复同伴正文”。重连保留两个候选，规范仍r3，root仍张三。
3. 服务端目录把所有人员设为 inactive。真实选择 Bob 后，原生拒绝保存，head不变；自己的 undo 恢复冲突，证明并非只做UI禁用。
4. 浏览器显示“已保存r3 @Alice 王”，点击“保留已保存版本”，正文改回Alice；保存r4保留同伴正文。撤销重新打开冲突，reader同步看到候选且所有选择按钮禁用；重做并重复保存仍r4。
5. 实际浏览器下载r4 DOCX，CLI回读；r3/r4规范引用相同，r4没有新增关联事件，反复查询一致，reminders仍为disabled。
6. 源文件缺席的HCD解包后，DOCX/PPTX/PDF/MD保留两姓名、同伴正文和源图片。DOCX/PPTX图片字节hash一致，PDF包含真实图片并渲染检查。最终head仍r4。

**522项前端测试**及TypeScript/standalone/embed构建通过；新增10例覆盖旧root与规范不同、自己的undo/redo、读前/读后head改变、缺失出现、错误文档/版本、权限/就绪失效、取消以及新候选已解决的迟到响应。本轮没有Rust修改，没有重计上一轮157项原生测试；原生运行证据是上述真实HTTP拒绝、保存和导出。没有生产、真实Office客户端、多实例、PostgreSQL、旧epoch、设备/浏览器崩溃验收。并发head改变的拒绝是单元注入证据，不冒称真实浏览器竞态复现。

- [真实双socket及拒绝](../assets/hcd-reference-saved-2026-10-25/socket-evidence.json)
- [浏览器与只读/撤销](../assets/hcd-reference-saved-2026-10-25/browser-evidence.json)
- [事件及实际文件](../assets/hcd-reference-saved-2026-10-25/file-evidence.json)
- [当前源码和检查](../assets/hcd-reference-saved-2026-10-25/validation.json)
- [恢复选择画面](../assets/hcd-reference-saved-2026-10-25/saved-choice-conflict.png)
- [实际下载DOCX](../assets/hcd-reference-saved-2026-10-25/browser-r4.docx)

## 复现

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-mention-preview.py --short-references \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-reference-saved
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-reference-saved.mts /absolute/owned-root/private.json
```

脚本在r3留下冲突；浏览器选择已保存值、保存r4、撤销/重做检查、下载r4 DOCX，然后运行：

```sh
python3 scripts/hcd-reference-saved-files.py /absolute/owned-root/private.json
```

探针仅适用于该隔离命名夹具，创建独立导出目录，不改变head。原清单中的任意custom mark、行内可编辑容器、复杂格式往返、删除竞争/意图压缩、旧epoch和完整生产/设备/AI验收继续。
