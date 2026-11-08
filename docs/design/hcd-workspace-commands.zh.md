# HCD 工作区共用命令：属性、视图、协作与修订

后续更新（2026-10-25）：无源 PDF 再导出已补入现有规范文字的不可见搜索/复制层，扫描页不运行 OCR；下文此前记录的静态 PDF 检索缺口已被此增量修复。完整范围、文件证据及输入解码/字体写入剩余缺口见 [离线 PDF 文字层](hcd-pdf-searchable-offline.zh.md)。

日期：2026-10-25。此批接通完整 Word 和固定布局 Word/PPT/PDF 的工作区命令，继续复用现有协同、保存、历史预览及还原确认。管理平台和提醒发送不在本批范围。

## 已实现的行为

属性、在线协作、导航、缩放不再只存在于各页面的按钮回调。宿主可通过同一个 `EditorCommandService` 查询、执行、订阅状态、组合命令和绑定快捷键；页面工具栏、页脚和相应面板入口使用相同的执行与权限判断。在线成员仍在右侧“在线协作”中定位和跟随。

Word 的属性面板中，粗斜体、下划线、删除线、文字颜色、高亮、正文/标题、列表已复用正文和选区浮层的格式命令。保护选区、只读、历史查看和过期选区的写入约束仍由注册表和原编辑适配器执行。

| 命令 | 配置/输入 | 支持范围 |
|---|---|---|
| `view.properties` | 无参切换；`{enabled: boolean}` 显式显示/隐藏 | flow、fixed；保留当前图片/页面属性页 |
| `view.collaboration` | 同上 | flow、fixed；右侧协作面板 |
| `view.navigation` | 同上 | flow 大纲、fixed 缩略导航 |
| `view.settings` | 同上 | flow 界面设置 |
| `view.readOnly` | 同上 | flow，写权限用户切换本地编辑模式；历史/权限失效/还原期间禁用 |
| `view.actualSize` | 无参，100% | flow、fixed |
| `view.zoom.set` | `{percent: number}` | flow 70–150，步长 5；fixed 25–200，整数 |
| `view.fit` | 无参 | fixed 适合窗口 |
| `view.focus` | 无参切换或 `{enabled: boolean}` | fixed 专注视图 |
| `view.panel.close` | 无参 | 关闭当前右侧栏；AI 栏先取消当前请求 |
| `revision.history` | 无参 | flow 修订页签和历史面板 |
| `revision.save` | 无参 | flow，转交 `file.save`，返回原保存结果；无变更时不会人为新增版本 |
| `revision.localCopies` | 无参切换或 `{enabled: boolean}` | flow 本机恢复副本 |
| `revision.open` | `{revision: number}`，0 到已知当前版本 | flow 文档内历史正文/差异预览 |
| `revision.current` | 无参 | flow 返回当前正文，保留本机草稿 |
| `revision.restore.review` | 无参 | flow，仅打开现有还原确认；不提交还原 |

数字和布尔值不接受字符串隐式转换，非法缩放、未来版本、负数和非整数版本均拒绝。显式隐藏某个面板不会关闭其他已打开的面板；重复显示会保留当前同类属性页。

这些查看命令按 `read` 能力注册，可在只读、受保护选区或加载期间使用；各适配器仍控制具体动作可用性。保存、还原预览及本地只读模式切换有额外权限和操作状态判断。自定义命令使用 `access: 'read'` 并不赋予它嵌套执行写命令的权限。

`revision.open` 的返回值表示请求已接收，不代表网络加载结束。加载器负责取消前一个请求，快速选择多个版本最终显示最后一次选择。还原仍保留目标/当前版本、变更数量、草稿保护和协同协调检查，最终确认继续走原还原流程。

## 宿主扩展示例

