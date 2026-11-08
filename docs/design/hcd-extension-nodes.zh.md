# HCD 自定义节点：保留兼容层与原子节点 SDK（2026-10-24）

2026-10-25 更新：资源归档、可移植导出和富文本容器已接入，当前协同 wire 模型为 3、通用 envelope 为 2；以下早期保留项以[最新实现与边界](hcd-node-resources-and-rich-content.zh.md)为准。

本轮先完成跨前端、协同服务、Rust、离线包和导出的共同节点模型。缺少业务扩展时，Word 仍展示可读替代内容，允许编辑周围正文，保存时保留节点身份和业务数据。E2 已开放 `nodeExtensions` 的行内/块原子注册、视图与属性接口；加载有效定义的结构化 Word 声明 `customNodes: atomic-v1`。**完整 SDK 尚未完成**：marks、富文本容器、业务迁移、资源和逐格式 adapters 等仍待实现，也不接受任意 Tiptap schema 注入。

## 已实现的契约

```json
{
  "schemaVersion": "hcd.extension/1",
  "instanceId": "x_00000000000000000000000000000001",
  "type": "example.future_card",
  "version": 77,
  "display": "inline",
  "data": {"businessId": "external:42"},
  "fallback": {"text": "关联项目 · 离线内容"}
}
```

`schemaVersion` 是共同模型版本，本轮只认识 1；`version` 是业务类型版本，未知的类型/业务版本可原样保留。`display` 支持 inline 和 block，当前都是原子节点，不提供嵌套富文本容器。`instanceId` 标识一次出现；普通保存保持身份，复制/兼容 HTML 粘贴生成新身份。

| 链路 | 当前行为 |
|---|---|
| 原生投影、结构 patch、规范 HTML | 校验载荷、显示文字与节点类型一致，拒绝重复身份；块级原子也有受保护的替代文字 |
| Word 与 Yjs | 未加载扩展显示只读 atom 和本地化说明；远端合法更新继续同步；本地普通删除/转换/格式操作不能破坏未知节点 |
| 普通正文 | 可在节点前后编辑、保存、重开；缺少业务扩展不使整个文档只读 |
| HTML 剪贴板 | 认识共同模型且文字/标签一致时保留 JSON 并重新分配出现 ID；遇到未认识或无效的扩展模型明确拒绝，原文不变 |
| 结构保存/完整 checkpoint | 涉及扩展时要求版本声明；不认识扩展的客户端不能用普通文字快照静默覆盖载荷 |
| 历史/还原/离线 HCD | 节点数据与身份进入规范版本；离线读取不要求加载业务代码 |
| DOCX/PDF/Markdown | 本轮采用可读文字替代；保真报告逐节点给出 `HCD_EXTENSION_FLATTENED`，业务关系不冒充可回转的原生 Office 对象 |

结构请求使用 `X-HCD-Extension-Version: 1`；完整 checkpoint 带 `extensionVersion: 1`。这是共同模型兼容声明，不能代替写权限、协同版本与 epoch 检查。规范包记录 `extensionNodes: 1` 必需能力；不认识该能力的旧实现拒绝打开写入。

载荷只是惰性 JSON，不执行脚本、不自动取网络资源、不授予业务权限。单个 envelope 最多 64 KiB，替代文字最多 16 KiB，data 最多 16 层/1024 个值，数字限制在 JavaScript 可互操作范围内；文档最多 10000 个不同出现身份。类型使用小写命名空间，`hcd.*` 保留；拒绝原型相关键、无效标量与不兼容的行内换行/制表。这里保留 JSON 语义数据，不承诺原始 JSON 空白/字节一致。

## 本轮真实验证

原生/API/socket 探针插入未知业务 v77 的行内与块节点，验证旧模型 patch/checkpoint 和只读写入被拒绝、真实协同迁移与普通正文保存、离线读取、历史/还原和每节点导出提示。DOCX 图片媒体字节另与原始样例比较。

真实嵌入页面从 r2 加入协作，未知节点可读且不能被 Backspace 删除；普通文字保存 r3 并重开。共同模型 v2 的 HTML 粘贴被明确拒绝；原生共同模型 v1 的未知业务 v77 HTML 粘贴成功，另生成出现 ID，保存 r4。原始两个载荷与 r2 深比较不变，新载荷数据/版本/身份独立核对；固定 r4 的 DOCX/PDF/Markdown 回读包含三处替代内容和新增正文。

