# 自定义节点的显式业务版本迁移

2026-10-25 更新：资源归档、可移植导出和富文本容器已接入，当前协同 wire 模型为 3、通用 envelope 为 2；以下早期保留项以[最新实现与边界](hcd-node-resources-and-rich-content.zh.md)为准。

当前为结构化流式编辑器的 `explicit-v1` 实现。管理平台、实际提醒发送继续后置；本阶段不表示所有格式、资源、marks 和容器 SDK 已完成。

## 宿主接口

`NodeExtensionDefinition.migrations` 注册从旧业务版本到当前版本的同步迁移。每个 `fromVersion` 只执行到下一整数版本，按完整路径依次执行；缺步骤、未来版本或显示类型不符时没有可执行路径。最多注册 16 步，也最多一次前进 16 个版本。示例：

```ts
const task: NodeExtensionDefinition = {
  type: 'example.task', version: 2, display: 'inline', label: '任务',
  defaultData: { caption: '审核', done: false },
  validate: data => typeof data.caption === 'string' && typeof data.done === 'boolean',
  fallback: data => `${data.done ? '☑' : '☐'} ${data.caption}`,
  migrations: [{
    fromVersion: 1,
    validate: data => typeof data.title === 'string' && typeof data.done === 'boolean',
    migrate: ({ title, ...rest }) => ({ ...rest, caption: title }),
  }],
}
```

回调接收深冻结的 JSON 副本。先校验共同 envelope 的大小、层级、键和数字范围，再执行源业务校验；每步输出继续受共同模型检查，下一步校验中间数据，最终按当前业务 schema 与属性定义校验、生成可读 fallback。异步、抛错、非法 JSON、过大数据或两次计算不一致时拒绝预览。可信宿主仍须保证纯函数与确定性；双算检查不构成远程脚本沙箱。

`NodeExtensionService.previewMigration(node)` 返回冻结的 `{before, after, versions}`，不修改正文、Y.Doc、规范版本或外部业务系统。保留 `instanceId`、type、inline/block 显示类型，仅更新业务 version、data 与 fallback。宿主不能通过回调重写节点身份或在行内/块之间搬动节点。

统一命令 `node.migrate` 接收 `{instanceId, expected, after}`。它重新计算并核对预览，按当前选择、权限、文档和注册状态检查后，提交单个正常编辑事务；读取或加载文档不会自动升级。卸载扩展、选区/原文变化、只读、输入法组合期间或预览结果变化均不提交。普通 setNodeMarkup 不能绕过未知版本的保护。

`capabilities()` 当前报告 `migrations: explicit-v1`、`collaboration: fields-v2`。没有业务 codec 或缺少迁移路径时，节点继续以原 fallback 只读展示，保留完整载荷；普通正文仍可编辑。当前提交适配器服务于结构化 Word/HTML/Markdown/TXT 流式编辑，PPT/PDF 固定对象尚未接入该节点迁移命令。

## 属性面板交互

选中旧版本行内/块节点，在右侧“节点属性”点击“预览节点升级”，显示版本路径、升级前后可读内容，以及可展开的数据变化；点击“应用升级”才进入正文、协同、正常保存和自己的撤销历史。取消不修改节点。

同伴先修改或升级后，旧预览失效，应用禁用。重新载入属性会同时清除失效预览，不保留一个无法执行的旧升级表单。升级后继续使用当前 codec 的属性编辑；未应用的表单数据仍留在本机。已保存的旧规范版本可历史查看/还原，未单独保存的迁移前状态可通过自己的撤销恢复，不承诺每次预览生成规范版本。

## 跨版本协同

共同 envelope 仍是 `hcd.extension/1`；业务 version 与协同记录版本不是同一概念。原 `hcd-node-edits/1/*` 集合保留，兼容读取既有 v1 记录；新写入使用 v2 intent。

