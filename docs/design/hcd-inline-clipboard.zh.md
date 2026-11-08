# 行内容器复制、剪切与粘贴（2026-10-27）

承接[宿主 SDK](hcd-inline-host.zh.md)，补齐模型 3 的递归副本和实际剪贴板。此增量仍是显式宿主模型：没有把新模型自动加入旧编辑页或活动房间，管理平台与提醒投递未实施。

## 副本与来源

公开入口新增 `copyInlineContainerSlice(slice, targetSourceId?)`。它复用普通粘贴的身份清理，显式启用行内容器：

- 每个嵌套容器、普通业务节点、人员提及都得到新的 occurrence；相同人员 target 和显示名称快照保留。
- 来源、规范块和结构 owner 绑定清除，由新文档的正常保存重新分配。目标段落的 source 只适用于容器外侧文字，不能盖到新的独立正文中。
- 独立正文保留所选文字、硬换行、普通格式、自定义 mark、业务数据、导出快照和资源描述。正文不复制到属性 JSON，原载体的 Yjs 字符不被借给副本。
- 正文字体默认值转成显式文字格式后再清理来源，避免把继承的字体与字号一起丢掉。
- 复制部分嵌套正文时，只复制选中的正文片段及其包装上下文；关闭行内容器的 open-slice 边界，保留可适配的段落上下文。不会把它同化到已有容器，或偷偷复制未选中的剩余正文。

```ts
import { Slice } from '@tiptap/pm/model'
import { copyInlineContainerSlice } from '@officecli/hcd-reference-editor/inline-containers'

const copied = copyInlineContainerSlice(editor.state.selection.content())
// copied 可交给已协商模型 3 的正常事务；仍须经过当前编辑权限和保存门禁。
```

包构建将 `@tiptap/pm/*` 保持为宿主依赖，防止公共 Slice/Fragment/Plugin API 带入第二份 ProseMirror 类。独立包消费者实际使用自己的 `Fragment` 创建选区再调用本函数，已经验证兼容。

## 剪贴板交互

| 格式 | 内容与处理 |
| --- | --- |
| `application/x-hcd-inline-slice+json` | `hcd-inline-clipboard/1`，有界结构选区；粘贴时再次分配身份，不把剪贴板中的身份当作活动载体 |
| HTML | 完整 envelope 与真实正文；标识和 envelope occurrence 必须一致，解析后的业务节点数量和载荷必须一致 |
| 纯文本 | 可读正文与提及姓名，不重复插入容器标签；明确选择“粘贴纯文本”时沿用普通文本路径 |

NodeView 自带复制、剪切和粘贴插件。复制不改共享文档；剪切先成功写入完整剪贴板，再走正常删除事务。剪切/粘贴受编辑状态、不可用 codec、既有历史和 binding 保护。剪切形成一条正常个人历史，撤销恢复原 occurrence；粘贴产生新 occurrence。

HTML 使用惰性 template 解析，不把原始 DOM 附着到编辑页。复用已有 custom-mark 解析，防止 fallback CSS 又被当成普通格式。解析前后比对业务载荷，PM fitter 之后再次核对全部新 occurrence 和子树；无法完整保留时返回 `inlineContainerClipboardInvalid`，原文不变。

JSON 上限 2 MiB、1000 个节点、64 层结构、24 层行内容器、1 MiB 正文；字段、schema 属性、mark、Unicode、模型和上下文都在共享写入前验证。含暂不支持的原稿 opaque 对象或无法解析的业务类型时整次拒绝，不降为普通文字。当前旧 schema 的粘贴入口也会拒绝模型 3 MIME/HTML；明确要求的纯文本粘贴可正常使用。

文件中没有 Yjs Item、服务签名、ACL、Token 或自动分享授权。资源沿用已归档的内容摘要引用；本轮验证同一文档已有的真实附件。跨文档缺少资源时仍须通过通用资源服务授权和归档，剪贴板本身不转移资产访问权或携带原始文件字节。未实现跨文档附件自动传输。

## 验证

证据目录：`docs/assets/hcd-inline-clipboard-2026-10-27/`。

9 项新增检查及更新后的宿主用例覆盖递归身份/格式/资源、每次粘贴独立身份、部分嵌套选区、非法 JSON/属性/Unicode/容量/深度、普通原子和 mark、旧 schema 门禁、纯文本意图、HTML 标识一致性，以及实际 binding 下的个人历史和迟到同伴输入。完整前端 **1005 项通过**，TypeScript、standalone/embed 构建与差异检查通过。

实际浏览器使用两份 Tiptap 视图交换本机 Yjs 更新：

1. 从标签选择容器，用真实复制快捷键获得三种剪贴板数据。完整粘贴与仅 HTML 粘贴分别增加独立副本；两端 occurrence 集合一致且不重复。
2. Bob 撤销自己的 HTML 粘贴，Alice 撤销自己的结构粘贴，恢复为原始一个容器；重做后重新出现。副本中输入“同伴”与“自己”，Alice 撤销只去掉“自己”，“同伴”仍在，两端收敛。
3. 原始字符始终 8/8。缺少 envelope 的 HTML 粘贴得到明确提示，正文与副本数量不变，错误区为空。
4. 实际“粘贴纯文本”仅添加文字，容器仍为一个。剪切后为零个，一次撤销恢复原 occurrence，原始字符仍 8/8。结构性删除/恢复会重新创建对应 NodeView DOM，这是预期结构操作，不是来源回执重建编辑器。

这不是活动 WebSocket/签名房间验收，中文/emoji 自动键盘输入也不等于系统 IME 验收。

实际包与文件链路使用 `npm pack` 产物，独立严格 TypeScript 消费者编译后执行 JavaScript。消费者通过宿主 ProseMirror `Slice` 调用公开复制函数，复制含粗体、提及和实际附件引用的 SDK 容器，再写入自有无源 r8 归档的临时副本。

原生保存 r9 后，新来源 ID 与 r8 中的来源不同；复制产生的提及 ID 保持且不等于原提及。DOCX/PDF/PPTX/Markdown 中实时正文和适配前缀各一次，原四处 Alice 提及加新的一处合计五处；DOCX 粗体 XML 另行核对。HCDZ 重开后的 r8/r9 投影精确一致，附件 SHA256/长度/字节一致，原始 r8 归档未修改。此处是 CLI 文件保存，不能称为主编辑页通过签名 checkpoint 保存。

```bash
cd examples/hdoc/editor
npm test
npm run build
cd ../../..
python3 scripts/hcd-inline-host-files.py --clipboard
python3 scripts/hcd-inline-binding-preview.py
```

## 仍待完成

主编辑页的模型协商与迁移、统一命令/菜单/属性面板、活动房间及普通恢复包 UI 还未启用内部行内容器模型。跨文档资源传输、旧 epoch、迁移提交、容器内部 AI/协作位置 UI、长文和原完整目标继续。PPTX/Markdown 的既有部分 run 样式静态化限制保留，没有以四种文字回读代替桌面 Office/PDF 的视觉排版验收。
