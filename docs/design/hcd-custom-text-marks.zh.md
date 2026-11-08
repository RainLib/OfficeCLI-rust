# 自定义文字标记：格式、协同、保存与离线文件

2026-10-26。继续[结构来源保留](hcd-structural-source-retention.zh.md)之后的扩展工作。新增格式型 mark；已有原子节点、资源归档、逐格式 adapter、业务迁移和富文本块容器继续保留。完整七阶段目标仍在进行，管理平台和提醒发送后置。

## 宿主接入

```tsx
import {EmbeddedHcdEditor,type CustomMarkDefinition} from '@officecli/hcd-reference-editor/react'

const review:CustomMarkDefinition={
 type:'acme.review',version:1,
 label:{'zh-CN':'需复核','en-US':'Review'},icon:'R',
 defaultData:{ticket:'DEMO'},
 validate:data=>typeof data.ticket==='string',
 fallback:data=>({label:`需复核 ${data.ticket}`,style:{bold:true,backgroundColor:'#fff2a8'}}),
}
// apiUrl、collabUrl 使用宿主实际提供的服务地址。
<EmbeddedHcdEditor documentId="demo" token={token}
 apiUrl="/v1/documents" collabUrl="wss://collaboration.example.invalid"
 nodeExtensions={{marks:[review]}} />
```

也支持 `NodeExtensionService.registerMarks()`／释放函数、`listMarks()` 和 `createMark()`。`capabilities().marks` 为 `format-v1`，公开类型已包含在实际 npm 包中。自动生成 `mark.toggle.acme.review`，工具栏、右键、选区浮层和命令面板共用注册表；快捷键沿用宿主 `keymap`。宿主命令可委托 `mark.apply`、`mark.toggle`、`mark.remove`，输入 `{type,data?}`，权限和当前选区由统一命令再次检查。

选区应用、移除和切换走正常文字事务。光标处仅更新后续输入的 stored marks，未输入时不产生空正文、不进入保存／导出；实际打字后才形成正常协同内容。重复应用完全相同的值不制造内容事务。多种标记按业务 type 的 ASCII 顺序排列，使即时显示、共享投影和规范保存的叠加顺序一致；普通直接文字格式保留在标记内部。

## 共同模型

`hcd.mark/1` 保存 type、业务 version、受限 JSON data、可读 label 及纯样式 fallback；文字、位置和来源 ID 仍由正文保存。支持粗体、斜体、下划线、删除线、六位小写十六进制文字色／背景色。没有可执行 HTML、URL 样式或替换正文回调。fallback 会在冻结数据上执行两次，拒绝不确定结果。

每段文字最多叠加8种不同 type；注册最多64种，宿主 type 最长116字符（为命令 ID 留空间）。每份载荷最多64 KiB、label最多256 UTF-8字节，业务 JSON沿用节点的深度／键／值和跨语言数字限制。导出清单按规范文字片段统计，同一格式跨片段可能多次计数。原生与前端都拒绝未知字段、非法样式、重复 type、超限和保留命名空间。同一混合选区有任一部分超限时，在改变前面可用文字之前拒绝整次操作，界面提供本地化提示。

这是不可变的格式值：不同 type 使用独立的 `hcdCustomMark:<type>` Yjs格式键，离线修改能够合并；同一 type 在同一范围的并发应用沿用文字格式值的确定收敛方式。已有节点的 fields-v2 属性候选继续适用节点；本批没有为 mark 新增逐字段候选或业务迁移操作。重新注册不同业务版本或不同 fallback 不会重写旧载荷，不匹配时按未知扩展保护。

## 缺少扩展与历史保护

未加载／不匹配的 mark 继续按持久 fallback 显示，并为对应文字加 `contenteditable=false`、`aria-readonly=true` 和本地化说明。普通本地事务检查文字、格式和原始载荷，保护层不只依靠 DOM；旁边正常文字仍可编辑。内部来源补写允许改变非可见的 hcdSource，避免把规范回执误当业务修改。

块操作、选区命令和个人历史使用同一实时 codec 判定。卸载扩展后，撤销若会删除或改变未知内容，保留当前正文和历史并显示审阅，可取消或跳过；重新加载后同一记录可继续执行。保护判定不缓存旧注册状态。实际远端的合法格式变化仍能同步到缺少 codec 的只读视图。

RoomProtocolGuard 在影子文档验证格式键与共同载荷；错误编码、非法样式、超限叠加及 atom／旧式正文上的不支持格式，在进入共享正文之前拒绝。原生将 mark 数据与普通 bold／color 等格式分别读写。规范 HTML 用受限样式外层和带载荷的文字 span 表示；读取时不会把 fallback 样式反写成普通格式，来源保留逻辑继续适用。

## 配套升级与导出

协同 wire升级为 **7**。前端、sidecar 和 native 需一起更新，旧wire6连接在同步前拒绝；持久元数据及reset保留模型门禁。结构3、coordinator4、节点envelope2、mention1不变。首次提交mark后，HCD manifest记录 `customMarks:1`；未知共同版本拒绝读取，旧文档缺少该字段仍兼容。

