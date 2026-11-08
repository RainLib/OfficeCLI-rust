# HCD 停顿补全首版与验收边界

日期：2026-10-24。Word 语义编辑器已接入默认关闭的私有灰字补全，复用 E3 的 Provider、流协议、权限/目标校验和接受事务。当前为本机首版；列表与选区浮层的两个更新循环已修复并完成隔离回归，**真实输入法/设备及生产验收仍未完成**。在线成员、操作位置、定位/跟随继续统一在右侧“在线协作”；管理平台与实际提醒发送后置。

## 接入与扩展

```tsx
const aiExtensions = {
  provider: createHttpAiProvider({url: '/api/editor-ai'}),
  autocomplete: {
    enabled: false,
    delayMs: 900,
    cooldownMs: 1500,
    minPrefix: 8,
    maxOutput: 256,
  },
}
```

省略 autocomplete 时能力可用但默认关闭；设置 false 禁止提供补全入口。开关是当前会话状态，不写入文档或恢复缓存。底部及 AI 面板共用 `ai.autocomplete.toggle`，另提供 `ai.autocomplete.accept/dismiss`。`commands.capabilities().autocomplete` 为 `ghost-text-v1` 或 reserved，表示接口实现而非生产验收完成。

宿主可覆盖短续写 instruction（最多 2,000 字符）。delayMs 范围 250–10,000 ms，cooldownMs 为 250–60,000 ms，minPrefix 为 1–256，maxOutput 为 1–2,048；默认分别为 900、1,500、8、256。补全输出还受宿主更小的全局限额约束，时间上限取全局与 15 秒的较小值，事件数上限 2,048。公共 `/ai` 入口额外开放纯调度器、策略、键盘仲裁和输入分类；不要求 React/Tiptap/Yjs。PM 灰字和焦点适配保留在编辑器内部。

## 触发和私有状态

只在本机可信文字输入、键盘删除、输入法提交/修正等编辑后安排尾部防抖；粘贴、拖入、结构命令、聚焦、远端更新和上次生成结束不主动请求。相同上下文去重、请求间冷却、无自动失败重试，避免每个按键或保存回执触发模型。

要求当前有焦点且可写、在线并完成协同同步，位于合法 paragraph/heading 空光标，已有足够文字。原保护 atom、code/link 等限制沿用。菜单、块操作、属性检查、恢复、历史审阅、AI 手动面板、输入法组合中、窗口失焦/隐藏和离线暂停或取消。IME 提交等到 PM composition 结束再调度；真实原生 IME/RTL/移动端还未验收。

请求仍是 `hcd-ai/1`，action 为 `hcd.autocomplete`、mode 为 insert。仅发送允许字段和有界文字，模型不会获得 HCD 令牌、人员身份、CRDT 锚点或整篇文档。灰字是当前 PM 插件的 widget decoration，不是正文节点，不写入 Yjs、IndexedDB、checkpoint、历史或导出。流中可以预览，只有完整有效 done 后才能接受。

接受时必须仍是同一相对光标和有效源上下文，重验原生写权限、代次/协议。只接受整份结果，成为一次自己的事务；未实现部分接受。接受后正常协同、保存、导出、撤销/重做。元数据保存回执不会单凭 docChanged 就取消仍有效的目标；同伴改动是否可保留由相对位置和原文条件判定。

## Tab、菜单和可访问性

顺序为现有 @ 与 / 菜单、宿主统一 keymap、自动补全、编辑器原生按键。只有可见、完整、合法建议的普通 Tab 才接受；Shift-Tab、列表缩进、表格导航和宿主 Tab 命令优先。请求中/隐藏灰字的 Tab 先取消，再继续原行为。正在接受的重复 Tab 不重复插入；Esc 取消，普通输入和移动光标丢弃旧建议。

灰字附有可点的接受/关闭按钮，点击保留编辑焦点；视觉文字不混入可编辑内容，另有本机 polite 状态播报。界面支持现有英文/简繁中文。屏幕阅读器、触控与操作系统切换焦点仍需独立设备验证。

## 已验证的本机链路

全部模型输出来自 loopback 确定性模拟 NDJSON，没有接真实模型或生产服务。原生 API、WebSocket、浏览器和实际文件分别验证：

| 步骤 | 结果 |
|---|---|
| 默认关闭后输入 | 模拟服务无生成请求 |
| 开启后停顿 | 当前成员见灰字，另一成员与独立共享投影无未接受内容 |
| 灰字期间保存 r3 | 灰字仍可见；实际 DOCX/PDF/MD 及固定离线目录副本无建议 |
| Tab 接受、保存 r6 | 真实共享投影和三格式文件各有一份补全，Bob 正文保留 |
| 一次撤销 r7、重做 r8 | 只撤销补全，保留手工文字和 Bob 段落；重做恢复一次 |
| Esc、流中继续输入、Left、同页编辑区失焦 | 旧灰字被移除，未误接受 |
| 列表 Tab 后 r12 | 协作端显示第二项嵌套，独立共享投影仍只有一份已接受补全 |
| 最终 r12 | DOCX/PDF/MD 和离线目录回读一致；无补全控件/光标姓名；DOCX 原媒体字节保留 |

440 项前端测试、TypeScript、standalone/embed 构建通过。测试覆盖调度时间/上下文/过期计时器、IME/修饰键/宿主命令优先级、严格光标相对位置、无正文灰字元数据。新增 PDF 仅验证文字回读，没有新增整页视觉保真验收；E3 已记录 opaque drawing 在语义 PDF 不重现原图的缺口。

