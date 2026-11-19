# 资源白板与工作空间 AI 验收

日期：2026-11-17。范围：独立多 Tab 编辑工作台，继续使用 Excalidraw、Yjs/Hocuspocus 与 HCD 原有提交机制。

## 已交付

- 白板“插入资源”：已打开的 DOCX / MD / TXT / HTML 文档及 XLSX 区域引用；文档可选整份文字摘要或段落，表格最多 200 格。
- 卡片存储源文件、稳定段落/单元格标识和显示范围；正文及凭据不写入白板。
- 当前可见白板的卡片按权限读取最新内容，支持手动刷新；源内容更新后显示新修订。
- 进入源文件 Tab 并定位段落或选中表格范围，保留返回白板入口。
- 工作空间共享 AI 任务记录和输入目标；切换 Tab 不隐式更换编辑文件，历史记录带来源。
- AI 启动、停止、续跑路由到任务所属文件，沿用原编辑器保存检查；关闭目标后阻止提交并保留未发送文字。
- 墨色、纸白、陶土强调与统一圆角；角角 SVG 欢迎动效和回复标识，离屏或减少动态效果时使用静态欢迎形象。

## 运行验证

在 `examples/hdoc/editor` 执行：

```sh
npm run build
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npx playwright test e2e/resources.spec.ts e2e/canvas.spec.ts --reporter=line
```

构建成功，包括 TypeScript 检查、独立编辑器和嵌入包。Vite 仍报告依赖包的 `use client` 忽略及大包提示。

画布原有 10 项测试通过；资源流程 5 项测试通过。补充表格插入行的失效检查后，修正测试中的控件角色选择并定向重跑该项通过。

| 验收 | 结果 |
| --- | --- |
| 文档段落预览、原生画布引用持久化、刷新页面后恢复 | 通过 |
| 白板 → 文档 → 返回白板 → AI 请求仍发送到原文件/段落 | 通过 |
| 表格范围预览、选中源范围、输入修改、卡片刷新 | 通过 |
| 表格前插行后，原地址变化使引用失效并禁止进入旧范围 | 通过 |
| 只有白板权限时不读取源内容；其他账号会话不能解析引用 | 通过 |
| 取得同身份只读源权限后显示预览，隐藏 AI 编辑按钮 | 通过 |
| DOCX 稳定段落定位，真实编辑保存后白板显示更新 | 通过 |
| AI 目标关闭后阻止提交，显式换目标才恢复输入 | 通过 |
| 原有双人绘制、AI/人工并发、范围约束、撤销、断网恢复 | 通过 |
| 原有桌面亮/暗主题面板、移动端面板切换 | 通过 |

测试使用临时目录、真实本地 HCD 服务与协同 sidecar、隔离令牌和本地模型模拟服务。资源测试验证了 AI 路由和目标参数，模型回复明确不修改内容；文档和表格更新由真实编辑器提交。现有画布测试另有模型工具调用提交并发补丁的验证。没有使用生产模型凭据，也不将模拟模型路由测试当作真实模型质量验收。

## 实际页面截图

- [文档引用与全局 AI 来源](hcd-resource-workspace-v1/resource-document-global-ai.png)
- [表格卡片与当前源内容](hcd-resource-workspace-v1/resource-sheet-preview.png)
- [进入表格并定位范围](hcd-resource-workspace-v1/resource-sheet-located.png)
- [Word 编辑保存后刷新预览](hcd-resource-workspace-v1/resource-word-live-update.png)

## 当前边界

- 引用来源须先在同一用户、同一服务的工作台中打开并认证；没有新增宿主跨文档授权。
- 表格插入行列导致原有锚点变化时提示重新选择，尚未自动变换范围；预览跟随当前修订，不支持固定历史版本。
- “全局 AI”本轮指任务、输入目标与来源导航共享。多个请求尚未共用跨文件模型对话历史，也不会自动读取其他文件作为上下文。
- 文档/表格选区传入现有 Agent 目标参数；本轮未新增服务端单元格级授权协议。
- 卡片显示轻量预览，完整编辑仍在源文件 Tab；原生画布保留引用，PNG 导出尚未烘焙动态 HTML 内容。
- 本轮没有将完整 V3 设计中的所有 Office 工具和跨资源工作流实现为产品功能。

实现分层与后续扩展见 [当前方案说明](../design/officecli-resource-workspace-v3/whiteboard-collaboration.zh.md)。

## 2026-11-18 标签页管理

顶部管理按钮或 `Alt+Shift+T` 打开标签列表。可按文件名、ID 或格式搜索，固定常用文件，在同一组内移动顺序，或者从最近关闭记录重新打开。固定标签排在前面，取消固定后可以关闭。标签栏使用左右方向键切换，`Alt+左方向键` 和 `Alt+右方向键` 移动位置。

关闭前调用当前格式的保存检查。文档会完成协同保存，白板会提交待保存事务，表格里未确认的公式需要先应用或取消。文件上的 AI 任务执行中会显示状态并暂缓关闭。关闭当前页后回到最近使用的仍打开文件，没有历史时选择相邻文件。