- [原生与 socket 证据](../assets/hcd-extensions-2026-10-24/extension-native-evidence.json)
- [真实页面与导出文件证据](../assets/hcd-extensions-2026-10-24/extension-browser-evidence.json)
- [重开页面](../assets/hcd-extensions-2026-10-24/extension-fallback-reopened.png)
- [不兼容粘贴的明确提示](../assets/hcd-extensions-2026-10-24/extension-paste-rejected.png)

验证命令：`cargo test -p hcd-core -p officecli`（437 项），编辑器目录 `npm test`（393 项）、`npm run build`，原生构建、clippy、fmt 和 `git diff --check` 通过。先构建原生二进制与编辑器依赖，再执行 `python3 scripts/hcd-extension-nodes.py` 可重跑隔离 API/socket/三格式文件链路；脚本停止自有服务，保留独立测试目录。不含生产身份、远程多实例、真实设备 IME、完整格式视觉与容量验收。

## E2 已接通的宿主原子 SDK

`EmbeddedHcdEditor.nodeExtensions` 接收 `NodeExtensionDefinition[]`。定义包含 type/version/display、国际化 label、defaultData、同步 validate/fallback、可选 mountView 和 properties。`NodeExtensionService` 提供原子注册/卸载、订阅、列表和细分能力声明；宿主注册最多 64 个类型、每个最多 32 个属性。配置复制，回调接收深冻结 JSON；宿主类型最长 116 字符，以容纳自动命令 ID。它是受信同进程代码接口，不是远程插件沙箱，也不会为业务操作授予服务端权限。

每个定义自动提供 `node.insert.<type>`，复用 `/`、工具栏、命令面板、右键和块插入菜单。统一 `node.insert` 生成新出现身份；`node.update` 和 `node.delete` 核对当前选中 atom 的完整旧载荷，拒绝过期/错误目标或卸载后的提交。自定义菜单能从冻结的 `context.selection.extension` 与 nodeId 取得选中载荷，再调用相同命令，无需取得 editor/Y.Doc。

右侧节点属性支持文字、数字和布尔字段；未应用输入留在本机表单，只有点击应用后才进入正文、撤销与协同。收到同伴的节点更新后保留表单草稿，禁用应用并提示重新载入。自定义 DOM 视图接收节点、语言和只读状态，卸载/重绘先清理，异常退回可读文字；视图代码不写入文件。缺 codec、未知版本或业务数据不通过校验时仍使用 E1 保护读取。泛型块转换/格式命令继续保护 atom，节点操作走专用命令。

真实双端测试先暴露并修复两个缺陷：

1. 块扩展遗漏结构身份，另一个成员编辑可能重新分配根节点并造成重复。现在补齐 schema 身份；旧 atom 记录的投影从权威 map key/owner 恢复身份。提交共享结构前额外检查所有出现身份，重复时不改变共享文档。
2. 已保存块属性更新误入普通文字来源校验而返回 400；文字不变的业务数据更新还可能被文字/样式优化遗漏。现在 atom 载荷变化走完整结构保存，替代文字不走独立文字 splice；块更新保留替代文字样式并去掉过期文字回执。

同一失败草稿在自有服务升级后重试保存 r5；随后不改变显示文字、只修改优先级的数据更新保存 r6。r6 重开属性为优先级 2；原始两个未知节点不变，两个已知节点身份保持独立。双端验证自己的属性撤销/重做保留 Bob 正文、旧表单提示、缺 codec 的只读会话。固定 r6 的 DOCX/PDF/Markdown 各含四处替代内容和同伴正文且均只出现一次；原始图片媒体字节不变；离线 HCD 完整保留四个载荷，导出报告有四处静态化提示。

- [SDK 使用示例](../../examples/hdoc/editor/README.md)
- [真实交互与修复证据](../assets/hcd-extensions-2026-10-24/sdk-browser-evidence.json)
- [原生/离线与三格式文件回读](../assets/hcd-extensions-2026-10-24/sdk-file-evidence.json)
- [r6 节点属性](../assets/hcd-extensions-2026-10-24/sdk-r6-properties.png)
- [旧表单保留与重新载入](../assets/hcd-extensions-2026-10-24/sdk-properties-stale.png)
- [未加载宿主扩展的读取](../assets/hcd-extensions-2026-10-24/sdk-without-codecs.png)

