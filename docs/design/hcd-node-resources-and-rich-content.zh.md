# 自定义节点资源、导出和富文本扩展（2026-10-25）

2026-10-26 后续：[格式型自定义文字mark](hcd-custom-text-marks.zh.md)已接入，协同现为wire7。下文保留本轮资源／块容器交付依据。

本轮实现结构化 Word 编辑器的资源归档、可移植导出适配、行内原子元素和可编辑富文本块。保存、协同、版本和离线读取共用 canonical 文档；管理平台、字体管理界面和提醒发送继续暂缓。

## 已实现的内容

| 能力 | 当前行为 |
|---|---|
| 行内元素 | `display: 'inline'` 的自定义原子节点，可以与普通文字混排，拥有稳定 occurrence ID、属性和资源引用。 |
| 富文本块 | `display: 'block', contentModel: 'blocks'` 声明可编辑子块。段落、标题及受支持的富文本走现有协同结构，不把正文复制进业务 JSON。 |
| 子块操作 | 容器内子块可以转换标题、移动、复制、删除；普通块操作限定在当前容器的同级范围，保护外层业务节点。 |
| 资源 | 属性面板归档、列出、下载和移除引用；SDK 提供 `archiveResource` / `readResource` / `updateResources`。 |
| 导出 | 注册各格式 `exportAdapters`，把纯函数结果持久化成受限快照。服务器和离线导出不执行宿主代码。 |
| 缺失扩展 | 未知类型/版本保留原始数据、ID、资源及子树，展示 fallback；禁止不理解该节点的客户端改写。资源仍可校验下载。 |
| 属性与迁移 | 继续通过统一命令、显式迁移预览、预期原文检查、自己的撤销/重做及协同保存。资源引用随迁移保留。 |
| 导出检查 | 按实际保存版本展示语义/静态/不支持状态及资源数量，普通附件无法进入通用文件的边界在下载前显示。 |

自定义行内元素目前是原子节点，不是可包裹任意文字范围的自定义 mark。已有粗体、斜体、下划线、删除线、颜色等内建 mark 不受此限制。任意 Tiptap schema 注入仍不接受。

## 宿主扩展方式

```ts
const definition = {
  type: 'example.callout', version: 1, display: 'block',
  contentModel: 'blocks', label: '资料块',
  defaultData: { title: '项目资料' },
  validate: data => typeof data.title === 'string',
  fallback: data => String(data.title),
  exportAdapters: {
    docx: ({ data }) => ({
      support: 'semantic', includeContent: true,
      blocks: [{ kind: 'heading', level: 2,
        runs: [{ text: String(data.title), bold: true }] }],
    }),
  },
}
```

`exportAdapters` 按 `docx/xlsx/pptx/pdf/html/md/txt` 注册，必须同步、无副作用且确定。注册、创建、更新、迁移和协同字段合并时重新验证结果。输入深冻结；相同输入重复调用结果必须一致。导出时只读取已保存快照，不依赖宿主是否在线。

块快照支持段落、标题、项目符号以及带受支持基础格式的文本 run、归档图片 run。图片通过资源 `key` 引用，带替代文字及显式尺寸。容器适配必须声明 `includeContent: true`：适配只添加业务外观，实时子树由导出器递归追加，不能用过时缓存正文覆盖成员输入。容器没有适配时默认保留标题 fallback 和实时子树。

资源归档后，宿主用 `node.resources` 命令传入 `{instanceId, expected, resources}` 绑定；属性面板也走这个命令。归档成功但原节点、权限或冲突状态已改变时，拒绝陈旧绑定，不覆盖新节点。上传完成前只存在 staging 资源，不冒充已保存正文。

## 保存、协同和资源一致性