标签顺序、固定项、活动标签和最多 8 条最近关闭记录保存在当前浏览器标签会话中。重开会重新验证访问权限。

浏览器回归累计 37 项通过，覆盖文件恢复、搜索、顺序、AI 编辑目标、文档关闭保存、表格未提交公式保护和同页草稿恢复。前端生产构建通过。

```sh
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npx playwright test e2e/resources.spec.ts e2e/canvas.spec.ts e2e/canvas-composition.spec.ts
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npx playwright test e2e/workspace.spec.ts -g 'document tabs retain|workspace reload restores|workspace restoration reauthenticates|workspace connections remain usable'
```

[标签搜索、固定与最近关闭截图](hcd-resource-workspace-v1/workspace-tab-manager.png)

### 拖拽、分组与批量关闭

- 在顶部拖拽标签，放到另一个标签的左半或右半即可排序。把未固定的标签拖到组名上即可归组。固定标签在独立区域内排序。
- 从管理窗口勾选标签，在「移动到标签组」里新建组、加入已有组或移出组。点击组名可折叠，当前正在使用的标签继续显示。组名、成员、排序和折叠状态随当前浏览器会话恢复。
- 「关闭所选」和「关闭整组」逐个检查并保存文件。固定项、执行中的 AI 任务、未确认的公式以及保存失败的文件留在工作台，并显示原因。关闭成功的文件进入最近关闭。
- 切换期间编辑器维持原来的视口尺寸。白板保留相机和框选区域，文档保留文字选区及滚动位置，表格保留工作表视口及活动单元格。返回文件时优先恢复该文件的 AI 草稿和目标，跨文件引用任务继续沿用自己的文档授权和目标。

浏览器回归使用真实 HTTP、协同服务及本地模拟模型。新增用例检查拖拽与分组恢复、批量关闭中的公式保护，以及白板、文档和表格在反复切换后各自发送的 AI 目标。

[分组与批量关闭截图](hcd-resource-workspace-v1/grouped-tabs.png)

### 刷新与重新打开后恢复

同一浏览器会话中，文件状态按已认证的服务、账号和文件保存。白板恢复平移、缩放、对象选区和框选区域，文档恢复文字选区和滚动，表格回到活动工作表、单元格选区和原视口。

未发送的 AI 草稿随原文件和编辑目标恢复。原目标的修订或协同版本已经变化时，需要重新选区才能继续提交，草稿文字会保留。服务端会在接受恢复的任务前再次核对版本。

从 `examples/hdoc/editor` 运行以下浏览器验收。测试使用本地模拟模型核对实际任务请求。

```sh
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npx playwright test e2e/resources.spec.ts --grep 'restore view and AI drafts|native canvas object selection|rejects a version race'
```

[重新打开后的文档、选区和 AI 草稿](hcd-resource-workspace-v1/restored-tab-draft.png)

### 白板与文档双向生成

- 白板选中对象或框选文字，点击「整理为文档」。在右侧 AI 选择目标，预览标题、章节和行动项。可追加到已有可编辑文档的指定段落后或文末，也可新建 Markdown 后导出 Word。
- 在 DOCX、Markdown、HTML 或 TXT 编辑器选中文字，右键点击「在白板讲解」。也可在大纲中对章节打开该操作。AI 自动选择卡片、流程图、时间线、思维导图或分步讲解。预览通过后，可追加到已有白板空位或新建白板。结果保留原生可编辑图形和连接器。
- 点击「查看结果」定位新增内容。文档内「查看白板来源」和生成白板内「查看原文」均支持回到选区。源文件和目标文件分别验证授权。已有目标使用对应写令牌，新建目标使用同账号的上传令牌。
- 任务在刷新后可恢复预览和进度。应用时再次核对选区与目标，来源变化时保留草稿供重新生成。一次应用对应一条提交回执。

HTTP 入口为 `POST /v1/documents/{id}/selection-transfers`。任务读取、取消和应用位于 `/selection-transfers/{run_id}` 与 `/selection-transfers/{run_id}/apply`，回源使用 `/selection-transfers/{run_id}/source?section=0`。已有目标在请求中携带 `x-hcd-target-authorization`，新建使用 `x-hcd-upload-authorization`。二者沿用 Bearer 令牌格式。

```sh
cargo build -p officecli
cd examples/hdoc/editor
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npx playwright test e2e/resources.spec.ts --grep 'reviewable Word draft|editable teaching sections|creating a Markdown result|new teaching board|changed source draft'
```

验收使用真实本地 HCD、协同服务与浏览器，模型由确定性替身提供。检查 Word 添加章节和回源、跨段 Unicode 选区、白板原对象几何、预览与写入的区分、新建目标、跨身份权限及冲突保护。

[白板整理文档预览](hcd-resource-workspace-v1/whiteboard-to-word-preview.png) · [文档生成的原生讲解白板](hcd-resource-workspace-v1/document-to-teaching-board.png)
