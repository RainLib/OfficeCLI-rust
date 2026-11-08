# 行内容器宿主 SDK 与缺少扩展时的保护（2026-10-27）

在内部独立正文、精确事务、属性候选、签名保存和删除审阅之后，补齐可复用的宿主注册器与实际 NodeView。新增本地包入口 `@officecli/hcd-reference-editor/inline-containers`，不是 npm 发布，也没有自动升级已有编辑页或房间。

## 宿主接口

`InlineContainerRegistry` 复用普通节点注册器的有界 JSON、属性校验、原子注册、翻译标签、资源描述和确定性导出适配；接受 `display:'inline', contentModel:'inline'`，生成独立的 `hcd.extension/3` 元数据。正文仍是永久共享文字载体，不放进业务 `data`、fallback 或整块属性覆盖。

```ts
import {
  InlineContainerRegistry,
  SemanticInlineContainerNode,
} from '@officecli/hcd-reference-editor/inline-containers'

const registry = new InlineContainerRegistry()
const disconnect = registry.connect()
const unregister = registry.register([{
  type: 'business.field', version: 1,
  display: 'inline', contentModel: 'inline',
  label: { 'en-US': 'Field', 'zh-CN': '字段' },
  defaultData: { title: '字段' },
  validate: data => typeof data.title === 'string',
  fallback: data => String(data.title),
  properties: [{ key: 'title', label: '名称', kind: 'text', required: true }],
  exportAdapters: {
    docx: () => ({
      support: 'semantic', includeContent: true,
      blocks: [{ kind: 'paragraph', runs: [{ text: '字段：' }] }],
    }),
  },
}])

const nodeExtension = SemanticInlineContainerNode.configure({
  registry: () => registry,
  onError: error => reportEditorError(error),
})
const payload = registry.create('business.field')
// 宿主在支持模型 3 的 schema 中创建节点，将 payload 放到 attrs.extension，
// 实时文字放到节点 content，并接入永久正文 binding 与保存链路。
// 卸载时：unregister(); disconnect()
```

注册器提供 `create/resolve/update/updateResources` 和显式 `previewMigration`；后者只预览，不暗中提交版本迁移。属性更新保持 occurrence 与资源身份，资源更新使用已归档的 `NodeResource` 描述。上传、私有文件日志和权限仍走既有通用资源服务，不由本注册器替代。

行内 fallback 禁止换行，导出适配必须保留实时子树（`includeContent:true`），只能输出受限的单段行内快照。允许不支持的格式显式声明 unsupported。注册器拒绝控制正文 DOM 的 `mountView`，防止宿主 callback 覆盖 ProseMirror 管理的正文。

此入口的 `capabilities().requiresNegotiatedModel` 固定为 true。旧 `NodeExtensionDefinition`、`EmbeddedHcdEditor.nodeExtensions` 和 wire7 继续拒绝这个模型；类型消费者也验证了新定义不能赋给旧宿主契约。

## 视图、焦点与不可用扩展

- 已注册节点以紧凑标签和真实正文呈现，标签可选择整个容器；标签不重复变成正文。NodeView 更新标签、状态和提示，不重建正文 DOM。
- 正文继承外层编辑宿主的 contenteditable。视图仅在节点变化、注册状态、语言或编辑权限变化时重绘，不让所有节点因每个按键重复绘制。初次浏览器验证发现显式 `contenteditable=true` 会建立第二个焦点根并阻止输入，现已修正；缺少 codec 或编辑器只读时才显式 false。
- 注销或重新注册立即刷新视图。缺少 codec 时仍显示全部原正文、嵌套内容及保留元数据，呈只读状态；其他已授权成员的协作输入仍能投影到当前视图。
- 只读 DOM 不是编辑门禁。事务插件在写共享状态前阻止内部输入、格式、属性、整个范围和父级删除，也拒绝伪造或重复 occurrence；周围普通文字可继续编辑。
- 导出的 `prepareInlineContainerHistoryGuard` 在执行个人历史时读取当前 codec 可用性。宿主须将其接到已有 guarded undo；不会把录制历史时的旧注册状态当作现在可用。
- 来源回执的源属性/标记维护可通过，不得借此改变未知正文或业务数据。远端投影由房间验证后进入；本插件不取代服务端权限或协议影子验证。