验证：编辑器 403 项测试与 standalone/embed 构建；原生 438 项（64+133+215+4+19+3）、原生构建、clippy/fmt。使用 `scripts/hcd-mention-preview.py --extension-nodes --node-sdk --pages-prefix .hcd-sdk-docx` 创建独立示例；完成双端操作后 `python3 scripts/hcd-node-sdk-verify.py <private.json>` 核验固定 r2/r5/r6、离线副本和实际文件。浏览器交互记录单独提供，文件脚本不会伪造点击证据。新增 PDF 只做文字回读，未追加视觉版面验收。

## 后续实施顺序

1. **扩展属性并发已继续补齐**：不同顶层字段合并，同字段候选保留/显式选择、撤销恢复冲突、保存拦截、原生模型限制及重启/文件链路已验证。历史压缩、删除与更新冲突和生产容量仍未完成；详见 [属性并发契约](hcd-node-property-conflicts.zh.md)。
2. **E2 完整节点能力**：业务版本迁移、资源归档/离线包、业务导入导出 adapters、实际节点能力报告；扩展 mark 与嵌套富文本容器需要独立模型。通用导出提示仍需替代目前人员专用静态说明。
3. **E3 AI 接口**：Provider、动作、目标锚点/源摘要、上下文预算、流事件、取消与建议状态；先私有预览，接受时校验权限/内容/节点 schema，形成单次可撤销普通编辑。
4. **E4/E5 AI 行为**：改写/续写先行，灰字补全后接；处理 IME、菜单/Tab、失焦、过期响应和并发目标修改。未接受内容不保存、不协同、不导出。

同 occurrence 引用改目标冲突、旧 epoch 离线恢复、PPT/PDF 的对应编辑/协同适配、字体与生产规模仍在总清单。在线成员的位置、定位和跟随继续集中在右侧“在线协作”；管理平台与实际提醒发送后置。


## E/F 下载前兼容声明（2026-10-24）

已增加按保存版本读取的通用业务 envelope 预检，区分 static 表现与数据 omitted/embedded/native。工具栏在下载前列出行内/块/引用的数量及有限示例，保存后新增节点或保留方式变化时先更新提示并停止此次下载。HTML 仍有嵌入数据，明确提示而不冒充静态脱敏；原生 HCD 保留载荷，不代表新增打包下载入口。真实 r4 五格式、r7 浏览器复核与实际下载、r10 恢复后下载通过，另修复 PDF 次级字体缺失选择导致“☐”丢失，以及浮层被紧凑工具栏裁切。详见 [契约、复验与边界](hcd-export-capabilities.zh.md)。这只是三类共同 envelope 的当前转换声明，不是按业务类型/版本的 export adapter SDK；业务迁移、资源、自定义 marks/容器及完整全格式视觉/字体/设备验收继续。


## E2c 显式业务迁移与跨版本候选（2026-10-25）

当前已开放 `NodeMigrationStep`、`NodeMigrationPreview` 与 `previewMigration`，能力声明为 `migrations: explicit-v1`、`collaboration: fields-v2`。受信宿主提供逐版本同步转换；加载不自动改数据，右侧先审阅升级前后及可选 JSON，再通过统一 `node.migrate` 确认。注册、深冻结输入、共同模型边界、最终业务校验、确定性与事务提交前重验均已接入；缺少路径、旧预览、只读和扩展卸载均拒绝。

跨业务 schema 不能按字段拼接。旧版离线修改与新版迁移形成完整候选，保存被阻止；明确保留旧候选后仍可再次升级，保留离线成员的内容。已有 v1 intent 继续可读，新记录与协同协商使用 v2，原生持久要求单调提升并阻止旧字段协调者降级。需配套升级前端、sidecar 和原生服务。

真实 socket、CUA、不可变版本及实际 DOCX/PDF/Markdown/离线 HCD 已验证行内/块升级、自己的撤销/重做、同伴保留、过期预览和历史还原。最终前端 468 项及独立/嵌入构建通过；原生阶段 67 项核心与 144 项 CLI、构建/Clippy/fmt 通过。保存锁还补齐重复描述符仍存活时的显式解锁。详细契约、验证方法及证据见 [业务迁移](hcd-node-migrations.zh.md)。

此阶段不扩大为全部 SDK 完成：资源归档/离线打包、逐业务版本导入导出 adapters、自定义 marks、嵌套富文本容器、删除与更新竞争及长期压缩、PPT/PDF 对应节点适配继续保留。AI 与通用导出预检已有独立阶段，按总清单继续补验；管理平台与实际提醒发送后置。