- `hcd.extension/2` 在旧 envelope 上增加可选 `resources/contentModel/exports`。原 `hcd.extension/1` 文档仍可读取和使用。
- 每节点最多 16 个资源、每文件最多 8 MiB；采用 SHA-256、实际字节长度、受限文件名/MIME 和资源 key。资源元数据没有远程地址或执行代码。
- 上传与下载使用文档鉴权。二进制附件可归档；可移植图片目前限 PNG/JPEG/GIF/WebP，并校验实际图片格式。响应有 `nosniff`。
- 保存结构时同时验证全部依赖、实际 hash/长度和图片格式，再提升到该 revision 的资源索引。缺文件或损坏依赖拒绝整批保存，不推进 head。
- 移除引用不会删除历史字节；历史版本继续使用自己的不可变资源索引。保存、版本还原、离线目录拷贝都保留依赖关系。
- 资源上传有全局 pending 计数和最多两个并发归档。上传期间保存、当前内容导出、还原交接、撤销和关闭受保护；浏览器导航显示未完成提示。状态栏说明正在归档，失败释放 pending，不把未归档内容标为已保存。
- 同 schema 的普通属性继续按字段合并，并为最终属性重算导出快照；资源或 envelope 变化作为完整候选冲突处理，禁止拼接出悬空图片引用。用户可查看资源名称和完整候选后选择。
- 富文本子树仍由现有结构/文字 CRDT 承载。两人离线修改不同子段合并，自己的撤销保留对方文字；属性命令不会重建或丢掉子树。
- 只读、未知 codec、失效预览及旧的预期值不能通过命令绕过保护。未应用的属性草稿不会因归档/移除资源被悄悄重置。

### 协同部署要求

编辑器/sidecar 使用 `hcdNodeEdits=3`、协商和保存状态 `nodeEditVersion: 3`；native shared state 使用 `X-HCD-Node-Edits-Version: 3`。canonical 新 envelope 使用扩展模型版本 2。持久要求只能上升，不能通过 epoch 切换降级。缺失/旧 1/旧 2/未知共享模型读写和 checkpoint 返回 426；旧 intent 记录仍可读取。

升级编辑器、sidecar、native 后刷新旧可写窗口。`collaboration: 'fields-v2'` 指字段意图模型；它与 wire negotiation 的版本 3 是不同字段。普通文档读取/导出不要求共享草稿连接。

## 离线与各格式兼容

原生 `.hcd` 保持目录形式；新增 `.hcdz` 单文件归档及 `hdoc pack/unpack`，可从导出操作区下载固定保存版本、历史、节点与资源，解包后重新读取、导出。详见[离线归档契约](hcd-offline-archive.zh.md)。浏览器本地 journal 保留协同状态和 hash，不能替代完整离线资源目录；上传中断必须重新选择文件。

| 输出 | 可保留内容 | 边界 |
|---|---|---|
| 原生 HCD 目录 | 业务 envelope、子树、格式适配快照、所有已归档附件及历史 | 离线编辑器冷启动/浏览器缓存资源仍不等于完整桌面离线产品。 |
| DOCX / PPTX / XLSX | 受限快照的实际文字、基础样式和嵌入图片，容器子树 | 业务行为和任意附件不会变为 Office 原生组件；复杂版式需单独适配。 |
| PDF | 实际绘制文字和 PNG/JPEG 图片，容器子树 | GIF/WebP 图片退化为替代文字和文件名并报告静态兼容。 |
| HTML | 可读内容、图片和节点声明 | 宿主 JS 不导出；普通附件字节继续留在 HCD 目录。 |
| Markdown / TXT | 可读文本、图片的替代文字与文件名 | 不产生离线后失效的伪资源 URL，不携带附件或交互行为。 |

未注册业务适配的原子节点走可读 fallback，报告静态；显式声明不支持的格式会阻止对应导出。快照不能携带任意 HTML、脚本或宿主回调。

本轮发现打印引擎会漏绘透明行内 span 中的图片。PDF 专用适配仅去掉 OfficeCLI 自有、无样式的媒体透明包裹，保留顺序和尺寸，不修改 canonical HTML 或 vendor。生成后再读取 PDF 的实际图片绘制实例：少于所需 PNG/JPEG 实例则报错，不发布缺图文件；同一图片重复使用按绘制次数验证。

## 可复现验证

先构建 native 和编辑器，然后运行隔离预览：

```sh
cargo build -p officecli
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-mention-preview.py --extension-nodes --node-portable \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-node-portable
```

在另一个终端，对预览输出的私有配置路径执行下列命令；配置含临时 token，不提交或展示其内容：

```sh
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-node-portable.mts /absolute/owned-root/private.json
```

该探针针对初始 r2 样例，完成资源和富文本插入 r3、两人离线编辑 r4、自己的撤销 r5/重做 r6。随后在 writer/peer 页面分别编辑子段，转换标题并移动子块；属性面板归档 `ui-archive.txt`、下载、移除、撤销并保存。文件探针按此命名样例的 r9–r12 阶段验证历史，不是任意生产文档的通用检查器：