- 相同业务版本的普通属性修改继续按字段合并。
- 迁移是完整 envelope 的 schema 屏障。只有共同新 schema 基线之后的同版本字段修改才可合并，不能把旧字段 title 与新字段 caption 拼成一个节点。
- 旧版本修改与迁移、不同迁移分支并发时，保留完整版本候选；内容完全相同的并发迁移可收敛。
- 未解决冲突时，规范保存、导出和关闭前保存不能绕过。右侧提供版本、可读内容和可展开候选数据，选择完整节点；候选菜单的长文字有显示上限，完整业务数据不截断。
- 选择绑定完整 intent ID 集，迟到选择不能解决已变化的候选。选择本身可撤销，原候选记录仍保留；选择旧候选后仍按未知旧版本只读展示，可再次显式升级并带入该候选的业务修改。
- 迁移、选择和普通修改使用既有自己的历史；撤销迁移不会删除同伴的独立正文。删除与属性修改竞争、长历史压缩、更多复杂分支与多实例仍需继续验收。

保存服务不加载业务 JS。合并后的可读 materialization 绑定精确记录集、schema version 和 data；只有加载匹配 codec 的可写宿主派生同版本合并 fallback。缺少 codec 不允许任意表单改写未知数据；完整候选选择仅保留已存在、通过共同模型检查的候选，不是任意修改未知节点。

## 协议与升级部署

非固定布局 WebSocket 声明 `hcdNodeEdits=2`，协商及保存状态报告 `nodeEditVersion: 2`，原生共享读写使用 `X-HCD-Node-Edits-Version: 2`。新客户端在上传本机缓存前拒绝缺声明、v1 或未知服务；新 sidecar 在接收正文前拒绝旧客户端。

原生持久描述符从 v1 向 v2 单调提升，epoch reset/还原保留要求。达到 v2 后，属性协议 v1 的 shared read、put、checkpoint 都返回 426，不能覆盖 schema 候选。文件模式与 PostgreSQL 适配器均实现该检查；后者本阶段只有编译/静态路径证据，没有真实数据库或跨机器多实例验收。规范文件读取/导出与共享草稿协议分开。

需配套更新嵌入包、sidecar 与原生服务，并刷新旧可写窗口。兼容读取 v1 记录不代表允许 v1 写入 v2 状态；不以清除草稿、重置文档或静默降级来完成升级。业务 JSON 不包含宿主可执行代码，离线 HCD 仍可保留并读取新旧业务版本及 fallback。

## 验证证据与边界

- 注册与事务、行内/块两端的迁移、后续同版本合并、旧版本冲突、完整候选选择、自己的撤销/重做、过期/只读/卸载拒绝、非法/异步/不确定回调、缺路径与未来版本均有针对性测试。
- 独立真实 WebSocket：旧 codec 的离线修改与迁移相遇，保存拒绝，选择旧候选并再升级保留 Bob 修改；迁移、撤销、重做分别保存 r4/r5/r6，九份实际 DOCX/PDF/Markdown 回读、未知 v77 载荷、四个出现身份、原始图片媒体及离线 HCD 保留。
- 有意重启自有 API/sidecar/Vite，再由两个新 socket 读取，确认版本、正文和无冲突状态；不是观察超时后重启。
- 单独真实 CUA 样例验证行内迁移、自己的撤销/重做保留 Bob 正文、块迁移、同伴使预览失效、重新载入、缺 codec 阅读、迁移后继续改属性，以及 v2 协议下还原 r6 为新 r8。r3-r10 与十二份实际文件回读通过。
- 另一个持久化 CUA 样例验证：已经发布新版后，旧业务 codec 的离线候选加入，规范版本保持不变并拒绝保存；用户查看完整数据、保留旧版本，再次迁移带入离线修改。

