# 人员目录、引用载荷与默认 @ 接入进度

**2026-10-25 后续：** 已补已有人员引用的搜索改绑、同一 occurrence 的离线完整候选、明确选择/自己的撤销重做，以及客户端和协调器共享的元数据保存门禁。当前协同声明为 4；[改绑契约、升级边界和实际文件证据](hcd-reference-retarget-conflicts.zh.md) 是本项的后续状态。下文 D1/D2/D3 的历史说明保留原验收时间，不能据其“仍未完成”列表忽略后续节点/AI 阶段；用户中心、旧 epoch 恢复、删除竞争和完整生产验收仍未完成。

2026-10-24。D1/D2 本机首版已接通原生人员接口、规范引用、默认 `@人员` 菜单、可信操作来源、协同保存与导出；D3 补充引用搜索、人员资料/停用状态和当前/历史正文定位。命令 SDK 在完整结构化 Word 中返回 `mentions: person`；其余工作区仍为 reserved。**完整 D/E/F 仍未完成：用户中心适配、并发改同一 occurrence 的冲突、旧 epoch 离线恢复、通用节点 SDK、AI 和跨格式对齐仍需推进。** 管理平台不做；没有通知渠道、调度或发送服务。

## 已实现的链路

1. 服务端从当前文档 token 的稳定 `sub` 获取人员访问者，不采用浏览器 clientId、头像姓名或客户端 tenant。`GET /v1/documents/{id}/mention-options?kind=person&q=&cursor=&limit=` 支持同名区分、姓名/辅助标签搜索及 1–50 条分页。没有目录配置返回 503；配置损坏整体拒绝，公共错误不返回配置中的私有值。
2. `PeopleDirectory` 与 Presence 分离。当前文件适配器读取服务根目录 `people/{documentId}.json`；候选同时受文档成员访问策略、人员可见范围、可提及范围和 active 状态限制。目录可以列出离线人员，不因在线自动添加陌生人。配置来源是可信服务端，不提供目录编辑或用户管理 UI。
3. 游标绑定文档、访问者、搜索词、当前 ACL 和目录内容，120 秒失效；使用独立 audience/issuer 的签名游标，目录指纹另做 HMAC，不公开私有配置的原始哈希。改名、禁用和范围变更会使旧分页失效；不同用户不能复用游标。人员及引用接口使用 no-store，防止读取过期权限范围的缓存。
4. `POST /v1/documents/{id}/references/resolve` 每批最多 100 个目标。无权限和未知 id 都返回 restricted、不返回名字；失效人员不回传新姓名；当前目录信息不覆盖正文快照。只读 token 的 `canMention` 为 false。文档/日期/业务 kind 当前返回 unsupported，保留同一目标结构，不自动创建提醒。
5. 规范行内 `reference` 同时保存稳定 occurrence、目标和可读快照。原生 HTML span 保存经过转义的载荷，正文始终有 `@姓名`。HCD 目录包复制/离线归档保留载荷和出现 ID；读取不依赖人员目录或网络。
6. `GET /v1/documents/{id}/references?revision=N` 仅从已提交不可变版本提取，返回 blockId、childPath、inlineIndex 和版本；这些锚点只能用于对应版本，不能当作实时游标。未保存 CRDT 增量不等于已关联。
7. 每个相邻规范版本可重建 created/retargeted/removed 转换，带稳定 eventId、文档 scope、来源、执行人和提交时间。普通正文、移动和显示快照改名不产生新关联；同一版本反复查询结果不变。还原按原生不可变回执的目标/父版本/哈希确认 source=restore，不能只靠 patch ID 前缀冒充；普通文字、结构和批注补丁在发布前拒绝还原专用的 restore- 命名空间，避免产生验证不通过的伪还原版本。接口固定声明 reminders.enabled=false、delivery=disabled；没有发送动作或“已提醒”回执。
8. HTTP 结构补丁覆盖客户端传入 actor，执行人来自已鉴权 token。新引用/改目标重新检查当前目录与权限，不授予文档访问；旧引用保存不依赖当前目录可用。完整协同 checkpoint 对新引用要求由可信协调服务提交 `referenceAuthors`，并绑定到精确请求的 HMAC 身份；浏览器节点中的 actor 不作为证据。
9. 未理解引用的旧完整快照不能把引用变成普通文本后保存：当前或请求中有引用时必须声明 referenceVersion=1。含引用文档的结构补丁需要 `X-HCD-Reference-Version: 1`。首次使用后 manifest 增加 inlineReferences=1，保留为历史的能力要求；不认识此必需模型的旧二进制拒绝修改。未知载荷/版本、重复出现 ID、与快照不符的 fallback 和提及文字局部 splice 均在发布前拒绝。
10. 前端 hcdMention 是长度 1 的原子节点，显示和纯文本提取均为 `@姓名`；参考目标 ID 不显示成正文。复制/粘贴生成新 occurrence、保留目标和姓名快照，移动/同步/撤销保留原 occurrence。code/link 等不兼容 mark 在本地和接收投影时拒绝，避免原生保存时才发现模型不一致。