```ts
const commandExtensions = {
  keymap: { 'view.collaboration': ['Mod+Alt+J'] },
  commands: [{
    id: 'business.reviewTogether',
    label: { 'zh-CN': '一起审阅', 'en-US': 'Review together' },
    access: 'read', ready: false, selectionSensitive: false,
    surfaces: ['palette'],
    execute: async ({ commands }) => {
      await commands.run('view.zoom.set', { percent: 100 })
      return commands.run('view.collaboration', { enabled: true })
    },
  }],
}
```

未新增默认快捷键。宿主绑定继续经过平台/文档类型冲突检查、输入法保护和工作区作用域判断，不拦截编辑器外的宿主表单。`menuOverrides` 继续只控制既有六种菜单表面；页眉和状态栏不声称支持该菜单布局配置。固定路径的新增视图分组也由注册表生成。

## 本机验收与文件边界

- 前端 494 项测试、TypeScript 和 standalone/embed 构建通过；包括参数拒绝、只读/历史/保护选区、文档类型过滤、宿主嵌套写入拒绝、面板显隐幂等。
- 真实本机浏览器接入 Alice、Bob 和 Reader：只读成员可以跟随 Bob，不能保存或通过宿主命令写入；Word 125% 缩放、工作区内重绑快捷键、PPT/PDF 属性/导航/专注/适应窗口通过。编辑器外的宿主选择框不会触发编辑器快捷键。
- 通过 `revision.save` 保存 Word 段落到 r2，Bob 收到正文。浏览器下载 DOCX 后核对新增正文和 1 张原图，协作成员信息没有写入导出正文。
- 快速 r0→r1 最终显示 r1；宿主还原命令仅打开目标 r1/当前 r2 的确认，取消后正文和 head 保持 r2。PPT 测试写入撤销后为 r0，PDF 为 r0；查看操作和取消还原没有新增版本。
- 三种 `.hcdz` 均解包并通过原生校验。Word/PPT 离线再导出正文通过。PDF 原生归档内文字节点保留，但无原始 PDF 的语义再导出是静态画面，当前产物无法抽取文字；本机已渲染核对文字和蓝色图形的画面，此项不记作可搜索 PDF 兼容完成。源文件支持的 PDF 导出保持原文件字节，PPT 的所有 OOXML 部件保持一致。

证据：[浏览器记录](../assets/hcd-workspace-commands-2026-10-25/workspace-command-browser.json)、[实际文件记录](../assets/hcd-workspace-commands-2026-10-25/workspace-command-files.json)、[Word 界面](../assets/hcd-workspace-commands-2026-10-25/word-workspace.png)、[还原确认](../assets/hcd-workspace-commands-2026-10-25/restore-review.png)、[PDF 界面](../assets/hcd-workspace-commands-2026-10-25/pdf-workspace.png)。范围为本机合成文档/原生服务/真实浏览器和文件；未验证生产部署、其他平台或真实 Office 客户端。

复验：先 `cargo build -p officecli`，再运行 `python3 scripts/hcd-workspace-command-preview.py`。使用输出端口的 `.hcd-workspace-command-{docx,pptx,pdf}-{writer,peer,reader}.html`。按上述步骤在 Word 添加段落“统一命令保存 · 保留原始图片与协同内容”并保存到 r2；PPT 测试写入后撤销，PDF 保持 r0。随后运行：

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-workspace-command-files.py target/hcd-preview-runtime/<本次目录>/private.json
```

预览脚本使用隔离目录、合成身份、仅本机端口和有时限的文档令牌；私密配置不纳入证据。停止脚本只清理自己创建的进程和带本次所有权标记的入口，保留原生文档用于复核。

## 继续保留的范围

B03 尚未整体完成：XLSX 命令适配、字体控件和固定布局属性写操作、编辑模式转换、历史差异组件内部的查看模式/逐项导航仍需继续迁移。自定义 marks、复杂嵌套块/设备输入、结构化 AI 工具、PPT/PDF AI、可搜索离线 PDF、跨平台与生产验收也继续保留。此前完成的节点资源归档、行内 atom/富文本容器、逐格式导出和离线原生归档契约见各专题文档；本批没有改变原生格式或协同协议。