证据分别来自本机样例、实际 HTTP/WebSocket、浏览器和独立文件回读，不构成生产、真实 PostgreSQL、多实例、设备 IME 或完整 Office 视觉验收。长时受管会话曾清理 `/tmp` 并终止临时服务，已将后续样例放入 Git 忽略的 `target/hcd-preview-runtime`；先前文件的 SHA/检查证据仍保留，不把已经清理的文件描述成仍在线。

回归另发现一次并行 SSE 测试报写锁占用。克隆描述符测试独立复现：仅关闭 guard 文件时，仍存活的重复描述符继续持锁。现由 guard 显式 unlock，包含诊断写入失败路径的 RAII 释放；修复后 67 项核心与 144 项 CLI 单元通过。该实验说明一个真实的锁释放问题，不将其追认为先前 SSE 失败的唯一原因。

复验（先构建原生二进制及安装编辑器依赖）：

```bash
python3 scripts/hcd-mention-preview.py --extension-nodes --node-migrations --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-node-migrate
# 使用上一步打印的隔离 root；以下三个命令只适用于尚未被页面编辑的初始样例。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-node-migrations.mts /absolute/root/private.json
python3 scripts/hcd-node-migrations-files.py /absolute/root/private.json
python3 scripts/hcd-node-model-fence.py /absolute/root/private.json
```

页面冲突探针是 `hcd-node-migration-offline-peer.mts`：它输出 READY 后，页面先迁移并保存，再在同一 root 创建 `migration-offline-peer-resume` 文件让旧 schema 候选重连。最终页面选择、再次升级后可用 `hcd-node-migration-browser-files.py ... --conflict` 核对固定 r3-r7 流程。不要将固定版本/数量探针直接用于用户文档或另一流程。

预览脚本拒绝复用仍在运行的同一 root，清理只处理属于当前 owner 的页面；`--reuse-root` 需先等旧进程明确退出。复用时仅续签相同本机样例身份、scope、时长的令牌，私有令牌文件不进入仓库。

- [socket 与九份文件证据](../assets/hcd-extensions-2026-10-24/node-migration-file-evidence.json)
- [有意重启证据](../assets/hcd-extensions-2026-10-24/node-migration-restart-evidence.json)
- [CUA r3-r10 文件证据](../assets/hcd-extensions-2026-10-24/node-migration-browser-file-evidence.json)
- [跨版本完整候选画面](../assets/hcd-extensions-2026-10-24/node-migration-schema-conflict.png)
- [原生协议门槛](../assets/hcd-extensions-2026-10-24/node-model-fence-evidence.json)


### 2026-10-25 收尾验证

最终前端 468 项测试与 TypeScript/standalone/embed 构建通过。持久样例的 r3-r7 确认迁移与完整候选选择，十二份实际 DOCX/PDF/Markdown 均精确包含各版本替代内容，原图和四个身份保留。r7 后观察到 Alice 的任务 done 字段变为 true 并保存为 r8；触发动作未确定，未擅自还原。随后实际点击块选择、在线协作跟随/停止和导出未增版本。r7/r8 的浏览器下载分别独立回读，与各自不可变正文匹配，协作姓名不进入文件。此处保留该观察边界，不将 r8 冒充固定 r3-r7 探针的一部分。

- [完整候选页面与实际下载回读](../assets/hcd-extensions-2026-10-24/node-migration-schema-browser-evidence.json)
- [当前持久样例十二份文件与离线回读](../assets/hcd-extensions-2026-10-24/node-migration-schema-file-evidence.json)
- [独立旧业务 codec 的离线 socket](../assets/hcd-extensions-2026-10-24/node-migration-offline-peer-evidence.json)
- [r8 节点属性及固定导出状态](../assets/hcd-extensions-2026-10-24/node-migration-final.png)
- [右侧在线协作跟随](../assets/hcd-workbench-2026-10-24/online-collaboration-final.png)
- [最终检查与源码摘要](../assets/hcd-extensions-2026-10-24/node-migration-validation-evidence.json)