## 配置样例

下列文件是服务端文档范围的目录，不是全组织人员表，也不会自动分享。人员 id 应与已有用户中心的稳定身份保持一致；文档 ACL 仍单独控制访问。

```json
{
  "schemaVersion": "hcd-people/1",
  "generation": 1,
  "people": [
    {
      "id": "person-a",
      "label": "同名成员",
      "detail": "产品组",
      "active": true,
      "visibleTo": ["alice"],
      "mentionableBy": ["alice"]
    }
  ]
}
```

文件最多 1 MiB、10000 个唯一人员；字段和范围有界。生产用户中心适配、可信工作区/租户映射、审计与集中目录更新仍待接入，不能把本机文件测试当作真实账号系统验收。

## 规范载荷及保存契约

```json
{
  "text": "@同名成员",
  "reference": {
    "type": "hcd.mention",
    "version": 1,
    "mentionId": "m_0123456789abcdef0123456789abcdef",
    "target": { "kind": "person", "id": "person-a" },
    "snapshot": { "label": "同名成员" }
  }
}
```

`mentionId` 一次出现一个，target.id 才是人员身份。文档最多 10000 个出现；嵌套和载荷受限，未知字段不静默丢弃。目标 kind 保留命名空间，当前新增授权只开放 person。目标改名不修改 id，也不自动刷新已保存快照。

协同服务现在同步监听服务端 Yjs update，直接读取已鉴权连接的操作来源；不再通过延后的 onChange hook 把多个事务后的最终投影归给第一个人。具体 occurrence 的新增、改目标和删除都记录作者；移动和改显示快照不创建关联。台账与文档、epoch、lineage、规范基准和精确草稿观察值一起签名，写进持久协同状态。客户端修改、缺失或过期的签名不能被“另一个人继续打字/点击保存”补成可信作者；未知来源保留为不可提交的恢复数据。

每次 checkpoint 捕获具体 `referenceAuthors` 和贡献者，并沿用原尝试直到结果确定。保存期间继续输入不会改掉已发送的作者。原生 API 对每个新增/改目标重新校验实际作者，而非所有贡献者中任意一人；删除需要对应已鉴权贡献者，但不要求目录在线。原生不可变 revision 保留逐引用作者，关联查询可区分同一批次中 Alice、Bob 各自的提及和删除；旧协同版本缺少逐引用作者时返回未知，不假冒首位贡献者。删除保存后自己的 undo/redo 重新出现原 occurrence，按该次实际操作者重新授权；新副本另分配 ID。各层稳定人员 ID 统一允许命名空间和 Unicode，显示名按原生 64 UTF-8 字节边界处理。

默认菜单在可编辑正文/标题的 `@` 处触发，也可通过统一命令 `reference.person`（插入工具栏、右键、命令面板）打开；候选插入走 `reference.person.insert`，再次检查当前选区及触发文字。异步查询按文档/访问者/搜索/触发位置隔离并取消旧请求；支持默认推荐、输入搜索、下一页、上下键、Enter、Escape、失焦与输入法组合期间抑制。失败保留输入并显示重试。选中候选才生成 occurrence 和写入正文；服务端最终校验仍可因权限变化拒绝保存并保留草稿。提及不能进入链接/代码，块转代码的菜单也明确禁用。自定义候选源/任意业务 kind 的宿主注册接口尚未开放。

