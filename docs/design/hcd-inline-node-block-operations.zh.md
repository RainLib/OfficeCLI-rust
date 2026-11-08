# 含自定义行内节点的段落操作

2026-10-25，接续 [资源与富文本扩展](hcd-node-resources-and-rich-content.zh.md)。本轮修复既有行内原子节点与Notion式块操作之间的缺口，不把它描述成任意custom mark或可编辑行内容器已经实现。管理平台和提醒发送仍后置。

## 原因与修改

原先 `protectedBlock` 将所有自定义节点都当作保护屏障：即使宿主已经注册了匹配codec，含行内节点的段落仍不能复制、移动或转换样式。简单解除保护又会让 `duplicateBlock` 复用节点ID，造成规范保存拒绝重复身份。因此本轮同时处理动作授权和复制身份。

- 行内节点有当前有效codec时，所在普通段落可以复制、删除、移动，并转换为段落、标题、列表或引用。动作仍来自统一命令注册表，块菜单、工具栏和命令面板共用事务。
- 复制为行内节点分配新occurrence ID，保留业务数据、版本、资源和各格式导出快照；原件/副本属性独立。普通段落和来源标识沿用原复制规则，不能继承规范来源ID。
- 移动和样式转换保留出现ID及原始载荷。含原子对象的段落不转为代码块，不把对象变成空内容或静默静态文本。块级业务节点和未知节点仍是屏障，本轮不放开整容器的任意结构转换。
- 注册策略从编辑器的保留插件读取当前回调，动作判定和提交时都重新解析。缓存只记录不可变子树中是否有特殊内容，不缓存“已经授权”的结果；卸载codec后，即使正文和选区没变，已暂存的复制也拒绝提交。
- 容器内操作检查当前容器及所有外层业务容器的codec。已知内层不授予修改未知外层子树的权限。只读/历史/组合输入及陈旧选区继续由既有命令和提交检查保护。

为允许这些明确受检查的块动作，内建 `block.*` 可以进入含保护对象的选区，但格式适配器必须证明目标可编辑。普通文字格式、AI或任意宿主命令没有因此获得豁免；未知节点也不会因菜单能打开而允许写入。

没有更改规范envelope、Yjs正文表示或native版本：协同声明仍4、portable envelope仍2。新增插件状态只是本地codec查询函数，不进入文档、历史或导出。

## 验证范围

**527项前端测试**及TypeScript、standalone/embed构建通过。新增回归覆盖：复制产生唯一ID且资源/快照完整；标题/列表/引用转换不扁平化；代码块拒绝；暂存后卸载codec拒绝；未知版本与未知外层容器保护；真实Yjs结构副本中移动与peer打字并发，自己的undo保留peer文字并恢复位置。既有容器子块测试现在明确提供codec策略，不依赖没有codec也可构造事务的旧行为。

本机合成文档、实际native/sidecar、两个真实鉴权WebSocket先生成资源及离线子段输入，保存到r6。随后CUA实际操作：

| 操作 | 观察结果 |
|---|---|
| 选中资源行内节点、块菜单 | 复制/标题/列表/引用可用，代码块禁用；未知邻居仍限制移动 |
| 搜索“复制”并Enter | 复制段落保存r7，节点数从4变5，新增独立ID |
| 副本段落转标题 | 保存r8，同一副本ID保留 |
| 属性改为“副本资料” | 保存r9；原件仍“项目资料”，两份均保留图片/普通附件引用 |
| Bob新窗口重开 | r9可读原件、副本、标题及Alice/Bob已有富文本 |
| 浏览器实际下载 | 导出前展示5个业务节点转换声明，实际r9 DOCX回读通过 |

r6/r7/r8/r9规范回读确认所有原节点保持原值，两个未知v77载荷未变。DOCX中源图片及资源图片hash一致；r6有2处图片，复制后3处。源文件缺席的HCD归档解包保留所有规范历史/资源字节，导出DOCX/PPTX/PDF/MD保留原件/副本替代文本和双端子段文字。PDF整页渲染复核。回读未发布新版本，head仍r9。

没有Rust修改，不重复计入先前原生单测；native证据是本轮实际保存、回读、资源和导出。真实浏览器没有做拖动竞态或卸载codec的演示，这些为结构/命令回归证据。多次CUA鼠标/观察超时先核对实际页面再继续，未据此重复动作或重启服务。没有真实Office客户端、数据库、多实例、生产、设备崩溃或旧epoch验收。

- [块菜单画面](../assets/hcd-inline-blocks-2026-10-25/known-inline-block-menu.png)
- [副本独立属性r9](../assets/hcd-inline-blocks-2026-10-25/inline-copy-saved-r9.png)
- [浏览器与下载](../assets/hcd-inline-blocks-2026-10-25/browser-evidence.json)
- [实际版本/资源/文件](../assets/hcd-inline-blocks-2026-10-25/file-evidence.json)
- [最初双端准备](../assets/hcd-inline-blocks-2026-10-25/initial-socket-evidence.json)
- [当前源码与检查摘要](../assets/hcd-inline-blocks-2026-10-25/validation.json)
- [实际下载DOCX](../assets/hcd-inline-blocks-2026-10-25/browser-r9.docx)

## 复现

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-mention-preview.py --extension-nodes --node-portable \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-inline-blocks
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-node-portable.mts /absolute/owned-root/private.json
```

脚本保存r6；浏览器依次复制保存r7、转标题保存r8、副本改名保存r9、下载实际DOCX，再运行专用于此命名夹具的只读探针：

```sh
python3 scripts/hcd-inline-block-files.py /absolute/owned-root/private.json
```

## 继续项

行内节点目前仍为原子对象，文字内容通过属性/业务命令修改。可编辑行内容器需要同时扩展规范模型、共同正文存储、位置映射和导出，不能仅给DOM加 `contenteditable`。后续已补 [整个已知业务块的复制/移动/删除](hcd-business-block-operations.zh.md)，但任意结构转换、custom mark、删除竞争/历史压缩、复杂往返及完整原目标继续；不以本批块操作替代这些范围。