## 列表与浮层稳定性复查（已修复）

先前超时已在关闭 AI 时复现，输入先进入共享数据，随后 PM 追加事务不再收敛。独立读取同一份 15,989 字节共享状态后，给测试中的身份插件设置 12 轮上限，可靠复现第 13 轮失败；修复后同样输入 2 轮完成。没有修改原生文档来绕过问题。

根因是嵌套 listItem 具有稳定结构 key，但不是独立的规范保存 owner，其 hcdBlockId 按模型必须为空。旧身份插件每次为它补临时 ID，结构绑定又清空；现让已绑定且无保存 owner 的节点保留该状态，未绑定/旧协议节点继续原身份流程。项目符号和编号列表均覆盖输入、Enter、缩进/反向缩进、自己的撤销/重做、远端正文保留和共享投影一致；测试有收敛上限，回归时会明确失败而非挂死。

另修正 Tiptap BubbleMenu 的 shouldShow 使用内联新函数：固定版本的 React 包会在该 prop 改变时分发 options transaction，正文 UI 又按 transaction 刷新，形成重复更新反馈。改为仅随实际权限/菜单状态/命令实例改变的 useCallback，仍动态隐藏/显示浮层。修复前页面捕获 Maximum update depth 告警；修复后新验证时间段内菜单、灰字、选择、保存与重开未再捕获该告警。没有在生产代码保留诊断日志。

新的独立浏览器样例实际验证：

- 补全关闭时，嵌套列表 Tab 后连续输入、Enter 正常。
- 完整灰字出现时 Tab 缩进、Shift-Tab 反向缩进，继续输入正常且没有误接受灰字。
- Bob 用真实独立 socket 新增另一段后，已有灰字仍就绪；列表中的可点接受按钮正常提交。
- r6 接受、r7 一次撤销、r8 重做，各版本 DOCX/PDF/MD 与离线目录回读补全计数正确，手工列表及 Bob 段落均各一次。
- `/` 菜单经 Down/Enter 转标题，模拟服务请求数仍为 8，没有额外 AI 请求。
- r9 保存后同一可写会话正常从本机缓存重开，补全默认关闭；继续输入并保存 r10；选区浮层仍可见。

最终为 442 项前端测试、TypeScript、standalone/embed 构建与 diff 检查通过。新增实际文件只验文字、原 DOCX 媒体字节及离线状态，不代替原稿保真：这轮另确认 DOCX 将嵌套列表内容转换为文字项目符号，没有原生 w:numPr/ilvl；此原生编号/层级保真缺口继续列入 F 阶段。最小源 drawing 在语义 PDF 缺图的原缺口也仍存在。

最初失去响应的旧标签页未通过强制清缓存或结束用户浏览器进程恢复，不能将新隔离回归扩大为所有旧缓存/浏览器版本验收。IAB 不同虚拟页点击也不能替代真实 OS blur；离屏 Tab、真实原生 IME/RTL/移动端/辅助技术、长文与生产规模仍需独立验证，E05 不据此标记为完整交付。

复查证据：[浏览器与根因](../assets/hcd-ai-2026-10-24/autocomplete-stability-browser-evidence.json)、[列表内接受](../assets/hcd-ai-2026-10-24/autocomplete-fixed-accepted-file-evidence.json)、[撤销](../assets/hcd-ai-2026-10-24/autocomplete-fixed-undone-file-evidence.json)、[重做](../assets/hcd-ai-2026-10-24/autocomplete-fixed-redone-file-evidence.json)、[缓存重开后继续编辑](../assets/hcd-ai-2026-10-24/autocomplete-fixed-reopened-file-evidence.json)。

原生 AI 来源台账、白名单结构化工具、宿主模型鉴权/配额/任务取消/幂等、PPT/PDF AI、完整节点 SDK、引用并发与旧代恢复、字体/国际化及生产规模等原清单继续有效。

证据：[浏览器步骤与缺口](../assets/hcd-ai-2026-10-24/autocomplete-browser-evidence.json)、[接受前文件](../assets/hcd-ai-2026-10-24/autocomplete-before-file-evidence.json)、[接受](../assets/hcd-ai-2026-10-24/autocomplete-accepted-file-evidence.json)、[撤销](../assets/hcd-ai-2026-10-24/autocomplete-undone-file-evidence.json)、[重做](../assets/hcd-ai-2026-10-24/autocomplete-redone-file-evidence.json)、[最终](../assets/hcd-ai-2026-10-24/autocomplete-final-file-evidence.json)。

复现：`python3 scripts/hcd-mention-preview.py --autocomplete --pages-prefix .hcd-autocomplete-docx` 创建隔离的原生/sidecar/web/模拟 AI 服务；按实际 UI 步骤操作，再用 `scripts/hcd-autocomplete-probe.mts` 和 `scripts/hcd-autocomplete-verify.py` 核对。private.json 及页面令牌仅存 0600 的本机临时目录，不能提交。

后续 F 阶段已补齐语义 DOCX 的原生列表编号，固定 r10 的新导出为 depth 0/1/1；Markdown 层级/硬换行与自有 Word 预览续号也已验证。前述静态项目符号结论是当时证据，现状与 DOCX/HTML 导入缺口见 [列表导出契约](hcd-list-export.zh.md)，不改变 E05 剩余设备验收。