## 导出边界

已通过实际文件回读的 DOCX、PDF、Markdown 会保留两个同名提及的可读姓名。业务关联静态化，`HCD_REFERENCE_FLATTENED` fidelity warning 按出现记录；不依赖在线目录才能打开。Native HCD 目录包保留稳定 id 与载荷。测试用受控 ZIP 往返证明目录包元数据可携带，**当前 CLI 未提供 hdoc pack/unpack 命令，不将此测试当成新增命令交付**。

HTML、PPTX、XLSX、跨格式再导入、完整逐节点兼容报告还未通过本轮专项验收。导出区已在对应保存版本有提及时说明：可读姓名会保留，在线身份关联和提醒不会包含在离线文件中。缺失业务 codec 不允许静默删除；通用自定义节点 SDK 仍在 E 阶段，当前原子节点并不等于任意节点注入已开放。

## 验证与剩余工作

- 核心：载荷原生 HTML 往返、Unicode/转义、重复 ID 拒绝、局部文字修改拒绝、还原及不可变历史、未知模型拒绝、事件去重。
- 服务：不同访问者候选、离线人员、同名区分、分页身份/范围绑定、无目录/损坏目录、受限解析、单个 occurrence 的执行人授权及未知客户端保护。
- 前端模型：atom 编解码、纯文本姓名、复制/粘贴的新身份、真实 Yjs 同步与自己的撤销重做、未知 schema/不兼容 mark 拒绝。
- `python3 scripts/hcd-people-references.py`：隔离原生 HTTP 服务、目录缺失时真实 WebSocket 协同保存、规范关联查询和还原、三种实际导出与离线 HCD 重开。证据：`docs/assets/hcd-mentions-2026-10-24/people-reference-api-evidence.json`。

D2 当前验证：383 项前端/服务测试；`cargo test -p hcd-core -p officecli` 全部通过（61 核心、125 CLI 单测及 241 集成测试，共 427 项）；clippy、格式、standalone/embed 构建通过。真实 WebSocket 验证一批提交中不同作者、无权限目标不能借另一个贡献者保存、删除与跨保存 undo、已有引用在无目录时保存及三种实际导出。两份真实浏览器验证同名选择、默认/分页、失败保留与重试、Bob 保存 Alice 的提及、自己的撤销/重做和同伴输入保留、右侧在线协作跟随，以及引用静态导出的说明。固定 r2/r3/r4/r5 原生回读确认稳定身份、逐引用作者、两位不同人员、离线目录包、姓名和图片文件；Awareness 姓名没有混入导出。

新增证据：`docs/assets/hcd-mentions-2026-10-24/{collaborative-reference-evidence,mention-browser-evidence}.json`，同目录菜单、失败、协作与导出截图。`python3 scripts/hcd-mention-preview.py` 启动独立本机双页面测试文档；终止后只清理其服务/页面，保留临时 bundle。`python3 scripts/hcd-mention-preview-verify.py <private.json>` 回读文档中所述 r2–r5，不驱动或模拟浏览器。当前浏览器联测使用 Vite 源码页；库构建已通过，尚无真实宿主发布、用户中心、物理设备输入法、PPT/PDF 人员交互或多实例验收。

## D3：引用资料、搜索和当前/历史正文定位