本专题初版拒绝容器 HTML 粘贴，避免缺 parser 时静默展开业务元素。后续已接通新正文/容器/来源/提及身份、结构剪贴板与完整 HTML 粘贴，并保留损坏输入的整次拒绝；详见[复制、剪切与粘贴](hcd-inline-clipboard.zh.md)。跨文档附件自动传输与主编辑页/活动房间仍未开放。

## 验证

证据目录：`docs/assets/hcd-inline-host-2026-10-27/`。

新增 9 项测试覆盖注册与默认数据、原子失败、资源和迁移预览、非法导出与 DOM callback、不可用节点的文字/格式/属性/父级删除、嵌套保护、代码重载后的历史、同伴属性与正文合并及剪贴板拒绝。两项原有来源/字体输入测试现在显式注册其测试 codec，避免把未知节点可写作为默认假设。完整前端 **996 项通过**，TypeScript 与 standalone/embed 构建通过，差异检查通过。

实际浏览器中，两份 Tiptap 编辑器交换本机 Yjs 更新：

1. 已注册的行内正文可输入，原始字符身份保持 8/8；来源回执前后 PM 选区为 `10:10 → 10:10`，之后能继续在对应正文输入。
2. 卸载 Alice codec，删除整个容器被阻止；Bob 继续输入“同伴”，Alice 的只读正文仍更新。Alice 可编辑并撤销外侧文字；重新注册后撤销、重做自己的内部输入，保留“同伴”。
3. 编辑器根与正文容器 DOM 保持同一对象，错误区为空。宿主只读时两层 contenteditable 均为 false、ARIA 为只读，仍能接收同伴更新；恢复后正文重新继承外层编辑器并可继续输入。另用真实 HTML 剪贴板粘贴带标识的容器，得到明确提示，两份正文均未改变。

这不是 WebSocket/活动签名房间或真实系统 IME 验收。中文和 emoji 的键盘自动输入不冒充设备输入法验证。

独立文件链路实际运行 `npm pack`，从产物安装到隔离目录，编译严格 TypeScript 消费者并执行输出的 JavaScript：验证公开类型、运行时导入、独立 Tiptap schema，以及旧宿主类型拒绝。消费者用 SDK 生成新 envelope、实时正文和已有真实附件描述，写入一份自有无源 r8 HCDZ 的临时副本，原生 CLI 实际保存为 r9。

HCDZ 打包重开后 r8/r9 投影精确相等、附件字节一致。DOCX/PDF/PPTX/Markdown 实际回读中 `SDK: ` 与 `SDK 正文😀` 各一次，标签没有混入正文；DOCX 另核对粗体 XML。原始 r8 归档摘要不变。PPTX/Markdown 的既有部分 run 样式静态化限制仍保留。首次验收工具错误地直接运行 `.mts`，已改为先编译再执行 `.mjs`，最终完整文件链路重新通过。

```bash
cd examples/hdoc/editor
npm test
npm run build
cd ../../..
python3 scripts/hcd-inline-host-files.py
python3 scripts/hcd-inline-binding-preview.py
```

## 仍待完成

当前是独立宿主 SDK、NodeView 和协议内核的可组合接口，尚未加入主编辑页的 `/`、节点属性/冲突面板或现有活动房间。下一步仍须模型协商与迁移、公共房间/保存/恢复门禁、统一命令、迁移提交、跨文档附件，以及容器内部选区的 AI 和协作位置 UI。独立宿主的复制新身份已在后续接通，旧 wire7 的拒绝门禁保持有效，不能通过注册 codec 绕过。

普通恢复包 UI 尚不支持内部行内容器模型；固定/区域恢复包、旧 epoch、长文容量与分页、其他格式深度保真、真实 Provider 和原完整目标继续。管理平台与提醒投递仍后置。