```sh
python3 scripts/hcd-node-portable-files.py /absolute/owned-root/private.json
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-node-portable.mts /absolute/owned-root/private.json --read-only
cargo test -p hcd-core -p officecli --lib --bins
cargo clippy -p hcd-core -p officecli --all-targets -- -D warnings
cargo fmt -- --check
```

本地检查：前端 481 项、hcd-core 74 项、CLI 146 项、hcd-docx 43 项、hcd-formats 48 项通过，TypeScript/独立版/嵌入版构建及 Clippy 通过。七格式文件和离线目录探针在 r14 通过；实际浏览器下载的 r14 DOCX 已再次读取。PDF 的两处图片已按实际绘制实例和[整页渲染图](../assets/hcd-node-portable-2026-10-25/portable-pdf-proof.png)核对；DOCX/PPTX/XLSX 各有两个图片对象。后续请求生命周期批次已补真实延迟网络浏览器验收：native 成功后取消、503、45 秒超时、关闭/导出门禁、重试及同伴子段输入保持选中/属性草稿，最终 r10 的历史/离线/实际下载通过；501 项前端测试及构建通过，详见 [请求与选区契约](hcd-resource-request-lifecycle.zh.md)。原生测试数字仍为前一批历史结果，本轮没有 Rust 修改。

实际本地证据：

- [双 WebSocket 离线合并与撤销](../assets/hcd-node-portable-2026-10-25/portable-socket-evidence.json)
- [浏览器资源与块操作](../assets/hcd-node-portable-2026-10-25/portable-browser-evidence.json)
- [实际导出和离线目录](../assets/hcd-node-portable-2026-10-25/portable-file-evidence.json)
- [重新连接只读检查](../assets/hcd-node-portable-2026-10-25/portable-restart-evidence.json)
- [旧模型降级防护](../assets/hcd-node-portable-2026-10-25/portable-model-fence-evidence.json)

证据仅覆盖本地 native、真实浏览器、两个 WebSocket、实际文件和无宿主/无网络的原生目录导出；不代表已部署、多实例、生产 PostgreSQL/S3 或真实 Microsoft Office 全版式验收。

## 后续仍需完成

1. 任意范围的自定义 mark、行内可编辑容器及更复杂混合子树的扩展契约与 Office 往返转换。
2. 更完整的业务导出适配：图表、表格、布局、复杂样式、原生 Office 自定义组件；外部编辑后重新导入业务身份的恢复规则。
3. 资源生命周期容量治理、持久附件列表/批量管理、完整离线启动/资源缓存；这些不由管理平台 UI 代替。
4. 大文档子树增量加载、长期协同意图压缩、多实例与对象存储故障、设备输入及真实 Office 应用验收。
5. PPT/PDF 的自定义对象编辑适配与上述 flow 节点契约的统一。既有固定版式保存/协作继续沿用自身路径。

AI 接口继续使用既有公共服务和命令接受路径。该批不新增 AI 对复杂节点的自动改写；后续必须声明节点能力、资源权限和目标格式，候选预览经明确接受后进入同一协同事务。人员 @ 和关联事件接口沿用既有服务，提醒发送与管理平台均未加入本轮。


可编辑行内容器的原生envelope3/子树/来源/资源/提及与文件门禁已见[后续原生基础](hcd-inline-content-native.zh.md)。当前浏览器SDK仍声明blocks-v1，没有因native支持而提前开放行内编辑；共享载体、位置映射、历史/删除审阅和浏览器双端验收继续。

恢复时重新固定附件仍由服务端在文档与资源回收锁内执行；不能因为此前导入过就跳过固定。客户端现在直接对恢复文件中的字节快照做摘要验证，仅在服务端返回资源不存在或不支持固定接口时才构造上传 Blob，避免先构造 Blob 再完整读回。自动化测试覆盖重复恢复不重传文件、权限与损坏拒绝回退、资源缺失回退，以及回退期间调用方修改原缓冲区时仍上传原快照；未量化真实浏览器性能。

附件归档/重新固定的成功回执读取现在受同一请求取消信号和 64 KiB 大小上限约束；取消时停止等待迟到的响应，超限或损坏回执不会触发上传回退。受控流测试覆盖响应正文停滞、回执超限与取消后迟到的响应；无法据此推断已到达服务端的暂存请求被回滚，也未覆盖真实网络故障。