- 统一命令 `view.references` 在插入、视图、修订及命令面板打开右侧“文档引用”。每页最多 50 处，按文档保存姓名/当前段落搜索；分开展示已保存提及和本机新增、变更、删除草稿。搜索不依赖仅覆盖当前页的在线人员解析结果。
- 正文提及支持点击或键盘 Enter/Space 打开人员信息；按实时 occurrence 和目标重新校验位置，跟随内容移动，目标变化/删除后不跳到另一人的引用。浮层和侧栏只读，不改名、不重定向。已保存姓名与服务端当前姓名分开；停用/无权限/不支持/目录故障保留快照，隐藏未授权的当前姓名与详情。解析按文档、token、目标集合和可见状态隔离，关闭/失权取消请求；超时、刷新和前台定时刷新不写正文。
- 当前定位重新扫描实时节点身份，选择整个原子节点并退出成员跟随，只滚动文档区域。历史查询增加可选 `locations=true`，返回固定 revision 的 chunkSequence/indexPage；原生校验对应 chunk 中的引用，不将实时段落位置当作历史位置。历史定位按需加载目标分块，在只读原文高亮，并报告缺失/变更；不会借用当前 Tiptap/Yjs 正文。
- 在线成员、操作位置、定位和跟随继续集中于右侧“在线协作”。本轮再次验证点击跟随显示指定成员和“停止跟随”。

真实浏览器使用本地 debug 长文：80 段、6400 个交替粗体行内 run、3 个原生 chunk，首尾各一处同名提及。验证末尾当前定位、搜索空结果、目录改名时保留正文快照、停用人员隐藏当前详情、历史 chunk 2 加载/高亮与在线面板跟随；所有查看操作后规范 head 仍为 r2。只读资料/列表，以及无权限/目录故障资料的专项浏览器交互仍待验证，API/模型测试不能替代这些。

这份用例发现并修复两处热点：前端块移动候选反复遍历被保护子树，改用不可变节点缓存及一次扫描的保护边界；原生投影对每个 source-map ID 搜索整段 HTML，改为一次解析段内 ID。相同本地 debug 数据，投影 JSON 完全一致，CLI 24.133→11.288 秒，HTTP 引用查询 20.834→3.386 秒。仍会物化完整语义投影，不是生产容量或延迟承诺。

验证更新：前端 388 项，原生 428 项（62 核心、125 CLI 单测、241 集成），clippy/fmt 和 standalone/embed 构建。原生 HTTP/真实 socket/常规三格式导出回归通过，新增不可变 chunk 定位匹配检查。长文 r2 的真实 DOCX/Markdown 回读保留两处姓名、末段和图片，目录临时新姓名及 Awareness 姓名未进入文件；**同一长文 PDF 请求超过客户端 120 秒，未取得可验收的文件**，采样显示导出子进程在 ironpress 字体 shaping/行宽计算，单列为后续性能与导出问题，不靠增大超时宣称通过。

证据见 `docs/assets/hcd-mentions-2026-10-24/reference-{navigation-browser-evidence,navigation-file-evidence,performance-evidence}.json` 及 `reference-{current-name,inactive,historical-location,online-follow}.png`。`scripts/hcd-mention-preview.py --long-document --pages-prefix .hcd-reference-docx` 可启动独立用例；`--reuse-root` 只用于已有测试根目录，保持原 token/epoch/文档，不能当作权限续期入口。

下一步：长文 PDF shaping/超时、只读/失权资料 UI 复验、同一 occurrence 并发改目标冲突、旧 epoch 离线引用恢复及真实输入法/长文容量验收；继续 E/F 节点 codec SDK、AI，以及尚未完成的 PPT/PDF 对齐和布局能力。提醒投递、管理平台保持后置；不把这份本机首版当作全目标完成。

## D4 导出补验更新

D3 的长文 PDF 缺口已有后续修复，不能再把当时 120 秒客户端停止等待等同于原生导出失败。开发依赖优化、原生硬换行打印适配及跨样式超宽词组换行补丁后，最终 10 页 PDF 通过全部页面渲染与实际浏览器下载回读：2 处提及、80 段、6400 个交替样式字符完整，r2 没有变化。人员快照及离线可读姓名保留。HTTP 运行期限、并发上限、超时终止/回收和临时目录清理已做原生只读接口验证；“停止等待”只终止客户端等待，不中断已开始的保存，也不假称服务端任务已取消。详情见 [D4 进度](../hcd-optimization-progress.zh.md) 与同目录导出证据。此项不补代人物只读/受限 UI、并发重定向、旧 epoch 恢复、节点 SDK、AI 或跨格式编辑的验收。