读取含mark的编辑投影及结构／checkpoint写入需声明 `X-HCD-Custom-Marks-Version:1`。未知版本也拒绝。对未声明模型的旧请求，即使其提交内容已经丢弃 customMarks 字段，也不会发布覆盖版本。浏览器和sidecar已附带声明。

| 目标 | 当前结果 |
|---|---|
| 原生 HCD／HCDZ | 完整保留每个版本的业务数据、文字格式及资源；不依赖宿主 codec |
| DOCX／PPTX／PDF | 文字与可表示格式静态转换，业务载荷与在线交互不保留；导出区明确提示 |
| Markdown／TXT | 可读文字和目标可表示的普通格式；业务载荷不保留 |
| HTML | 保留内嵌mark数据；实际浏览器下载同时嵌入图片字节；静态文件不提供原业务交互 |

HTML中的“嵌入”不等于原生业务回导；CLI `hdoc render-html` 是使用相对HCD资源的检视文件，完整单文件HTML通过现有HTTP／浏览器导出取得。本批没有声称 native HTML importer 能重建mark业务语义，编辑器HTML剪贴板和复杂Office往返仍需专项验收。跨格式导出不回写规范，未接受AI建议仍不会进入这些文件。

## 已取得的证据

638项前端测试（新增10项）、84项hcd-core和160项officecli测试、TypeScript／独立和嵌入构建、native构建、相关all-targets Clippy deny warnings及fmt／diff检查通过。实际npm pack后，独立消费端在严格TypeScript、未启用allowImportingTsExtensions／skipLibCheck的条件下编译通过。

真实本机鉴权socket先保存新段落r2，Alice复核标记r3、离线Bob项目标记与文字合并r4、Alice自己的撤销r5／重做r6。浏览器继续切换r7／r8，卸载codec后撤销被保护并取消，重载codec后原记录undo r9／redo r10。九条首次native checkpoint均200，保护操作没有额外checkpoint。新Y.Doc直接读取实际持久r6／r10文件，业务载荷和签名回执均与规范digest匹配。

逐份r2–r10实际DOCX、原文／原图规范块不变、**r4.blocks==r6.blocks、r7.blocks==r9.blocks、r8.blocks==r10.blocks**（含source ID／hash）通过。无源HCD全部版本1–10精确相同；DOCX／PPTX／PDF／MD回读、PDF整页检查通过。浏览器DOCX的粗体、下划线、文字色246a4b和高亮fff2a8均从OOXML确认，业务数据未混入文件。浏览器HTML的mark数据和图片字节与无源HCD检视结果一致。未知manifest模型2拒绝且文件不变。

缺失／未知HTTP mark模型的编辑投影、会丢弃mark的checkpoint及结构patch六次均426。旧wire6鉴权socket同步前拒绝。另一真实合法鉴权socket发送坏样式，影子验证关闭该连接；共享持久字节和head10精确不变。当前只读无codec新窗口、动态卸载保护和最终无验收按钮的声明式注册页面均已确认。

最初消费端探针漏填必需服务URL、patch探针使用了错误op，已纠正后重新验证；CLI导出HTML的探针改为文档公开的 `render-html`，单文件结果另取真实浏览器下载。不把探针错误当产品反例／通过证据。导出中发现的SEMANTIC原始代码显示已修为“语义转换”，未知fidelity代码不直接呈现给用户。修改ExportControl后的刷新不代表个人历史跨刷新持久化。

证据：[socket](../assets/hcd-custom-marks-2026-10-26/socket-evidence.json)、[实际文件](../assets/hcd-custom-marks-2026-10-26/file-evidence.json)、[模型门禁](../assets/hcd-custom-marks-2026-10-26/model-fence.json)、[持久r10](../assets/hcd-custom-marks-2026-10-26/persisted-r10.json)、[消费端](../assets/hcd-custom-marks-2026-10-26/package-evidence.json)、[卸载与历史保护](../assets/hcd-custom-marks-2026-10-26/unavailable-history-r8.png)、[最终页面](../assets/hcd-custom-marks-2026-10-26/editor-final-r10.png)、[检查摘要](../assets/hcd-custom-marks-2026-10-26/validation.json)。

## 复现与剩余工作

```sh
python3 scripts/hcd-mention-preview.py --custom-marks --checkpoint-probe \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-custom-marks-final
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-custom-marks.mts <root>/private.json
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-custom-marks-persistence.mts <root>/private.json 6
# 浏览器按上面的r7–r10流程操作，下载DOCX及HTML。
python3 scripts/hcd-custom-marks-files.py <root>/private.json <actual.docx> <actual.html>
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-custom-marks-persistence.mts <root>/private.json 10
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-custom-marks-fence.mts <root>/private.json
```

普通正文 mark 的 HTML 回读、剪贴板及来源修复见[后续验证](hcd-mark-html-roundtrip.zh.md)。可编辑行内容器、mark属性候选／迁移、更广 HTML/CSS 与业务节点／资源回导、复杂格式拆分与注释锚点、跨格式深度编辑、长文容量／压缩／GC、在线恢复个人undo和其余完整目标继续；这些小夹具不代表长文容量、真实Office、真实模型、服务重启／数据库多实例、全部IME／设备或生产验收。无使用行为的head1预备夹具在等价lint修正前主动停止，正式夹具使用新native且整个验证期间未重启。管理平台和提醒发送继续后置。
