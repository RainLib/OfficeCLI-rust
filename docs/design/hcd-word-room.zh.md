# Word 区域房间协议与逐包接入

2026-10-26。在区域模型、保存和上传生命周期之后，将 `WordSaveCoordinator` 接到实际 Hocuspocus sidecar。此批验证本机单 sidecar、显式初始化的合成文档；不表示旧用户文档已经自动迁移，也不表示浏览器纸张页已经切换到新房间。

## 独立身份与启用条件

| 项目 | 区域房间 |
|---|---|
| 原生/客户端协议 | `hcd-word-regions/1` |
| 房间名 | `{documentId}:{epoch}:wordregions1:save5` |
| 客户端声明 | URL 同时声明 `hcdNodeEdits=7`、`hcdWordRegions=1` |
| sidecar 开关 | `HCD_WORD_ROOMS=1`，默认关闭 |
| 原生身份 | 必须已具有相同协议及 epoch；不能仅通过改 URL 选择新模型 |

普通 `typography2:save4` 和 `structure3:save4` 不接受区域载体。错误保存代次、非规范 epoch 拼写、旧协议和缺少区域声明的客户端被拒绝。新协议原生 metadata 可读写，并在撤权/重置 epoch 时保留；普通格式保持原协议。

此批只增加协议识别，没有提供旧用户文档迁移入口。验证脚本在启动任何服务前，为新建的合成文档显式设置区域身份；没有改写用户的 epoch 文件。远端存储宿主不开放此开关路径。本机多进程所有权已由[后续增量](hcd-word-room-ownership.zh.md)接入，完整迁移另行完成。

## 写入前校验

复用 `RoomProtocolGuard` 的增量 Yjs shadow，完整校验先于 Hocuspocus 应用数据包。拒绝时丢弃 shadow 的候选更新、从服务端当前状态重建；真实房间不接受这次数据，异常连接会关闭。

- 禁止 default fragment 混入区域房间、旧结构模型、未知非空共享数据及尚不支持的隐藏行内容器。
- 节/页眉/页脚目录、schema、永久结构版本、图片规范回执均以服务端值为准；客户端不能改写。既有规范 ID 不可被客户端重新赋值，新 provisional owner 只能使用空规范 ID。
- 检查完整区域拓扑、内部边界、跨区域结构键、规范块/文字来源，以及只读 opaque 内容。既有只读块不能被远端删除或改成可编辑段落。
- 图片意图必须指向服务端知道的原生区域图片；几何/资源的不可变基线核验仍在保存阶段执行，不把共享 receipt 当作可信来源。
- 尚有未解析依赖的 Yjs 包拒绝进入，避免未知载体留在后台，随后在另一名作者的事务中才显现。
- 每包继续经过现有原生成员鉴权，空闲连接也复查。作者只从 Hocuspocus 的服务端 connection origin 解析，校验写权限、当前 epoch/协议、有效期与 readOnly，不采用客户端姓名或 userId 声明。

shadow 不在每次键入时复制整份二进制文档，但区域拓扑/来源验证仍会遍历当前模型。超长文档性能、分段数据与虚拟化尚未验收，不能把“增量 shadow”当作完整的长文性能结论。

## 保存、恢复与原生边界

区域 onLoad 先验证签名私有日志/规范基线并持久化，Hocuspocus 复制同一 Yjs 状态后，协调器只允许绑定到完全相同的签名状态；外来宿主状态被拒绝，调用方的 Y.Doc 不被销毁。避免随机重新初始化永久载体，再把另一份数据混入真实房间。

房间保存和自动保存使用已有区域队列。stateless 请求的类型/请求 ID/文字和图片 digest 均核验；回执仍匹配原请求，广播带 `nodeEditVersion:7`、`wordRegionVersion:1`。onStore 持久化，卸载先 drain，再释放监听器与 guard。进程重启使用同一 API/文档/epoch 的 HMAC lineage 和私有日志恢复，不用客户端副本替代服务端来源。

服务端来源回执更新后，客户端通过不可变原生 projection 的 layout/hash 调用 `syncLayout` 刷新本地视图。不能仅看到共享 metadata 的新 hash 就盲目接受另一套页面设置；真实测试在核验后继续编辑和保存。

原生增加两项约束/修正：区域身份拒绝旧 `collaboration/state` PUT 和普通 restore；协作服务的 auth scope 与既有专用路由写权限保持一致，受限成员目录下不会错误降为 read。协作服务仍不能通过普通资源上传路由写入，规范 checkpoint 继续检查每个 contributor 的当前权限。

本批房间 stateless 接口只接保存/状态。上传预留、恢复选择的组件已有单独验证，但尚未把其 HTTP/消息入口、成员 transport 和浏览器界面接到这个房间。没有暗中启用一个使用服务 token 上传的后门。

## 真实验证

```bash
python3 scripts/hcd-word-room.py
```

此命令新建临时文档、端口和进程，运行实际 native、生产 sidecar 源码和真实 WebSocket 客户端：

1. Alice/Bob 并发移动/修改正文、页眉、空页脚和页眉图片几何，共同保存为 r2。
2. 保存后的新输入继续通过 guard；Bob 的个人文字撤销保留 Alice 的同伴输入，保存为 r3。这不是图片个人撤销的验收。
3. 默认 fragment 和伪造 schema 两个异常客户端被关闭，正常同伴仍保有原状态。
4. 结束 sidecar，使用另一个 PID 重启。签名日志恢复后继续输入页眉并保存为 r4。
5. 只读成员的编辑/保存不能进入真实文档；旧协议和缺少区域声明的客户端无法加入。
6. 管理 token 撤去 Alice 写权限后，旧写连接关闭；epoch 从 1 升为 2，协议仍为区域模型，旧 epoch 原生请求返回 409。
7. 解析实际 DOCX 的正文/页眉/页脚，检查原始图片字节、无内部边界泄漏；HCDZ 离线 r1/r2/r3/r4 状态完全一致，两个 bundle validate 通过。

新增 11 项前端检查（9 项区域 guard/协议/回执，2 项宿主文档绑定），全部 835 项通过；TypeScript、生产与嵌入构建、原生服务测试、metadata/checkpoint 检查、Fmt 和 Clippy 的结果见 `docs/assets/hcd-word-room-2026-10-26/`。这是实际 API/Socket/文件证据，不是浏览器或多实例部署验收。

## 后续启用门槛

1. 本机多进程所有权见[租约与日志绑定](hcd-word-room-ownership.zh.md)；远端/多主机适配、不同恢复快照的显式审阅仍待完成，不能用本地 OS 锁结果替代。
2. 显式 epoch 迁移与失败恢复：冻结旧房间、未保存的浏览器/上传准备、私有日志、原生 CAS 和迟到回执必须贯通，不能直接改旧用户文档 metadata。
3. 接浏览器区域 binding、layout 回执、上传/关闭/导出/重开选择，再接统一命令、Notion 菜单、个人图片撤销与 AI 接受事务，完成真实双浏览器验收。
4. 长文数据虚拟化、私有链压缩/GC、远端日志适配及部署验收。

总目标继续进行，管理平台和实际提醒发送仍暂缓。
