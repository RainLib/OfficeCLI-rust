# HCD 优化进度与验收

2026-10-30：普通语义/inline1 恢复包 File/Blob 现直接交给 Worker，避免解析前主线程整包读取和重复复制，保留包摘要身份、资源独立校验及明确确认。104 项专项、含 TypeScript 双入口构建及真实 Node Worker/两份 6 MiB 文件回读通过，损坏资源拒绝、head r8 不变。普通 Chrome 文件选择因扩展权限及原生捕获故障未完成，不作为浏览器性能/完整交互通过；见[实现、复验和范围](design/hcd-recovery-file-worker.zh.md)。所有格式、正文分段、复杂排版和生产目标继续；管理平台/提醒后置。

2026-10-30：区域 Word 备份反馈最终 TypeScript/双入口构建已通过，37 项相关回归通过；普通浏览器仍待验收。页码域另经独立 LibreOffice 实际打印/另存：PAGE、NUMPAGES 和分节编号保留，SECTIONPAGES 未计算，明确记录部分不通过；产品新增目标应用支持提示，34 项相关检查与最终双入口构建通过。详见[应用兼容实测](design/hcd-word-field-application-compatibility.zh.md)。不将外部打印当作编辑器分页/重算，完整格式目标及管理平台/提醒后置约定保持。


2026-10-30 页码节点编辑器接线：原生 `inline-v1` 声明、受控内置注册、统一菜单/命令、有限属性和禁用附件策略已接通；前端完整 2043 项、33 项专项、TypeScript/双入口及原生构建通过。浏览器插入/属性保存与重开、真实双成员服务个人撤销保留同伴、页眉节点、实际设备下载读取，以及 CLI DOCX/HCDZ 和 79 个规范文件/r0–r8 历史有分层证据。浏览器完整双成员流程、未提交备份恢复、分页/重算/目录与整体目标继续开放，见[实现与准确边界](design/hcd-word-numeric-field-ui.zh.md)。管理平台和提醒后置。


2026-10-30 最新页面设备增量：普通区域 Word `/2` 的完整页面请求已迁入 IndexedDB，异步落盘后提交、跨窗口 CAS、旧标签页不同请求排队保留/去重、原请求下载及恢复触发已接通；取消意图在重开/服务重启后继续原取消。实际三角色无刷新页面交接、关闭重开签名核对、同账号窗口完成通知、两次服务重启与受控旧存储两请求迁移通过；DOCX/HCDZ r1–r5、再导入及实际 `/6` 备份独立回读通过。最终前端 **1962 项**、30 项相关专项及含 TypeScript 的双入口构建通过。**停房草稿检查点编号仍用标签页存储，历史私有草稿比较/合并、结构自身撤销、原稿混合导出、分页及各格式完整目标继续开放**；管理平台和提醒后置，见[页面设备请求与准确边界](design/hcd-word-page-device.zh.md)。

2026-10-30 最新正常链接增量：区域 Word `/2` 的插入操作区和命令面板已接页眉/页脚“链接前一节”、来源及逐批影响确认、IndexedDB 完整原请求、核对/同次重试/未准备取消。实际三角色普通窗口无刷新接续，成功丢响应的自动重试只产生原 r3；关闭重开及侧车重启后核对原版本、源页脚迟到输入保护与取消、DOCX/HCDZ r1–r5 和实际 `/6` 设备备份回读通过。最终前端完整 **1954 项**、72 项相关专项及含 TypeScript 的双入口构建通过。**历史私有草稿比较/合并、页面请求跨标签页持久化统一、结构自身撤销、原稿混合导出和完整格式清单仍开放**；重启后的取消 UI 及所有旧成员无缝重连不在本批已证范围。管理平台和提醒后置，见[正常链接与准确验收范围](design/hcd-word-link-requests.zh.md)。

2026-10-30 最新链接会话增量：普通区域 Word `/2` 已接链接状态查询、原生固定记录/请求摘要证明、空传输新房间与原视图/个人历史/设备日志桥接，并显式声明链接能力。真实三个普通窗口无刷新自动接续，双方草稿保留；同段落同伴续写后个人撤销/重做、继承页眉编辑、设备备份下载与刷新重开通过。DOCX、HCDZ r1–r7 和 `/6` 备份独立回读通过。前端完整 **1945 项**、24 项相关专项及含 TypeScript 的双入口构建通过。**正常链接创建/影响确认 UI、设备持久原请求、历史草稿比较/合并仍未完成**；服务 API 发起不等于普通链接按钮交付，见[链接会话与证据边界](design/hcd-word-link-session.zh.md)。完整格式目标保持，管理平台和提醒后置。

2026-10-30 最新中断链接恢复增量：版本 5 原链接日志现已接通停止恢复 HTTP 和普通兼容性恢复页，支持检查原请求、分批影响说明、明确确认、核对原生签名及按 head 提升；历史 head 前进时显示独立状态并保留双方私有草稿，不安装旧基线。真实成功丢响应、侧车重启、普通恢复 UI 及正常保存有本机浏览器证据；历史分支的 r3 不变，DOCX/HCDZ r1–r3 回读通过。前端完整 **1938 项**及 TypeScript/双入口构建通过。**正常链接创建/确认、设备完整原请求、原窗口自动桥接、历史草稿比较/合并仍未完成**；详情见[中断链接恢复及边界](design/hcd-word-link-recovery.zh.md)。完整格式目标保持，管理平台和提醒后置。

2026-10-30 最新活动链接增量：实际侧车已接确切请求的停写/排空、签名准备/确认、旧房间退役和新宿主安装，以及状态、未准备取消和已安装房间的原生回执核对。两套真实服务/三角色 Socket 样本覆盖原生成功丢响应、最终响应丢失、同次重试只提交一次、草稿保留、侧车重启后核对及续存 r4；DOCX/HCDZ r1–r4 回读通过。前端完整 **1933 项**及 TypeScript/双入口构建通过。**原窗口自动链接桥接、设备完整原请求、未完成链接的停止恢复 HTTP/UI 与正常确认界面仍未完成**；不能把新会话服务验证当作正常链接交互完成。详见[活动链接及证据边界](design/hcd-word-active-link.zh.md)。完整格式范围保持，管理平台与提醒后置。

2026-10-30 最新链接日志/停止恢复增量：私有签名链新增版本 5 的确切链接请求、原生签名确认及专用提升，普通保存不能冒充确认或清掉未知请求。真实 TCP 丢响应、原生重启和另一 Node owner 核对原 r2 后，保留草稿正常保存 r3；实际侧车加载已提升日志，三名新 Socket 成员继续保存至 r5，DOCX 与 HCDZ r1–r5 回读通过。另一还原样本确认历史 r2、保留签名草稿并拒绝提升，规范 r3 未被改写。前端完整 **1926 项**、12 项新专项、TypeScript/双入口构建通过。**活动链接提交、在线房间替换与客户端桥接、设备原请求和正常确认/恢复界面仍未接通**；历史草稿合并与原稿混合导出继续。停止协调器与新会话证据不等于活动房间交付，详见[日志、验证及边界](design/hcd-word-link-journal.zh.md)。完整格式范围保持；管理平台和提醒后置。

2026-10-30 最新原生链接事务增量：增加独立协作请求摘要、模型 3 提交及固定版本签名回执；后续正文/页面保存和显式还原后，原请求仍返回原链接版本，不回退 head。修复取消门禁遗漏已提交链接，并禁止页面、独立区域创建与协作链接互用编号。原生相关 **13 项**、核心/DOCX **203 项**、TypeScript 专项 **16 项**与类型检查、原生构建通过；独立原生 HTTP 样本验证 r1–r7 语义 DOCX 重新导入、原图片字节及 HCDZ 回读。**侧车签名日志/重启恢复、在线房间替换、设备原请求和正常链接确认仍未接通；原稿混合导出仍明确拒绝。** 本批没有前端全量或双入口构建新结果，没有生产/真实设备验收，见[契约与证据](design/hcd-word-link-transactions.zh.md)。完整格式清单继续；管理平台和提醒后置。

2026-10-30 最新链接预检增量：修复当前工作树的 TypeScript 类型错误；区域 Word `/2` 新增活动“链接前一节”只读预检，核对原独立/前节继承区域及后续影响，保护双方未保存内容和图片任务，保留不相交正文草稿。真实服务路由鉴权遗漏已通过本机 HTTP 回归修正；前端完整 **1914 项**、原生 5 项及核心链接 10 项、TypeScript/双入口与原生构建通过。实际三角色 Socket 验证空白/图片继承预检、普通内容保存至 r3/r4 及下载 DOCX/HCDZ 回读。**尚无正常链接确认、提交和签名恢复闭环**，不将预检视为完整链接功能；Clippy 的本轮未修改区域错误与首次失败均保留，见[证据及剩余链路](design/hcd-word-link-preflight.zh.md)。其他格式和完整清单继续，管理平台及提醒后置。

2026-10-30 最新正常创建与原请求增量：区域 Word `/2` 的插入操作区及命令面板已接创建独立页眉/页脚、影响确认、设备完整原请求、结果核对和未准备取消；原请求使用跨窗口 CAS 的 IndexedDB，关闭标签页后仍保留。新增活动签名回执核对不重载共享日志或重新提交；取消意图在进程重启后继续同一编号。前端完整 **1902 项**、34 项专项及含 TypeScript 的双入口构建通过；普通 Chrome 故障注入、DOCX/HCDZ 和设备备份的确切验收范围见[正常创建与证据](design/hcd-word-story-requests.zh.md)。恢复链接前节、复杂资源复制、结构/页面字段历史、旧协议迁移及各格式/生产条件仍开放；管理平台和提醒后置。

2026-10-30 最新正常 story 会话增量：最终前端全量 **1891 项**、40 项专项及含 TypeScript 的双入口构建通过。普通区域 Word `/2` 现声明 story 能力，并按确切轮次及原生固定版本证明自动使用空传输加入新区域，保留个人内容历史和设备日志。实际 Chrome 三角色无需刷新切换、同伴输入后的个人撤销/重做、独立页脚继续编辑及设备重开通过；DOCX、HCDZ r1–r7 和 `/6` 设备备份回读通过。固定投影读取增加同一租约已确认日志 tip 变化时的有界重读，未变化拒绝和写请求不重试；首次浏览器核验失败与含图片页眉复制拒绝均保留，见[会话与证据边界](design/hcd-word-story-session.zh.md)。正常创建确认、浏览器持久请求/取消核对、恢复链接前节、复杂资源复制、页面字段历史与生产场景继续开放。管理平台和提醒后置。

2026-10-30 最新活动 story 事务增量：实际侧车已接受审阅提交、成员停写/排空、原生签名确认、旧宿主退役、新宿主暂存安装和确切轮次查询；页面/story 共用阶段内核但身份和状态独立。修复模型推进后的 owner 续期声明。真实侧车/原生/Socket 样本验证成功后断 TCP 响应、原请求重试只创建一次、双成员迟到草稿保留和新房间续存 r3；首次失败请求另经进程重启按签名恢复至 r3。DOCX 独立页脚关系及 HCDZ 回读、普通 Chrome 在新模型上页面设置/个人历史/设备备份回归通过。完整前端 **1882 项**、24 项专项及含 TypeScript 的双入口构建通过，详见[活动提交与证据边界](design/hcd-word-active-story-submit.zh.md)。正常创建确认、浏览器持久请求/取消核对、自动 story 桥接及恢复链接前节仍未完成；管理平台与提醒后置。

2026-10-30 最新 story 预检增量：实际侧车新增活动房间的独立页眉页脚只读预检，核对当前 owner/租约/版本、实际继承来源和影响范围；来源含未保存文字或图片任务时拒绝复制，不相交正文草稿保留。隔离 Chrome 三角色及真实原生服务验证稳定预览、不增加版本、只读/旧模型拒绝、正文与页脚续存 r3，DOCX/HCDZ 回读通过。完整前端 **1879 项**、新增 5 项专项及含 TypeScript 的双入口构建通过，详见[活动 story 预检与未完成接线](design/hcd-word-active-story.zh.md)。当前仅服务预检，正常创建确认、活动提交/房间切换、持久请求和双向链接编辑仍未完成，不能据此开放完整页眉页脚结构编辑。

2026-10-30 最新页面设置增量：区域 Word `/2` 正常操作区已接入“布局 → 页面设置”、发送前完整原请求持久化、核对/同次重试/未准备取消；实际 Chrome 验证正常三角色自动交接、响应丢失后刷新重试、侧车重启后的原生签名回执核对与持久取消。修复取消重试重复停写及旧重放挤掉已完成轮次的问题；DOCX、固定版本 HCDZ 和设备备份回读通过。完整前端 **1874 项**、页面请求专项 **32 项**、TypeScript 和双入口构建通过，详见[正常页面事务、证据及边界](design/hcd-word-page-transactions.zh.md)。这仍限显式启用的 `/2`，旧文档/协议不自动迁移；页面字段自身撤销、story 正常结构操作、分页及跨设备/多实例继续。下方同日较早记录按当时范围保留。

2026-10-26 浏览器区域分段编辑：Word 模型 1/2 自动识别，正文/页眉/页脚文字和映射图片接入既有分段保存、草稿与个人历史；空页脚可新增文字。节属性与共享页眉预览可查看，协作面板可定位/跟随并在 story 内显示姓名和操作高亮。真实三角色 CUA、r2 联合保存、个人撤销/重做、同段冲突、r8 合并、只读下载和无源文件/全历史归档通过。该模式仍不是完整区域富文本 CRDT 编辑器，普通语义文档迁移、布局编辑、正文目录与页码更新继续。见[浏览器路径与验证](design/hcd-word-region-ui.zh.md)。

2026-10-26 Word 区域无源 DOCX 导出：正文分节、独立页眉页脚、首页/奇偶页与共享继承关系进入实际文件；富文本、列表、链接使用所属 part 的关系，图片资源和宽高可保留。当前/历史/离线包及只读 HTTP 下载已验证，旧模型在私有快照内投影，不修改原 head；缺少旧投影身份时明确拒绝。域结果暂静态化，浮动图片转行内，PDF 等区域导出、浏览器区域协作、页码更新与正文目录仍待继续。管理平台和提醒发送未做。见[实现与实际文件证据](design/hcd-word-region-export.zh.md)。

2026-10-26 Word 区域结构增量：模型 2/`hcd-patch/6` 和显式 `--word-regions` CLI 预览接通分节正文、独立页眉页脚的富文本/映射图片联合事务。空区域、来源与锚点隔离、节边界更新、跨模型还原及晚回执、扩展/人员/资源保留已验证。13 项新增、615 项原生/CLI 回归、clippy/fmt/构建、真实 HTTP 及旧模型复核通过；实际页眉换图和几何与三处文字同批保存、失败回滚、离线全历史及图片资源字节通过。浏览器区域协作/个人撤销、当前 HTML 等通用文档迁移、story 创建/链接、页码/正文目录和完整区域导出未完成；普通导入仍默认不启用，管理平台和提醒发送后置。见[完整证据与边界](design/hcd-flow-regions.zh.md)。

2026-10-26 Word 基础能力增量：内部 opt-in 导入新增分节/独立页眉页脚 story 模型及必需能力声明，进入版本资产图。已有正文/页眉/页脚映射文字可联合保存，计算域缓存只读、未知指令不透明保留；源 DOCX 和无源 HCD 历史/还原已验证。14 项新增、602 项原生/CLI 回归通过；补源导出模型校验后相关 52 项再次通过，最终 clippy/fmt/构建及真实鉴权 HTTP 文件通过。普通导入和浏览器区域编辑尚未开放，区域结构/签名协作、页码更新、正文目录和无源区域导出继续；现有标题导航与此前短文入口修正保持。详见[模型、文件证据和边界](design/hcd-flow-layout.zh.md)。管理平台和提醒发送未做。

2026-10-25 PDF 导入/新字保存增量：ASCII85+Flate 反例已可导入；共享间接字体字典正确注册，新中文/emoji 可通过正常 CLI/HTTP 保存。279 项相关原生测试、clippy/fmt/构建及真实当前/历史/离线文件通过。两 actor 顺序保存、原请求重复回执、逆向 patch 保留他人段落和未知字形不推进版本已核对。候选源的新字框/混合字体信息回写仍是已测量的缺口，继续实施；管理平台未做。详见 [PDF 输入与字体保存](design/hcd-pdf-input-and-font-save.zh.md)。

2026-10-25 离线 PDF 增量：无源再导出在页面图像上补入所选已保存版本的 Unicode 文字层；历史/当前文字、四种旋转/裁切选区、continuation、扫描页无伪造文字、10 页像素完全一致及只读鉴权 HTTP 文件通过。修正简单字体 ToUnicode 的中文框宽度，隔离不可见字体与正常字体选择。原生 46+48+157 项测试、clippy 和构建通过。原始 PDF 向量/标签结构不重建；ASCII85+Flate 导入和源子集字体新字写入仍待处理。详见 [离线 PDF 检索与实际文件](design/hcd-pdf-searchable-offline.zh.md)。

2026-10-25 工作区命令增量：属性/协作/导航/缩放和 Word 修订入口已接统一注册表，宿主菜单与快捷键复用权限及原保存/还原路径。494 项前端测试、TypeScript 和 standalone/embed 构建通过；本机三端浏览器、Word r2 正文/图片、PPT/PDF 原始导出、三类离线归档已核对。离线 PDF 的可搜索文字仍是实际缺口，未记作完成。详细证据与剩余范围见 [工作区命令专题](design/hcd-workspace-commands.zh.md)。管理平台未开始。

## 当前推进：长 PPT/PDF 的跨索引协作定位（2026-10-25）

在已有协作面板基础上，补齐未加载页面的主动定位/跟随、已保存对象摘要、跨索引续片完整性及取消/版本边界。跟随状态并入固定高度画布栏，缩略图留固定槽位，避免点击时位置移动。490 项前端测试与构建通过；130 页双格式 CUA、只读跟随、本机草稿保留与保存、实际源文件及离线归档通过。[实现与完整证据](design/hcd-fixed-lazy-collaboration.zh.md)记录了边界；元数据前缀/缩略图 DOM 的规模优化和生产验收仍待继续，管理平台与提醒发送后置。

## 当前推进：单文件离线归档（2026-10-25）

在上一批节点资源基础上，继续补齐 `.hcdz` 打包、校验解包和操作区下载；固定保存版本、历史、富文本与归档资源随包保留，运行时凭证/ACL/协同草稿/暂存文件排除。详情、命令与验证见[单文件离线归档](design/hcd-offline-archive.zh.md)。浏览器直接打开本地归档及完整离线冷启动仍未接通；管理平台与提醒发送仍不做。

## 当前批次：节点资源与富文本扩展（2026-10-25）

已接入自定义节点资源归档/校验下载、行内原子元素、可协同富文本块及每格式持久导出快照；资源随保存版本归档，移除保留历史，旧客户端有模型防护。上传期间保存、导出、还原、撤销和关闭受保护。实际浏览器完成双人子段编辑、标题转换/块移动、资源添加/下载/移除/撤销、只读缺 codec 查看和保存重开。PDF 曾漏绘行内图片，本轮增加受控打印适配及实际图片实例验证。

完整实现、SDK 示例、兼容表、复现命令和本地证据见[节点资源与富文本扩展](design/hcd-node-resources-and-rich-content.zh.md)。原生离线形式仍是 HCD 目录，普通附件不会被通用 Office/PDF 文件完整携带；管理平台继续暂缓。下文为逐批历史记录，测试数量与早期“预留”描述保留其当时范围。

顺序：保存正确性与内容完整性 → 国际化与字体基础 → 协同可靠性。云文档管理平台及字体管理界面归入后续阶段。

属性侧栏补充分析见 [上下文属性侧栏设计](design/hcd-context-properties.zh.md)：区分页面、文字框、字符选区和图片；对照当前源码记录缺口，明确 Word/PPT/PDF 的作用范围、紧凑分组和验收条件。该文为设计分析，不代表新增字段已经实现。

## 保存正确性

- 文本 splice 平移未受影响的 annotation，使与编辑相交的旧识别标注失效，并接受同批基于新文本的 annotation upsert。
- 结构替换及修订接受/拒绝清理不再有效的标注，历史 revision 保持不可变。
- 文本补丁定位带 hash 的 canonical span，避免外层 block 共享 nodeId 时错误定位。
- 语义 checkpoint 与 HTML 重建保留代码块、代码语言、段内换行、下划线、删除线、行内代码、引用、多段列表项、嵌套列表、编号起点和水平线。
- 固定版式草稿按 nodeId 独立于视口组件保存；远端同节点更新保留本地文本并要求显式选择冲突结果。保存响应到达时保留请求期间继续输入的内容。
- 固定版式导出及关闭前检查未保存草稿；浏览器导航使用未保存提示。当前草稿仅在已挂载工作区内保留，不声称浏览器崩溃后的磁盘恢复。

回归命令：

```bash
python3 scripts/hcd-save-correctness.py --officecli target/debug/officecli
cargo test -p hcd-core -p hcd-docx -p hcd-formats --offline
cargo test -p officecli --offline hdoc_server::tests
cargo test -p officecli --offline --test hdoc_cli --test hdoc_multi_format --test html_convert
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
cargo fmt -- --check
cargo clippy -p hcd-core -p officecli --all-targets --offline -- -D warnings
```

2026-10-22 本地浏览器已验证：

1. PPTX 第一页输入草稿，外部 API 更新另一文本节点，草稿不丢失。
2. 滚至末页令第一页预览卸载，再返回，草稿恢复。
3. 外部 API 更新同一节点，显示冲突，保存暂不可用；选择保留本地草稿后保存到新 revision，重新打开可读取。
4. 粘贴含中英文与 emoji 的代码块、删除线、换行、引用、从 4 开始的编号列表及嵌套列表，保存、重新打开后检查真实 DOM。
5. 服务端 HCD 校验通过；无源 DOCX 语义导出保留九项测试正文。

以上是本地样例验证，未覆盖生产部署、真实 PostgreSQL/S3 故障或大文档容量。

## 紧凑编辑工作区（2026-10-23）

本轮按用户最新要求对齐 Word、PPT、PDF：

- 顶部保留文档身份、语言、协作状态和关闭。保存和导出集中在操作区左侧；导出格式和版式选项在导出选项卡展开。
- PPT/PDF 使用左侧缩略图、单页画布、右侧属性、底部状态栏。Word 完整模式保留连续正文、大纲与修订面板；统一工具尺寸、间距、蓝灰色、图标和状态栏。
- 导航栏和属性栏支持拖动分隔条，也支持聚焦分隔条后按左右键每次调整 10px。导航宽度 120–340px，属性宽度 220–440px。支持收起面板、画布缩放、适应窗口、专注视图和重置布局。宽度状态在当前工作区内保留。
- 属性由当前对象驱动：点击文字显示一个内容编辑框；点击图片显示图片替换与位置/尺寸；点击空白画布显示页面与视图选项。文字对象列表可折叠、查找、按 40 个对象分组浏览，避免整页文本框堆叠。
- 固定版式的原文字体和字号目前作为原文样式信息展示；没有把尚未支持的字体/字号编辑伪装成可用控件。Word 完整模式的文字属性提供实际可用的粗体、斜体、下划线、删除线、颜色、高亮、段落和列表操作。
- PDF 使用预览内的文字矩形建立可点击区域。图片矩形也可选择；位置/尺寸提交复用版本校验 API。PPT 图片位置提交已在本地浏览器验收。PDF 图片保存及源文件回写的新增验收见下文；旋转与复杂图层仍有限制。

### 长文按需加载

- 语义文档有至少 4 个 HCD 分片时，默认进入分段编辑；短文也可从完整编辑模式的视图选项卡切换。
- 分段模式只请求当前正文分片，左侧目录不请求每段正文或缩略图；正文放在禁止脚本、限制资源来源的独立 frame 中。缓存限于 16 个已访问分片、32 个资产条目。
- 点击正文定位当前 canonical 文字节点，修改通过 nodeHash + revision 校验提交，保留未编辑段和原有格式。不同分段草稿可以统一保存。
- “完整格式工具”会在保存草稿后读取最新协同 epoch，再加载完整 Word/Yjs 模型，用于结构与富文本格式编辑。该模式仍加载全文；不将它描述为已经支持数据分页的完整 Word 编辑器。
- 本地样例：2,000 段非空正文（另含段间空白）导入成 125 个 HCD 分片。首次请求只出现 `/chunks/0`；浏览过程中仅请求实际选中的少数分片，没有 `/editor` 或 `/collaboration/state` 全文请求。跳至第 125 段后，首尾两段修改统一保存为 r1，再返回首段可读取。

### 固定版式协作

- 新增仅负责在线状态和选区的 `fixed:<documentId>:0` 房间。房间通过文档 token 鉴权，全部连接的 Yjs 文档写入关闭，不把存在状态当作文档正文或持久保存。
- 文档正文仍由版本校验 API 保存，经 SSE 通知其他窗口；不同文字的本地草稿不会被无关更新覆盖。同一文字发生并发更新时保留草稿并要求选择结果。
- 属性选择可在其他窗口的对应对象上显示协作者标记。在线人数按用户合并。协作在线不等于草稿已经保存。
- 本地两个不同用户的 PPT 窗口已验证：不同文字编辑并保存、远端更新同步、同一文字冲突、保留本地后保存。只读窗口的编辑字段与提交操作不可写。
- 协同 token 续期、权限撤销、多实例、离线磁盘恢复和事件补发仍在后续阶段。

### 本轮检查结果

- `npm --prefix examples/hdoc/editor test`：11 项通过。
- `npm --prefix examples/hdoc/editor run build`：TypeScript、独立版和嵌入版均通过。现有依赖的 `use client` 指令提示和大包提示仍存在，Univer 保持独立懒加载。
- `cargo test -p hcd-formats --offline`：37 项通过。
- `cargo clippy -p hcd-formats -p officecli --all-targets --offline -- -D warnings`、`cargo fmt -- --check` 和 `git diff --check` 通过。
- `python3 scripts/hcd-save-correctness.py --officecli target/debug/officecli`：5 项通过。
- 浏览器复验：PDF 日期在点击的原位置保存为 r1；PPT 图片水平位置从 36pt 调整到 48pt，保存为 r1；Word 属性跟随光标；PPT 属性跟随所选对象。长文可切到完整编辑模式，3999 个段落节点中的首尾两处修改保持，保存后可返回分段模式。
- 长文请求日志在浏览及跳转中仅有正文分片 0、73、109、124（共 125 个），没有完整编辑投影请求。首尾两个修改统一保存后，新 head 为 r1。

### PDF 保存位置回归

浏览器验收发现旧页面重绘从 `data-hcd-y` 读取 PDF 底部原点坐标，实际 HTML 预览使用顶部原点，可能把修改绘制在页面另一侧。本轮改为读取该文字元素实际的 `left/top/width/height` 样式；缺少有效矩形时停止该页重绘，回退到有警告的叠加路径。去掉了按 700 字节截取 HTML 的做法，避免 Unicode 边界问题。

增加回归：原 PDF y=37.08、预览 top=792.8 时使用后者；像素级检查重绘只改变预览文字矩形所在行，页面其他行不变。

## PDF 图片保存与导出（2026-10-23）

- 发现并修复：旧图片移动只改几何元数据，页面底图仍保留原图片，造成旧位置残影；PDF 源文件导出也拒绝这些修改。
- 现在从校验 SHA-256 的不可变 PDF 重建候选文件，重放所选 revision 的文字、图片位置/尺寸和替换。对选中的单次 `Do` 绘制追加局部变换，不修改其他位置对同一 Image/Form 的引用。替换图保留 PNG alpha，通过独立 SMask 写入；克隆当前页资源，保留继承字体，不修改其他页面的共享资源。
- 内容流通过 lopdf 对象解码/编码，保留二进制文字字符串。保留页面绘制顺序和已有图形状态；源页面重新渲染，因此移动后露出原背景。源资源名称支持 PDF `#XX` 转义。奇异矩阵、无效地址、缺少/不匹配的源文件、未支持的内联图片流和旧坐标版本的旋转页会停止提交，不发布新 head。
- 修复空图片命中区域的替换：在当前 canonical 对象内建立子图片，不再向后查找并误改下一个对象的图片。新页面图包含全部对象后，隐藏重复图片像素，保留供工作区选择的几何信息；同步处理同一页的后续分片和旧文字覆盖标记。
- 图片接口、CLI apply 和源 PDF 导出共用上述逻辑。核心层拒绝未提供源重绘结果的 PDF 图片修改，防止绕过保存保障。新 revision 和历史 revision 均由自己的资产索引解析替换图。
- 无源 PDF 导出可使用修改后的页面图，前提是没有未合成的文字/图片覆盖层或额外样式；输出明确报告 VISUAL，正文与矢量成为页面图片。带源文件导出保留可选择文字及原 PDF 对象，报告 SEMANTIC。两者不混称。

新增验证：

```bash
cargo test -p pdf-handler --offline image_edit::tests
cargo test -p hcd-formats --offline pdf_image_save_and_native_export
cargo test -p hcd-core --offline replacing_an_empty_image_placeholder
cargo test -p officecli --offline --bin officecli hdoc_raster_pdf::tests
```

本地结果：hcd-core 44、hcd-formats 38、pdf-handler 34 项通过；无源导出新增 1 项通过；API 10 项、多格式 CLI 17 项和原保存回归脚本 5 项通过。像素验证包含：原位置恢复彩色背景、透明图替换、预览与源 PDF 导出一致、历史 revision 图像不变、图片与文字同批保存、多个 continuation 分片、未合成覆盖层不能走页面图捷径。还覆盖共享图片引用、继承资源、Form 本地旋转/边框、转义资源名和二进制文字。

浏览器本地样例 `pdf-images-workbench`：点击第一张图片后，右侧出现图片属性；水平位置从 40pt 改为 220pt，保存到 r1，旧位置恢复背景，第二个共享图片引用不动。CLI 分别完成源 PDF 导出和无源视觉 PDF 导出。此证据未覆盖生产环境。

![PDF 图片选择、属性与保存](assets/hcd-workbench-2026-10-23/pdf-image-properties.png)

## PDF 裁剪和旋转坐标（2026-10-23）

- 修复页面底图已旋转、文字/图片命中区域未旋转的问题。新导入分片声明 `data-hcd-pdf-coordinates="viewport-v1"`，图片属性和文字外框均为裁剪旋转后的左上原点坐标，源矩形另存。文字 span 在外框内绕中心旋转，点击区域保持轴对齐，不重复旋转。
- 统一前后坐标转换；源 PDF 重建逆变换 UI 中的位置与宽高。继承的 MediaBox/CropBox/Rotate、CropBox 与 MediaBox 的交集一并处理。归一化负旋转和超过 360° 的整数旋转，仅修改临时渲染或候选副本，保留不可变源文件。
- 有经过 hash 校验的源文件时，文字保存改为 PDF 原生修改后重绘，与源导出使用同一路径，保留原背景、颜色及旋转；缺字仍使用已嵌入的字体回退。有源重建失败时不把它悄悄改成白底覆盖保存。无源文字仍保留明确近似的兼容路径。
- 旧非旋转 HCD 保持原坐标解释；旧旋转 HCD 的命中区域升级尚未实现。图片修改会明确要求保留历史的坐标升级，不建议覆盖或删除旧 bundle 重新导入。

验证：

```bash
cargo test -p hcd-formats --offline
cargo test -p officecli --offline --bin officecli hdoc_raster_pdf::tests
cargo test -p officecli --offline --test hdoc_multi_format
cargo clippy -p hcd-formats -p officecli --all-targets --offline -- -D warnings
```

- hcd-formats 40 项、当前页面图导出 1 项、多格式 CLI 17 项通过；原保存回归脚本 5 项通过。坐标往返及像素回归覆盖 0/90/180/270/-90/450°、继承裁剪框、图片原位置背景恢复、独立的目标源矩形、跨分片、旋转文字修改、源导出与预览一致。
- 本地浏览器 `pdf-rotation-workbench`：90° 页点击文字后选框覆盖实际文字；“旋转 PDF 保存”提交为 r1，图片垂直位置 30pt→180pt 提交为 r2，重开保留中文与图片位置。源 PDF 的文字提取保留中文，源导出报告 SEMANTIC，无源页面图导出报告 VISUAL；HCD 校验通过。仍未进行生产验收。

![旋转 PDF 的属性、中文与图片保存](assets/hcd-workbench-2026-10-23/pdf-rotation-properties.png)

## 旧 PDF 的保留历史布局升级（2026-10-23）

- 已手动保存的图片位置/尺寸保持原数值；只有旧导入器生成且未改过位置的命中区域重新投影。核心提交和离线校验均拒绝布局升级改变已保存的图片位置。
- 提供 `视图 → 更新 PDF 布局`、`POST /v1/documents/{id}/pdf/layout` 和 CLI `hdoc upgrade-pdf-layout`。操作追加 revision，不覆盖旧 bundle，不要求重新导入；已有文字、图片资源、批注和源节点映射保留。文字草稿或待应用图片位置存在时，升级按钮不可用。
- 新 revision 使用 `layoutUpgrade: true` 声明纯展示升级，兼容读取缺少该字段的旧记录。该类型只能改变 HTML 坐标和页面重绘资产，源文本/图片修改的 dirty 集不被伪造，后续源导出继续重放原保存记录。旧坐标版本的历史 revision 也可按其旧坐标解释导出。
- 核心提交持有写锁并校验 base revision、body root 和各分片原 hash；检查所有 canonical 文本/节点 hash、图片资源和 source map；新图片、HTML、索引和 revision 就绪后再推进 head。并发保存导致 CAS 失败时不覆盖新内容。
- 离线校验器独立验证该类型：源映射与非布局 metadata 不变，canonical 文本和图片资源不变，原资产保留，批注 root 不变，dirty chunk 集与实际变化一致。伪造布局升级标记不能隐藏真实文字或图片替换。
- 规划过程按原页面处理，逐页解析/渲染、逐分片写入内容寻址对象；内存保留分片描述符，不保留全部升级 HTML。保持现有源文件、页面栅格、单分片和控制对象的资源上限。
- 修复无源 PDF 导出对属性/CSS 顺序的依赖：升级器重新排序属性后，导出按 XML 属性及 CSS 键读取尺寸和页面图，不再要求 `width` 紧邻 `height`。

验证方式：

```bash
cargo test -p hcd-core -p hcd-formats --offline --lib
cargo test -p officecli --offline --bin officecli hdoc_server::tests
cargo test -p officecli --offline --bin officecli hdoc_raster_pdf::tests
cargo test -p officecli --offline --test hdoc_multi_format --test hdoc_cli
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build

# 真实旧 bundle；--expected-revision 必须使用当前 head。
officecli hdoc upgrade-pdf-layout legacy.hcd --source immutable.pdf --expected-revision 4 --json
officecli hdoc validate legacy.hcd --json
officecli hdoc export legacy.hcd --source immutable.pdf --output native.pdf --json
officecli hdoc export legacy.hcd --output visual.pdf --json
```

本地证据：core 44 项、formats 42 项、API 11 项、页面图导出 2 项通过；前端 11 项以及独立版/嵌入版构建通过。新增持久化回归包括已保存中文、图片替换/位置、批注、完整历史、重复调用无新版本、陈旧版本拒绝、非法内容计划拒绝、伪造布局标记被离线校验发现，以及升级前历史源导出与升级后画面一致。

浏览器在上一轮实际旧样例 `pdf-workbench-verified` 上执行 r1→r2：临时文字草稿会禁用升级按钮；还原草稿后升级成功，165 个文字节点及其源地址完全一致、2 个图片资源保留、原 2 份 revision 文件逐字节 hash 不变、批注 root 不变，HCD 校验通过。升级后源导出 SEMANTIC、无源导出 VISUAL 均成功；界面中的 PDF 无源选项改为“当前文档内容”，按实际结果说明页面外观已保留、文字不可选，避免将页面图导出误写成重新排版。此轮仍是本地证据，没有进行远端 PostgreSQL/S3 或生产验收。

![旧 PDF 升级后的版本和属性](assets/hcd-workbench-2026-10-23/pdf-layout-upgrade.png)

## 多标签连接与断线草稿保护（2026-10-23）

此前复验发现，同源 SSE 长连接达到 HTTP/1.1 连接池容量时，新增窗口停在正文加载；关闭重复窗口才恢复。本轮已把浏览器版本通知迁到 Rust 原生 WebSocket，保留 SSE 兼容调用方；Vite `/v1` 代理启用升级转发。该通知通道不依赖可选的 Hocuspocus 在线状态服务。

- 首帧认证，令牌不放在 URL；只读/可写身份均可订阅，文档不匹配拒绝、授权到期断开。前端停止对到期授权无限重试，并提示本页草稿保留。
- 每次连接携带最后收到的 revision；根据不可变历史和一个确定的 manifest 补齐改动，不再依赖短暂的内存消息。合并多个 revision 不伪装成单次本地 patch，避免跳过同批远端改动。
- 所有成功发布的修改共用通知入口，包括结构、历史恢复和批注等；hub 只存版本号、清理无订阅文档，不把全文反复排入广播队列。2 秒 head 检查补足本地 CLI 修改及丢失的通知。
- 有远端存储时先读取 PostgreSQL 已提交的版本和 root，再解析对应本地历史，防止 CAS 尚未成功的本地候选被广播。此处有本地模拟发布边界的回归，没有真实 PostgreSQL/S3 验收，也未扩展多实例缓存协议。
- 重连及草稿 ID 变化时检查全部待保存对象，包含当前 UI 已到同一 revision 的情况。正文超过 1 MiB、积压超过 256 个版本或发生结构/布局变化时要求刷新；仍返回草稿对象 hash 或删除标记，避免默默漏掉冲突。跟踪上限 10,000 个 ID。
- 固定版式与分段编辑保留离屏草稿；同节点远端修改必须明确选择。对象删除或需要刷新时禁用保存，并提供复制/丢弃草稿。结构刷新重新读取版本固定的索引，保留草稿 store。Univer 在已有保存完成后才执行远端重载，避免中途销毁保存对象。
- SSE 增加事件 revision ID，支持 `Last-Event-ID` / `afterRevision` 历史补发与广播 lag 恢复；浏览器不再为每个页面占用一条 SSE HTTP 长连接。

本地验证：API 19 项（含 WebSocket 真实握手、只读订阅、跨文档拒绝、到期断开、同版本草稿检查、丢失/滞后恢复、SSE 补发、远端未发布候选隔离）；前端 15 项；保存回归脚本 5 项。类型检查、独立版/嵌入版构建、clippy（全部 target、warnings 为 error）、fmt 和 diff 检查均通过。构建仍有现有大型 Univer bundle 及第三方 use-client 提示，本轮未处理体积拆分。

浏览器同时保留 8 个编辑窗口（7 个固定/分段工作区及 1 个完整 Word 工作区），新增 PPT 两位编辑者和一位只读用户均加载完成。独立样例 `revision-sync-workbench`：r0→r1 后只读用户收到中文/emoji，另一位的草稿保留并禁用保存；通过仅测试用页面开关暂停其更新，保留第一页草稿并切到第二页；远端连续保存 r2/r3 后恢复连接，离屏草稿被发现为冲突，“查看文字冲突”能定位并同时展示本地草稿和 r3 文字；明确选择保留本地后保存为 r4，只读窗口同步收到。随后在最终构建复验短文字冲突并保存 r5，选择远端内容后无残留草稿。r4 源 PPT 导出保留已保存中文/emoji，bundle 校验通过；其他样例仍为原 revision。测试开关只在忽略的本地 harness 中，不属于产品功能。

复验命令：

```bash
cargo test -p officecli --offline --bin officecli hdoc_server::
cargo clippy -p officecli --all-targets --offline -- -D warnings
cargo fmt -- --check
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-save-correctness.py --officecli target/debug/officecli
```

![属性栏协同冲突与草稿保护](assets/hcd-workbench-2026-10-23/revision-conflict-properties.png)

此轮未实现跨页面关闭/刷新后的草稿恢复、主动权限撤销、生产代理配置或多实例远端验收；仍不能宣称协同已经全部完成。


## 字体身份与 PDF 回退完整性（2026-10-23）

发现并修复两处无源 PDF 重绘问题：遇到缺字原来直接留空，遇到换行原来只绘制第一行；同时修复按“字符覆盖”复用其他字体、忽略指定字体文件的嵌入行为。

- 新增 `pdf-handler::fonts`：字体文件 SHA-256 + faceIndex 身份，默认实例的名称/样式/字重检查；内置静态 Regular Noto Sans SC / Noto Emoji catalog。不增加字体管理平台或上传入口。
- 无源单行重绘按完整字素簇选择内置 face，经 Rustybuzz 整形；中文、拉丁和单色 emoji 可混排，家庭/肤色/国旗等组合整体处理。按实际轮廓计算 mask 边界，保留 descender，不再用固定基线把字形裁掉。
- 缺字、没有实际映射的表意/数学变体、换行/布局控制、RTL/竖排需求、非法字号、区域溢出及资源超限都会停止该页的完整重绘。正文仍通过明确的叠加兼容路径完整保存；未合成的页面不能走 VISUAL 页面图捷径。多行语义 PDF 导出的真实 CLI 回归保留了 `FIRST` 和 `SECOND`。
- 绘制上限：4096 字符/16 KiB，字号 1–256px，mask 单边 8192px/总 4M 像素，并限制轮廓扫描工作。调用方还检查文字区域与页面边界。
- 页面图新增 `data-hcd-raster-font-ids`，由 revision 的 HTML hash 覆盖；复制旧背景重绘时保守继承其已知字体依赖。提交返回 `PDF_RASTER_FALLBACK_FONTS`。这不是原生 PDF 或全部文档的完整字体清单，字体文件本身尚未打包进 HCD。
- 修复嵌入字体的多对一字符映射：相同字形的不同 Unicode 字符现在使用独立 CID，通过 CIDToGIDMap 指向共享字形；ToUnicode 每个 CID 对应一个标量，避免把空格/NBSP 等别名串成重复文字。旧连字/簇映射不再被用于单个字母的反向编码；需要时使用可安全编码的回退字体。单字节字体保持 8-bit 编码，组合字体保持受支持的 16-bit 编码，超界报错而不截断。已有错误输出不作自动内容猜测或历史覆盖。
- PDF 强制嵌入复用同时匹配源字体文件 hash、faceIndex 和字符覆盖；记录源身份，使用真实 PostScript 名称，不再将自定义字体都标成 NotoSansSC。相同字体跨页复用，不同文件即使覆盖相同字符也保持各自身份。文件读取限制 64 MiB；无效文件不会被无关缓存字体掩盖。
- 固定版式属性栏根据当前页面的真实叠加标记显示本地化检查提示；新文字文案覆盖简体/繁体和英语 locale。该提示经过类型检查和构建，本轮未作浏览器视觉验收。

本地验证：core 45、formats 43、pdf-handler 45 项库测试；OfficeCLI 二进制单元测试 90 项，多格式原 17 项加新增字体导出 1 项，HTML 转换 3 项；前端 15 项及独立版/嵌入版构建；保存回归 5 项。clippy（相关四 crate 全部 target，warnings 为 error）、fmt 和 diff 检查通过。新增回归覆盖文件身份复用、无效/超大字体、共享字形的 Unicode 别名往返、连字反向编码回退、单/双字节编码边界、组合 emoji、轮廓边界、缺字/换行/溢出、有界绘制、历史不变、字体依赖继承和实际 PDF 文本提取。

实际 API 样例 `font-fallback-workbench`：缺少源 PDF 时保存中文/emoji 到 r1，记录两个内置字体身份，导出报告 VISUAL；随后保存多行文字到 r2，返回重绘跳过及近似叠加提示，导出实际报告 HIGH，PDF 文本提取含两段文字。r1 分片未变化，bundle 校验通过。[API 证据](assets/hcd-workbench-2026-10-23/font-api-evidence.json)。仍是本地服务证据，没有生产部署或远端数据库/对象存储验收。

复验命令：

```bash
cargo test -p pdf-handler -p hcd-core -p hcd-formats --offline --lib
cargo test -p officecli --offline --bin officecli --test html_convert --test hdoc_multi_format
cargo clippy -p pdf-handler -p hcd-core -p hcd-formats -p officecli --all-targets --offline -- -D warnings
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-save-correctness.py --officecli target/debug/officecli
```

实际 fallback painter 的输出（单色 emoji）：

![中文、英文与组合 emoji 字体回退](assets/hcd-workbench-2026-10-23/font-fallback-proof.png)

字体/字号编辑、完整字体依赖打包、浏览器与各导出器统一解析、原生 PDF 组合 emoji 与 RTL、多语错误码仍未完成。下一步按 [字体与国际化接入设计](design/hcd-fonts-i18n.zh.md) 接通，管理平台继续后置。

## Word 属性读取与字体格式保存（2026-10-23）

本轮先完成属性区读取和字体格式的保存基础，尚未开放字体/字号修改。原先完整 Word 投影仅承接粗斜体等标记，继承的字体/字号未进入编辑模型；结构保存存在丢失这些信息的风险。

- `EditorInline.typography` 保留请求的 CSS 字体栈、pt 字号及 Latin / EastAsia / BiDi 字体槽；它不代表字体文件已安装或已打包。投影从分片祖先、命名样式、行内样式解析字体，支持受限 CSS 2.1 选择器优先级、important、继承和相对字号。字体名称保留大小写。不能安全展开的 font shorthand、字号表达式或超限解析会明确拒绝投影，避免生成有损数据。
- 结构 checkpoint 将这些字段安全编码到规范 HTML，重开时恢复；保留相邻段落及历史 revision。前端格式 mark、代码块及行内代码均承接字体信息，通过 Yjs 二进制存储后可恢复。
- 右侧文字属性显示当前选区的字体和字号；跨不同格式的选区显示“混合样式”，光标位置读取当前/待输入格式。属性仍按文字、图片、页面对象切换，保存/导出留在操作区。
- checkpoint 新增 `typographyVersion: 1`。带字体信息的文档拒绝旧客户端的无版本快照（HTTP 426），未知版本也拒绝。语义协同 room 改为 `documentId:epoch:typography1`，旧页面需重载；固定版式 room 不变。更新 sidecar 与浏览器需一起发布。
- 旧 Yjs 状态仅在规范文字能够逐一对应时补充格式，直接为原 CRDT 文字添加 mark，不重新建立文字身份。存在无法准确对应的未保存文字、换行等情况会保留旧状态并停止迁移；尚无面向用户的手动迁移恢复流程。不能宣称所有旧协同房间已自动迁移完毕。

本地真实 DOCX 样例 `word-typography-workbench`：命名段落样式 14pt + 行内 Arial/黑体 20pt。旧 API 快照被拒绝且 head 不变；新快照只修改正文，使用 `source-text` 保存到 r2，原 styles.xml、run properties、相邻段落和历史分片不变。浏览器再修改文字保存到 r3，刷新后属性仍为 Arial/黑体 20pt；r3 实际 DOCX 导出包含新正文，原字体样式及 run properties 均未改变。[API 与导出证据](assets/hcd-workbench-2026-10-23/word-typography-api-evidence.json)。

![Word 保存重开后的字体属性](assets/hcd-workbench-2026-10-23/word-typography-saved.png)

![混合字体与字号选区](assets/hcd-workbench-2026-10-23/word-typography-mixed.png)

验证覆盖字体继承、样式优先级、相对字号、多语字体槽、CSS/属性安全、解析资源边界、结构保存/历史/相邻内容、代码格式、混合选区、Yjs 存储、旧状态迁移与失败时不变、离线文字身份合并、旧快照防丢失，以及真实本地 API / 浏览器 / DOCX 导出。

本地检查通过：hcd-core 50、hcd-docx 34、hcd-formats 43、OfficeCLI 二进制 91、多格式集成 18、HTML 转换 3、前端 20 项测试，以及保存脚本 5 项检查；前端独立版/嵌入版构建、相关 crate 全 target clippy、fmt 与 diff 检查通过。API 与 sidecar 已更新到本地验证版本，未进行生产发布。

复验：

```bash
cargo test -p hcd-core -p hcd-docx -p hcd-formats --offline --lib
cargo test -p officecli --offline --bin officecli --test hdoc_multi_format --test html_convert
cargo clippy -p hcd-core -p officecli --all-targets --offline -- -D warnings
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-save-correctness.py --officecli target/debug/officecli
```

边界：已验证的 DOCX 字体保持限于保留源结构的正文修改。结构重建后的语义 DOCX 导出仍未贯通全部字体格式；尚未开放字体/字号修改，也未完成字体依赖打包、跨导出器一致解析或生产协同迁移。管理平台继续后置。

## Word 选区字号修改与 DOCX runs 导出（2026-10-23）

本轮接通字号控件和实际导出，并继续保护保存过程。整体目标仍进行中，管理平台未开始。

- Word 文字属性新增字号输入、常用字号和应用操作，支持 1–1638 pt、半磅递增；混合选区保持各自字体与其他已建模的标记。空光标设置用于随后输入。只读、输入法组合中、部分代理对/emoji/组合字符的选区及非法字号不会被当成成功修改。
- 语义 DOCX 不再先将正文转成 Markdown，新增类型化 native runs / paragraphs / tables 批量写入。覆盖字体槽、字号、粗斜体、下划线、删除线、颜色、高亮及已识别文字边框；换行和 Tab 使用 Word 原生节点，保留规范文字空格。表格分片的文字样式和链接按明确的字节范围、行列偏移重组，不靠内容搜索匹配。半磅外的源字号会报告舍入，超出可往返范围会拒绝写入。
- 新导入 DOCX 的样式表包含受限语言字体元数据；命名样式中的 Latin / EastAsia / BiDi 不再只剩一个 CSS 字体栈。旧 API 文档可从经 SHA-256 核验的原 DOCX 补充字体槽，不修改历史对象、root hash 或 revision；CLI 的 `--typography-source` 提供同一能力。该补充不重放源正文。已缺失的旧原稿属性不能靠猜测恢复。
- 协同房间和 checkpoint 字体元数据协议升级为 2。v1 marks 的迁移直接补充原 CRDT item 的字体槽，保留已有字号修改、其他标记和硬换行；无法准确对应的旧文字仍保留状态并停止迁移。不能宣称全部旧待保存房间已迁移。
- 新增按 revision 查询的导出能力接口；字号等格式修改后，DOCX 导出自动使用当前文档内容，原文件重放选项禁用。导出前重新检查实际保存版本，明确显示可能重新排版/改变部分原稿样式。保存状态和结果文案改为用户可理解的文字，补充简体/繁体和英语文案。
- 首次协同同步完成前锁定编辑/保存；断开或未同步的写入者不能提交整份文档快照，避免未加载的空白视图覆盖正文。连接未就绪时不把本地 awareness 当成在线人员。手动保存返回期间若出现新文字/字号修改，会保持编辑状态并阻止此次关闭/导出，不用旧确认冒充全部已保存。

真实本地样例 `word-size-workbench`：先修改选区 `Text` 为 28.5 pt（r2），第二个编辑窗口同步显示，第三个只读窗口禁用格式控件；撤销保存为 r3，重做保存为 r4。刷新后字号仍为 28.5；从操作区实际导出 DOCX，按当前内容模式完成。API / Word XML 检查：三个相邻片段字号为 14 / 28.5 / 20，西文字体 Times New Roman / Arial 与宋体 / 黑体槽分别保留，正文、相邻段落和 r1–r4 历史均保留。旧协议快照 HTTP 426、只读提交 HTTP 403，head 不变。[验证记录](assets/hcd-workbench-2026-10-23/word-size-api-evidence.json)。

旧样例 `word-typography-workbench` 在 r3 上完成 v1→v2 协同加载：浏览器正文仍包含 `中文保存 Text` / `Mixed saved`；已渲染 DOM 分别记录 Times New Roman + 宋体 14 pt、Arial + 黑体 20 pt，HCD revision/root 不变。未加载连接的独立窗口即便已轮询到 r4，保存控件仍锁定。

![Word 字号保存重开与实际导出](assets/hcd-workbench-2026-10-23/word-size-saved-export.png)

![第二个窗口同步字号](assets/hcd-workbench-2026-10-23/word-size-peer.png)

![协同未加载时禁止提交空文档](assets/hcd-workbench-2026-10-23/word-size-bootstrap-guard.png)

本地检查通过：hcd-core 52、docx-handler 39、hcd-docx 34、OfficeCLI 二进制 94、多格式集成 19、HTML 转换 3、前端 27 项测试；保存脚本 5 项检查、独立版/嵌入版构建、相关 crate 全 target clippy、fmt、diff 检查。回归包含命名样式多语字体、真实结构修改→DOCX→再次导入、旧样式补充不改历史、原文件 hash 不符拒绝、Unicode 边界和非法数据不产生部分输出。均为本地证据，未部署或进行生产验收。

仍需优先处理：结构 checkpoint 的原始块/样式类及未建模的段落/字符属性保留；手动保存、sidecar 自动保存和外部规范修改的统一协调；旧房间存在不匹配待保存文字时的恢复界面。当前语义重建不保证原稿全部样式、分页、批注/字段关联或高级排版；本轮验证不能证明这些要求完成。字体选择、字体文件依赖/预览解析、PPT/PDF 字体编辑、RTL 与多实例协同继续在原目标内推进。

## 属性区对齐分析（页面、文字与对象）

本节记录用户补充的 PS / Office 操作逻辑，属于设计与代码审查结论，尚未作为全部已实现功能验收。此次浏览器样例返回 401，未据此刷新凭证、重置文档或进行新的界面验收。

对照依据：[Adobe 字符格式](https://helpx.adobe.com/photoshop/desktop/text-typography/characters-glyphs/format-characters.html)区分选中字符与整个文字图层；[PowerPoint 文本框设置](https://support.microsoft.com/en-us/powerpoint/training/set-text-direction-and-position-in-a-shape-or-text-box-in-powerpoint)区分文本内容、文本框尺寸及内边距。HCD 采用同样的作用范围区分，三个编辑器共享属性面板结构，按格式能力提供实际操作。

### 选区与属性的对应关系

| 当前操作或选区 | 属性区内容 | 修改的作用范围 |
| --- | --- | --- |
| 打开文档、点击页内空白、选择页面缩略图 | 页面尺寸、方向、背景等页面属性 | 当前页或显式选择的页面；Word 排版设置按节处理，不能把任意正文分片当作物理页 |
| 单击文字对象边框 | 位置/尺寸、文本框内边距、垂直对齐、换行与溢出 | 当前文本框；对象格式与字符格式分组显示 |
| 双击进入文字、框选文字 | 字体、字号、颜色、强调；段落对齐、缩进、间距及列表 | 字符属性仅影响选区；段落属性影响选区覆盖的段落；空光标设置后续输入格式 |
| 选择图片 | 替换、位置/尺寸、比例锁定；具备能力后提供裁剪、旋转 | 当前图片；Word 需另区分行内图片和浮动图片 |
| 选择形状 | 位置/尺寸、填充、描边与排列 | 当前形状，内部文字编辑另有文字选区 |
| 多选对象或跨格式文字 | 共同可用的属性；不同值显示“混合” | 只修改用户明确操作的属性，其余属性保持各对象原值 |

以上是目标能力，不代表页面背景、文本框格式、形状或多选编辑已经接通。PDF 的扫描页面/不可解析区域不能伪装成可编辑文字；OCR 若引入，需要独立能力声明与识别结果确认。

### 当前代码差距

- 固定版式用 `selectedRun`、`selectedImage` 和 `inspector` 三组独立状态，加载页面时还会自动选择首个文字/图片。页面切换并不统一重置选区，属性标签可以与真实点击对象脱节。应由一个包含文档、页面、对象和选区类型的选择状态驱动面板与协同标记；浏览对象列表只作为辅助入口。
- 固定版式文字命中区域调用 `selectRun` 后直接聚焦侧栏 textarea。当前属于侧栏内容编辑，尚无 Office 式“选择文本框 → 进入框内文字 → 字符选区”的分层。一个视觉对象包含多个 run 时，点击只选择 `nodeIds[0]`，不能据此把首个 run 的样式展示成整个对象的统一样式。
- Word 完整模式的属性区固定为文字属性；字号和字体已读当前选区，颜色/高亮控件仍使用固定 `defaultValue`，不能准确表达当前或混合颜色。图片操作留在插入工具区，页面/节、图片与表格选区未统一接入属性面板。
- 当前“页面”属性主要显示只读尺寸，同时包含缩略图开关和重置布局。应把文档内容属性与工作区视图设置分开：缩放、面板显隐、宽度及重置留在“视图”。页面属性不应承担工作区布局调整。
- 分析时图片几何草稿仅存在于 `ImageGeometryPanel` 的本地 state，按图片 key 重建，切换对象/页面/属性类型可能丢失。此项已在下文“图片属性草稿与文字的统一保存”中修复并作本地验收；完整 Word 的统一快照协调仍未完成。
- PPT/PDF 字体和字号目前主要为原文信息，不能将展示信息换成可输入框就声称可修改。必须逐项接通持久化、重开、导出及历史保留后再开放。

### 面板与交互约定

1. 顶部显示选中类型、对象名称和必要的只读/冲突状态；下方按“文字、段落、变换、外观”等相关组折叠，优先展开常用项。沿用当前可拖宽的紧凑侧栏，不把全文或所有对象编辑框堆入面板。
2. 切换选区自动刷新属性值，保留用户对同类属性组的展开状态。点击属性控件不得丢失文字选区；输入法组合期间不强制变更格式。多值状态与未设置/继承状态分开表达。
3. Enter 或明确的应用操作确认输入，Escape 撤销本次字段输入；鼠标与键盘均可操作。单位转换只发生在展示边界，写回保留规范精度。修改能预览、撤销、重做。
4. 未支持的属性隐藏或说明限制；权限只读时保留准确属性值并禁用写入。协作者的选区单独显示，不改变本人的属性目标。远端更新与本地草稿相交时保留输入并提供冲突选择。
5. 页面、对象、文字属性读取只依赖当前加载页/分片及所需元数据。长文打开属性区不得隐式拉取完整正文；Word 完整模式当前仍有全文模型限制。
6. 保存与导出继续放在操作区；页面/对象属性的应用不等同于整篇已保存。所有新字段、混合状态、错误及单位文案纳入现有国际化机制。

### 实施与验收顺序

仍先修复保存正确性：统一手动/自动保存与外部修改的版本协调，保留未建模原稿样式，并保护图片等属性草稿。之后统一选区状态、属性值读取及面板分组，再按 Word、PPT、PDF 的能力开放可持久化属性；字体与协同同步验收。管理平台继续后置。

验收必须覆盖：页面→文字→图片→页面的连续切换；字符选区与文本框对象的作用范围；混合值；只读；撤销/重做；切页/收起面板不丢属性草稿；保存响应期间继续输入；两个协作者修改不同/相同属性；刷新重开及实际导出；长文属性读取不加载全文。当前仅完成此项分析，未将这些验收标为通过。

## 图片属性草稿与文字的统一保存（2026-10-23）

本轮继续保存正确性阶段，没有开始管理平台。修复属性区切换可能丢失图片位置/尺寸草稿，以及只检查文字就允许关闭/导出的问题。

- 新增由工作区持有的 `ImageDraftStore`，按稳定图片 nodeId 保留原始 visualHash、位置/尺寸、页面及冲突信息。切换图片、页面、文字/页面属性或收起面板不销毁草稿；空输入、非有限数值及非正尺寸保留为待修正草稿，不作为 JSON null 提交。保存期间的新输入、还原原值、较新远端更新及删除不会被迟到确认清除。
- 固定版式和长文分段的操作区保存新增 `POST /edits`，只接受 `hcd-patch/3` 的 `text.splice` 和 `image.geometry`，身份由 token 写入。跨页文字/图片用同一次 revision CAS 与各自原始 nodeHash / visualHash 校验提交，任一冲突或非法尺寸拒绝整批。单张图片的“应用位置”仍可独立提交，其余草稿保持待保存。
- 发现旧图片写接口按服务器最新图片生成 visualHash，旧客户端若已获知新 head，可能覆盖旧画面未呈现的图片修改。图片替换/位置接口现在要求 `expectedVisualHash`：缺少返回 HTTP 428，不匹配返回 409；前端替换传入实际展示图片的 hash。仅获取新 revision 不足以授权旧图片快照覆盖新内容。这是请求协议变化，客户端需随 API 更新。
- 新增单图片读取接口 `GET /images/{nodeId}`，返回同一不可变 manifest 上的 revision 与图片状态；删除返回 `image: null`。只刷新实际有草稿的图片，最多并发四个请求，不下载全文或依赖前 50 张图片列表判断删除。HCD 查询复用索引 bloom 与受校验的 source map / chunk。
- 保存回执的文字 hash 从实际保存 revision 的不可变 manifest 读取；图片回执基于请求所校验的 base 和本次几何修改生成。不会因读取时 head 已推进而将后续内容的 hash 标成旧请求确认。精确重放同一 patch 保持原 revision。
- 固定版式的标题、状态栏、缩略图标记、保存、关闭、导出、模式切换、PDF 布局升级及 beforeunload 都纳入图片草稿和正在提交的状态。删除图片的草稿可复制或丢弃；同图冲突显示远端矩形，支持显式采用远端或保留本地。控件和新增状态补充简体/繁体与英语文案。
- 完整 Word 的图片面板也使用工作区草稿，切离“插入”不会丢失；有图片草稿时阻止关闭/导出/切分段模式，并要求先在“插入”应用或丢弃。完整 Word 仍通过单独的语义 checkpoint / sidecar 保存正文，此处没有宣称它已与图片和自动保存合并为一个协调器。该分支本轮完成类型/构建检查，没有新的 Word 图片浏览器验收。

### 本地证据

浏览器新建独立样例 `geometry-drafts-workbench`，没有修改此前 PPT/Word/PDF 样例的 head：

1. 第一页两张图片水平位置分别 80→96、300→316 pt，第三页图片垂直位置 140→180 pt，另修改第一页中英文/emoji 文字。切换图片、文字属性和页面后全部草稿保留；未保存时关闭、导出均提示先保存。
2. 操作区保存一次提交 4 处修改为 r1。随后本地输入 100 pt，另一用户身份通过 API 改为 110 pt（r2）；页面保留本地输入并显示远端 110 pt，暂停保存。明确保留本地后提交 r3，刷新仍为 100 pt。只读浏览器窗口禁用替换、坐标/尺寸和提交，仍可读取属性。
3. 实际语义 PPTX 导出 r3：3 张幻灯片、6 张图片、所改文字及三处几何值均通过导出包的原生 XML 检查；历史 r0–r3 保留，HCD 校验通过。陈旧图片 hash、只读提交、缺失图片前置条件分别 409 / 403 / 428，拒绝后 root 不变。[PPT API 与导出证据](assets/hcd-workbench-2026-10-23/image-drafts-api-evidence.json)。
4. 独立 `geometry-pdf-workbench` 文字与图片水平位置 40→52 pt 同批保存 r1。原生 PDF 导出可提取新文字；重新导入后，两张图片的矩形均与保存值相同，未编辑文字/图片与原不可变源重新导入结果一致，HCD 校验通过。[PDF 原生导出/重导入证据](assets/hcd-workbench-2026-10-23/image-drafts-pdf-evidence.json)。

![图片草稿保存、刷新后的位置与实际导出](assets/hcd-workbench-2026-10-23/image-drafts-saved-export.png)

[未保存时导出拦截](assets/hcd-workbench-2026-10-23/image-drafts-export-guard.png) · [图片位置冲突](assets/hcd-workbench-2026-10-23/image-drafts-conflict.png)

本地检查：前端 35 项测试及独立版/嵌入版构建通过；hcd-core 52、hcd-docx 34、hcd-formats 43 项库测试，OfficeCLI 二进制 95 项测试通过；补强陈旧图片用新 head 提交的拒绝测试后，API 定向 13 项再次通过。相关 crate 全 target clippy、fmt、diff 检查和保存脚本 5 项通过。全部为本地证据，未部署或进行生产多实例验收。

边界：草稿仍仅在当前工作区内存中，不支持刷新/崩溃后的磁盘恢复。修改图片后的源文件重放 PPTX 导出仍明确拒绝；本轮浏览器实际使用语义重建导出，没有将其算作原稿全部样式、母版或动画保持。完整 Word 的自动/手动快照协调、外部规范修改同步、未建模原稿样式、PPT 原生图片回写和字体/协同的其他项目继续在原目标内，管理平台后置。

复验：

```bash
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
cargo test -p hcd-core -p hcd-docx -p hcd-formats --offline --lib
cargo test -p officecli --offline --bin officecli
cargo clippy -p hcd-core -p officecli --all-targets --offline -- -D warnings
cargo fmt -- --check
python3 scripts/hcd-save-correctness.py --officecli target/debug/officecli
```

## 完整 Word 保存协调与草稿副本（2026-10-23）

继续保存正确性阶段。本轮针对旧快照配新 revision、手动与自动保存竞争、房间重置删除待保存状态三个问题，没有开始管理平台。

- 语义房间改为 `documentId:epoch:typography2:save1`。浏览器通过 stateless 请求发送 requestId 与当前内容摘要；不再直接向 `/checkpoints` 上传整篇正文。手动、导出前和自动保存由同一房间协调器串行执行，期望 revision 固定为草稿所对应的基础版本，不在提交前读取新 head 作为旧快照的授权依据。
- 确认包含保存内容摘要与 revision。保存期间继续输入、撤销到原值、跨窗口输入及尚未确认的修改不会被旧确认清除；协作者按捕获时的 generation 清理，新输入仍留待下一次保存。对象键顺序经过规范化，Rust 与 Yjs 的字体字段顺序差异不会被误判为旧草稿冲突。规范 blockId 只回填给请求时捕获且仍存在的 CRDT 对象，不按响应时的新数组位置赋值。
- 基础版本/root/digest/lineage 有服务端 HMAC 签名。提交前持久化完整 CRDT；提交后更新并持久化基础回执。revision 的 checkpoint ID 含提交身份、摘要、完整 HMAC，并限制在 256 字节内；同一提交重放可返回原保存版本的 root 和投影，不把后续 head 的内容冒充原回执。重启只在连续、受签名保护的同一 lineage 记录能证明已提交时推进基础版本，其他情况保留草稿并停止覆盖。扫描上限 256 个 revision，超出需要恢复处理。
- `/checkpoints` 及当前协同状态的写入要求服务协调器协议；普通旧浏览器或旧 sidecar 不能继续走整篇快照路径（HTTP 426）。只读仍为 403。当前二进制状态写入同时校验 `X-HCD-Coordinator-Version: 1`、epoch 和前一状态 hash；不同持有者的陈旧二进制返回 412，保留恢复副本并停止规范提交。相同字节的重试允许幂等确认。API、sidecar、浏览器需一起更新。
- 本地状态按 epoch 分文件，旧无代次文件在受锁保护的访问中迁移。重置先保留恢复副本，再推进代次；旧文件不会作为新房间初始状态。文件内容与目录在 Unix 下同步后确认。PostgreSQL 新增恢复表，代次推进、旧状态归档/删除在同一事务内；当前状态的 hash 校验在锁定元数据行的事务内进行。此远端分支已编译和静态检查，本轮没有真实 PostgreSQL/S3 验收。
- 发现外部版本或旧待保存内容时保留现有编辑模型，进入只读对比状态，不由轮询直接卸载草稿。可下载 `.hcd-draft` 协同备份、按 50 块查看最新正文，或选择“保留备份并打开最新版本”。该操作先通过 HTTP 保留本地完整 CRDT，旧 WebSocket 无法连接时也能执行，再显式切换房间；操作期间有新内容则保留当前页面。恢复 API 接受旧 epoch 的副本，但不能借此写当前房间或规范正文。
- “修订 → 草稿恢复副本”可再次下载最近 50 份服务端副本。副本仍引用原文档资源，不是打包字体/图片的独立 Office 文件；目前没有选择性合并或备份文件导入界面。页面关闭前检查文字/图片草稿和进行中的提交。房间卸载分为持久化准备和真正卸载后释放，避免新连接取消卸载时协调器已被销毁。

### 实际本地流程

独立样例 `coordinator-word-workbench`，原稿含 14/20 pt 字体片段及相邻段落：

1. 首次建立投影 r1，writer 修改 `Text → Manual saved`，通过协调器手动保存为 r2；peer 修改 `Mixed size → Auto saved`，实际闲置自动保存为 r3。writer、peer、reader 三个窗口显示相同正文及已保存版本，只读控件不可写。原文件 DOCX 导出包含两处新文字，`word/styles.xml` 与原稿逐字节相同；浏览器实际导出 r3，报告 HIGH。
2. writer 输入未保存的 `Local draft survives`，另一用户身份用外部文本 API 提交 `External canonical` 为 r4，并将 epoch 0→1。旧窗口保留本地文字，显示 r3 草稿与 r4 最新正文，暂停覆盖。明确选择保留副本并打开最新版本后，加载 r4；从 API 下载并解码的三份 CRDT 副本仍含该本地草稿。侧车普通停止/重启后仍加载 r4，没有生成重复保存版本。
3. 停止侧车，浏览器离线输入 `Offline draft survives`；API 仍可访问，外部文本 API 推进为 r5、epoch 1→2。旧窗口保留离线文字并可对比最新 r5。侧车仍离线时选择保留备份并打开最新版本，HTTP 副本已存入服务器；随后恢复侧车，成功加载 r5，并实际导出 DOCX（HIGH）。从服务端副本解码读回离线文字，规范 r5 仍为 `External latest five`，没有被草稿覆盖。
4. 普通旧快照、旧 sidecar 快照、只读快照、旧二进制持久化、陈旧二进制 hash 分别按 426 / 426 / 403 / 426 / 412 拒绝，拒绝后 root 保持。Rust 生成的签名 checkpoint ID 已用同一私有 secret 重新校验；HCD 完整历史和校验通过。[API、导出与恢复副本证据](assets/hcd-workbench-2026-10-23/word-coordinator-evidence.json)。

![外部更新后保留草稿并对比最新正文](assets/hcd-workbench-2026-10-23/word-coordinator-conflict.png)

[手动/自动保存后的导出](assets/hcd-workbench-2026-10-23/word-coordinator-saved.png) · [侧车离线时的草稿](assets/hcd-workbench-2026-10-23/word-coordinator-offline-draft.png) · [恢复后最新版本与导出](assets/hcd-workbench-2026-10-23/word-coordinator-latest-export.png)

本地检查：前端 48 项测试及独立版/嵌入版构建；OfficeCLI 二进制 97 项、API 定向 15 项、多格式集成 19 项、HTML 转换 3 项；相关 crate 全 target clippy、fmt、diff 和保存脚本 5 项通过。新增测试覆盖重叠提交、迟到响应、更新途中输入、重启时已提交但回执未确认、规范版本变化、被替换的 CRDT 对象、旧待保存内容、二进制竞争、卸载取消及字体对象键顺序。提交后丢响应再重启的故障点属于隔离单元测试；真实服务验证了普通重启和侧车离线恢复，不能将两者混为同一证据。

仍未完成：未建模原稿样式/段落/字符属性的结构保存保留，完整 Word 图片属性与正文的同批事务，草稿选择性合并及导入，浏览器磁盘自动恢复，权限主动撤销与生产多实例容量/远端存储验收。保存确认前所有副本同时终止仍可能丢失最近输入。字体选择、PPT/PDF 同等字体编辑和其他协同能力继续在原目标内；管理平台后置。

复验：

```bash
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
cargo test -p officecli --offline --bin officecli
cargo test -p officecli --offline --test hdoc_multi_format --test html_convert
cargo clippy -p hcd-core -p officecli --all-targets --offline -- -D warnings
cargo fmt -- --check
python3 scripts/hcd-save-correctness.py --officecli target/debug/officecli
```

## 局部字号的原稿保存与导出（2026-10-23）

新增 `hcd-patch/5` 的 `text.runs`：同一个 canonical 节点内记录 Unicode scalar 数量及字号分段，正文仍只存 HTML。保留原节点 ID、source anchor、外层 run/段落样式和未编辑属性；字号分段不制造新的来源 ordinal。省略 `sizePt` 表示沿用原始 run，包括未建模的复杂文字字号。字号为 1–1638 pt、半磅步长，不能在组合附加符或 emoji ZWJ 字素簇内部切分。

- 补丁同时检查 `nodeHash` 与 `formatHash`；纯字号变化不会改变纯文字 hash，但会改变格式 hash。失败不推进 head。格式修改不清掉原批注；正文变化沿用范围重定位与失效规则。后续 CLI `text.splice` 会重定位已有字号分段。
- 编辑投影将格式分段展示为多个 inline，但保留它们的同一个来源 nodeId。协调 checkpoint 可按未变正文的字符范围识别局部字号变化；可逐段对应的后续改字也可归并回原节点，保存模式为 `source-runs`。这些版本标记为非结构修改。
- 原生 DOCX 回写按字号边界拆原 run，复制其原 `rPr`，只覆盖选中范围的 `sz`/`szCs`。保留未知属性、字符样式、段落属性、主题引用；制表符、换行、域和绘图等非文字子节点各保留一次。重复 run 的 Word `textId` 只保留在首个输出 run；其他命名空间的同名未知属性仍保留。支持命名空间前缀别名和 Strict Word 命名空间。未修改 ZIP 条目继续复制原压缩内容。
- 导入时，同段落内重复的原文字身份现在按 occurrence 生成稳定编号，避免同 run 多个 `w:t` 共用 `textId` 时导入失败；原来唯一身份的编号规则保持。
- 修复 canonical 文字提取遇到内层同名 `span` 提前结束的问题。持久化字号元数据必须与真实 HTML 文字、分段覆盖和字号 wrapper 一致，离线校验可独立发现不一致。
- 修复语义保存摘要将 Yjs 合并的同样式相邻文字与原始分段视为不同草稿的问题。摘要递归合并属性完全相同的相邻文本，保留不同来源 ID、不同格式、换行和块边界；不会用这种归一化忽略真实文字/格式编辑。

接口：`GET /v1/documents/{id}/text/{nodeId}?revision=N` 返回所选不可变版本的正文、格式 hash 和可选字号分段；写入复用鉴权 `/edits`，版本 5 支持 `text.runs`，回执带保存版本的 `formatHashes`。CLI `hdoc get-node` 同样提供格式前置条件。版本 4 的结构补丁仍独立，不被版本 5 替代。

本地验收样例 `source-size-workbench`：原稿包含命名段落/字符样式、字号 14 pt、复杂文字字号 16 pt、字符间距、书签、制表符和相邻 `w:t`。创建投影 r1 后，在浏览器选中 `中😀` 设置 28.5 pt，协调保存为 r2；两个窗口同步，peer 重开仍显示 r2。浏览器实际“保留原文件”导出 HIGH。API 读回仍为原 nodeId、原 part/ordinal；源 DOCX 导出中只有选中的 `中😀` 使用 57 half-points，源样式文件及其他未改 ZIP 条目逐字节相同。该证据只覆盖本地样例。

[结构化证据](assets/hcd-workbench-2026-10-23/word-source-size-evidence.json)

![选区字号、协调保存与原稿导出](assets/hcd-workbench-2026-10-23/word-source-size-preserved.png)

新增公开 CLI 回归覆盖 9 类检查：局部中文/emoji 字号、格式 CAS、字号后的文字修改、校验、原生与语义 DOCX 字号、未改 ZIP 条目、命名样式/间距、非文字子节点、不可变历史。隔离 API 测试覆盖只读拒绝、旧补丁版本拒绝、格式前置条件失败、精确重放、局部字号二次拆分和随后改字。

```bash
cargo build -p officecli --offline
python3 scripts/hcd-font-size-preservation.py --officecli target/debug/officecli
cargo test -p hcd-core -p hcd-docx -p hcd-formats --offline
cargo test -p officecli --offline --bin officecli --test hdoc_cli --test hdoc_multi_format --test html_convert
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
cargo clippy -p hcd-core -p hcd-docx -p hcd-formats -p officecli --all-targets --offline -- -D warnings
cargo fmt -- --check
```

本地结果：核心 54、DOCX 37、其他格式 43、OfficeCLI 二进制 98（含 API 16）、CLI 集成 4、多格式集成 19、HTML 转换 3、前端 50 项通过；独立版/嵌入版构建、clippy、fmt、diff、原保存脚本 5 类检查及新增 CLI 9 类检查通过。

当时未完成的稳定字符来源 mark 和文字/字号联合保存，已在下节继续修复；粗斜体、颜色、字体族等其他格式及结构仍可能触发重建，不能据此宣称完整原稿保真已完成。原始嵌套字段/链接标记的字号修改、含 `rPrChange` 的源 run 拆分会明确拒绝或需要后续专门支持，不能静默展开。当前语义编辑视图也未完整表达命名样式中的颜色、间距等全部属性，源文件保留与视图完整还原需要分别验证。Word 图片/正文事务、字体选择、PPT/PDF 字体编辑及协同/国际化剩余项继续推进，管理平台仍后置。

## 字符来源与联合修改保存（2026-10-23）

本轮仍在保存正确性阶段。来源身份独立于可见格式：Tiptap/Yjs 的 `hcdSource` mark 贯通投影、中文/emoji 输入、代码块、字号分段及 checkpoint；相邻同样式的多个原 `w:t` 不再依赖改字前后的字符偏移猜测对应关系。字号额外记录继承/显式状态；点击设置为基础字号也属于明确修改，不改字号时保留源复杂文字字号。

- API 按原块校验来源成员和顺序，来源缺失或未知明确拒绝。文字/字号联合变化按原节点生成非结构 `text.runs`，DOCX 源样式不被整块重建覆盖。其他字符格式或结构变化仍有语义重建路径。
- 普通文字修改使用 Unicode scalar 的最小差异范围，避免整节点 splice 使未编辑范围的批注无必要失效。HTML/Markdown/TXT 的同格式文字修改继续保留原来源结构；字号持久化的原稿精确链路目前针对 DOCX。
- 粘贴清除外部来源身份；行内粘贴继承实际插入位置，跨块粘贴不复制源 ID。显式粘贴字号保留。空段落及嵌套文本块输入使用各自的来源/字号默认值。
- 保存摘要只描述可见内容与格式，内部来源/规范 ID 回填不会生成虚假的未保存状态。原始请求仍由精确 body hash、签名和来源校验绑定。迟到回执仅更新仍存在的捕获对象，保留较新的文字和结构编辑。
- 保存协议升级为 2，房间后缀 `:typography2:save2`；binary 写入头及 checkpoint 同步使用版本 2，旧写入返回 426。API、sidecar、浏览器须一起更新。历史版本 1 回执仍可验证；先核对签名和不可变基线，再原子迁移来源，不改 revision/epoch。可确定的格式和单一来源待保存文字被保留；多个来源文字对应不明确时，原状态进入恢复副本流程。

本地浏览器样例 `source-size-workbench` 从旧签名回执 1、r2/epoch0 原位迁移。窗口 A 同时将 `中😀` 改为 `中文😀`、字号 28.5→32 pt，保存 r3；窗口 B 将紧邻的同样式来源 `after` 改为 `after edited` 并设置 18 pt，保存 r4。两窗口刷新均为 r4；选区回显 32 pt，实际操作区“保留原文件”导出 HIGH。CLI 源文件导出验证了两个原 source ordinal 保留，未编辑文字仍为原 14/16 pt，命名样式、字距、书签、制表符与换行各自保留，其他 4 个 ZIP 条目逐字节不变。证据为本地样例，不代表生产验收。

[结构化证据](assets/hcd-workbench-2026-10-23/word-source-identity-evidence.json)

![文字与字号联合保存、重开回显和原稿导出](assets/hcd-workbench-2026-10-23/word-source-identity-compound.png)

检查结果：前端 64 项、核心 54、DOCX 37、格式 43、OfficeCLI 二进制 99（含 API 17）、CLI 集成 4、多格式集成 19、HTML 转换 3 项通过；独立/嵌入构建、TypeScript、相关 crate 全 target clippy、fmt、diff、保存脚本 5 类及字号 CLI 9 类检查通过。针对旧草稿不明确归属、UTF-16/Unicode 边界、1200 个相邻来源、过期回执及并发编辑的覆盖属于隔离测试，不能等同于生产容量证明。

属性设计下一步仍按 [上下文属性侧栏分析](design/hcd-context-properties.zh.md) 推进：统一页面/对象/字符选择，分开工作区设置，准确回显混合值，再逐项贯通保存和导出。完整 Word 图片/正文事务、其他格式的原稿保留、字体选择、国际化与协同余项仍在目标内；管理平台后置。

## 完整 Word 正文与图片几何的原子提交基础（2026-10-23）

本节当时完成服务端和核心事务能力，前端尚未接入。下节已继续完成完整 Word 的正文与图片位置/尺寸统一协调保存；图片替换仍独立提交，不能据此宣称全部图片操作已经合并。

- 协调 `/checkpoints` 增加可选 `images`，每项为 `nodeId`、原坐标单位下的 `geometry` 和 `precondition.visualHash`。文字/字号、颜色、段落结构均可与图片几何在同一个文档写锁和 revision CAS 下提交。图片单独变化也不会因正文无变化被忽略；重复图片、过期视觉 hash、缺失图片、单位变化及非法尺寸均拒绝整批。
- `hcd-patch/4` 的语义事务增加 `image.geometry` 操作，支持与块插入/删除/移动/替换一起提交。图片操作在块操作之后校验和应用，块的原 hash 不受图片输入顺序影响；图片失效时，之前内存中修改的块不会写入 revision/manifest。重复图片操作拒绝，不以后一个值覆盖前一个值。纯图片批次不标成结构变化。
- 联合请求的签名 body hash 同时绑定正文和图片，空图片请求保持原文本协议签名兼容。回执包含该保存版本的图片状态；重放在更晚图片修改之后仍返回原 revision 的图片，不能把最新 head 的图片冒充原请求结果。
- 修复未改动的只读图片块使颜色修改误走结构重建的问题；保留原图块时，颜色可走已有 `node.style` 路径。此项不扩展源 DOCX 的颜色或图片原生回写能力。

真实 loopback HTTP 回归使用 4 份独立 Word 样例，覆盖文字/字号＋图片、颜色＋图片、段落转标题＋图片及仅图片变化。各自 r1→r2 一次提交，故意构造的图片冲突不改变正文、图片和 revision；之后图片独立修改为 r3，再重放旧请求仍返回 r2 的原图片回执，head 保持 r3。只读请求返回 403；源 DOCX 图片回写仍在输出文件创建前明确拒绝。

[HTTP 验收证据](assets/hcd-workbench-2026-10-23/word-image-transaction-evidence.json)

```bash
cargo build -p officecli --offline
python3 scripts/hcd-word-image-transaction.py --officecli target/debug/officecli
cargo test -p hcd-core -p officecli --offline --lib --bin officecli
cargo test -p officecli --offline --test hdoc_cli --test hdoc_multi_format --test html_convert
cargo clippy -p hcd-core -p officecli --all-targets --offline -- -D warnings
cargo fmt -- --check
```

本地核心 54、OfficeCLI 101、CLI 集成 4、多格式集成 19、HTML 转换 3 项通过；四路径定向测试、真实 HTTP 回归、fmt、diff 和相关全 target clippy 通过。结构操作执行到后置图片校验才失败的回滚、输入顺序与重复图片拒绝另有隔离测试。

下一步必须把完整 Word 图片草稿放入与正文相同的协同模型和协调器：保存前持久化、自动/手动提交统一、迟到回执只确认捕获值、重启恢复已提交但未确认的图片，并让保存摘要、导出和关闭覆盖图片。共享草稿需按 nodeId 和捕获 generation 更新，不能整张 Map 回填覆盖其他窗口的新草稿；未编辑图片不装载到草稿正文，缩略预览与资源内容也不应重复写入 CRDT。图片替换目前也仍是独立写入，需要一起继续收敛。旧客户端兼容、图片选区/草稿冲突、撤销重做、实际导出和双窗口浏览器验收未完成。原生 Word 图片几何回写及完整布局保真仍未实现；管理平台后置。

## 完整 Word 的正文与图片属性统一协同保存（协议 3，2026-10-23）

完整 Word 的操作区“保存”现已同时覆盖正文和图片位置/尺寸；图片详细属性从紧凑操作栏移至“插入 → 图片属性”的右侧可滚动面板，复用可调宽度、只读控制及同一个协调保存入口。页面/节属性与跨对象选择逻辑仍需后续统一，不能把这一图片侧栏视为整个属性 redesign 完成。

- 图片草稿与正文处于同一 Y.Doc。每次图片编辑使用独立意图 ID，按实际改动的字段合并；过期渲染闭包不能把其他字段回填为旧值。不同字段可以合并，同字段不同值保留全部候选，按 20 项展开审阅，明确选择后才提交。此模型最多处理 1000 张待保存图片和 4000 个意图；它不把预览图或资源字节复制进 CRDT。
- 一间房由同一协调器串行执行手动和自动保存。请求同时核对正文和图片意图摘要；关闭、切换分段模式及导出需要覆盖当前两部分的确认。非法坐标/尺寸和未解决的图片分歧阻止整批规范提交；只读窗口可查看，但不能修改、采用冲突候选或丢弃共享草稿，也不因别人的待保存内容阻止自身离开。
- 提交前保存 CRDT 和签名待提交记录。记录包含捕获图片意图及正文块的 Yjs 相对位置，不重复存一份正文。迟到确认仅删除捕获的意图；可证明是后续输入/回撤的值继续保留，未见过的新同字段意图则与已提交值并列为冲突。祖先线索有界为 64 步，无法证明顺序时保留冲突，不猜测覆盖。
- 迟到或重启后的图片基线来自鉴权 API 的不可变 `GET /images/{nodeId}?revision=N`，不信任可写 CRDT 内的预览回执。协调器按原始和当前版本比较实际字段：不相交的字段可重定位；重叠不同值需确认。请求并行上限 4，缓存最多 2048 个不可变查询，不读取全篇图片来打开属性栏。
- 保存协议升级为 3，语义房间后缀 `:typography2:save3`，checkpoint 和 binary 写入均要求版本 3。API、sidecar、浏览器须一同更新；旧写入返回 426。版本 1/2 签名回执仍可核对迁移，不新增内容 revision、不重置 epoch。历史 `hcdsave1/2` 与当前 `hcdsave3` 按各自签名验证。服务端恢复有效基线后，客户端可解除旧的缓存冲突状态，待保存内容仍须另行确认。

本地浏览器样例 `atomic-word-workbench`：

1. 窗口 A 改正文、图片横坐标 10→12 pt；窗口 B 改宽度 100→110 pt。一次操作区保存生成 r2，规范记录只含一条联合提交，保留两位协作者，两个窗口刷新值一致。
2. 将宽度设为 0，同时修改相邻段落，保存失败后 head 仍为 r2；规范正文仍是 `Neighbor`、宽度仍 110 pt。修正为 120 pt 后，正文和图片一起保存 r3。只读窗口的修改和丢弃控件均禁用。普通侧车重启后仍可恢复 r3。
3. 侧车断开时，两窗口分别输入横坐标 13 和 14 pt。先重连的窗口保存 13 为 r4；14 pt 草稿稍后到达时，右侧完整保留两个值，head 保持 r4。重启并从已持久化草稿审阅仍可选择；明确采用 14 pt 后才生成 r5，宽度仍 120 pt，正文不变。此项覆盖实际迟到重连；未模拟所有浏览器副本在确认前同时终止。
4. `source-size-workbench` 的签名回执 2→3 原位迁移后仍为 r4/epoch0，规范 rootHash 完全相同。联合保存样例 r5 的协同二进制确认没有残留图片意图或待确认提交。

[联合保存、迁移及导出证据](assets/hcd-workbench-2026-10-23/word-image-coordinated-evidence.json)

![已保存的紧凑操作区与图片属性](assets/hcd-workbench-2026-10-23/word-image-coordinated.png)

![已提交值与迟到草稿的明确选择](assets/hcd-workbench-2026-10-23/word-image-collaboration-conflict.png)

浏览器实际语义 DOCX 导出验证 r3；CLI 在不可变 r5 验证新正文和图片 120×50 pt 尺寸。此证据不覆盖 Word 浮动 x/y 的完整导出保真，源 DOCX 图片增量回写仍不支持，界面选择当前内容导出并明确标示语义重建。

本地前端 81、OfficeCLI 101、CLI 集成 4、多格式集成 19、HTML 转换 3 项通过；四路径真实 HTTP 回归使用协议 3，覆盖旧客户端拒绝、不可变图片读取与重放；独立/嵌入构建、相关全 target clippy、fmt 和 diff 检查通过。提交后丢响应的重启恢复、保存期间新输入/回撤、三个同时写入者的全部候选、离线不相交字段重定位属于隔离测试；不能扩展为生产容量证明。

仍未完成：图片替换与正文/几何的同批提交，图片属性与正文统一撤销重做，原生 Word 图片回写/浮动布局，浏览器磁盘自动恢复、正文选择性合并/备份导入、权限主动撤销和生产多实例/远端存储验收。完整 Word 仍是全文 Yjs 模型，分段模式才有正文按需加载。字体选择、其他格式同等字体编辑、国际化/RTL 与页面/文字对象属性余项继续在原目标内；管理平台后置。

## 图片替换的联合事务服务端基础（2026-10-23）

本阶段继续处理保存正确性。完整 Word 的替换按钮原先直接写入独立图片版本，尚不能与正文、位置和尺寸作为同一待保存内容。当前先补齐规范服务端事务，前端入口仍待接入，不能将此阶段解释为用户侧联合替换已经完成。

- `POST /checkpoints` 的图片项新增可选 `assetHash`。省略时保留原几何请求的序列化和签名形式；传入时精确请求签名同时绑定资源身份、几何和正文。源文字/字号、表现样式、语义结构和仅图片四条路径都可一次提交替换与几何，沿用服务协议 3。
- `hcd-patch/4` 新增 `image.replace`，可在同一操作携带可选 `geometry`。图片操作在块操作之后应用，仍使用原始视觉前置条件；同一图片重复目标拒绝，被删除的图片目标使整批失败。仅替换图片不被错误标记为正文结构重建。
- 替换引用的资源须先通过 SHA-256 和长度验证，包含复用已索引资源的情形；同批次相同资源只检查一次，避免多张图片复用时重复读取字节。只有全部正文和图片操作通过后，新资源才进入该不可变版本的资源索引。历史版本沿用原资源索引；无新资源的结构修改保留原索引对象。失败不能发布新的 head、正文或资源索引。
- 回执与重试使用已保存的不可变图片。即使后来又调整图片位置，旧请求重放仍返回原资源和几何；同一请求标识换资源会冲突。
- 修正了 patch/4 JSON Schema 的视觉哈希引用：使用已定义的 `hash`，避免原 `sha256` 悬空引用。

复现命令（先构建，脚本运行期间不要重编译同一二进制）：

```sh
cargo build -p officecli
python3 scripts/hcd-word-image-transaction.py
```

脚本使用独立临时目录、临时签名密钥和随机 loopback 端口，不修改已有工作台文档。覆盖四种保存路径各自含/不含替换，共八组真实 HTTP 场景；解包固定 r2 的语义 DOCX，检查实际图片字节、尺寸以及变更正文。源 DOCX 图片增量回写仍明确拒绝，不能以语义导出代替原生版式保真证明。

本地验证通过：完整 Rust 回归 397 项（核心 54、OfficeCLI 102、命令 215、HCD CLI 4、多格式 19、HTML 转换 3）；最终资源重复读取优化后再次通过核心/OfficeCLI 156 项。构建、`cargo clippy -p hcd-core -p officecli --all-targets -- -D warnings`、fmt 和 diff 检查通过。八组真实 HTTP 回归已解包 r2 语义 DOCX，沿 `a:blip` → relationship → media 文件验证实际引用的新图片字节；后续 r3 再替换为原图并改几何，r2 重放仍返回原来已保存的新图。证据范围为本地 HTTP、文件系统和 CLI，不包含浏览器替换入口、生产部署或原生 Word 浮动布局验收。

[八组联合事务和 DOCX 字节验证证据](assets/hcd-workbench-2026-10-23/word-image-replacement-api-evidence.json)

待继续：把上传后的资源身份作为共享替换意图，与正文及几何一起等待同一保存回执；补齐并发替换候选、上传期间关闭/导出约束、迟到确认、断线重开与协议迁移验证。此阶段没有修改浏览器界面，没有重置现有工作台或协同房间；管理平台仍后置。

## 完整 Word 换图的共享草稿与联合保存（协议 4，2026-10-23）

接续上一阶段的服务端事务，完整 Word 的“替换图片”现已不再直接发布单独版本。上传完成后形成共享资源意图，与正文、位置和尺寸一起等待同一保存确认。管理平台仍后置。

- 图片资源身份是独立可合并字段；换图和另一人的宽高修改可以合并，多个相同资源选择可以收敛。不同替换保留全部候选，明确采用其中一个后才提交。确认不仅核对坐标，还核对实际资产哈希；错误回执不能清除图片草稿。
- 异步上传前捕获基线与已见意图。上传后只替代当时已见且仍相同的资源意图，保留几何及后来到达的输入。共享模型只存资源身份，图片字节仍留在鉴权资源存储。尚未上传完成时，本窗口保存、导出、关闭和“保留副本后打开最新版本”受保护；这些入口不能把未注册完的换图算作已经保存。
- 新增 `GET /staged-assets/{hash}`，要求同一文档读权限，核对哈希及长度，不增加内容版本。图片预览使用鉴权请求和可回收的 Blob URL；候选预览点击后才加载，卸载/切换时取消请求并回收 URL。仅换图冲突省略重复的几何对照，位置尺寸仍显示在属性输入区。
- 进一步修复暂存资源的 GC 丢失风险：暂存描述符作为资源保留根，未提交的换图不会因不在规范资源索引中而被清理。上传在同一 bundle 写锁内发布资源和描述符，避免 GC 观察到半次暂存。损坏描述符使清理失败，不能将不确定资源当作孤儿删除；暂存字节不计入最新规范 revision 的新增字节。当前保守保留全部暂存资源，尚未实现安全的暂存租约/取消清理；并发本地写锁冲突可返回 409，草稿不会被误记为保存成功。
- API、sidecar 与浏览器保存协议同时升级为 4，房间 `:typography2:save4`，图片意图元数据 2。旧协议 3 的 checkpoint/binary 写入返回 426，防止旧协调器忽略资源字段。版本 1/2/3 的有效签名回执在不可变基线验证后原位迁移，保留 Yjs 对象、待保存内容及 epoch；提交后丢响应仍从已签名尝试及不可变图片恢复。

真实浏览器验证使用独立样例 `replacement-word-workbench`：

1. 构造有效协议 3 的 r1/epoch0 待保存正文与 110 pt 图片宽度。协议 4 工作台以原稿基线恢复两份草稿，之后自动保存为 r2；旧 r1 root 保持不变，epoch 仍为 0。此为本地构造的旧协议迁移夹具，不是生产旧数据验收。
2. 红色替换草稿在上传后显示“待保存”，之后自动保存 r3。浏览器再修改正文为 `联合换图正文 中文😀`、选择蓝图并将高度设为 55 pt，一次操作区保存生成 r4。r3→r4 的不可变记录同时包含正文与图片两节点变化，资源和高度随正文一起更新，没有残留意图。
3. 两窗口已同步 r4 后停止本地侧车，分别上传红图和绿图。重连后两份资源意图均已落盘，规范 head 保持 r4；只读第三窗口可查看冲突，采用和丢弃按钮禁用。明确选择绿色候选后才保存 r5，正文与 110×55 pt 尺寸不变。
4. 重新打开仍为 r5，图片属性预览为绿色。从操作区实际下载 r5 DOCX，沿 `a:blip` → relationship → media 核对引用的确为绿色图片原始字节，同时检查宽高与 Unicode 正文。规范 binary 的签名版本为 4、epoch0，正文摘要一致，没有剩余图片意图或待确认尝试。

[浏览器、不可变版本和实际下载证据](assets/hcd-workbench-2026-10-23/word-replacement-browser-evidence.json) · [协议 4 八组 HTTP/CLI 回归](assets/hcd-workbench-2026-10-23/word-image-replacement-v4-evidence.json)

![操作区导出及保存后的图片属性](assets/hcd-workbench-2026-10-23/word-replacement-saved.png)

![重连后保留的两份替换候选](assets/hcd-workbench-2026-10-23/word-replacement-conflict.png)

验证通过：前端 89 项；补强 v2/v3 迁移后相关协调器 27 项；API/修订通知 29 项；暂存资源 GC 修复后的核心 55 项、格式 43 项（含 PDF 图片保存/原生导出）；独立和嵌入构建；协议 4 的八组真实 HTTP/CLI/DOCX 字节验证；相关全 target clippy、fmt、diff 与新增源码空白检查。一次既有修订通知测试在构建负载下暴露固定 10 ms 等待竞态，改为等待第二个连接事件，并在测试结束时中止监听；原挂起进程已停止，修正后完整前端测试通过。提交后丢响应恢复与上传期间新输入/撤回属于隔离测试；未进行浏览器慢网上传中途终止或生产多实例验收。

额外的 GC 端到端回归先在修复前二进制复现：暂存后执行 `hdoc gc --delete`，预览返回 500，资源文件丢失。修复后八组场景都在暂存后实际执行清理，仍可读取暂存预览、联合保存并导出正确图片。已更新本地 API 运行时，原工作台保持 r5。

仍未完成：固定/分段工作区换图与正文/几何的联合事务，图片与正文统一撤销重做，权限主动撤销，生产远端存储/多实例验收。浏览器磁盘恢复的后续进展见下一节。完整 Word 正文中的图片仍是受保护占位，图片预览在属性栏，尚非完整所见即所得排版；图片列表分页与正文对象选择也需完善；源 Word 图片增量回写与浮动 x/y 保真未实现。国际化、字体选择、统一页面/文字对象属性和长文全文协同分段模型继续属于原目标。

## 完整 Word 的本机草稿日志与恢复选择（2026-10-23）

继续优先处理保存正确性。新增原生 IndexedDB 的 Yjs 追加日志，按 API/协作服务、文档、用户和 epoch 隔离，键不含 token。每次更新事务完成才显示“本机备份已记录”，配额/写入失败有独立告警；不能把本机备份当作规范服务端保存。日志限制为单条 8 MiB、总量 64 MiB / 100000 条，累计 128 条后在同一读写事务中合并所有窗口的日志，避免旧窗口快照覆盖其他窗口的输入。未自动删除历史副本。

启动时先读取本机日志、鉴权协作 binary 并比较，再创建协作 provider。发现当前 epoch 未同步草稿时，展示文字与图片意图对照，允许恢复、下载 `.hcd-draft`，或打开服务端版本并保留本机副本。恢复动作重新取得当前服务端内容，以 CRDT 合并正文和图片意图；签名回执、schema 和图片确认元数据仍以鉴权服务端为准。协调器同时修复来自旧磁盘重放的回执/schema/尝试元数据，私有签名中的有效基线和在途尝试不能被客户端 map 回放取代。旧 epoch 或归档副本仅供下载，不自动进入新房间；选择保留副本后创建独立日志分支。

正常保存后等待本机写入屏障，并再次核对新输入；磁盘故障不阻止有效的服务端保存，但持续显示本机备份不可用。浏览器不支持数据库枚举、存储不可用或载荷损坏时明确提示并提供重试/显式继续，缓存不会被故障处理清空。完整 Word 的离线恢复仍需当前服务鉴权和协作状态可读取，尚非整个应用断网冷启动。

真实浏览器隔离样例 `offline-word-workbench`：

1. r1 同步后停止该样例专用 sidecar，输入 `断线后保留的正文 中文😀`，上传红图、宽度改为 125 pt。确认本机事务完成；真实 API 此时仍为 r1 原文。
2. 关闭整个样例页，再新开相同 URL。页面从真实 IndexedDB 读出正文与一张换图草稿，进入恢复选择，尚未加入房间。已取得恢复对照截图。
3. 另一个用户窗口只看到服务端原文，将第二段改为 `另一位协作者的新内容` 并保存 r2。原恢复页选择恢复时重新获取 r2，保留两个不同段落的修改和红图/125×50 pt 尺寸，联合保存为 r3。
4. 再次重载直接打开已保存 r3，不重复要求恢复；实际 API 导出的固定 r3 DOCX 解包回读，两段 Unicode 正文正确，沿实际 blip/relationship 引用的媒体文件与红图原始字节一致，宽高 125×50 pt。规范协作 binary 无剩余图片意图或待确认尝试。

[浏览器/HTTP/DOCX 证据](assets/hcd-workbench-2026-10-23/word-local-draft-browser-evidence.json) · [恢复对照](assets/hcd-workbench-2026-10-23/word-local-draft-review.png)

![关页重开恢复、合并协作者新内容并保存后的工作区](assets/hcd-workbench-2026-10-23/word-local-draft-recovered.png)

验证：前端 96 项通过，包含 6 项 IndexedDB 日志/配额/多窗口合并/旧版副本测试和 1 项协调器元数据重放测试；独立与嵌入生产构建通过。真实验证范围为本地浏览器关页重开、IndexedDB、鉴权 HTTP 和实际 DOCX；浏览器不支持所尝试的 renderer crash 方法，未执行强杀/系统崩溃测试，不能用关页验证替代系统掉电、磁盘驱逐或隐私模式验收。事务尚未完成的输入仍可能丢失。图片缓存只有资源身份，恢复预览依赖服务端暂存资源，并非自包含离线图片包。

待继续：旧版/多分支副本的安全清理、备份导入和正文选择性合并、完全离线应用启动与资源包、固定/分段编辑器等效保护、统一撤销、权限撤销及生产多实例。现有原工作台保持 r5；测试使用独立文档和独立 sidecar。

## Notion 式交互、可扩展内容与 AI 的分析

新增 [扩展与 AI 设计](design/hcd-editor-extensions-and-ai.zh.md)，覆盖菜单/快捷键统一注册、块与行内扩展、schema 与协作版本协商、逐格式降级报告、私有 AI 建议与接受事务。现有 Tiptap 已提供基础浮层/右键/格式，但公开扩展 SDK、slash 菜单、自定义节点协议和 AI 尚未实现。先完成保存基础，接着抽取现有命令，再扩展内容协议及 AI；管理平台继续后置。

用户确认继续后，新增 [分阶段实施清单与人员提及服务](design/hcd-editor-delivery-plan.zh.md)：覆盖保存/协同、统一命令、Notion 式交互、默认 `@`、人员目录与文档关联、提醒事件接口、自定义节点、通用 AI 及导出验收。当前服务的 doc/scope/sub/name/exp token 尚不构成完整组织人员目录；提及候选将由受文档权限约束的服务端目录适配器供给，不能用 awareness 在线头像代替，也不能通过提及自动授予访问权限。实际提醒不发送；人员节点、引用查询与提醒契约仍为待实施项。

保存优先的补强：增加回归复现 IndexedDB 日志一次写入失败后，下一次 delta 成功会把状态改回“已记录”的问题。此时中间 CRDT 更新可能未落盘，后续写入不能证明日志完整。现改为保留首次失败状态与错误；只有用完整当前文档初始化独立新日志才重新取得可靠的备份状态。完整前端 97 项通过（新增失败后继续输入用例），没有用隔离 IndexedDB 回归代替浏览器真实配额耗尽或系统崩溃验收。

## 固定布局与分段编辑的换图联合保存（2026-10-23）

继续执行保存优先。固定/分段模式此前把替换图片直接发布为独立版本；现在与正文、图片几何共用待保存集合。上传只产生已暂存资源和内存草稿，不提前发布内容版本。图片属性栏的“保存”也提交全部待保存文字与图片，避免只保存选中图片而留下正文。

- `/edits` 在既有 `hcd-patch/3`、`hcd-patch/5` 中开放 `image.replace`，同一图片的替换和几何使用相同 visualHash 前置条件。核心仍在单一写锁下校验资源、正文及图片并发布不可变 revision；错误资源使整批失败。
- 服务端回执从实际保存的不可变 manifest 读取图片资源、尺寸和 visualHash，按图片去重，而非从几何请求推测资源身份。后来再换图，旧请求重放仍确认原图片。旧 base 的 PDF 请求先交给核心判断重放或 CAS 失败，不再提前拿旧正文前置条件规划当前 PDF 页面。
- 工作区图片草稿包含 assetHash；调整尺寸回到原值不会丢掉待换图。匹配尺寸但资源不同不能自动确认；并发远端资源变化保留冲突，明确保留本地后重建前置条件。保存期间再次换图或修改尺寸仍留为新草稿。整批回执不完整或资源错误时，不能仅清掉正文子集。
- 上传状态提升到工作区，切换页/卸载属性栏仍受保存、关闭、导出、布局升级和切换完整编辑器保护；上传中头部不显示“已保存”。预览使用鉴权资源/暂存读取和可回收 Blob URL。

本地验证：前端 101 项，API 模块 22 项，相关全 target clippy、fmt/diff、Rust 构建、独立与嵌入前端构建通过。新增独立复现脚本：

```sh
cargo build -p officecli
python3 scripts/hcd-fixed-image-transaction.py
```

脚本为 Word/PPT/PDF 创建独立夹具和临时端口，核对错误资源不发布 revision、r1 同时保存文字/换图/宽度、r2 再替换后 r1 重放仍返回原资源。实际 DOCX/PPTX 沿 blip/relationship 读取引用媒体并核对尺寸；原生 PDF 导出用独立 `pypdf` 验证可选文字、实际 Do 引用的红色 XObject 和宽度缩放矩阵，未把仍保留的未使用原始蓝图当作错误。

真实 PPT 浏览器在独立工作台输入 `浏览器联合保存 中文😀`、上传红图、将宽度设为 130 pt，暂存时规范 head 仍为 r2；从图片属性保存一次生成 r3，正文和图片草稿全部清空。重载仍为 r3；从操作区实际下载语义 PPTX，回读文字、活动图片引用字节和 130 pt 宽度均正确。Word 分段与 PDF 本轮为真实 HTTP/文件验收，未声称三种格式都完成同样的浏览器操作。

[HTTP、实际文件与浏览器证据](assets/hcd-workbench-2026-10-23/fixed-image-transaction-evidence.json)

![PPT 正文、换图与宽度联合保存并实际导出](assets/hcd-workbench-2026-10-23/fixed-ppt-joint-save.png)

仍需继续：固定/分段本机持久草稿与未知请求结果恢复、统一图片/文字撤销重做、字段级并发合并、权限主动撤销、完整 Word 数据分段和生产多实例验收。当前固定/分段草稿在内存中，页面刷新前仍有离开保护，尚不具备完整 Word 的 IndexedDB 恢复。Office 源图片增量回写和浮动布局保真仍未完成；本次 Office 导出为语义重建。上述均为本地证据，原 Word 工作台核查时已为此前 10:38 自动保存的 r6（含新增空段落），本阶段未回退或再新增该文档版本，仅刷新了同权限的到期验收令牌；其正文、绿色图片与尺寸保持。空段落来源需另行核查，不能依照旧记录把当前 head 写成 r5。统一命令、Notion 菜单、人员引用、自定义节点、AI 和管理平台尚未在本阶段实现；管理平台继续后置。

## 固定/分段的持久草稿与未知保存结果恢复（2026-10-23）

接续联合保存，新增每窗口 `FixedSaveController` 和 IndexedDB 完整快照日志。普通固定/分段编辑不属于全文 Yjs 房间，因此以鉴权用户、API/协作地址、文档 ID 和不可变源文件 SHA-256 隔离；不随 Word 分段提交触发的语义 epoch 重置而丢掉后续输入。每个窗口拥有独立分支，恢复时另建分支，其他窗口和显式保留的副本不被旧快照覆盖。

- 新请求先把原 patchId、baseRevision、捕获正文/图片/资源和当前后续输入持久写入，再发 `/edits`。超时、网络错误或不完整回执保留原身份和捕获对象。未确认时不允许丢弃/解决被捕获的草稿，但仍可继续输入；关闭、切换完整编辑和导出继续受保护。服务端已确认后，本机确认写入失败不否定规范保存；旧磁盘请求下次仍解析为相同回执。正常备份模式下，配置日志无法记录新请求时不提交，保留草稿和下载入口；可重试备份，或明确选择暂停本机备份继续联网保存，后者持续告警且不承诺跨关页恢复。
- 新增只读 `POST /edits/receipt`：提交相同 patch 内容，按不可变记录和鉴权作者核对完整哈希，返回 `missing` 或 `committed`。人员显示名变更使用记录中的原署名还原哈希；同作者读令牌可查，异作者、同 ID 不同内容均拒绝。查询不写版本、不改变规范 head，不触发协作 reset。仅确认尚未提交时才可重发原请求；不会换一个新 patchId 盲重试。
- 保存回执现在还须匹配捕获正文的实际 SHA-256，和图片资源/几何一起验证后才清除任何子集。后来的输入重定位到已确认基线；更晚的远端文字、删除和资源冲突仍保留。恢复后刷新含屏外草稿在内的目标，不只依赖当前已加载页。
- 本机快照每份最多 8 MiB，最多 64 个非空窗口副本，加载副本累计限制 64 MiB；用有界 cursor 读取。只有自己的空确认状态可删除自己的分支；保留副本不自动清理，也不再次自动套用。存储故障保留之前已提交副本；完整新快照成功后可恢复备份状态，区别于 Yjs 增量日志的缺口不能靠后续 delta 掩盖。
- `.hcd-draft` 下载采用 `hcd-fixed-recovery/1`，包含不可变源身份、正文、几何、资源引用和原请求，不含 token、预览 URL 或目录凭证。未完成上传的文件记录中断状态并提示重新选择，尚未缓存上传中的完整文件字节。

本地验证通过：前端 110 项（新增 9 项固定恢复/隔离/并发分支/限额/丢响应/错误摘要验证）；API 模块 22 项（扩展联合事务测试，覆盖只读回执、异作者拒绝、改名、错误载荷和不变 head）；Rust 构建、相关全 target clippy、fmt/diff、独立与嵌入前端构建。Word 分段清空全部文字额外通过真实 HTTP 保存与空字符串摘要回执验证。复现脚本 `scripts/hcd-fixed-image-transaction.py` 已对三种格式增加真实回执查询、旧版本图片/正文确认和错误载荷拒绝；实际 DOCX/PPTX/PDF 文件验证仍通过。

真实 PPT 浏览器故障链路使用独立本地代理，规范 API 运行在独立 8770 端口：

1. r3 输入 `提交后丢响应 中文😀`、上传绿图并设宽度 135 pt。代理在规范提交 r4 并读完响应后断开浏览器连接，同时让回执查询暂时 503。独立 API 确认 head 已是 r4；页面显示结果未确认，原尝试与草稿已写入真实 IndexedDB。
2. 继续输入 `丢响应后继续输入 中文😀`，确认本机备份完成，关闭整个页面再重开。恢复页同时显示本机新文字、服务端 r4 原文字和待核对请求；明确恢复后移除故障，核对原请求，head 保持 r4，后续输入仍为未保存草稿。
3. 再保存后续输入生成 r5。实际从操作区下载 r5 语义 PPTX，回读正文、blip/relationship 活动绿图字节和 135 pt 宽度正确。
4. 再建未提交的黄图、140 pt 与新文字草稿，关页重开后仍能预览暂存黄图。下载草稿并选择“打开服务端版本，保留本机副本”，规范仍为 r5 绿图，两个本机副本保留，重载不反复恢复旧内容。
5. 通过正常界面下载此前未确认的副本，验证其中原请求仍指向 r3 基线，捕获正文与后续正文分开；从文件重建完整请求，真实 `/edits/receipt` 返回 r4，和 r4 不可变记录 ID 一致。两份备份都含原始 source hash，不含令牌。未将浏览器内存/隐藏状态读取当作磁盘恢复证据。

[真实浏览器、下载备份和实际 PPTX 证据](assets/hcd-workbench-2026-10-23/fixed-recovery-browser-evidence.json) · [三格式 HTTP/文件证据](assets/hcd-workbench-2026-10-23/fixed-recovery-api-evidence.json)

![已提交但结果未知时的本机恢复对照](assets/hcd-workbench-2026-10-23/fixed-recovery-review.png)

![核对原请求并保存后续输入后的 r5](assets/hcd-workbench-2026-10-23/fixed-recovery-saved.png)

本地默认 API 8766 已更新为同版二进制，保留原文档目录、签名密钥和不可变历史，全文 Word 仍沿协议 4。恢复的完整浏览器链路本轮验证了 PPT，Word/PDF 为真实 HTTP/文件与共享恢复模型验证；未宣称各格式所有浏览器行为或生产多实例均已验收。仍需服务端鉴权和当前源身份才能冷启动，图片依赖服务器已暂存/已索引字节，备份导入、跨源副本迁移、安全清理、浏览器驱逐/隐私模式、renderer/系统崩溃与生产部署仍未验证。图片/文字统一撤销重做、权限主动撤销、长文全文数据分段和其他协同剩余项继续优先；Notion 菜单、人员提及、自定义节点、AI 仍待后续实现；管理平台与实际提醒继续不做。

## 后续工作

1. 编辑能力：PPT 新建/删除/重排幻灯片、形状拖动与格式、母版/动画/备注；PDF 内联图片流、复杂裁剪及内容处理；完整 Word/Yjs 的数据分段模型。当前不宣称达到 Office 全功能。
2. 国际化：已去掉 Word 边栏区域标签对浏览器全局语言的读取，改为当前编辑器语言；继续统一服务端错误码、名称长度、正文语言、RTL、输入法与 Unicode 边界。
3. 字体：已增加内置字体身份、无源 PDF 簇级回退、嵌入身份复用校验，以及 Word 原字体/字号读取与保存；已接通 Word 选区字号与 native DOCX runs；继续保留完整原稿属性、接通字体选择、文档依赖、预览与各格式导出。字体上传/管理平台后置。
4. 协同：本地已修复多标签连接排队及历史补发，并接入语义保存协调与恢复副本；继续处理正文选择性恢复/合并、离线资源完整打包、磁盘副本生命周期、主动权限撤销、审阅线程与多实例验收。完整 Word 的本机 CRDT 日志及恢复选择、固定/分段完整快照和原请求结果核对均已接通。
5. 管理平台：在以上基础稳定后再做 WPS 云服务式的文档、成员、权限、模板、字体与常用管理；本轮没有开始管理平台。

整体目标仍进行中。以上均为本地样例与本地构建/测试证据，未部署或进行生产验收。

本轮界面截图：

- [PPT 对象属性](assets/hcd-workbench-2026-10-23/ppt-properties.jpg)
- [Word 文字属性](assets/hcd-workbench-2026-10-23/word-properties.jpg)
- [PDF 点击区域与保存位置](assets/hcd-workbench-2026-10-23/pdf-properties.jpg)
- [长文分段](assets/hcd-workbench-2026-10-23/long-text-sections.jpg)
- [图片位置与尺寸属性](assets/hcd-workbench-2026-10-23/image-properties.jpg)

## 固定/分段的按字段撤销与 PDF 源图恢复（2026-10-23）

固定布局 PPT、PDF 和 Word 分段页新增 `FixedHistory`，按当前窗口的用户动作记录正文、图片资源和几何字段。连续输入可合并为一条记录；切换控件、保存和显式边界结束合并。保存回执、远端刷新与本机草稿恢复不产生用户撤销项。保存后记录继续有效，撤销先读取鉴权后的当前对象，只生成待保存反向草稿，再走原有联合事务和原请求回执流程。

- 撤销图片宽度时，仅逆转宽度，保留同事改变的高度等字段；生成的新反向草稿不重复提交未改变的图片资源，只有真实换图/源图恢复才写资源操作。已有本机其他字段也先按当前规范对象核查、保留；相同字段已发生不同修改、对象删除或请求失败时不改草稿、不发布版本。不会调用整文档历史版本回退来实现个人撤销。
- 正文与图片共用一条时间顺序记录；`Mod+Z`、`Mod+Shift+Z` / Windows `Ctrl+Y` 与操作区按钮一致。搜索框保留自身输入撤销，组合输入期间不接管按键。新输入会清除当前分支的重做记录。
- 核查期间出现输入或刷新时，旧核查结果不能覆盖新草稿；关闭时取消请求。上传、保存和结果未知期间暂停撤销/重做，原请求身份和捕获内容保持不变。核查冲突后可明确选择“保留当前内容并跳过此记录”，只处理历史栈，不修改当前正文或草稿；过期的核查不能跳过后来新增的操作。
- 原生 PDF 有些图片/图形直接来自源 XObject，没有独立资源哈希。新增 `image.restoreSource`：仅允许已验证的原始 source-only PDF 位置，移除其替换覆盖，保留当前几何，原始源对象继续提供内容。它与 `image.replace` 在同一对象内互斥，使用相同 visualHash/CAS、联合保存和不可变回执；非 PDF、无对应原始来源或缺少可验证源文件时失败并保留草稿。保存前明确显示源图预览将在保存后更新。操作定义已加入 patch/3 和 patch/5 的 JSON Schema，需配套新版 API；旧 API 拒绝时不得降级为只保存几何。
- 固定草稿状态升级为 version 2，保存和恢复“恢复源图”意图及其未知请求；普通 version 1 副本可读取并规范化，未来未知版本和不合法组合继续保留而不静默导入。数据库作用域与各窗口副本隔离规则不变。

浏览器已验证 PPT：正文保存 r9 后撤销并保存 r10；文本框快捷键撤销/重做后保存 r11；自己的宽度 150 pt 保存 r12，另一身份的高度 90 pt 保存 r13；撤销自己的宽度并保存 r14，结果 125 × 90 pt。实际从界面下载的 r14 语义 PPTX 已核查 Unicode 正文、活动 blip 引用的红色资源和两个尺寸。见 [浏览器证据](assets/hcd-workbench-2026-10-23/fixed-history-browser-evidence.json)。

![撤销自己的宽度后保留同事高度并导出 r14](assets/hcd-workbench-2026-10-23/fixed-history-ppt-saved.png)

复现原生服务与实际导出文件回归：

```sh
cargo build -p officecli
python3 scripts/hcd-fixed-history.py
```

脚本使用临时源文件、独立回环 API 和两个鉴权身份，驱动与界面相同的 `FixedSaveController` / `FixedHistory`。已通过 DOCX、PPTX、原生 PDF 的保存后正文/换图/宽度撤销重做、同事高度保留、无效源图恢复整批拒绝、源图恢复回执，以及 r5/r8 实际文件中的活动资源、尺寸和正文。Office 验证属于语义重建；PDF 验证使用独立 pypdf 读取活动 XObject、图形状态矩阵、原始对象身份和可选中文字。见 [实际 API/文件证据](assets/hcd-workbench-2026-10-23/fixed-history-api-evidence.json)。验证终态：前端 123 项测试、服务端 22 项 API 回归、新增核心源图恢复局部测试均通过；Rust 构建、格式检查、Clippy 全目标检查和最后源码的独立/嵌入前端构建通过。三格式实际文件回归在去掉多余资源写入后重新通过，并检查几何撤销/重做请求只含 `image.geometry`。前端依赖仍有既有 `use client` 忽略和大分块告警，不将其记作无告警构建。

补充浏览器验收：同字段冲突保持 r16 和同事宽度 175 pt；明确跳过这条图片历史后，仍可撤销更早的正文并保存为 r17，图片保持 175 × 90 pt，实际导出正文和尺寸再次核查。PDF 另用干净源文件从界面换图保存 r1、撤销保存 r2 并下载；独立 pypdf 确认活动 `/Im1`、蓝色原始像素和可选中文字。导出界面仍报告其既有 `SEMANTIC` 级别，不据此提升保真等级。见 [PDF 浏览器证据](assets/hcd-workbench-2026-10-23/fixed-history-pdf-browser-evidence.json)。

![冲突后继续撤销自己的正文并保留同事图片值](assets/hcd-workbench-2026-10-23/fixed-history-conflict-resolved.png)

![PDF 源图恢复并导出](assets/hcd-workbench-2026-10-23/fixed-history-pdf-source-saved.png)

同时修复后台标签页/不可见宿主的零宽快照被当作窄屏、自动折叠侧栏的问题。只对实际可见宽度执行紧凑规则；PPT/PDF 来回选择对象后，两侧栏和最终图片数值仍保留。

边界：当前操作栈仅限当前窗口，会话刷新后不恢复撤销栈，待保存反向草稿和未知请求仍按 version 2 持久恢复；显式丢弃/解决冲突会清除此目标的旧历史，其他目标保留。撤销需要联网核查对象，不承诺离线撤销服务已确认的修改。此阶段的反向历史先于下节普通字段协同，持久状态和普通字段合并的后续升级见下节；完整 Word 的 Yjs 正文与共享图片统一历史、主动撤权、跨窗口历史、Notion 菜单、服务端人员 `@`、自定义节点和 AI 接口仍按实施清单继续，A05 不标全部完成。管理平台和实际提醒不在本阶段。

## 普通图片草稿的字段协同与持久意图（2026-10-23）

接续前一阶段的反向历史，普通固定布局和分段编辑现在也按 `x/y/width/height/assetHash` 跟踪用户意图。图片内容包括显式的 PDF 源图恢复状态。远端已提交的其他字段进入最新基线，本地只保留自己改过的字段；相同字段的不同值才进入冲突选择。

- 冲突栏列出具体字段。“使用远端内容”只采用冲突字段，保留本地其他字段；“保留我的草稿”也不会恢复已过期的远端高度/位置。后续输入、更多远端版本、已相同的字段逐项确认和旧响应乱序均有回归。未解决的同字段冲突不能通过撤销绕过，避免反向草稿清掉冲突保护。
- 保存结果未知时，捕获请求的 patchId、baseRevision、几何与资源仍保持原样。当前可变草稿单独记录 authored fields；迟到回执只确认被捕获的值，保留后续输入和之后的远端字段。即使自己的提交没有被客户端观察到，晚到的回执仍能识别提交后他人将同字段改回原值的冲突。
- 上传开始后即把目标加入刷新集合，无需先有几何草稿。上传期间可跟随远端几何；另一个人改了图片内容或删除对象时保留资源冲突/删除状态，不能把上传当作隐式覆盖。已确认/删除对象的缓存保留有界元数据，排除预览字节；活跃草稿、上传和请求目标不因缓存裁剪而丢失。
- 固定草稿状态升级为 version 3，持久化 `touched` 和 `conflictingFields`，读取旧 version 1/2 副本；旧请求仍按原内容核对。旧副本的显式回退可结合捕获请求恢复意图。未知版本、非法字段和重复字段不静默导入。数据库作用域、每窗口分支和原请求回执协议保持不变。

验证终态：138 项前端测试、TypeScript 检查、独立与嵌入前端构建通过。本阶段未更改 Rust 服务端。自包含脚本仍可运行：

```sh
python3 scripts/hcd-fixed-history.py
```

脚本在原保存后撤销/重做回归之外，增加两个真实鉴权身份的普通编辑：上传期间先提交远端几何，合并本地图片资源/宽度和正文到 r10；随后制造宽度和资源冲突，采用远端冲突字段而保留本地 X，保存为 r12。DOCX/PPTX 核查活动媒体引用、正文和尺寸；PPTX 另核查 X/Y，原生 PDF 独立核查活动像素、可选中文字和完整 CTM。Office 验证属于语义重建，DOCX 的浮动坐标保真仍未实现，不将规范模型中的 X/Y 当作实际 Word 浮动布局验收。见 [实际服务与文件证据](assets/hcd-workbench-2026-10-23/field-merge-api-evidence.json)。

浏览器单独验证：本地宽度 130、X=20 未保存时，另一身份将高度改为 75，合并保存到 r2；再编辑宽度 150、X=30，另一身份将宽度改为 180、Y=120、高度=80。界面只报告宽度冲突，选择远端后保留本地 X=30，保存 r4，实际从界面下载的 PPTX 核查为 X=30、Y=120、180 × 80 pt，活动图片仍为原始蓝图。见 [浏览器证据](assets/hcd-workbench-2026-10-23/field-merge-browser-evidence.json)。

![普通字段协同与冲突选择后保存导出](assets/hcd-workbench-2026-10-23/field-merge-saved.png)

边界：固定布局正文仍以文本对象处理冲突，不能将图片字段合并称为 PPT/PDF 逐字 CRDT 协同。显式冲突选择仍清除此图片目标的旧本机历史；候选选择自身的安全撤销、完整 Word 正文/共享图片统一历史、主动撤权及后续命令/Notion/人员/扩展/AI 工作继续按实施清单推进。实际提醒和管理平台保持暂缓。

## 主动撤权与协作房间隔离（2026-10-23，本地单进程）

- 新增版本化 `DocumentAccessPolicy` 和本地文件适配器，读/写成员分别管理，实际写入还需读取权限。缺省名单沿用已签发文档令牌，空名单拒绝相应用户。稳定 subject 是权限依据，展示名/在线头像不是成员目录。
- `GET/POST /access` 使用独立 `manage` 令牌；普通读写令牌不能管理权限，manage 也不能读取正文。更新明确提供 readers/writers/expectedGeneration，旧版本返回 409；成员唯一、有界，损坏策略拒绝访问。策略替换落盘并同步目录。
- 权限更新与同一文档的 HTTP 请求串行化：先前已经进入的修改完成后，收紧操作才可确认。收紧前保留协作恢复副本并切换 epoch；旧服务状态/检查点不能写当前房间或规范正文。扩权不复活旧房间。协作服务令牌的修改路由被限制为协调器所需路径，限制名单下提交还复查贡献者。
- Hocuspocus 在应用每条消息前重新鉴权，空闲连接也定期复查；过期/撤权/旧 epoch 关闭连接，服务异常按连接关闭处理。原生修订 WS/SSE 也检查当前读取权限；JWT 不再使用默认 60 秒过期宽限。
- Word/PPT/PDF/分段查看的权限丢失保持锁定；Word 停止旧连接重试，固定布局同样停止在线协作。未保存内容留在本机，下载恢复副本不依赖协作连接。未知固定布局提交在仍可读时可以查询旧回执，但不能重新发送未提交请求。备份确实写入后可关闭，备份不可用时保留窗口与下载入口。
- 本阶段还保留了工作区已有的 Word 统一历史实现及其 5 项基础用例，但尚未完成其真实多端/导出验收，A05 不标全部完成。

验证：前端 148 项测试、37 项服务端相关测试、officecli 构建与 clippy、编辑器 standalone/embed 构建。`python3 scripts/hcd-access-revocation.py` 启动隔离原生 API 与真实 Hocuspocus，验证授权保存、撤权、旧房间隔离、服务权限边界、旧版本拒绝与排队草稿保留，运行后停止两服务。证据为 [API/协作](assets/hcd-workbench-2026-10-23/access-api-evidence.json)。

真实浏览器分别输入 Word 与 PPT 草稿后撤权，确认禁用保存、草稿保留和下载；独立解码 Word CRDT、读取 PPT version 3 恢复文件确认原输入仍在。当前两个真实 HCD 的规范版本分别保持 r1/r0，未包含撤权草稿。Word 与 PPT 最终版本均验证本机备份成功后关闭。见 [浏览器证据](assets/hcd-workbench-2026-10-23/access-browser-evidence.json)、[Word 界面](assets/hcd-workbench-2026-10-23/access-revoked-word.png)、[PPT 界面](assets/hcd-workbench-2026-10-23/access-revoked-ppt.png)。本次浏览器没有重复单独验证 PDF，PDF 共用固定布局监控与保存控制器的代码/用例，不将其等同于 PDF 浏览器验收。

边界：访问策略适配器只覆盖本地单 API 进程。远端存储配置下更新返回 501，待接入共享且原子化的宿主权限/epoch 适配器后另验；本地通过不代表多实例或生产通过。权限复查具有轮询/请求耗时，权限更新确认后的规范写入由服务端门禁和 epoch 隔离，不能只依赖按钮禁用。恢复副本引用资源而非自包含 Office 文件。管理平台、真实提醒发送、服务端人员目录与 @、统一命令和 Notion 菜单、自定义节点 SDK、AI 均按[详细交付清单](design/hcd-editor-delivery-plan.zh.md)继续。

## 完整 Word 正文与图片的统一撤销重做（2026-10-23）

完整 Word 现在使用同一窗口的时间线处理本人的正文、格式/结构 CRDT 操作，以及图片几何、换图和接受图片候选。正文复用已安装协同插件的 Yjs UndoManager；图片使用字段级反向意图，经正常协议 4 保存，不回滚共享图片 Map 或整个文档 revision。

- 图片撤销先读取当前鉴权 API 的最新对象。不同字段保留远端已提交内容；同字段被他人改动、对象删除或单位不兼容时保留历史并要求检查，允许明确跳过此条记录。查询期间继续编辑会保留新输入并让旧撤销请求失效，关闭会取消请求。
- 修复连续改同一图片多个字段时后一个撤销清掉前一个字段的问题。只重建本人剩余字段与本次反向字段，不把他人尚未保存的其他字段变成自己的新意图。换图、选择候选独立成组，连续同字段输入可合并；回到原值的连续编辑不留下空记录。显式丢弃清除该图片的相关历史。
- 正文、图片共享撤销/重做顺序，编辑器 commands、工具栏、右键与 Mod+Z/Shift+Mod+Z/Mod+Y 均使用同一入口。图片新编辑同时失效旧正文重做分支。协作者已删掉的文字导致某条 CRDT 历史无效果时，只跳过该条，不能越过图片动作撤销更早正文。
- 区分初始化、远端同步、保存确认、来源标记修复和用户输入。生产 UndoManager 保留插件默认段落保护，并遵守 addToHistory；撤销或远端同步后的来源身份修复不制造新用户动作或清空重做，普通输入的来源默认值仍随用户动作记录。监听支持 effect 清理后重新接入。

验证：新增图片历史与真实 ProseMirror 来源修复用例，前端共 163 项通过；standalone/embed 构建通过。`python3 scripts/hcd-semantic-history.py` 运行原生 API、真实 Hocuspocus 和两位用户，覆盖文字/换图/尺寸的已保存撤销重做、离线期间另一用户保存后重连、同资源冲突保护、并发候选选择后的保存/撤销/重做。独立检查九份 DOCX 的实际正文、活跃 blip 对应图片字节和尺寸，见 [API/文件证据](assets/hcd-workbench-2026-10-23/semantic-history-api-evidence.json)。该脚本的文本用例为追加文字，不将其当作浏览器完整替换的证据。

真实浏览器使用两位用户：本人替换整段文字并调整宽度，另一用户追加“协作者保留”并将高度改成 75 pt；本人通过按钮和快捷键按顺序撤销、保存、重做。修复前浏览器明确发现来源修复清空重做，修复后验证重做保留且可继续。通过实际 UI 下载 r15/r16 DOCX，独立检查：r15 为 Original + 协作者文字、100×75 pt；r16 为本人替换 + 协作者文字、140×75 pt，活跃图片相同。见 [浏览器/下载证据](assets/hcd-workbench-2026-10-23/semantic-history-browser-evidence.json)、[撤销界面](assets/hcd-workbench-2026-10-23/semantic-history-undo.png)、[重做界面](assets/hcd-workbench-2026-10-23/semantic-history-redo.png)。

边界：历史仅保留当前窗口，刷新不会恢复撤销栈；CRDT/固定草稿仍按现有持久恢复路径保留。图片历史要求联网读取当前对象，不承诺离线撤销已提交图片。完整 Word 的接受候选已覆盖；固定/分段的冲突选择本身可撤销仍待补齐，A05 不标全格式完成。复杂表格、跨节编辑和规模部署另有验收，不由九份样例推导完成。管理平台和实际提醒仍后置。

## 固定布局与分段编辑的冲突选择历史（2026-10-23）

接续完整 Word 的统一历史，固定/分段正文和图片的“使用远端内容 / 保留我的草稿”现在也进入同一窗口的时间线，选择不再清空该目标的旧历史。

- 未提交选择的撤销恢复待确认草稿：保留本地输入与最新远端候选，冲突仍阻止保存。重做复查选择所依据的字段；在该次撤销之后又发生同字段远端修改时，旧重做不会直接采用过期决定。其他字段继续按当前基线合并。
- “保留本地”已被本窗口的原请求回执确认后，撤销生成对应字段的反向草稿；提交这份草稿才改变规范版本。图片资源、尺寸和正文选择可按统一顺序撤销/重做；其他本地位置和远端高度不会随之回滚，不恢复旧文档 revision。
- 回执只确认捕获时仍生效的选择与字段，被后续选择取代的旧决定不能借用新请求的成功。提交后丢响应仍按原 patchId 查询；迟到确认保留之后的输入，不凭重试分配新请求。
- 支持“选择远端 → 后续编辑并保存 → 连续撤销/重做”，不要求每步反向草稿都先保存。按目标保留经过校验的反向状态，因此在正文/图片交错的时间线中也能衔接；新的同字段协作修改继续形成冲突或拒绝旧重做。
- 冲突草稿仍采用 version 3 持久格式；操作栈、选择回放快照和回执归属仅在本窗口内使用，不写入离线恢复包，也不包含凭证。刷新后可恢复待确认内容，不恢复撤销栈。

验证：新增 12 项选择历史用例，全部前端 175 项测试与 standalone/embed 构建通过。`python3 scripts/hcd-fixed-choice-history.py` 用真实原生 API 验证 DOCX 分段、PPTX、PDF，覆盖已保存本地选择的反向保存、远端选择撤销恢复冲突、后续保存后的连续撤销、跨目标交错及新远端值拒绝旧重做。独立检查九份文件：DOCX/PPTX 正文与活跃图片关系/字节和尺寸，PDF 可选择正文、实际绘制图像 RGB 与 CTM；PPTX/PDF 另核对位置。DOCX 位置不作为浮动排版已完成的证据。见 [API/实际文件证据](assets/hcd-workbench-2026-10-23/fixed-choice-api-evidence.json)。

PPT 真实浏览器验证了同一流程，并下载实际 r4/r5 PPTX：r4 为远端正文、180×75 pt 图片，r5 为本地中文正文、130×75 pt；两者都保留 x=20、y=40 pt 与同一图片。第二次远端选择被撤销后，正文和宽度冲突重新出现且保存禁用；备份下载保留 version 3 的两份冲突候选。新远端宽度从 210 变成 230 后，旧重做被拒绝，规范 head 保持 r7。见 [浏览器/下载证据](assets/hcd-workbench-2026-10-23/fixed-choice-browser-evidence.json)、[恢复冲突界面](assets/hcd-workbench-2026-10-23/fixed-choice-conflict-restored.png)、[拒绝过期重做](assets/hcd-workbench-2026-10-23/fixed-choice-newer-peer-guard.png)、[已保存撤销](assets/hcd-workbench-2026-10-23/fixed-choice-undo.png)、[已保存重做](assets/hcd-workbench-2026-10-23/fixed-choice-redo.png)。这次浏览器单独覆盖 PPT，不将共用控制器的 API 证明等同于每个格式的浏览器验收。

当前基础正文/图片路径的 A05 保存协同闭环已补齐，可以进入统一命令迁移。复杂表格/跨节事务、跨窗口持久撤销、原稿全部版式保真和多实例部署仍按各自范围另验；不能把当前字段/对象级反向操作称为固定正文的逐字符 CRDT。管理平台与实际提醒继续后置，人员 @、自定义节点和 AI 仍在后续阶段。


## 统一命令首批接入与宿主扩展（2026-10-23）

进入 B 阶段，新增实例级 `commands/`，宿主可通过 `EmbeddedHcdEditor.commandExtensions` 注册业务命令，而无需逐处修改 App 的菜单数组。

- 注册描述支持 ID、多语言名称/别名、图标、分组、顺序、适用 profile/入口、快捷键、状态谓词及执行函数。重复 ID、缺依赖、依赖环、平台/profile 按键冲突在注册时报告，动态注册支持释放；撤掉依赖使消费者失效，不影响无关注册。菜单隐藏和排序不改变执行权限。
- 执行时重新检查当前文档、权限、保护内容、选区与依赖。异步宿主工作可取消，等待后经 `commands.run` 写入时再次复查；新选区/语义变化、文档切换或只读状态不能继续套用旧目标。宿主只能拿到有界冻结上下文和受检查的命令入口，不直接拿编辑器实例；这是可信宿主 API，不是任意脚本安全沙箱。
- Word Home/Insert 操作区、右键和选区浮层由同一注册表生成，命令面板支持中英文搜索、上下键/Enter/Esc/Tab、平台按键显示和宿主重绑定。PPT/PDF/Word 分段接入 Save、Export、Undo/Redo、命令面板及宿主字面文本插入。保存、导出仍在操作区。属性/视图/修订控件和导出参数表单尚未全部迁移；XLSX 未迁移，B03 不标全入口完成。
- 快捷键忽略组合输入、229 和 AltGraph；搜索、URL、属性输入框保留原有文本键位，保存与面板可用工作区作用域。固定版式正文输入继续使用文档统一撤销，防止浏览器本地撤销与文档历史混用。命令边界隔开历史捕获，正文插入走原有协同/草稿/保存协议，不另存一份 HTML。
- 实际 StrictMode 嵌入发现并修复 Word 协同连接与共享撤销管理器被重复挂载销毁的问题：连接/管理器由 effect 创建，编辑器延后到 effect 创建，文档采用短期引用释放以区分 effect 重放与真实卸载。浏览器验证修复后连接就绪、命令撤销/重做可用。固定版式在线状态也发现同类问题并改为 effect 拥有连接；最后双会话页面复验因浏览器连接中断未完成，不能把这个修复标为浏览器通过。

验证：前端 195 项测试通过，其中新增命令核心、公共声明与文档生命周期用例共 20 项；打包 dry-run 确认公开类型、命令类型、runtime/CSS 均包含，私有夹具页面未入包。standalone/embed 两种生产构建与 `git diff --check` 均通过。`python3 scripts/hcd-command-workbench.py` 提供隔离原生 API/Hocuspocus/Vite 的复验工作台，具体步骤见 [editor README](../examples/hdoc/editor/README.md#extensibility-and-editor-ai-design)。

真实浏览器已验证业务命令的 Word 四入口、英文查询中文名称、键盘撤销/重做、选区变化拒绝异步插入和只读宿主直接执行拒绝。PPT 从正文快捷键插入后撤销、重做、保存，PDF 从画布命中区域选中正文后插入、保存；三种格式都通过 UI 下载实际文件，再独立读取 DOCX/PPTX XML 和 officecli 可选择正文：Word r5 有四个字面 `<b>审批标记</b>`，PPT r1/PDF r1 各一个，均无被拒绝的“延迟内容”。这只证明本次文字命令路径，不推导新节点或全部排版保真。见 [文件证据](assets/hcd-workbench-2026-10-23/commands-file-evidence.json)、[浏览器范围与缺口](assets/hcd-workbench-2026-10-23/commands-browser-evidence.json)、[命令面板](assets/hcd-workbench-2026-10-23/commands-palette.png)、[右键菜单](assets/hcd-workbench-2026-10-23/commands-context.png)。

后续：完成 C 阶段 `/`、块旁插入、手柄和指定块操作事务；再接默认 `@人员` 的服务端目录、身份解析、稳定 occurrence ID 与已提交引用查询。`capabilities()` 当前版本为 `hcd-commands/1`，`customNodes/mentions/ai` 明确为 reserved，尚非可用节点/人员源/AI Provider 接口。管理平台、字体后台和实际提醒发送继续不做。


## Word `/` 插入首版与默认块的实际导出（2026-10-23）

C01/C02 首批接通完整语义 Word，所有条目来自既有注册表，不另维护菜单命令副本。支持正文、标题、项目列表、编号列表、引用、代码块、分隔线；宿主添加 `slash` surface 后可复用同一候选查询与执行入口。PPT/PDF 固定文字属性框和 XLSX 尚不提供此流式块菜单。

- 在合法文字边界触发，中文/英文名称与别名可查，分组、上下键/Enter/Esc 和空结果反馈可用。URL 路径、代码/链接标记、代码块、非空选区、保护内容与只读状态不触发。菜单保持正文焦点，随滚动和缩放定位，靠近边界时翻转并限制高度。正文现在具有本地化多行 textbox 名称及候选关联属性。
- 不先删触发串。适配器用无派发的 Tiptap/ProseMirror 事务准备一次内容修改，外层宿主成功后才提交；返回 false、抛错、多次内容暂存、卸载中间命令、撤权或选区/正文/输入样式变化都不产生部分插入。异步内容变化按现有相对位置和语义 generation 检查，普通 UI 元数据变化不误判为正文变化。仅在提交时隔开历史捕获，因此一次撤销恢复触发文字及原块类型。
- 自动化最初发现测试夹具混用 schema，已统一为编辑器自身 schema；实际页面进一步发现 state 对象身份校验过严，改为核对正文、选区与 stored marks，并增加专门回归。测试通过不能替代真实页面验证。
- 实际导出发现原有转换器把 `<blockquote><p>…</p></blockquote>` 扁平为普通段落，已按引用上下文保留子段落与换行。原先遗漏的 Word `Quote` 样式定义也已补齐，回归用例经过正式导出验证器，防止仅检查 XML 而漏掉悬空引用。Markdown 会转义字面符号、HTML 标签和链接标签；代码含反引号时选择更长围栏，避免内容变成标记或提前结束代码块。

验证：215 项前端测试、113 项 officecli 原生单元测试全部通过（其中 HTML 转换子集 26 项）；standalone/embed 构建、officecli 构建、clippy all-targets 拒绝 warnings、Rust 格式与 diff 检查通过。包 dry-run 确认 runtime/CSS/公共类型包含，私有夹具 HTML 未入包。复验：`python3 scripts/hcd-command-workbench.py --slash`，步骤见 [editor README](../examples/hdoc/editor/README.md#slash-insertion-and-conversion-boundaries)。

真实页面验证中文查询、Enter、一次撤销/重做、宿主字面插入、宿主暂存后失败保留 `/失败`、代码内字面斜杠、七种默认块、分组上下选择与取消，以及 150% 缩放定位。最终通过 UI 下载 r9 DOCX/Markdown/PDF，独立检查实际 Word Heading2/Quote 样式及引用、Markdown `>`/列表/围栏/转义标签和 PDF 可选择文字，失败宿主的“暂存正文”未进入文件。Markdown 再导入保留字面标签和引用预览；初始代码/引用为保护块，不当作任意富节点可编辑往返。见 [文件证据](assets/hcd-workbench-2026-10-23/slash-file-evidence.json)、[浏览器范围](assets/hcd-workbench-2026-10-23/slash-browser-evidence.json)、[分组菜单](assets/hcd-workbench-2026-10-23/slash-groups.png)、[中文查询](assets/hcd-workbench-2026-10-23/slash-menu.png)、[失败保留](assets/hcd-workbench-2026-10-23/slash-failure-preserved.png)、[缩放定位](assets/hcd-workbench-2026-10-23/slash-zoom.png)。取消完整列表验证后，原“尾部正文”恢复并确认仍保存于 r9；当前测试标签已关闭，隔离服务已停止。

上一轮固定版式 StrictMode 在线状态的复验缺口本轮已补齐：PPT writer/read 两个真实会话均显示 2 人在线并标出另一人的选中对象，关闭 read 会话后回到 1 人，见 [协作截图](assets/hcd-workbench-2026-10-23/commands-fixed-presence.png)。它证明本地连接生命周期与人数更新，不替代实时逐字 CRDT 或生产协作验收。

边界与后续：DOCX 列表仍为文字标记，分隔线为线字符；引用嵌套深度暂扁平，PDF 为静态排版，完整原稿分页不保证。真实设备输入法仍需另验。C03/C04 的块旁 `+`、手柄、复制身份、拖拽、批量/嵌套事务未完成，继续此项后再接默认 `@人员` 的服务端目录、身份解析、稳定 occurrence ID 与关联查询。自定义节点 SDK、AI 接口和自动补全继续保留原目标范围；管理平台、字体后台与实际提醒发送仍后置。


## Word 块手柄、批量事务与菜单取消（2026-10-23）

C03/C04 首版接入完整语义 Word；本节接续上一节的待办状态，不表示整个 C 或原目标已完成。

- 块旁 `+` 前后插入，块手柄提供复制、删除、上下移动、目标位置移动和类型转换，原生拖放给出合法落点反馈；`Mod+/` 与目标位置菜单提供键盘替代。搜索与权限状态复用注册表，宿主 `block` surface 可增加操作，插入模式复用 `slash` surface。多块文字选择或 Shift 手柄范围可成组操作，作为一次内容事务与一次撤销边界；块菜单打开时隐藏选区浮层，避免两个操作面板叠加。
- 事务检查完整根块边界与正文指纹，异步完成后再检查权限、选区、文档和命令注册归属。关闭、Escape、卸载或正文/选区变化会取消暂存操作。已补齐 `/` 的异步取消：触发字串不会先删除，取消后宿主迟到结果不会写入内容。
- 复制保留文字、格式和字体，但分配新临时块身份、移除来源身份；移动保留现有块身份。真实页面发现连续回车会继承重复块 ID，已在本地拆分后分配新身份，远端同步不自行生成随机竞争身份。规范保存后临时身份按已有回执映射替换；真实页面重开后的十个可编辑根块均为唯一规范 ID，与保存前逐项一致。
- 普通文字块、简单列表和纯文字引用可转换；嵌套结构可整体复制/移动/删除。复杂嵌套转换拒绝执行；非空正文不能直接转换成分隔线，保护对象不能被修改或跨越。合并成单个引用/代码块时保留首个身份，不承诺转换回来能复活被合并的多个身份。

验证：235 项前端测试通过（新增块操作/身份和菜单取消用例），standalone/embed 构建通过。实际浏览器覆盖单块复制/上移/目标位置移动、多块复制并一次撤销、标题转换、加号插入分隔线、真实手柄拖放并一次撤销、两位写用户下远端修改关闭菜单、延迟 `/` 命令 Escape 取消、保存与重开身份一致。首轮拖动被容器的 mousedown preventDefault 阻止，移除对手柄的阻止后真实拖放通过，不能以只有事件处理器代码作为验收。见 [菜单截图](assets/hcd-workbench-2026-10-23/blocks-multi-menu.png)、[浏览器证据](assets/hcd-workbench-2026-10-23/blocks-browser-evidence.json)。

通过 UI 下载 r6 DOCX/Markdown/PDF，独立回读正文并检查 DOCX Heading2、静态分隔线、Markdown 标题/分隔线；同伴正文保留，未接受的“延迟内容”和协同光标标签没有进入文件。见 [实际文件证据](assets/hcd-workbench-2026-10-23/blocks-file-evidence.json)。未新增 Rust 转换器修改，本节不重新宣称原稿分页或 PDF 视觉保真。构建仍包含现有大 chunk 提示，未作为包体优化完成。

仍未完成：同时移动/打字同一块的结构协同与撤销冲突、复杂嵌套/表格/跨节、拖动自动滚动、设备输入法与窄屏缩放专项、PPT/PDF 对象级等价操作、完整命令迁移和字体/导出能力报告。Yjs 移动目前由删除/插入构成，逻辑 ID 保留不等于并发文字节点身份不变；必须做专项并发验证和修复，不能以顺序同步测试覆盖。之后继续默认 `@人员` 的服务端目录/解析/权限/稳定 occurrence 与关联查询，再完成自定义节点 SDK、通用 AI 接口和接受流程。管理平台、字体后台和实际提醒发送继续不做。


## 结构协同缺陷复现与永久内容核心（2026-10-23）

本轮确认上一轮列出的结构并发风险真实存在：生产块命令构建器配合当前安装的 Tiptap/Yjs 绑定，一端移动首段、另一离线分支编辑首段，交换更新后同伴文字消失；编辑相邻段落的对照组保留。逻辑 blockId 相同和顺序浏览器导出通过都不足以证明并发安全。当前页面仍是旧协议，因此本轮不能标记该缺陷已在页面修复。

新增内部 `SemanticBlockStore` 与行内内容 codec：永久内容和位置引用分离，删除可见性独立于移动位置；同块同时移动只选一个位置，不复制内容。正文/标题的类型与属性独立于永久文字载体。空段落仍保留同一 XmlText，接住迟到输入；只写变化的格式字段，避免输入时重发旧格式。Unicode 码点差异保持 UTF-16 寻址，hardBreak 等叶子行内对象有结构存储。未知节点、mark 或属性读取失败时保留原始字节，不调用可能删除未知类型的绑定修复解码器；只读 fallback 和完整自定义节点 SDK 尚未实现。

新核心 `reconcile` 能把插入、修改、删除和排序作为一次历史动作。移动命令增加临时选择意图，避免把相邻块索引变化误记为本人的移动；正文未改变排列时不发布位置。撤销新增/复制仅隐藏块而保留同伴内容，重做可恢复；较新的同伴位置不被自己的旧撤销回滚。

验证：25 项新核心用例、前端全部 260 项测试、TypeScript 与 standalone/embed 构建通过。覆盖双副本两种交换顺序、并发文字/格式/同块移动、删除竞争、复制、自己的撤销重做、规范 ID 元数据、整笔编辑器事务和快照恢复；另有 12 个确定性三副本随机调度，每次 60 步，检查乱序/重复更新、收敛与所有追加文字保留。复现脚本同时输出旧绑定失败对照与新核心的实际内容/物理文字身份、撤销重做和恢复结果，见 [核心证据](assets/hcd-workbench-2026-10-23/structural-concurrency-core-evidence.json)。这是真实 Yjs 的进程内副本证据，不是服务端房间、原生保存、浏览器或生产验收。

接下来必须把新模型接入编辑器选区/IME/协作光标、保存协调器的单一逻辑投影、sidecar 持久恢复、来源 ID 回执和新房间协议迁移；再做真实双窗口离线/重连、保存重开和实际导出。正文/容器互转、文字拆分/合并、复杂嵌套的内容所有权也仍需补齐。迁移必须服务端单所有者、旧客户端不得混写；本地初始化检查不等于分布式租约。不得在当前 room 里同时维护两个规范正文。具体数据模型与验收顺序见 [结构协同修复设计](design/hcd-semantic-structure.zh.md)。原 `@人员`、节点 SDK、AI 和跨格式目标继续保留；管理平台及实际提醒发送后置。


## 结构绑定、相对选区与规范保存适配（2026-10-23）

本轮把新核心接到实际 PM 插件事务与保存协调器的显式适配入口，默认 App 和 sidecar 房间仍未切换。

- 新模式 schema 增加内部结构键，与规范 blockId 分离；不写入 HTML，复制/粘贴清除旧键，拆分分配新键。绑定在发布前检查快照与写权限，只读和不支持的容器所有权转换不改变正文。被绑定拒绝的暂存命令返回 false，避免误报执行成功。
- 远端更新按内容差异更新文档，相对文字选区与 NodeSelection 跟随块；本地初始投影不成为历史动作。未知内容导致保留最后可显示正文及原始 CRDT，不调用删除式恢复。协作光标装饰、真实 DOM/IME 和复杂容器转换仍待接入，不以 headless 状态测试替代。
- 保存的投影、摘要、块捕获与来源回执统一读取结构模型。规范身份可映射到仍保留内容的隐藏块；迟到回执不替换后续文字，丢响应重启可恢复规范身份和待保存输入。未显式选用新适配时拒绝协调结构数据，防止当前代码误读空的旧 default 文档；服务端协议隔离与更早客户端防护仍须另做。

新增 9 项绑定、5 项保存适配用例，全部前端 274 项测试、TypeScript、standalone/embed 构建通过。原生 `hdoc serve` 探针走实际绑定 → 两个进程内 Yjs 副本 → 保存协调器 → 原生规范提交 → 持久状态重启，验证移动与离线同伴输入、自己的撤销/重做、规范块身份和不变的物理文字载体。

独立回读 5 个实际文件：移动后的 DOCX/Markdown/PDF、撤销和重做的 DOCX。文字顺序和 Peer! 保留，DOCX 活跃原图哈希一致，Markdown 经实际重导入检查转义内容。见 [原生 API/文件证据](assets/hcd-workbench-2026-10-23/structural-save-api-evidence.json)。初轮原文匹配把 Markdown 正确的感叹号转义当作缺失，已改为重导入校验，未因此修改导出内容。这一探针没有浏览器、Hocuspocus 房间或生产部署；本轮没有新增 Rust 修改。

后续必须完成容器转换所有权、光标/IME、单所有者迁移及服务端协议/epoch 限制、统一文字/图片历史，再切换默认页面并做真实双窗口复验。管理平台、字体后台和实际提醒仍不做；服务端 @人员、节点 SDK 与 AI 保留原范围继续实施。详细门槛见 [结构协同修复设计](design/hcd-semantic-structure.zh.md)。


## 2026-10-23：结构原型 v2 的容器归属、迟到回执与光标组件

本轮继续替换模型，未切换默认 App 或 sidecar。引用/列表包裹和还原现在保留子段落与永久文字载体，结构父子引用和规范所有者 token 独立；竞争包装只采用一个归属。空包装可省略，非空错误/环/重复规范所有者拒绝投影并保留原始数据。全部内容消失时使用共享预分配空段落。初始化拒绝旧 default 和原型 v1 数据，不代表分布式迁移已实现。

实际原生探针先暴露了引用保存后还原时沿用已吸收 native ID 的 400 错误，现通过规范所有者映射和退休 ID 修复；另修复不同来源格式下逐字插入造成的并发词组分散，连续字符串先整体插入。保存捕获永久文字与所有者，回执迟到也不会还原旧容器、重建文字或吞掉保存中输入。

新增相对选区 Awareness/光标装饰和可选 Tiptap 组合扩展：支持文字范围、节点选择、光标、失焦清理、无效位置过滤，不把光标写入正文。测试使用 headless view；没有真实 DOM/IME、光标视觉或浏览器验收。

验证：全部前端 **287 项测试通过**，TypeScript 和 standalone/embed 构建通过。隔离原生 API 走真实 PM 绑定、两个进程内 Yjs 副本、规范保存与持久状态重启，独立回读 **11 个文件**（移动、引用、还原各 DOCX/Markdown/PDF，以及撤销、重做 DOCX）。正文、同伴追加、顺序、规范投影、永久文字身份和活跃原图哈希通过；Markdown 经实际重导入检查。见 [API/文件证据](assets/hcd-workbench-2026-10-23/structural-save-api-evidence.json)。这是本轮最新结果；前两节 260/274 项及 5 个文件是之前阶段的历史结果。未新增 Rust 修改；隔离 API 已停止。

仍需完成：跨段合并/多段代码转换的文字流归属（新模式当前提前拒绝此类合并）、真实 DOM/IME、sidecar 单所有者迁移与服务端协议/epoch 限制、文字/图片共同历史、默认页切换和真实双窗口复验。**默认页面仍有移动块导致离线同伴输入丢失的已复现缺陷**，不能以本轮原型验证宣称修复。详细模型和顺序见 [结构协同设计](design/hcd-semantic-structure.zh.md)。服务端 @人员、节点 SDK、AI 与跨格式目标继续保留；管理平台、字体后台和实际提醒发送后置。


## 2026-10-23：结构原型 v3 的共享文字流、合并与拆分

本轮将文字流层接到替换模型，默认 App/sidecar 仍未迁移。跨段合并、Enter 拆分、多段代码转换、跨段选区替换和多段粘贴复用原文字载体；内部边界和连接描述显示段落的组合，不复制正文。迟到输入与相对光标按物理载体定位，撤销自己的连接/边界保留同伴文字。相反方向合并形成的文字流环采用确定性投影保留所有分段，块父子图的非法环仍拒绝。

并发 Enter 验证暴露过根数组顺序与文字切点顺序不同的问题，现按分段边界排序；手动移动、插入使用目标当时的位置引用，不让旧锚点拖走后来移动的目标，也不让移动原段落带走其他拆分段。空段复制仍分配独立载体。空段转换成非文字节点后遇到旧载体离线输入会保留原始数据、阻止不兼容投影；实际冲突恢复 UI 仍待完成。

验证：全部前端 **318 项测试通过**，TypeScript 和 standalone/embed 构建通过。文字流有 16 项测试，其中 8 组随机调度各使用 3 副本、60 步输入/拆分/合并，验证每个新增字符恰好保留一次及最终收敛。原生 API 探针独立回读 **18 个实际文件**，新增多段代码合并、撤销和段落合并再拆分的 DOCX/Markdown/PDF；规范代码类型、离线追加、选区、内部边界排除、保存与重启通过。见 [API/文件证据](assets/hcd-workbench-2026-10-23/structural-save-api-evidence.json)。探针首次把规范内容类型错读为 `block.kind`，现改用 `block.content.kind` 并通过；未因此更改原生转换器。隔离服务已停止，本轮未新增 Rust 修改。

投影缓存避免同一文档版本下逐段重复扫描文字流，事务内不复用缓存；这不等于长文 DOM 懒加载或容量验收完成。新协议原型使用 `hcd-semantic-blocks/3` 与 `hcd-text-flow/1`，本地初始化和协调器拒绝旧原型/未协商数据；分布式迁移与旧客户端写入限制仍未实现。没有真实 DOM/IME、Hocuspocus 房间、默认页或生产验收，默认旧绑定的结构并发缺陷尚未修复。

下一步继续真实编辑器接入与 IME/光标验证、单所有者迁移及协议/epoch 限制、文字/图片共同历史、剩余嵌套/混合事务与冲突恢复，然后切换默认页并做双窗口端到端复验。服务端 @人员、节点 SDK、AI、跨格式与导出能力报告保持原范围；管理平台及实际提醒发送继续后置。门槛见 [结构协同设计](design/hcd-semantic-structure.zh.md)。


## 2026-10-23：原生正文协议、迁移提交与防混写

原生 API 现在持久记录正文协议，并在 `/auth` 返回 `collaborationProtocol`。旧数字 epoch 文件仍兼容旧协议；结构协议采用包含 epoch、protocol 和迁移回执的描述符。新协议下 state、checkpoint 及服务身份 project 写入缺少/传错协议会被拒绝，旧 epoch 不能写入新代。

新增受信任保存服务的 `POST /collaboration/migrate`：比较捕获的旧 epoch、状态哈希与规范版本，保存旧恢复副本，持久化转换结果后才发布新描述符。同迁移 ID 的精确重试返回原回执，不覆盖后来输入；同 ID 不同内容拒绝。未激活文件采用独立文件名，不能被后续普通 reset 当成当前正文；reset 保留协议并清除旧迁移回执。文件模式用原子描述符发布，PostgreSQL 路径用事务一起提交恢复副本、正文和元数据。

验证：118 项 officecli 原生单元测试全部通过，原生构建、Clippy all-targets 拒绝 warnings、Rust 格式和 diff 检查通过。真实 HTTP 探针从与规范正文一致的旧 Yjs 状态迁移，验证旧恢复字节、旧 epoch 拒绝、新 epoch 下缺少协议的 state/checkpoint/project 拒绝，以及保存后迟到迁移重试不改正文；再完成持久状态重启与 18 个 DOCX/Markdown/PDF 实际文件回读。隔离 API 已停止。见 [API/文件证据](assets/hcd-workbench-2026-10-23/structural-save-api-evidence.json)、[协议和复验步骤](design/hcd-collaboration-protocol.zh.md)。本轮未改前端源码；上一阶段的 318 项前端测试与两种构建是之前结果，不算本轮重新验证。

边界：Rust 不解析 Yjs，转换和旧 room 排空仍由待接入的 sidecar 驱动负责；原生 CAS 不是运行中房间的迁移租约。尚无脏草稿、图片冲突、未知保存结果、真实 PostgreSQL/对象存储、Hocuspocus 或浏览器迁移验收。默认 App/sidecar 仍使用旧绑定，已复现的结构协同缺陷尚未在默认页修复。接下来完成房间排空/协商和草稿迁移，再接替换绑定、文字/图片历史、真实 DOM/IME 与双窗口复验。@人员、节点 SDK、AI 和跨格式目标保持原范围；管理平台及实际提醒发送继续后置。


## 2026-10-23：Sidecar 显式协商、脏草稿迁移与未知结果恢复

本轮接入 sidecar 的 `collaboration/negotiate`，默认 App 还未调用。消息屏障从异步鉴权前计数到实际消息应用后，阻止新写入并排空已接纳操作；暂停自动保存后才转换。转换读取冻结的协同正文，保留未保存输入、图片替换意图、冲突候选和来源，重新签发新 epoch 的基线及作者账本，不把草稿换成规范正文。来源不明、签名/摘要不符或未知共享数据保留副本并拒绝自动发布。

迁移任务在发送前写入私有 journal，绑定源/目标字节、哈希、版本与 ID；失败文件不静默覆盖。超时、5xx、回执不完整及发布后日志写入失败保持旧房间暂停。重启复用原 ID 确认结果；鉴权服务暂时不可用也不能错误恢复旧写入。确认发布并归档旧房间后才接纳 `structure3:save4`。增量影子校验在正文应用前拒绝 default/结构协议混写，不逐键全量复制文档。

验证：333 项前端/服务测试、TypeScript 与 standalone/embed 构建通过。真实双 Hocuspocus socket 验证延迟鉴权输入排空、两次协商只提交一次、迁移成功后丢回执、重启复用原任务、脏正文/换图候选保留、错误协议 payload 拒绝、离线输入与拆分收敛、显式保存与发布后重启。另一个案例确认“规范保存已提交但回执丢失”复用原 checkpoint ID，没有多增规范版本。4 个实际 DOCX/Markdown/PDF 文件独立回读，活动换图字节正确；见 [sidecar 证据](assets/hcd-workbench-2026-10-23/sidecar-migration-api-evidence.json)。

另外复验旧模式两端混合历史，9 份实际 DOCX 验证自己的文字/图片撤销重做、同伴文字/几何、重连和同字段冲突；见 [旧模式回归](assets/hcd-workbench-2026-10-23/legacy-history-regression-evidence.json)。原结构保存探针的 18 文件也重新通过。所有隔离服务已停止；本轮未改 Rust 源码，118 项原生测试是前轮结果。

边界：以上 PM 视图均为 headless，不是浏览器/IME、真实数据库、多实例或生产验收。默认 App 仍使用旧绑定，已复现的缺陷尚未在默认页修复。接下来连接协议选择、结构绑定与统一文字/图片历史，补旧页面上传/本机未发送操作交接、旧代离线草稿语义恢复及冲突界面，再进行真实双窗口和文件验收。@人员、节点 SDK、AI、跨格式、长文与导出能力报告保持原范围；管理平台和实际提醒发送后置。详见 [协议契约](design/hcd-collaboration-protocol.zh.md)。


## 默认结构编辑与协同位置（2026-10-23）

默认 Word 已连接协议协商、结构绑定与文字/图片共同历史。先核对本机同代缓存；旧正文通过无编辑/上传的交接页同步后才升级，可写旧窗口未交接时拒绝升级。新旧协议缓存隔离，鉴权/协议失败不再当作空正文继续；旧代离线语义恢复仍待完成。

真实浏览器发现并修复两处问题：并发拆分后移动边界时引用顺序不稳定；重做恢复文字后来源修复只停留在 PM 视图，导致规范保存失败。后者现在以非历史元数据写回共享正文，保留一笔原始撤销动作。344 项前端/服务测试与 TypeScript、standalone/embed 构建通过；真实 native + sidecar 探针新增输入/撤销保存/重做保存 3 份 DOCX，总计 7 个文件独立回读；旧基线证据另保留。

默认页面已实际验证中文字面输入、斜杠标题、两人同步、只撤销本人动作、重做、保存和重开；两份浏览器下载的 DOCX 检查成员文字保留、自己的标题删除/恢复，Awareness 姓名未进入文件。协同姓名被长文绘制隔离裁切的问题已修复；当前操作段落和选区显示高亮。新增临时视口锚点/进度、右侧成员位置标记、主动跟随、手动操作退出，60 段双页面验证不主动拖动本地视图、跟随与退出。见 [浏览器/文件证据](assets/hcd-workbench-2026-10-23/default-structure-browser-evidence.json)、[姓名高亮](assets/hcd-workbench-2026-10-23/structure-activity-names.png)、[位置标记](assets/hcd-workbench-2026-10-23/structure-activity-locations.png)。

边界：这不是完整 IME、旧代离线恢复、复杂嵌套/表格、真实数据库、多实例或 PPT/PDF 视口验收。用户追加的主文档历史查看、git 式差异及明确确认还原正在接入，尚未视为交付；还原必须保护当前/同伴草稿并生成新历史，期间新增修改需重新核对。@人员、节点 SDK、AI 和跨格式目标保持不变；管理平台与提醒发送仍后置。用户正在操作的隔离预览页暂保持运行。

用户随后确认将操作集中在“在线协作”：顶部在线入口现在打开右侧面板，显示成员、浏览进度和本地解析的活动段落摘要，提供定位与跟随/停止；正文侧栏为被动位置标记。真实页面操作通过，浏览/跟随/定位未增加规范版本（60 段文档仍 r1）。见 [右侧协作面板](assets/hcd-workbench-2026-10-23/structure-collaboration-panel.png)。新增空规范 ID 预检避免无效载荷触发修复循环，测试总数更新为 344，构建通过。历史查看、diff 与确认还原按已保存设计继续实现，不计入已交付。


### 2026-10-23：历史主文档、差异、可恢复还原与协作面板

默认 Word 结构化页已在主文档区显示不可变历史正文/图片；固定版本比较以红删绿增、格式/对象/移动标记呈现，同伴新增保存只提示重新比较。历史导出固定版本。右侧“在线协作”包含姓名、操作片段、浏览位置、定位和跟随。

本机 sidecar 还原先交接所有可写窗口并排空消息，再归档共享内容；原生以 head/epoch/状态 hash/作者权限检查后追加恢复版本。两层 durable intent 处理丢回执及 head 已提交但 epoch 未轮换的重启，不生成重复版本。旧连接提前关闭时，已交接客户端依据权威 epoch 进入新房间。关闭隐式末尾空段落，改用统一的显式追加命令，避免未输入即显示编辑中或保存摘要不一致。

本轮 364 项前端/服务测试、121 项原生测试、clippy/fmt；双端浏览器和 7 份 API 导出回读通过。详见 `design/hcd-revision-review-and-restore.zh.md` 及 `assets/hcd-workbench-2026-10-23/revision-restore-{api,browser}-evidence.json`。此项是本机 Word 的验收，PPT/PDF 面板适配、远程/多实例、IME、复杂差异细分及长差异窗口化仍待补。默认 @、节点 codec SDK 和 AI 仍在原清单中，管理平台继续延后。


### 2026-10-24：D1 人员目录及规范引用底层

接通文档范围的服务端人员搜索、签名分页、批量解析和不可变版本关联查询。原生 inline reference 保存出现 ID/目标/姓名快照，前端内置 atom 支持读取、纯文本提取、复制身份及 Yjs 同步；已有引用可随正文修改共同保存，目录失联不阻断旧引用。新引用在 HTTP 写入时重新校验人员权限，协同 checkpoint 要求可信 per-occurrence 作者证据；未升级客户端不能保存丢掉身份的快照。结构补丁执行人改从鉴权取得，公共目录错误不泄露配置值。

真实 HTTP + WebSocket、DOCX/PDF/Markdown 回读、离线 HCD 重开证据在 `assets/hcd-mentions-2026-10-24/people-reference-api-evidence.json`。D 阶段没有完成：默认 @ 候选菜单、新增/改目标作者台账、IME、资料状态、逐格式 UI 和双浏览器还待接通；详见 `design/hcd-people-and-references.zh.md`。新建关联提醒固定 disabled，不发送。节点 SDK/AI、PPT/PDF 对齐、长文和旧 epoch 离线恢复继续保留在原目标里。


## 2026-10-24：D2 默认人员提及与可信操作来源

- Word 内置 `@` 推荐/搜索/分页、同名辅助标签、键盘选择、失败保留/重试；工具栏/右键/命令面板统一 `reference.person`，候选插入再检查选区与触发串。完整结构化 Word 的 SDK mentions 能力为 person，其他工作区仍为 reserved。
- 服务端同步 Yjs 操作来源、逐 occurrence 新增/改目标/删除作者、签名台账持久化及精确 attempt。保存者不成为提及作者，缺失/篡改证明不能借另一贡献者权限；目录缺失不阻止已有引用的普通保存或已鉴权删除。不可变版本保留逐引用作者，提醒固定 disabled。
- 双端浏览器验证 Alice 插入、Bob 保存、自己的跨保存撤销/重做、同伴输入保留；两个同名目标保持独立 ID，右侧在线协作姓名/操作摘要/跟随已复验，自己输入退出跟随。目录故障不删输入，恢复后重试成功；统一命令在正文词尾也可打开菜单。
- 原生固定 r2/r3/r4/r5 与实际 DOCX/PDF/Markdown 回读确认身份、姓名、他人正文和 DOCX 图片字节保留，Awareness 姓名不混入导出；离线原生 HCD 保留 occurrence。导出区显示在线关系静态化说明。
- 383 项前端测试、427 项选定原生测试、clippy/fmt、standalone/embed 构建通过。详见 [D1/D2 设计与剩余工作](design/hcd-people-and-references.zh.md)、[双端证据](assets/hcd-mentions-2026-10-24/mention-browser-evidence.json) 与 [socket 证据](assets/hcd-mentions-2026-10-24/collaborative-reference-evidence.json)。引用状态 UI、并发改同 occurrence、旧 epoch 离线恢复、真实用户中心/输入法/长文规模与 PPT/PDF 对齐、通用节点 SDK 和 AI 仍待继续；管理平台后置。

## 2026-10-24：D3 文档引用资料与历史定位

Word 新增右侧“文档引用”，支持按保存姓名/当前段落搜索、每页 50 处、已保存与本机草稿状态、实时 occurrence 定位；点击正文提及可打开只读人员资料。保存姓名与当前目录姓名分开，停用/受限/离线状态保留文档快照且不展示未经授权的新详情。历史定位使用服务端固定 revision 的 chunk 锚点，按需加载原文并高亮，不改变协同正文。在线成员/操作位置/定位/跟随仍在“在线协作”，跟随与停止已再次实际点击验证。

80 段/6400 行内 run/3 chunk 的本机 debug 用例验证末尾实时/历史定位、搜索、改名和停用显示，读取操作未增加规范版本（仍 r2）。同时修复前端块移动候选的重复子树遍历及服务端 source-map ID 的重复 HTML 扫描；相同投影 JSON，CLI 24.133→11.288 秒、HTTP 引用查询 20.834→3.386 秒。仍有完整投影成本，不作生产容量承诺。

388 项前端、428 项原生测试，clippy/fmt、standalone/embed 构建通过；常规 API/socket/三格式文件回归通过。富文本长文 DOCX/Markdown 实际回读通过，**PDF 超过客户端 120 秒，未取得可验收文件**，已作为独立性能缺口记录。只读/受限/故障人员资料专项浏览器交互、同 occurrence 冲突、旧 epoch 恢复、PPT/PDF 对齐、SDK/AI 继续推进；管理平台和实际提醒发送后置。详见 [D3 设计与边界](design/hcd-people-and-references.zh.md)、[浏览器证据](assets/hcd-mentions-2026-10-24/reference-navigation-browser-evidence.json)、[文件证据](assets/hcd-mentions-2026-10-24/reference-navigation-file-evidence.json) 与 [性能数据](assets/hcd-mentions-2026-10-24/reference-performance-evidence.json)。

## 2026-10-24：D4 长文 PDF、停止等待与导出进程边界

D3 的 120 秒 PDF 客户端超时已继续追踪：同一未优化 debug 任务实际在 166.532 秒正常结束；仅优化开发配置中的 rustybuzz、ttf-parser 0.25.1 和 ironpress 后为 18.431 秒，原 4 页的文字和全部页面 PNG 完全相同。这是本机开发构建的依赖优化，不能说成 release 或生产性能提升。

实际渲染又发现原文件没有完整保留版面内容：原生硬换行 span 被折叠，交替样式长串的部分字符排到页面外。现在仅在打印副本中把带原生硬换行标记的单一换行 span 转为保留属性的 br；同时启用长串紧急换行，并在固定的本地 ironpress 1.6.0 补丁中对跨样式的完整超宽词组计算换行边界。只对超宽组增加机会，保留文字/样式，不插入空格、软连字符或零宽字符；避免在字素簇内部新增边界。未更改规范 HTML/协同节点。补丁、MIT/字体许可、上游 commit 和测试文件来源见 `vendor/ironpress/OFFICECLI-PATCH.md`；不把此局部回归当成完整 Chromium 排版一致性。

同一 r2 的最终 HTTP 导出约 19.09 秒，10 页全部渲染检查；80 段、2 处提及、6400 个交替样式字符完整回读。真实编辑器导出并下载 `mentions-docx-r2.pdf` 后独立验证相同计数，页面显示“已导出 r2”，规范版本仍为 r2。可检查 [实际 PDF](assets/hcd-mentions-2026-10-24/long-rich-export.pdf)、[服务与文件证据](assets/hcd-mentions-2026-10-24/export-lifecycle-api-evidence.json)、[浏览器下载](assets/hcd-mentions-2026-10-24/export-browser-evidence.json) 和 [开发性能隔离对比](assets/hcd-mentions-2026-10-24/export-development-performance-evidence.json)。

导出子进程现在最多同时运行 2 个；第三个返回 429，不在内存中积累无界等待队列。默认运行期限 300 秒，可用 `HCD_HTTP_EXPORT_TIMEOUT_SECONDS=1..3600` 配置，错误配置在启动时拒绝；期限到返回 504，并终止/回收子进程。子进程全部临时目录收进请求专属目录，期限后一起清理；错误诊断保留最多 64 KiB，继续排空管道避免阻塞。请求任务销毁有 kill-on-drop 保护。隔离原生 API 使用只读令牌并发发起 3 份导出，实测 429/504/504；无遗留子进程、无遗留临时目录，规范 bundle 全部文件哈希不变。

操作区新增“停止等待”：保存前置步骤与下载请求分开，已经开始的保存继续完成，停止等待后不生成下载/成功状态。浏览器核验保存期间和原生导出子进程已启动后的两种停止场景。切换身份/关闭工作区取消等待并忽略迟到结果，忙时不能切换格式/方式；错误可读、结果绑定实际导出的保存版本。客户端等待上限 310 秒；**停止等待不是服务端任务取消回执**，远端导出可能在运行期限内继续，界面有明确说明，不假称已经取消服务器任务。

验证命令：`python3 scripts/hcd-export-lifecycle.py <owned-preview-private.json>` 会复制独立测试 bundle，验证运行期限/并发/清理和实际 PDF，运行后停止其两个隔离服务。上述 19 秒是固定本机样例测量，不是容量上限或 SLA；复杂脚本连写、完整 Chromium 字体/分页一致性、生产部署和各格式全量导出能力仍需继续验收。通用节点 SDK、AI、PPT/PDF 对齐、引用并发冲突和旧 epoch 恢复仍保持原清单，管理平台与实际提醒发送后置。

D4 最终检查：前端 388 项与 standalone/embed 构建，原生 `cargo test -p hcd-core -p officecli` 435 项（62+132+241），补丁模块 3 项专项测试，clippy/fmt、vendor rustfmt 与 `git diff --check` 全部通过。依赖单测最初因发布包缺少 19 个编译期样例而无法编译，之后从原始上游 commit 取回真实样例/字体并保留哈希、字体许可后才通过；没有用占位字体或改写测试基准代替。完整 upstream Chromium parity 未运行，仍明确保留该验证边界。

## 2026-10-24：E1 通用扩展保留与离线兼容

新增版本化惰性 JSON envelope，支持行内/块原子、稳定出现身份、未知业务版本与可读替代文字。Rust/前端共同限制载荷大小、深度、键与数字范围；规范包声明必需能力，涉及扩展的 patch/checkpoint 要求认识共同模型，旧客户端不能把业务数据当普通文字覆盖。缺少业务 codec 时 Word 显示只读节点，本地删除/转换受保护，周围正文仍可编辑保存。兼容 HTML 粘贴保留业务数据并生成新身份，不认识的共同模型显式拒绝；没有执行业务代码或自动取网络资源。

真实 WebSocket 迁移发现旧来源身份升级忽略原子文字长度，现已同时计入提及与扩展的替代文字，块原子直接核对完整载荷。真实页面另发现全禁用选区浮层遮挡正文，现仅在存在可执行动作时显示。两处均有针对性验证。

本机浏览器从 r2 到 r4，检查 Backspace 保护、普通输入/保存/重开、不兼容 HTML 粘贴提示及兼容原生 HTML 粘贴。r4 原有两个未知 v77 载荷与身份不变，新增节点业务数据保留且身份重新生成；固定 r4 的 DOCX/PDF/Markdown 实际文件均回读新增正文及三处替代文字。离线 HCD 保留完整载荷；Office/静态文件采用文字替代，保真报告逐节点给出 `HCD_EXTENSION_FLATTENED`。DOCX 原始图片媒体字节另已对比。

本轮原生 437 项（64+132+241）、前端 393 项、standalone/embed 与原生构建、clippy/fmt、`git diff --check` 通过。见 [E1 完成项与详细待办](design/hcd-extension-nodes.zh.md)、[原生/socket 证据](assets/hcd-extensions-2026-10-24/extension-native-evidence.json)、[浏览器/三格式文件证据](assets/hcd-extensions-2026-10-24/extension-browser-evidence.json)。此轮新增 PDF 只验文件文字回读，未追加独立版面视觉验收。

完整宿主 SDK 尚未开放，customNodes 保持 reserved；注册 API、自定义视图/属性、业务 schema/迁移、资源、逐格式导出 adapters、富文本容器/custom marks、通用 AI 与自动补全仍待后续。通用节点导出提示尚未替代当前人员专用静态提示。引用冲突/旧 epoch 恢复、PPT/PDF 对齐、生产身份与规模继续保留；在线协作内的位置/定位/跟随保留原入口，管理平台和实际提醒发送后置。

## 2026-10-24：E2 宿主原子节点、属性与共享命令

嵌入入口新增 nodeExtensions；宿主声明类型/业务版本、行内或块显示、校验与可读替代、国际化菜单名、可信 DOM 视图和属性字段。类型自动进入 `/`、工具栏、命令面板、右键与块插入入口。统一 node.insert/update/delete/properties 不暴露 editor/Y.Doc，更新核对当前选中出现身份和完整旧载荷，继续使用原有历史/协同/保存。宿主命令可读取冻结的选中节点快照；注册原子化、配置复制、卸载保护、视图清理和错误降级均已接通。只读不会因加载 codec 获得写权限。

双端验证发现块扩展缺少结构身份，会在同伴编辑后产生共享根重复；现为块扩展增加结构身份，从权威 key/owner 恢复旧记录投影，并在共享结构写入前拒绝重复出现身份。还发现已保存块再次更新返回 400，以及显示文字相同的数据更新可能被文字优化遗漏；现让 atom 业务载荷变化走完整结构保存，补齐文字/样式优化的排除条件，保留替代文字样式并移除过期回执。

真实浏览器已完成任务/提示两类节点的 `/` 插入、属性更新、自己的撤销/重做保留 Bob 正文、同伴更新后保留旧表单并要求重新载入。保留的失败草稿在自有服务升级后重试到 r5；随后文字不变的优先级修改保存 r6，重开显示 2。无宿主 codec 的会话只读展示两个已知节点；四个出现身份无重复，最初两个未知载荷不变。实际 r6 DOCX/PDF/Markdown 各含四处替代内容和同伴正文且只出现一次，DOCX 原图媒体字节保留；离线原生包保存完整业务载荷，保真报告逐节点四处静态化提示。

验证：438 项原生（64+133+215+4+19+3）、403 项前端、原生与 standalone/embed 构建、clippy/fmt、diff 检查通过；泛型未知节点的真实 socket/三格式链路也已重跑。详见 [E2 接口与边界](design/hcd-extension-nodes.zh.md)、[浏览器记录](assets/hcd-extensions-2026-10-24/sdk-browser-evidence.json)、[实际文件证据](assets/hcd-extensions-2026-10-24/sdk-file-evidence.json)。新增 PDF 仅文字回读，没有新做版面视觉验收。

这轮开放的是 atomic-v1，而非完整节点 SDK。两个离线/同时从同一旧值修改属性的候选保留与冲突处置仍未完成；当前旧表单防护不能代替该验收。业务迁移、资源/导出 adapters、通用导出 UI 能力报告、custom marks/富文本容器、AI 建议和自动补全继续实施。原来的引用冲突、旧 epoch 恢复、PPT/PDF 对齐、生产身份与规模范围保持不变；管理平台和实际提醒发送不做。

## 2026-10-24：E2b 字段候选、可撤销冲突选择与模型限制

原子节点的属性更新不再直接替换整份共享 JSON：保存每次修改的独立 ID、根载荷、前后载荷、父记录和触及字段，投影时合并。不同顶层字段自动合并，同一字段不同值保留候选；相同值收敛，缺失字段与 null 区分。行内 atom 保留原有共享载体，避免并发替换产生第二个身份。根载荷不被派生值改写；宿主只为精确的记录集合生成可读替代内容，服务端不执行任意业务代码。无有效替代或有冲突时，规范保存被拦截。

右侧“节点冲突”定位到属性面板并逐字段选择，选择进入同一撤销/协同路径。两个真实 WebSocket 客户端实际断开后从 r3 同一旧值编辑，重连验证任务名冲突与提示块的名称/确认状态合并；页面应用 Bob 候选后保存 r4。撤销选择恢复冲突并阻止保存，重做不重复增加版本；继续正文编辑保存 r5。双端、页面重开和自有服务重启后，接受/未接受候选、选择、合并和显示记录均保留。实际 r5 DOCX/PDF/Markdown 各含最终选择、合并提示、继续输入及两处未知替代内容一次；未接受候选不导出，原图字节不变。离线 HCD 保存已接受载荷，HCD draft 保存候选。

新增连接声明 hcdNodeEdits=1，协商/保存状态声明 nodeEditVersion=1，新客户端在上传缓存前拒绝旧服务，服务在接收正文前拒绝旧客户端。原生共享持久化另保留 nodeEdits:1：后续共享读写和 checkpoint 必须带 X-HCD-Node-Edits-Version:1，reset/restore/迁移保留要求。本机先发布限制再发布共享内容，旧元数据解析器拒绝未知模型；可选 PostgreSQL 的状态 CAS 同事务检查列值，避免降级写入。实测旧读、重发相同字节的旧写、旧 checkpoint 和未知模型均为 426，原共享字节与 head 不变。PostgreSQL 本轮仅代码/编译，没有真实 DB 或旧 DB 二进制验收。

415 项前端、440 项原生（64+135+215+4+19+3）与构建/clippy/fmt 检查通过；默认人员引用和泛型未知节点的真实 socket/文件链路已重跑。详见 [完整契约与命令](design/hcd-node-property-conflicts.zh.md)、[双 socket](assets/hcd-extensions-2026-10-24/node-conflict-socket-evidence.json)、[页面](assets/hcd-extensions-2026-10-24/node-conflict-browser-evidence.json)、[重启](assets/hcd-extensions-2026-10-24/node-conflict-recovery-evidence.json)、[文件](assets/hcd-extensions-2026-10-24/node-conflict-file-evidence.json) 和 [原生限制](assets/hcd-extensions-2026-10-24/node-model-fence-evidence.json)。新增 PDF 仅文字回读，没有新增视觉排版验收。

这不代表完整协同/SDK 已完成：每节点 128 条、文档 2048 条与记录/原生/传输限额仍有边界，没有自动压缩；达到上限前拒绝修改，旧内容、普通正文与撤销保留。长时间编辑容量、节点删除与更新竞争、业务版本迁移、资源、逐格式 adapters、custom marks/富文本容器、人员引用冲突、旧 epoch 离线恢复、通用 AI、PPT/PDF 对齐仍待继续。管理平台和实际提醒发送不做。


## 2026-10-24：在线协作入口与 PPT/PDF 跟随对齐

按确认将 PPT/PDF 顶部成员弹层改为右侧“在线协作”入口，与现有 Word 入口对齐。面板按人员显示姓名、多窗口连接数、所在页、页面内浏览比例和操作内容；当前已加载页面可解析原文摘要/图片名称，其余页面显示对象类型。画布继续显示带姓名的对象边框，旋转对象的边框沿用对象变换。只读用户可定位/跟随，保存和编辑命令仍受原权限约束。

“定位”是一次性跳转：优先将成员所选操作对象带到可见区域，不接管本机所选对象。“跟随”持续同步对方所在页与页面内横纵滚动比例，按各自窗口可滚动范围换算。跟随采用临时 awareness，不写入正文、历史或导出；PPT/PDF 本机原生 API 核对均保持 r0。自己的鼠标、触摸、滚动或键盘操作停止跟随；成员离开/连接断开停止跟随，直接与间接循环被拒绝。未加载到的页面禁用定位/跟随并说明等待索引；没有视图协议的旧客户端仍可显示姓名。

本机隔离原生 API、真实 WebSocket 与 CUA 页面验证了两页 PPT 翻页、图片选区/姓名框、两页长 PDF 的滚动同步、一次性对象定位、手动退出、成员离开、互相跟随保护，以及只读成员跟随。PDF 的两个窗口可视高度不同：成员 455/1193、跟随者 469/1229，滚动比例一致；手动停止后本机 scrollTop=888，对方继续滚动仍为 888。详见 [浏览器及原生 head 记录](assets/hcd-workbench-2026-10-24/fixed-follow-browser-evidence.json)、[PPT 画面](assets/hcd-workbench-2026-10-24/ppt-collaboration-follow.png) 和 [PDF 画面](assets/hcd-workbench-2026-10-24/pdf-collaboration-follow.png)。

验证：`npm --prefix examples/hdoc/editor test`（417 项）、`npm --prefix examples/hdoc/editor run build`（TypeScript、standalone/embed），`git diff --check`。运行 `python3 scripts/hcd-command-workbench.py --follow` 生成独立两页样例，终端输出 webPort 后打开 `.hcd-follow-{pptx,pdf}-{writer,peer,reader}.html`；凭据只写入权限 0600 的本机临时文件。此轮没有重新进行文件导出验收，没有变更保存/导出数据模型；生产身份与网络/规模、完整 PPT/PDF 编辑能力及原清单其余事项继续保留，管理平台和实际提醒发送后置。


## 2026-10-24：E3 通用 AI、私有改写/续写与接受事务

开放 aiExtensions 和独立 `/ai` 包入口：厂商/框架无关核心、宿主 Provider、严格 NDJSON HTTP 传输、有界上下文、动作目录、流序号/请求隔离、取消与超时。Word 右侧私有面板、统一工具栏/右键/浮层/命令面板共用 action；没有 Provider 时不影响普通编辑。相对位置只在本地适配器，模型请求没有访问令牌、人员或 Yjs 锚点；输出只作纯文本，不执行 HTML、业务节点或脚本。接受前再次校验原生权限/代次/协议、目标文字与格式，成为一次自己的可撤销事务。

真实本机原生 API + WebSocket + CUA + 模拟 HTTP 流：r1 建议未接受，另一成员和实际三格式文件均无 AI 建议；Bob 在另一段输入后，改写保存 r4，一次撤销 r5 保留 Bob，重做 r6，续写保存 r7。流中取消不改正文；同伴修改选区后旧建议立即失效，撤销该同伴修改也不会重新启用旧建议。重开保留 r7 正文而私有状态回到 idle；只读写动作禁用。

空来源段落续写另已验证：接受按实际事务回执判断，允许来源/样式附加修复；一次撤销 AI 插入，再次撤销先前清空原文，边界独立。432 项前端测试与 TypeScript、standalone/embed、独立无 React AI 核心入口构建/导入通过。r1/r4/r5/r7 共 12 份实际 DOCX/PDF/MD 回读、固定版本原生目录副本和 DOCX 媒体字节核对通过，运行时光标姓名均未混入文件。r7 PDF 新中文正文经渲染核对；最小源 drawing 为 opaque 占位，语义 PDF 没有原图，不能将本轮正文验收称为原稿保真。该静态表达/提示仍属 F 阶段待办。

详见 [AI 接入、协议、证据和后续范围](design/hcd-editor-ai.zh.md)、[页面](assets/hcd-ai-2026-10-24/ai-browser-evidence.json) 和 [文件](assets/hcd-ai-2026-10-24/continued-file-evidence.json)。没有连接真实模型或新建原生 AI 路由；宿主服务鉴权/配额/去重/实际模型取消、原生 AI 来源台账、自动灰字补全、结构化工具和 PPT/PDF AI 仍需继续。原有内容 SDK/导出/字体/引用并发及生产验收清单保持完整；管理平台与实际提醒发送不做。


## 2026-10-24：E05 私有灰字补全首版，浏览器稳定性待复查

接入默认关闭的本机停顿补全：有界前缀、尾部防抖/冷却/去重，复用 Provider 和取消/超时核心；灰字为 PM widget，不进入共享正文或导出。菜单/宿主快捷键/列表/表格/IME 优先，只有完整可见建议的普通 Tab 接受。接受重验原生权限/代次和原相对光标，走一次自己的历史/协同/保存。统一命令与英文/简繁中文入口已接入，框架独立调度器随 `/ai` 入口开放。

真实本机模拟 HTTP、原生 API、独立 socket、浏览器和实际 DOCX/PDF/MD：r3 未接受不出现在文件；r6 Tab 接受一次；r7 一次撤销仅移除补全，r8 重做，均保留手工输入和 Bob 段落。Esc、继续输入、移动光标和同页编辑区失焦取消灰字。列表 Tab 的嵌套结构在协作端及 r12 可见，r12 最终文件和离线目录回读通过。440 项前端、TypeScript、standalone/embed 构建通过，本轮无 Rust 修改。

原 writer 随后开发协议超时，Alice 新页停留本机备份读取；peer 后续原生选区/输入调用也超时。尚不能区分页面/选区、工具、缓存和资源压力，连续列表操作、菜单/离屏 Tab、真实重开与设备 IME 等仍待复查。只读新会话已成功重开 r13，补全关闭、正文与列表保留；Alice 可写缓存恢复仍未通过。因此只记录首版及已通过证据，不将 E05 或完整目标标记完成。详见 [设计与边界](design/hcd-ai-autocomplete.zh.md) 和 [浏览器记录](assets/hcd-ai-2026-10-24/autocomplete-browser-evidence.json)。管理平台及实际提醒发送继续后置；原生 AI 来源、真实服务、完整 SDK、PPT/PDF、字体/国际化与原清单保持有效。


## 2026-10-24：嵌套列表与浮层更新循环修复

先前页面超时已在 AI 关闭时独立复现。嵌套 listItem 用结构 key 定位但没有规范保存 owner；旧身份插件反复补临时 ID，结构绑定反复清除。现在仅对已绑定且无保存 owner 的空 ID 节点保留模型规定的状态，旧/未绑定身份流程不变。同一份共享状态从超过 12 轮仍不收敛变为 2 轮完成；新增 bullet/ordered 两类列表的输入、Enter、缩进/反向缩进、自己的撤销/重做和同伴正文回归，测试有限轮保护。

同时将 BubbleMenu shouldShow 改为随实际依赖变化的稳定回调，避免 Tiptap 每次重渲染都追加 options 事务，再引发父页面刷新。新隔离 CUA 页在完整灰字时 Tab/Shift-Tab 正常处理列表；独立 Bob socket 新增另一段后灰字仍可接受；r6/r7/r8 三格式与离线目录核对自己的接受/撤销/重做不丢手工列表和 Bob。斜杠菜单 Down/Enter 未增加 AI 请求，可写缓存重开 r9 后继续输入保存 r10，选区浮层正常，修复后的观察时间段内没有重复更新告警。442 项前端、TypeScript、standalone/embed 与 diff 检查通过；无 Rust 修改。

详见 [设计与边界](design/hcd-ai-autocomplete.zh.md) 及 [复查证据](assets/hcd-ai-2026-10-24/autocomplete-stability-browser-evidence.json)。最初失去响应旧标签页的强制恢复没有验收；真实 IME/OS 焦点/移动端/离屏等仍待后续。实际 DOCX 将嵌套列表静态成文字项目符号而无原生编号层级，不能将本轮文件文字回读称为层级保真；此缺口与 opaque PDF 缺图继续列入 F 阶段。管理平台/实际提醒后置，完整 SDK、AI 来源/真实服务、PPT/PDF 与原清单不缩减。


## 2026-10-24：F1 原生列表导出与再导入边界

DOCX 语义导出改用原生 numbering 定义和段落 numPr，记录列表容器、层级、首段/续段和起始/恢复/重启编号；保留文字、链接/已有运行格式，不把编号拼入 w:t。规范保存后的独立 li 在临时副本按已声明属性补容器，并合并跨块连续编号，不改原 HCD。Word 预览另保留每个 numId 的计数，嵌套返回后不重复应用 startOverride。MD 保留父标记宽度缩进、空父项、多段和显式硬换行。

139 项 officecli bin、39 项 docx-handler lib、构建及 clippy/fmt/diff 通过。实际 DOCX/MD/PDF 读回全部测试中英文正文一次；DOCX 验原生 depth 0/1/2、start 4/7/10，MD 再导入的树/起始号/正文一致。Word 自有 reader + CUA 显示 4→5、7→8、10；PDF 实际渲染也核对了列表。上一轮真实协作 r10 的新 DOCX 原生深度为 0/1/1，AI 接受内容与 Bob 各一次，manifest 未改。

真实文件验证同时确认导入侧缺口：当前 DOCX importer 仍将列表/标题投影为普通段落，HTML importer 某些带 p 的嵌套列表在导入时拆散父项；保留失败证据继续修复，不能称完整格式回转。九级以外、极大编号、复杂容器、全 marks、原图/字体/分页和 Office/WPS 实机亦未整体验收。详见 [F1 设计与矩阵](design/hcd-list-export.zh.md)、[文件与模型](assets/hcd-lists-2026-10-24/native-list-file-evidence.json) 和 [HTML 导入缺口](assets/hcd-lists-2026-10-24/html-import-gap-evidence.json)。其余 SDK/AI/引用/协同与生产范围保留；管理平台、实际提醒仍后置。

## 2026-10-24：F1 DOCX 标题与列表重新导入修复

上述 DOCX 普通类型导入缺口已修复：标题根据直接 outlineLvl、样式继承和内置名称识别；混合列表由原 numId/ilvl/计数重建，保留 4→5、7→8、独立 10 和空父项。每个根条目连同子树作为一个有界块，不缓存整份列表；300 个条目在小分块配置下通过。高级编号/编号标题、七至九级标题、范围外编号及可视对象组保留可读原文并标记只读，不伪装成可完整编辑。

64 项 hcd-core lib、40 项 hcd-docx lib、140 项 officecli bin 和 444 项前端测试通过，原生构建/clippy、前端 standalone/embed 构建通过。实际文件完成 `HCD → DOCX → HCD → DOCX/Markdown → HCD`，树/起始号/正文与源模型相同；可视编号没有重复进入正文，再导出原生实例保持续号。新增回归还核对来源节点一一对应、子项文本改动后源文件回写、numbering.xml 不变及历史不变。完整 marks 没有包含在本轮实际树比较中，原 Office/WPS 应用未验收。

见 [最新契约](design/hcd-list-export.zh.md)、[文件与模型](assets/hcd-lists-2026-10-24/native-list-file-evidence.json)、[保留的修复前证据](assets/hcd-lists-2026-10-24/docx-reimport-before-evidence.json)。HTML 导入、复杂列表子节点及其余完整 SDK、AI、协同、字体/国际化/PPT/PDF 与生产范围继续保留；管理平台、实际提醒后置。

本轮页面复核同时修复两个集成问题：无序子列表的无效 start 属性导致来源迁移被拒绝；嵌套条目的冗余 level 与前端编码不一致导致纯文字保存触发结构重建。真实双端已保存 r2/撤销 r3/重做 r4，自己的动作不删除 Bob 内容；三份实际源 DOCX 导出均为 HIGH，其他 OOXML 部件字节及 document.xml 非正文结构/运行属性不变，再导入与保存模型一致。可写重开 r4、右侧在线协作操作摘要/跟随通过，跟随未增版本。见 [页面证据](assets/hcd-lists-2026-10-24/docx-reimport-browser-evidence.json) 与 [截图](assets/hcd-lists-2026-10-24/docx-reimport-editor.png)。旧已保存段落形态的 HCD 未进行历史语义升级，HTML 导入与其余完整目标继续。


## 2026-10-24：F1 HTML 多段父项与混合子列表导入修复

修复 HTML 中 li 内 p 拆散父项的问题；根项保留多段、混合子列表、尾段、起始号/重启和硬换行，原始文字来源锚点及空节点插入位置保留。支持的行内格式跨段正确闭合/重开，危险链接仅保留标签。根子树有界分块、超限明确失败；整个来源仍按 64 MiB 限制读入，表格复合块保持只读，新声明块不改变旧历史解释。

48+64+40+140 共 292 项原生测试、构建、all-targets clippy、fmt/diff 通过。真实 CUA 双端完成 Alice 子项修改、Bob 正文修改、r2 联合保存、自己的撤销 r3/重做 r4。三份 source-backed HTML 为 HIGH，来源 ID 不变、无结构重建、仅预期文字字节变化，再导入等于保存模型。可写页重开 r4、在线协作内姓名/操作摘要/跟随通过，原生 head 仍为 r4。

实际 HTML 检视文件和 Markdown 再导入保留树/起始号/换行/正文，未比较完整 marks；DOCX 保留原生编号/文字，但多段列表再导入仍丢续段归属及样例硬换行，完整树比较为 false。PDF 经渲染可读，续段/尾段缩进仍未与编辑页对齐。HTML 无来源语义导出尚不支持，本轮 render-html 仅为检视。详见 [最新契约](design/hcd-list-export.zh.md)、[文件](assets/hcd-lists-2026-10-24/html-list-file-evidence.json)、[页面](assets/hcd-lists-2026-10-24/html-list-browser-evidence.json) 与 [截图](assets/hcd-lists-2026-10-24/html-list-editor.png)。本轮未修改前端，未重复前端测试。旧历史语义迁移、完整 SDK/AI/协同/字体/国际化/PPT/PDF 与生产目标保留，管理平台和实际提醒发送后置。


## 2026-10-24：F1 续段排版与普通 DOCX 硬换行

PDF 列表续段曾从首段换行 x≈76 退回 x≈40，根因为排版器展开非首段块时丢失 li 的内容宽度和累计缩进。共享路径修复后普通段落、块容器及子项续段与父内容边缘对齐，长行不越界，固定/绝对定位保留其坐标。原测试文件 PDF 的父项/续段/尾段均 x≈70，子项 x≈100、叶项 x≈130；实际整页渲染已核对。

新导入普通 DOCX 段落/标题通过显式 word-tree 声明保留 br/cr，配对和空元素写法均处理，旧快照解释不变。实际 DOCX 正文/硬换行一致，来源回写为 HIGH 且仅目标文字字节变化，换行元素/其他部件/历史不变。无编号续段归属仍未重建，完整 DOCX 列表树比较继续为 false。

64+41+48+141 共 294 项原生测试、构建、四个 crate all-targets clippy、直接 renderer clippy 与 fmt/diff 通过。未改前端，未重复 UI/前端检查；没有新增 Office/WPS 实机或生产证据。详见 [契约](design/hcd-list-export.zh.md)、[本轮证据](assets/hcd-lists-2026-10-24/list-paragraphs-evidence.json) 和 [渲染](assets/hcd-lists-2026-10-24/list-paragraphs-pdf-after.png)。完整 SDK/AI/引用/协同、旧历史、字体/国际化/PPT/PDF 与其余原清单不缩减；管理平台/实际提醒后置。


## 2026-10-24：F1 DOCX 显式续段归属与完整列表树回转

新增共享的有界、带版本归属类型，由 L2 RichParagraph 写入可忽略的 DOCX 命名空间属性，原生编号和正文正常保留。导入校验真实命名空间、原生层级、唯一条目身份和当前开放范围，支持子列表后返回父项尾段；无标记/失效元数据不猜归属，保持可读内容并报告限制。新样例 HTML→HCD→DOCX→HCD 的树/起始号/硬换行/正文现已相等，旧无标记文件仍能复现差异。完整 marks 未比较，第三方应用保存扩展是否保留尚未验收。

366 项相关原生测试（31+39+64+43+48+141）、原生构建及六个 crate all-targets clippy、fmt/diff 通过。实际双端在续段输入、Bob 在另一段输入，r2/自己的撤销 r3/重做 r4 的来源 DOCX 全部 HIGH，仅目标文字变化、来源 ID/非正文结构/运行属性/其他部件保留，再导入与保存树一致。可写重开和右侧在线协作跟随通过，head 保持 r4。peer 初次本机备份读取失败，重试未恢复，使用 UI 明确继续入口；本机恢复没有验收通过，需继续追查。

见 [契约](design/hcd-list-export.zh.md)、[协议与页面证据](assets/hcd-lists-2026-10-24/docx-ownership-evidence.json)、[实际文件](assets/hcd-lists-2026-10-24/html-list-file-evidence.json)、[双端来源文件](assets/hcd-lists-2026-10-24/native-list-file-evidence.json) 和 [截图](assets/hcd-lists-2026-10-24/docx-owned-editor.png)。旧历史、完整 SDK/AI/引用/协同、资源/字体/国际化/PPT/PDF 与生产原清单保持，管理平台和实际提醒后置。


## 2026-10-24：本机草稿启动故障分类与实际恢复

修复整个启动异常都被显示为本机备份不可用的问题，分别处理磁盘、服务端、身份和协议失败；旧代次 409/426 或正文协议不符仅核对一次当前身份，真实变化才刷新会话。只有磁盘故障提供无备份继续；重试/退出取消旧请求，旧代次结果不能创建连接或替换新状态。服务端未核对时不归档候选，已加载的本机副本可对比/下载。恢复预览另保留硬换行。

实际原生 API 验证 409→200 身份核对且 manifest 不变；新双端自动启动无需跳过备份。暂停自有 sidecar、native API 保持在线时，r2 原生快照没有第二次离线文字，真实 IndexedDB 恢复页有本机独有文字而服务端预览没有。恢复同一进程、按恢复后进入 r3，同伴随后输入保存 r4。实际来源 DOCX 为 HIGH，仅三处预期文字改变，源 ID/换行/非正文结构/运行属性及其他部件不变，再导入等于保存树、历史 r1 不变。

450 项前端测试、TypeScript/standalone/embed 构建及 diff 检查通过，无 Rust 修改，未重复原生单测。原故障没有记录异常，不能认定其精确原因；首次重载未离开受保护页面，最终验收使用新窗口，本轮不是浏览器进程崩溃/OS 重启证明。真实浏览器存储拒绝/容量/阻塞、完全离线身份初始化仍待补验。见 [契约](design/hcd-local-draft-bootstrap.zh.md)、[浏览器](assets/hcd-workbench-2026-10-24/bootstrap-browser-evidence.json)、[文件](assets/hcd-workbench-2026-10-24/bootstrap-file-evidence.json) 与 [截图](assets/hcd-workbench-2026-10-24/bootstrap-recovered-editor.png)。完整 SDK/AI/引用/协同、字体/国际化/PPT/PDF 与生产原清单继续，管理平台和实际提醒后置。


### 在线协作中的跟随入口与多窗口稳定性（2026-10-24）

按已确认交互，成员姓名、操作段落、浏览进度及定位/跟随集中在右侧“在线协作”。本轮补齐语义编辑器的多窗口选择：合并成员行时保留正在跟随的连接，新增同成员窗口不再替换跟随目标；循环跟随在按钮上禁用并在点击时复核。自己的滚动或输入退出跟随。

本机原生 API、真实 WebSocket 与 CUA 双成员长文页面通过，包含同成员第二窗口、操作摘要、循环保护、手动退出后对方滚动不拉走当前视图。导航前后规范仍 r2，manifest 字节不变。前端 454 项测试、独立页/嵌入构建通过；本轮无 Rust 跟随逻辑变更。详见 [协作协议](design/hcd-collaboration-protocol.zh.md)、[页面证据](assets/hcd-workbench-2026-10-24/online-collaboration-follow-evidence.json)。其余扩展、导出和全格式验收继续按原清单推进，管理平台后置。


### 固定版本的业务节点导出预检（2026-10-24）

下载前按规范版本显示自定义行内/块和引用的数量、可读示例、目标格式表现及数据保留方式。Office/PDF/Markdown/TXT 的共同业务节点采用文字替代并省略业务数据；HTTP HTML 仍含嵌入载荷，界面明确披露。原生 HCD 仍保留身份、版本和 JSON，不新增原生打包下载能力。预检读取有界分块，不执行宿主扩展；失败不绕过，固定历史版本不换成最新 head。

保存回执后再次核对：真实页面从 6 个业务节点保存为 r7 的 7 个，先更新提示并停止下载，再次点击才下载固定 r7。普通正文变化不反复要求复核；sidecar 暂停时阻止导出并保留本机草稿，恢复后同伴可见、自动保存 r10，残留连接警告清除，实际 r10 DOCX 回读保留两处恢复正文和所有业务替代内容。详情改用顶层浮层避免紧凑工具栏裁切，中英繁体提示通过。

五格式探针实际发现 PDF 丢失“☐”，现按完整 grapheme 选择覆盖该字符的次级字体，仅修改打印副本；真实文件精确回读及整页渲染通过。完整字体覆盖/平台一致性仍未证明。初版预检 449 项原生通过，字体修复后重跑 143 项 CLI 单元和 2 项 PDF 集成回归；最终 456 项前端与独立/嵌入构建、原生构建、相关 all-targets Clippy/fmt/diff 通过。证据见 [契约](design/hcd-export-capabilities.zh.md)、[API/五格式文件](assets/hcd-extensions-2026-10-24/export-capabilities-file-evidence.json)、[页面与下载](assets/hcd-extensions-2026-10-24/export-capabilities-browser-evidence.json)。

本阶段的汇总声明不代替逐业务类型/版本的导出 adapter SDK。业务迁移、资源、marks/富文本容器、长历史压缩与删除竞争、引用并发/旧代恢复、完整协同/AI/字体/国际化/PPT/PDF 和生产验收保持原目标，管理平台与实际提醒发送继续后置。


### 显式节点迁移、完整版本候选与最终协作复核（2026-10-25）

宿主可注册逐业务版本迁移，先在右侧审阅原文、升级结果和可选数据变化，再确认应用；读取不自动升级。统一命令提交前核对节点身份/原文、权限、选区、当前注册及重新计算的结果。回调输入冻结、逐步共同模型及最终业务 schema/fallback 校验，异步/不确定/非法结果、缺路径、未来版本和失效预览不改正文。旧预览的“重新载入”同时清除预览，保留旧内容。

迁移使用整个 envelope 的 schema 屏障；旧字段 title 与新字段 caption 不能混合。真实旧业务 codec 的离线修改和已保存新版产生完整候选，未选择前阻止保存。CUA 选择旧版本保存 r5，再升级 r6、行内升级 r7，离线值保留。共同载荷仍 hcd.extension/1，协同新记录/声明提升至 v2；既有 v1 记录可读，原生要求跨 reset/restore 单调保留，缺声明/仅字段 v1/未知共享读写和 checkpoint 实测 426，字节/head 不变。PostgreSQL 仅代码编译证据，没有真实数据库或多实例验收。

468 项前端测试及 TypeScript/standalone/embed 构建通过。原生阶段的 67 项核心、144 项 CLI、原生构建与 all-targets Clippy/fmt 通过；写锁测试先复现重复文件描述符延长锁持有，再由 guard 显式 unlock 修复，不把它追认为早先一次 SSE 测试失败的唯一原因。真实 socket 与页面的三格式文件、四个节点身份、未知 v77 数据、源图片和离线 HCD 回读通过。随后观察到 Alice 的任务确认状态作为 r8 保存，原始触发动作未确定，未擅自回退；r7/r8 两份实际浏览器 DOCX 均与各自版本一致。新点击块选择和协作定位/跟随/停止不增版本。

在线成员、操作段落/姓名高亮、定位及持续跟随仍集中在右侧“在线协作”，本机双端再次验证。详见 [迁移契约](design/hcd-node-migrations.zh.md)、[页面与下载证据](assets/hcd-extensions-2026-10-24/node-migration-schema-browser-evidence.json)、[十二份三格式文件](assets/hcd-extensions-2026-10-24/node-migration-schema-file-evidence.json) 与 [右侧跟随画面](assets/hcd-workbench-2026-10-24/online-collaboration-final.png)。构建目录保留隔离样例与实际文件，原先临时目录已清理的证据仅作为历史记录。资源、逐类型导出 adapters、marks/富文本容器、删除竞争/长历史压缩、引用竞争/旧代恢复、完整字体/国际化/PPT/PDF/AI/设备与生产验收继续；管理平台、实际提醒发送后置。


### 2026-10-25：PDF 保存布局与离线选区对齐

候选 PDF 的文字框、基线与混合字体现在随正文和页面栅格提交，同一已保存版本用于点击框、带姓名的协作高亮、属性与无源搜索层。修复 CID 后代字体宽度读取和合并多个 show 操作替换残留旧字；布局以 root/节点 hash 和规范正文校验，旧式修改没有新布局时清除过期元数据。

358 项相关原生、496 项前端、TypeScript/双构建、all-targets Clippy/fmt/diff 通过。实际源文件支持与无源 PDF 各词边界最大误差约 0.000013pt，90/180/270° 新字体替换约 0.000007pt；历史、两 actor HTTP 保存/重复回执/逆向 patch、未知字形失败保持 head 和十页像素检查通过。CUA 两名只读成员验证混合字体/14pt、禁用保存、姓名高亮与命中框尺寸一致、右侧跨页跟随/停止。不是前端同时保存、生产/多实例或真实 Office 验收。

见 [契约、复现与限制](design/hcd-pdf-saved-text-layout.zh.md)、[文件实测](assets/hcd-pdf-search-2026-10-25/pdf-search-evidence.json)、[浏览器画面](assets/hcd-pdf-layout-2026-10-25/mixed-font-properties.png)。没有完整字体字宽、复杂脚本/文字矩阵、未保存旋转草稿等仍需继续。自定义节点资源、导出 adapters 和富文本容器的已有阶段见 [资源与富文本](design/hcd-node-resources-and-rich-content.zh.md)；任意 marks、复杂往返、引用/删除竞争、完整命令和 AI/设备/生产原清单不缩减。管理平台与实际提醒发送继续后置。


### 2026-10-25：资源请求取消、超时与协作行内选区

上传/读取绑定注册服务会话，取消/卸载/超时独立结束等待并隔离迟到结果，旧 cleanup 不关闭新连接。属性栏可取消上传；资源进度不再销毁统一命令服务。真实延迟 HTTP 验收又发现行内 NodeSelection 没有稳定书签，现按 occurrence ID 保持自定义行内元素与提及选中，远程删除安全退回普通选区。

501 项前端、TypeScript/双构建及 diff 检查通过。真实 loopback 代理记录 native 200 后取消、503、45.059 秒 deadline；关闭/导出受保护，失败/取消不关联资源，属性草稿保留。同伴子段输入保存到 r8，最终新窗口重试只关联一次保存 r9，明确应用草稿保存 r10。r6/r8/r9/r10 实际 DOCX、无源 HCD 包解包后 DOCX/PDF/MD、浏览器 r10 DOCX 回读保留四身份/未知节点/资源字节/双端正文/两处图片。原生程序有真实 socket/API/文件证据，本轮无 Rust 修改，未重复原生单测。开发中旧窗口曾有混合热更新失败，最终接受新窗口证据，不声称 HMR 迁移通过。

见 [契约和复现](design/hcd-resource-request-lifecycle.zh.md)、[浏览器](assets/hcd-resource-lifecycle-2026-10-25/browser-evidence.json)、[真实网络](assets/hcd-resource-lifecycle-2026-10-25/network-evidence.json)、[实际文件](assets/hcd-resource-lifecycle-2026-10-25/file-evidence.json)。custom mark/行内可编辑容器、复杂格式往返、容量与离线冷启动、其他全目标和生产设备范围继续，管理平台/提醒发送仍后置。


### 2026-10-25：人员改绑完整候选与元数据保存门禁

已有 `@人员` 可在右侧引用面板搜索改绑，保持 occurrence ID。双端离线改同一提及保留目标+显示快照的完整候选，不复制 atom、不拼接两个人的信息；明确选择和自己的撤销/重做走统一命令。只读、未知业务容器和保留 kind 无法借该入口改写。最终作者来自已鉴权 resolver，原生服务重新授权，实际提醒仍关闭。

协调器及客户端共用活跃引用/节点冲突检查。即使冲突占位正文与旧已保存内容相同，迟到回执也不能授权关闭或导出当前内容。共享模型升级为4，URL/协商/保存状态/HTTP声明同步；结构协议仍3，canonical mention仍1。原生持久要求单调，旧声明的共享读写/checkpoint拒绝，不改变规范文件读取。

512项前端测试、TypeScript/双构建，157项CLI单元测试、相关all-targets Clippy、native构建、fmt/diff通过。两个真实socket和浏览器完成r2竞争、r3选择、r4改绑、r5删除、r6自己的撤销恢复。实际r2–r6 DOCX、无源离线DOCX/PPTX/PDF/MD及浏览器下载r6回读保留身份、同伴正文及原图片字节；事件稳定且resolver正确。隔离token过期的401在同权限刷新后复验通过，没有重启服务或重建文档。不是数据库、多实例、生产、崩溃或真实Office客户端验收。

详见 [契约、剩余边界和复现](design/hcd-reference-retarget-conflicts.zh.md)、[浏览器证据](assets/hcd-reference-intents-2026-10-25/browser-evidence.json)、[实际文件](assets/hcd-reference-intents-2026-10-25/file-evidence.json)。删除竞争审阅、保留当前规范值的恢复交互、旧epoch恢复、长期历史压缩、任意mark/行内可编辑容器及其他完整目标继续；本批不能替代整个清单。管理平台、实际提醒发送仍后置。


### 2026-10-25：冲突中保留已保存人员值

新增 `reference.keepSaved`，在右侧展示具体已保存版本及姓名，点击后用当前鉴权会话读取规范引用并核对前后head。等待期间的候选变化、只读/就绪失效、取消、错误文档/版本拒绝写入；不能把旧root占位当规范值。自己的撤销恢复冲突，重做恢复值，只读端只能审阅。

522项前端测试、TypeScript/双构建通过。本轮无Rust修改，原生没有重复计入历史单测；真实socket先保存r3 Alice，再离线竞争并停用所有人员，候选发布收到原生403、head不变；CUA保留已保存Alice、同伴正文存r4，撤销/只读禁用/重做及重复保存仍r4。实际浏览器DOCX及无源离线DOCX/PPTX/PDF/MD、图片字节、稳定引用/无额外关联事件复验通过。不是生产、真实Office、多实例、数据库、旧epoch或崩溃验收。

见 [恢复契约、复现与剩余范围](design/hcd-reference-saved-recovery.zh.md)、[浏览器](assets/hcd-reference-saved-2026-10-25/browser-evidence.json)、[实际文件](assets/hcd-reference-saved-2026-10-25/file-evidence.json)。删除后的规范缺席不在此入口隐式处理；完整删除竞争、压缩/GC、自定义mark/行内可编辑容器、复杂格式和其他完整目标继续。管理平台与实际提醒仍后置。


### 2026-10-25：已知行内节点接入普通块操作

修复已注册行内元素也被整个段落保护的问题：复制、移动和标题/列表/引用转换按当前codec检查；复制生成独立节点ID并保留资源/逐格式快照，移动/转换保持ID，代码块仍拒绝原子对象。暂存后卸载codec和未知外层容器重新检查，不能靠旧授权或已知内层绕过保护。文本格式/AI没有获得通用保护豁免，整个业务块任意转换仍未开放。

527项前端测试及TypeScript/双构建通过，无Rust修改，不重复计入历史原生单测。实际双端准备r6，CUA复制r7、转标题r8、仅副本改名r9，Bob窗口重开和实际浏览器下载通过。r6–r9规范回读、原图片/资源字节及无源HCD包的DOCX/PPTX/PDF/MD通过；四个原ID/未知v77/双端子段内容保持，新增副本ID独立稳定。结构回归覆盖移动并发打字和自己的undo，不冒称浏览器拖放竞态或生产验收。

见 [实现与剩余模型工作](design/hcd-inline-node-block-operations.zh.md)、[页面](assets/hcd-inline-blocks-2026-10-25/browser-evidence.json)、[实际文件](assets/hcd-inline-blocks-2026-10-25/file-evidence.json)。行内元素仍为atom，可编辑行内容器和custom mark需要共同模型/存储/位置/导出扩展，不能只开contenteditable；这些和其他原目标继续，管理平台及实际提醒发送仍后置。


### 2026-10-25：整个业务块/嵌套容器与精确投影

已知整个业务块和容器可复制、移动、删除；检查整棵子树/祖先及跨越的邻居codec，复制为外层、内层、行内节点和提及分配新ID并清理来源回执。移动保留身份，自己的删除撤销恢复子树；不兼容转换继续禁用。菜单按同级目标计数，Shift扩选限制同一父范围。

实际嵌套页面首次出现重复身份空白，先排除规范/socket重复，DOM标记假设未通过后撤回。结构投影的开Slice fitter存在可复现的“合法但不等于目标”反例，现核对精确相等，必要时闭合顶层替换，仅改本地视图、保留共享载体及稳定选区。

534项前端、TypeScript/双构建及diff通过，无Rust修改。CUA复制r7；两个真实鉴权socket完成离线移动并发打字r8、删除与离线字r9、自己的undo/redo/undo到r12；新窗口只改副本容器属性保存r13，实际浏览器DOCX下载/Bob重开通过。r6–r13实际文件、引用事件/actor、原6载荷/未知v77、9个唯一业务身份和资源字节，以及无源HCD解包后DOCX/PPTX/PDF/MD通过；head未被回读改变。

见 [契约和复现](design/hcd-business-block-operations.zh.md)、[实际网络](assets/hcd-business-blocks-2026-10-25/socket-evidence.json)、[浏览器](assets/hcd-business-blocks-2026-10-25/browser-evidence.json)、[实际文件](assets/hcd-business-blocks-2026-10-25/file-evidence.json)。删除会隐藏共享子树，离线peer新增字在undo后恢复；完整删除竞争审阅仍未完成。副本已有peer内容后撤销创建/复制本身也未获验收。热更新旧窗口响应异常不记为通过，最终属性/下载使用新窗口。任意mark/行内容器、复杂往返、历史压缩及其他完整目标继续；管理平台与实际提醒发送后置。


### 2026-10-25：业务子树撤销审阅

结构历史现在在独立CRDT副本中试算：撤销创建/复制，或重做删除会隐藏已到达的同伴文字、格式、标题、业务属性、人员引用或新子块时，保留正文和历史，提示取消或保留内容并只跳过当前记录。来源绑定回执不误报；原动作已明确移除的内容与后来到达的修改分别核对。精确栈顶/版本门禁保留，跳过不清空较早历史或相反方向分支；本地redone映射在隔离试算中保留，正常连续undo/redo不被误拦。

审阅条移至工具栏下方，按钮不会挤到横向工具区末尾。546项前端测试和TypeScript/双构建通过，无Rust修改。真实鉴权socket、浏览器复制保存r7、Bob修改保存r8、撤销审阅/取消/重试/跳过、Bob重开和实际浏览器DOCX下载完成；规范仍r8。实际HCD归档解包、资源字节、引用actor及无源DOCX/PPTX/PDF/MD回读通过，PDF整页检查通过。

见 [实现、复现和边界](design/hcd-structural-undo-review.zh.md)、[浏览器](assets/hcd-undo-review-2026-10-25/browser-evidence.json)、[实际文件](assets/hcd-undo-review-2026-10-25/file-evidence.json)。这只保护当前窗口已经收到的同伴修改，不是完整服务端删除竞争/分布式锁或跨设备持久历史；检查后才到达的离线编辑、任意custom mark/可编辑行内容器、复杂往返、历史压缩和原完整目标其他验收继续。管理平台和实际提醒发送仍后置。


### 2026-10-25：扩展卸载后的历史保护

补齐历史绕过普通事务codec保护的缺口：完整Word每次undo/redo都读取当前注册表，未知行内/块节点及容器子树不能被历史移除或改写；业务属性、容器内部普通打字也检查。无关正文仍可撤销，恢复未知对象可只读保留，之后redo删除须复查。加载匹配codec后继续同一历史，不重建连接；替换注册表/内层单独卸载和精确跳过均有回归。558项前端及TypeScript/双构建通过，无Rust修改。

实际CUA复制r7、卸载后审阅、重载后继续undo保存r8、redo保存r9、再卸载并跳过通过；当前规范及离线r6–r10回读、资源字节/引用actor、实际浏览器DOCX和无源DOCX/PPTX/PDF/MD通过。**Bob随后普通正文的首次显式保存返回failed/native400，原探针exit1；约5秒后的协调器重试提交r10。**此异常保留待独立复现，不能把head10或文件正确当作首次请求成功，保存链路不据此整体验收。

见 [契约与证据](design/hcd-extension-history-guard.zh.md)、[保存异常与下一步](assets/hcd-codec-history-2026-10-25/save-anomaly.json)。接下来优先捕获首次400的请求/响应，核对来源/规范身份与探针裸Fragment追加和真实打字路径，再推进任意mark/可编辑行内容器及原完整计划其余项。此批不是管理平台，也不发送提醒。


### 2026-10-25：未知容器的来源修复与首次保存

独立负例捕获了裸Fragment及缺少append插件的PM探针首次400，规范仍r9、持久草稿保留；修正探针完整输入流程，保留旧失败与后续重试的原记录。另用真实插件回归发现未知富文本容器会误拦核心来源身份补写，现仅允许内部hcdSource标记变化，业务载荷、资源、可见格式与子树仍严格保护；历史检查共用此比较。

562项前端测试、TypeScript及双构建通过，无Rust修改。新夹具Bob首次保存r10和浏览器r11–r14各只有一条对应checkpoint，均200；页面连接中断后核对部分输入，在同一窗口补齐、撤销、重做，Bob重开和实际DOCX下载通过。逐份r6–r14规范/实际文件、引用actor、资源字节、稳定来源及无源HCD/DOCX/PPTX/PDF/MD回读和PDF整页检查通过。不是旧400原body的逐字节重建，也不是生产、真实Office或全设备输入法验收。

见 [来源修复契约与证据](design/hcd-source-identity-repair.zh.md)、[验证摘要](assets/hcd-source-repair-2026-10-25/validation.json)。完整删除竞争、任意custom mark/可编辑行内容器、复杂业务/Office往返、历史压缩和其余完整目标继续；管理平台和实际提醒发送仍后置。


### 2026-10-25：删除块后的离线修改审阅

显式块/容器删除记录完整公开子树的精确快照；之后到达的文字、格式、业务属性、引用意图或新子块触发右侧新旧内容审阅。协调器持久保留草稿，在处理前拒绝规范保存/当前导出；恢复同一最新子树，或二次确认继续隐藏，过期确认拒绝，认可后新修改仍重开。继续删除不写隐藏状态，不会压过并发恢复。未知codec及祖先不能确认删除，可恢复只读内容；统一命令与只读门禁适用。wire5要求配套升级编辑器/sidecar/native，结构3/coordinator4/envelope2/mention1不变。

573项前端、74项选定原生测试及构建/Clippy/fmt通过。真实鉴权socket与浏览器验证删除r7/恢复r8/删除r9、确认期间和确认后新修改、只读禁用、恢复全部四次输入到r10、撤销保护/取消、Bob重开和最终实际DOCX下载。原生首次checkpoint全200，冲突不进入checkpoint；当前持久Yjs文件直接重载保留内容及receipt，旧wire4同步前拒绝，原生缺失/1–4/未知6读写/checkpoint均426且字节/head不变。逐份r6–r10、无源HCD/DOCX/PPTX/PDF/MD、资源/原图、稳定业务/提及身份与引用actor核验通过。

见 [契约与证据](design/hcd-deletion-conflict-review.zh.md)、[实际文件](assets/hcd-deletion-review-2026-10-25/file-evidence.json)、[检查摘要](assets/hcd-deletion-review-2026-10-25/validation.json)。开发补充祖先检查引起页面重载，历史保护证据在重载前实际完成，最后改动后重新下载；不把热更新/跨设备持久历史、服务重启、数据库/多实例、真实Office/生产当已验收。同段行内节点删除、撤销创建后才到达的输入、复杂移动/转换与删除组合、容量/压缩/旧epoch及完整目标其余范围继续；管理平台和实际提醒发送仍后置。


### 2026-10-25：撤销创建后的迟到输入恢复

guarded结构历史在同一次逆操作中保留新建/复制子树的永久拓扑，只隐藏根并写入既有删除receipt。迟到离线文字、格式或子块可进入原载体并触发审阅，新窗口不依赖本机历史即可恢复。临时包装Yjs deleteFilter后finally还原，正常历史仍是一条动作；多块复制合并移动及重复undo/redo不重复投影。恢复包装时检测canonical owner是否已被外部原段落使用，为冲突槽位建立独立临时身份，不改原段落来源。

581项前端测试及TypeScript/双构建通过，无Rust修改，native二进制与上轮相同、不重复计历史原生测试。真实浏览器复制r7、原窗口撤销r8、迟到输入被拦、新Bob无历史窗口恢复r9、原窗口重做不重复；真实socket引用包装/撤销r10/r11、迟到新子段审阅及浏览器恢复r12均通过。r8/r11/r12实际native持久Yjs分别载入新Y.Doc；全部10条首次checkpoint200。逐份r6–r12、资源字节、业务/提及身份、Alice/Bob实际恢复actor、原段落ID/来源不变与独立引用ID，以及浏览器DOCX/无源HCD/DOCX/PPTX/PDF/MD验证通过。

见 [实现与复现](design/hcd-history-late-input-recovery.zh.md)、[实际文件](assets/hcd-history-late-2026-10-25/file-evidence.json)、[检查摘要](assets/hcd-history-late-2026-10-25/validation.json)。UI观察多次超时，按实际AX/head继续同窗，未重启服务或重复创建副本。wire仍5、离线规范不变；旧客户端需更新自身历史实现，旧版已缺失拓扑不自动修复。同段行内删除竞争、复杂跨树移动/owner并发、旧epoch、容量/压缩/GC、custom mark/可编辑行内容器及其余完整目标继续，管理平台与实际提醒仍后置。


### 2026-10-25：写作 AI 浮层与拖动目标反馈

AI 写作入口移至选区/光标附近，支持私有流式预览、接受/重试/丢弃，接通空行空格及 `/AI`。斜杠菜单增加描述、AI 分组和跳过禁用项的键盘导航。块拖动使用指针捕获，整行高亮、前后插入线及目标名称与松手提交共用位置计算；原位不创建内容事务，不损坏重做，文档/权限变化中止旧拖动。

591 项前端、TypeScript 和两种构建通过，无 Rust/协议变更。真实双窗口行前/行后移动、撤销、保存、可见反馈 DOM 及原位释放通过；AI 空格与 `/AI`、私有预览、接受/撤销、并发选区失效和斜杠键盘搜索确认通过。本地合成 AI，实际浏览器 r7 DOCX、稳定移动身份、无源 HCD 与 DOCX/PPTX/PDF/MD 顺序及私有建议排除通过。见[实现/复现/开放项](design/hcd-notion-writing-and-drag.zh.md)和[检查摘要](assets/hcd-notion-drag-2026-10-25/validation.json)。边缘连续滚动、复杂嵌套和长文设备验收仍开放；完整目标继续，管理平台和提醒发送仍后置。


### 2026-10-26：列表恢复与永久空项的保存目标修复

有序/无序列表新反例均显示可见快照2项、保存目标3项。`projectedChildren` 将可见遍历与永久拓扑分开，来源/owner检查和历史共享可见子树，恢复时仍预留永久项独立owner。595项前端、TypeScript及双构建通过；本批无Rust或wire改变。

真实Alice列表r2/撤销r3、Bob迟到富文本新项被拦、新无历史窗口恢复r4、另一离线输入令原空项重现并保存r5通过；原生持久Yjs三次独立回读，首次checkpoint全200，撤销保护/取消和无codec只读重开通过。r3/r4/r5原段落与原图规范块精确不变、新项ID稳定、旧项独立、资源字节和Bob提及actor正确且无重复事件；实际浏览器DOCX和无源HCD/DOCX/PPTX/PDF/MD通过，PDF整页检查通过。见[实现与范围](design/hcd-projected-list-recovery.zh.md)、[摘要](assets/hcd-list-recovery-2026-10-25/validation.json)。旧错误捕获自动修复、任意owner竞争及其余完整目标继续；管理平台、提醒发送仍后置。

### 2026-10-26：并发引用／列表与规范身份

八种并发转换反例先 RED 后通过。纯投影按永久原文载体分配有效 owner，分支独立保存；缓存随任何事务失效，活动事务不缓存。自己的逆操作只从可证明的同伴永久锚点恢复缺失位置，保留拓扑并重捕逆操作后隐藏基线；同伴修改保护继续生效。实际文件严格比较暴露原生重写丢 ol 的独立问题，现重建根 li 的列表容器／start，并保留旧独立 li 的显式编号。

606 项前端及 170 项相关原生测试、TypeScript／双构建／native 构建／相关 Clippy／fmt 通过。最终新 native 夹具真实 r2–r8、实际持久 r5/r8 签名与规范 digest、七条首次 checkpoint200、浏览器单次输入／undo／redo 精确相等、无 codec 重开及实际 DOCX／无源 HCD/DOCX/PPTX/PDF/MD 通过。负例与正式通过证据分开，未重启服务，也不代表真实 Office／生产验收。见[契约与复现](design/hcd-concurrent-canonical-owners.zh.md)、[检查摘要](assets/hcd-owner-race-2026-10-26/validation.json)。其余完整目标继续；管理平台和提醒发送后置。

### 2026-10-26：行内删除后的迟到属性和人员改目标

为单独删除的 atom 保留 root、精确基线、永久位置及相邻 occurrence；迟到 intent 重新打开右侧审阅，确认只认可当前内容，保存／当前导出统一拦截。恢复经协调器串行与 CAS 校验，实际操作者记入引用账本，并发点击不插入两份。自己的插入撤销在同一逆事务保留行内回执，已有同伴修改仍保护。真实测试暴露中间分隔文字被 splice 重建，现仅在证明纯 atom 移除时保留所有中间载体，失败夹具不算通过。

621 项前端、3 项相关原生门禁、TypeScript／双构建／native 构建／Clippy／fmt 通过。实际 r2–r7、持久 r3/r6/r7、六条首次checkpoint200、wire5同步前拒绝／21次原生版本门禁、并发恢复幂等、只读／epoch拒绝、浏览器二次确认取消／恢复保存、无codec重开及实际DOCX／无源HCD/DOCX/PPTX/PDF/MD通过。wire6要求配套升级，结构3/coordinator4/envelope2/mention1不变。语义、业务／block身份精确；既有Replace重建部分文字来源ID，完整规范相等不成立。见[契约及剩余范围](design/hcd-inline-deletion-review.zh.md)、[检查摘要](assets/hcd-inline-deletion-2026-10-26/validation.json)。服务器恢复的个人撤销、行内格式竞争、任意mark／行内容器、旧丢失数据、原稿保真、容量／多实例生产和完整目标其余验收继续；管理平台与提醒发送后置。

### 2026-10-26：结构来源保留与合法跨根转移

结构Replace保留可证明的inline来源；段落合并／拆分只能复用本批修改／删除根的来源，最终保持唯一，未改根及随机ID不能借用。前端保存捕获携带永久item范围和内容SHA，回执逐inline绑定；迟到插字／已删除atom不误领来源，来源补写不新增个人历史。只修native仍失败的独立夹具与各RED反例保留。

628项前端、core82／officecli159项及构建／相关Clippy／fmt通过。两个新真实socket夹具各六条首次checkpoint200；浏览器恢复／确认取消／保存r4/r7／实际DOCX／无codec重开通过。实际持久Yjs新Doc、签名／规范digest、r4.blocks == r6.blocks、未改文字及段落join／离线迟到文字／undo／redo来源身份、两个无源HCD全部版本与DOCX/PPTX/PDF/MD及整页PDF通过。见[契约与复现](design/hcd-structural-source-retention.zh.md)、[摘要](assets/hcd-source-retention-2026-10-26/validation.json)。协议未变；退役根、任意格式拆分、原始OOXML保真、在线恢复个人undo、容量／多实例／真实Office等仍有边界，完整目标继续，管理平台和实际提醒仍后置。


### 2026-10-26：自定义文字mark、动态注册与实际文件

格式型hcd.mark/1通过nodeExtensions.marks／registerMarks接入统一菜单与光标／选区命令，不复制正文。独立type格式键支持离线叠加；确定排序、幂等应用、混合选区限额原子拒绝和缺codec保护接通。未知内容的历史检查包含mark，加载codec后可继续原记录。原生保存fallback与普通格式分离；HCD保留数据，静态文件明确告知转换，HTML可保留嵌入数据。

638项前端、84core／160officecli及构建、相关all-targets Clippy／fmt通过。真实socket／浏览器r2–r10、九次首次checkpoint200、完整规范4=6／7=9／8=10、持久签名r6/r10、缺codec读取／历史保护、实际DOCX样式／HTML图片与载荷及无源HCD全历史、DOCX/PPTX/PDF/MD回读和PDF整页通过。实际npm pack消费端严格编译通过。wire7、customMarks模型1及旧wire／不声明模型／坏帧门禁已验证，head和原生Yjs字节不变。见[契约与复现](design/hcd-custom-text-marks.zh.md)、[摘要](assets/hcd-custom-marks-2026-10-26/validation.json)。可编辑行内容器、mark字段候选／迁移、HTML原生回导、复杂往返／注释定位、容量和其余完整目标继续；管理平台和提醒发送后置。


### 2026-10-26：mark HTML 回读、剪贴板与新段落来源

补齐原生正文 mark 元数据回导和受限 span 格式、剪贴板一致性校验、浏览器RGB颜色规范化。实际浏览器另复现并修复 fallback 被DOM重读为普通格式、新段落继承旧来源导致保存400两处问题。642项前端、53项hcd-formats及构建/相关Clippy/fmt/diff通过；新隔离夹具r1–r6、五条首次checkpoint200、r3/r5规范精确、实际HTML回导、DOCX样式、无源HCD各版本及DOCX/PPTX/PDF/MD回读通过。见[契约/复现/范围](design/hcd-mark-html-roundtrip.zh.md)。仅文字 mark 范围，不将更广HTML资源/业务节点、行内容器、容量、生产等其余目标标为完成；管理平台和实际提醒后置。


### 2026-10-26：行内容器原生基础（浏览器协同待接）

新增envelope3、独立inline正文子树、来源/mark/提及/资源遍历及模型门禁；未知业务版本仍可由native保存/导出，body不进业务JSON。347项相关原生单元测试与构建/Clippy/fmt/diff通过；隔离HTTP/CLI r1–r8、精确还原/无源各版本、资源字节、两层提及与格式文字回读通过。DOCX格式及PDF整页已核对；PPTX/MD格式降级明确标static。见[契约与证据](design/hcd-inline-content-native.zh.md)。未改前端广告或开放UI，永久共享载体/位置映射、历史/删除审阅及浏览器验收继续；其余原目标、管理平台/提醒后置约束保持。


### 2026-10-26：行内容器永久共享正文与位置内核

建立不把body藏入embed/data的内部Yjs载体，支持嵌套、空内容和父级/内部偏移转换。16项新增回归覆盖并发文字/格式、移动、自己的撤销、迟到输入保留、新Y.Doc回读、来源/mark和拒绝不改字节。旧投影读取器拒绝空text包装的新inline.content，wire7房间明确拒绝未接入的新模型。完整前端658项及TypeScript/独立/嵌入构建通过，无Rust修改。见[实现与证据边界](design/hcd-inline-carriers.zh.md)。活动结构/保存/属性/删除审阅与浏览器仍待接入，不据此声明协同容器已交付；完整目标、管理平台和提醒后置约束保持。


### 2026-10-26：组合文字流中的行内容器拆合

通过显式内部参数把独立正文接入SemanticTextFlow的组合adapter，支持PM/存储长度映射、拆段/合并后的父子书签及自己的正文历史；接缝首个引用的物理父级定位已修复。17项新增回归和675项完整前端、TypeScript/双构建通过；内部Yjs实际文件在销毁原Doc后回读并继续编辑。见[实现与证据](design/hcd-inline-flow.zh.md)。这不是活动SDK/UI、native checkpoint/导出或生产持久服务验收；来源捕获/回执、结构分配阶段、属性/删除审阅和其余完整目标继续。管理平台和实际提醒后置。


### 2026-10-26：递归来源绑定与内部正文摘要

来源树按各层实际Yjs范围捕获和回绑，正文新增字符/新身份副本不继承旧回执；同内容的撤销复活可独立重捕，wrapper边界不作为正文来源。语义摘要递归忽略来源ID但保留业务身份、正文/格式/结构，冻结v1和旧平面绑定保持，未启用模型的协调器拒绝version2。新增12项、全前端687项及TypeScript/双构建通过；无Rust修改或本批实际文件/浏览器验收。见[契约及明确边界](design/hcd-inline-source-bindings.zh.md)。空正文默认值、原生DTO/签名回执/结构绑定、事务精确位置、属性/删除审阅和原完整目标其余项继续；管理平台和提醒发送后置。


## 2026-10-26 文档异常页

统一打开、内容读取、草稿恢复和显示异常视图，提供 17 个稳定错误码、原因描述、问题详情与主动重试。已有草稿比较/固定布局画布保留原恢复和下载入口。详情见 [异常页设计与错误码](design/hcd-document-problems.zh.md)。696 项前端测试、TypeScript 与两种构建通过；本机故障代理验证 503 重试进入真实 DOCX，另核对 403/426/无效 JSON、多语言与显示异常恢复。管理平台仍不做。


## 2026-10-26 追加：行内容器原生转换与空正文默认值

内部 DTO/PM 编解码递归保留嵌套/空正文、mark、提及及带格式的换行；空正文的规范来源/字体默认值存入永久正文载体，回执不修改业务定义或个人历史。默认/活动模型仍拒绝，未开放 SDK/菜单。新增11项、82项专项与完整707项前端回归，TypeScript/双构建检查见报告。实际 source-free HCDZ r8 经前端转换/新 Y.Doc 文件回读、精确追加及 CLI 保存为r9，来源回执后完整规范含ID精确相等；新归档/资源和DOCX/PPTX/PDF/MD实际文件回读通过。见[契约、命令与验收边界](design/hcd-inline-projection.zh.md)。活动结构预分配/签名回执、全来源清理、属性/删除/历史/复制及配套协作仍继续；不是浏览器/生产验收，管理平台与实际提醒发送仍后置。


## 2026-10-26 追加：活动编辑器重复字符事务位置

普通同段单步替换从真实PM事务传递位置，不再由最终文字的公共前后缀猜测。UTF-16/保留字符预检先于共享修改和分配；原始item、光标、来源回执和迟到同伴输入保持关联。13项新增、57项专项与完整720项前端、TypeScript/双构建通过；真实wire7离线socket及native r2–r7、浏览器r9–r11、签名持久文件、严格规范相等、浏览器DOCX与无源HCD全部版本/四格式文件已验证。见[实现、复现和开放项](design/hcd-transaction-text-positions.zh.md)。首份浏览器QA中未归因的额外结构变更单独保留，未计作通过；多步/IME/行内容器位置、容量与原完整目标仍继续，管理平台与实际提醒后置。


## 2026-10-26 追加：多步文字事务与相同文字替换

活动结构绑定按各步骤的真实位置处理跨段纯文字替换，完整预检先于共享写入。最终文字相同的删除重插仍保留身份变化，并重新定位远端选区；容量拒绝保留原文/草稿，允许继续小操作。17项新增、74项专项、完整737项前端及TypeScript/双构建通过。真实双端连接/native r2–r8验证离线合并、程序化组合输入、双方自己的撤销重做、同文字身份变化持久化与下一次同伴输入落点；签名/规范摘要、无源HCD全版本及四格式实际文件通过。见[实现、复现与边界](design/hcd-multi-step-text-edits.zh.md)。真实操作系统IME、长文本性能、活动可编辑行内容器/SDK等继续，管理平台与提醒发送后置。


## 2026-10-26 追加：行内容器结构预分配与递归回执

内部SemanticBlockStore显式接入永久正文，整次多根预检/再次校验后分配空载体；新父段只种引用，正文修改留在个人事务，移动到新段同时改字的undo可正确恢复。全局实例冲突、模型声明/旧wire拒绝、正文外来字符历史检查、递归/空正文来源回执和隐藏正文失效来源清理接通。17项新增、71项专项、完整754项前端及TypeScript/双构建验证；实际无源r8副本经结构reconcile/精确undo-redo/CLI保存r9/完整来源回执和新Doc文件回读，HCDZ/资源及四格式文件通过。见[契约、复现与边界](design/hcd-inline-structure.zh.md)。尚非活动binding/签名room/SDK/UI；行内容器从保留根删除先明确拒绝，需专门审阅/恢复。精确正文事务、属性/复制/缺codec保护、配套协作和其余原目标继续；管理平台和实际提醒后置。


### 2026-10-26：Word 纸张编辑入口与工作区清理

已将 flowLayout2 的页眉/正文/页脚合到纸张中，双击编辑；默认收起节导航，纸张外引导与重复工具移入顶部操作区、底部状态栏。跨节保留共同缩放，显示源纸张类型与方向，协作记录节内物理页。见 [纸张 UI 与证据](design/hcd-word-paper-ui.zh.md)。区域富文本服务端 checkpoint5 已有原生守卫与测试，浏览器/sidecar 尚未接入，见 [契约及边界](design/hcd-word-checkpoints.zh.md)。

仍待：跨节连续分页和超长节虚拟化、缺失页眉页脚创建及链接设置、页码/自动目录、完整区域 CRDT 富文本与命令菜单。管理平台继续暂缓。


### 2026-10-26：Word 区域富文本与持久化准备日志

新增区域模型、现有 ProseMirror 事务适配和 HMAC 压缩准备日志。实际原生 HTTP 验证正文/页眉/页脚联合保存，提交成功后断开 TCP 响应，另一个 Node 进程从磁盘按原请求重放，保留后续输入和作者代次；DOCX/HCDZ、图片字节、字段缓存与离线历史通过回读。全部 783 个前端测试和生产/嵌入构建通过。详情见 [区域协作与启用门槛](design/hcd-word-regional-collaboration.zh.md)。完整区域 coordinator、房间迁移及浏览器富文本入口仍待接入，管理平台和实际提醒继续暂缓。


### 2026-10-26：区域保存协调器核心及人员引用账本

区域保存已从验证脚本中的步骤提取为服务端 `WordSaveCoordinator`：统一自动/手动队列，准备日志先于规范请求，核验签名 patch 与内容，保留保存期间输入，处理日志失败、未知结果、作者代次及提及账本。实际断 TCP 响应、不同 Node 进程恢复、一次提及事件/后续正文不重复、DOCX/HCDZ 与图片字节通过验证；全部 800 个前端测试和生产/嵌入构建通过。见 [实现及待接入部分](design/hcd-word-save-coordinator.zh.md)。房间协议/迁移、逐包鉴权、区域图片意图和浏览器入口仍待完成；管理平台与实际提醒保持暂缓。


### 2026-10-26：区域图片与正文联合保存

区域协调器接入图片意图、不可变基线、已上传替换图、逐区域来源归属和图片 capture 私有日志。真实暂存上传/正文与页眉页脚/图片一次 r2 提交，丢 TCP 响应后另一个进程恢复，迟到文字与尺寸保留为 r3；实际 DOCX 关系目标/图片字节/最终尺寸、HCDZ 历史和提及事件去重通过回读。34 项协调器/日志专项及全部 811 个前端测试通过。见 [实现、复现与边界](design/hcd-word-regional-images.zh.md)。上传中资源租约、Hocuspocus 协议/逐包身份、浏览器区域富文本仍继续；管理平台与实际提醒暂缓。


### 2026-10-26：区域上传预留与中断恢复

服务端区域 owner 现在在上传期间保留 pending 和私有签名记录，上传/核验/应用分阶段落盘，取消或超时不会被迟到响应复活。成员身份核验和成员上传 transport 是显式依赖，协作服务不能绕过原生资源路由权限。真实上传成功后断 TCP、不同 Node 进程恢复、原生 GC 后原文件核验、原成员显式应用且不重复上传，以及后续联合保存/DOCX/HCDZ 通过验证；47 项协调器/日志及全部 824 项前端检查通过。见 [实现、复现与边界](design/hcd-word-upload-lifecycle.zh.md)。区域房间/epoch/逐包身份、浏览器上传关闭与恢复界面、多实例所有权仍继续；管理平台和实际提醒暂缓。


### 2026-10-26：区域房间协议与真实双端接入

本机 sidecar 在显式开关下支持 `hcd-word-regions/1` / `wordregions1:save5`，默认关闭。区域 guard 在写入前检查协议、边界、来源、只读块、服务端 metadata 和未解析依赖；协调器绑定精确签名宿主状态，接入保存/状态/onStore/drain 生命周期。实际双 WebSocket 与 native 验证联合保存、个人文字撤销保留同伴输入、异常包拒绝、sidecar 重启、只读/撤权与 epoch 隔离，DOCX/HCDZ 全版本回读通过；835 项前端测试通过。见 [实现与启用门槛](design/hcd-word-room.zh.md)。当前是显式初始化的合成文档与单 sidecar，旧用户文档迁移、跨实例租约、上传接口和浏览器区域切换仍待完成；管理平台与实际提醒暂缓。


### 2026-10-26：区域房间本机所有权和日志链保护

增加原生服务租约与 OS 锁，防止共享本地根目录的进程同时接管同一文档/epoch；租约同时绑定认证恢复存储与完整签名日志祖先，不能只复制身份而漏掉未提交内容。sidecar 续租/日志确认串行、提前本机到期，失效后冻结连接、阻止迟到确认并另存恢复快照。相同历史快照可确认，不同内容仍须显式恢复审阅。847 项前端、72 项原生服务筛选、TypeScript/双构建与静态检查通过；两个原生进程/四个 sidecar 实测竞争、暂停到期、草稿接管、旧进程恢复隔离与缺日志拒绝，DOCX/HCDZ 回读通过。见 [实现、实际验证和限制](design/hcd-word-room-ownership.zh.md)。需要固定原生实例路由，尚非远端数据库/S3 或跨主机所有权；旧文档迁移、浏览器富文本与恢复界面、长文和原完整目标继续。管理平台与实际提醒暂缓。


### 2026-10-26：区域草稿恢复审阅与可保全选择

不同签名快照不再只有阻断：服务端可按区域比较、预览真实因果合并，并以当前日志/恢复集合绑定的选择记录保留当前或合并。独占租约、两次成员核验、原作者/提及证明和上传中断保留接通；未知结果使用同 requestId 核对，恢复副本不删除。独立审阅组件通过中文/英文、只读禁用、确认/取消焦点、合并和审阅后下载验证；随后真实 Socket 保存、DOCX 精确正文/页眉页脚/图片及 HCDZ r1/r2 回读通过。完整 865 项前端、TypeScript 和构建通过；见 [审阅契约与证据](design/hcd-word-recovery-review.zh.md)。当前组件在隔离入口验证，主纸张富文本绑定和旧文档迁移仍待接入；跨基线/未确认请求恢复、图片可视比较、日志 GC、远端与原完整目标继续，管理平台和实际提醒暂缓。


### 2026-10-26：区域富文本浏览器、设备恢复与原位协作

显式区域协议现在路由到真实嵌入富文本入口，正文/页眉/页脚共用房间与个人历史；统一菜单、选区浮层、服务端 @、链接、图片尺寸和右侧定位/跟随接通。本机副本区分收到的同伴更新与自己产生的更新，新连接先比较再恢复自己的内容；断线旧实例冻结。保存增加状态序号、不可变原生投影屏障和确认后的图片摘要核验。真实双端、只读成员、断线恢复、DOCX/HCDZ 回读见 [实现与边界](design/hcd-word-browser-regional.zh.md)。仍为显式初始化的合成文档验证，旧文档迁移、精确分页/长文、区域换图上传恢复、自定义扩展和 AI 等原目标继续，管理平台/实际提醒暂缓。


### 2026-10-27：区域换图的浏览器预留、恢复和个人历史

实际区域嵌入入口开放换图：本机元数据先于服务端预留，预留先于字节；成员受权上传、精确恢复、取消记录、待处理列表与保存/导出门禁接通。真实半段 HTTP 取消、浏览器错误文件校验、设备记录与服务重启、新窗口恢复后保存前个人撤销、r4 原图/r5 重做、新旧资源和 HCDZ 全历史回读通过；898 项前端与双构建通过。见 [链路、接口、证据和边界](design/hcd-word-upload-browser.zh.md)。旧 epoch/房间迁移、被撤权成员选择审阅、长文分页和区域扩展/AI 等原目标继续；管理平台/提醒投递暂缓。


### 2026-10-27：Word 区域 AI 与灰字补全

正文、页眉、页脚复用现有 Provider、私有建议控制器、Notion 弹窗、统一命令和可选自动补全；控制器绑定准确区域和视图，切换或权限失效时取消，接受后进入个人历史/协同/联合保存。真实双写端与只读端验证私有建议、页眉页脚接受、个人撤销保留同伴、同伴修改导致失效、斜杠/空格入口、r5 未接受灰字不导出及 r6 Tab 接受。900 项前端、TypeScript/双构建通过，实际 DOCX 和浏览器 HCDZ r0–r9 回读通过。见 [实现与证据](design/hcd-word-ai-regional.zh.md)。Provider 为本机确定性测试服务；区域 PDF/MD/HTML 仍明确不支持，未作成功声明。旧迁移、区域扩展、精确分页及原完整目标继续；管理平台与真实提醒暂缓。


### 2026-10-27：区域行内节点、资源和富文本块

区域编辑器接通既有节点注册、统一插入入口、属性/资源/冲突面板和可编辑子块。补齐本地业务冲突门禁、资源上传期间的保存/关闭保护和精确业务作者观察值，并修复真实块原子节点保存后的默认格式回执差异；原 r3 在服务恢复后核对成功，没有重复提交。905 项前端及最终双构建通过；真实双 Socket 字段合并、个人撤销保留同伴、同字段候选阻断、浏览器显式选择及其撤销重做、缺扩展写成员保全、页眉节点、实际 DOCX/浏览器 HCDZ r0–r10 回读通过。见 [实现与证据](design/hcd-word-nodes-regional.zh.md)。未完成节点文件选择的跨重启账本、旧迁移、精确分页/长文、区域其他导出和原完整目标仍继续；管理平台和实际提醒暂缓。

### 2026-10-27：区域节点文件选择的持久恢复

节点文件先写本机字节日志再归档，重开提供定位、继续、核对原/现目标后关联和取消；未完成日志接入保存/关闭/导出门禁。取消终态防止慢响应复活，关联仍通过正常命令、协同和个人历史。914 项前端测试、最终 15 项专项及构建通过；真实双成员浏览器 r3 失败保留、r4 同伴属性、r5 恢复关联、r6/r7 个人撤销重做，以及实际 DOCX/HCDZ r0–r7 校验通过。详见[契约、复核与剩余范围](design/hcd-word-node-resource-recovery.zh.md)。普通语义入口推广、跨设备、旧房间与精确分页等仍开放，管理平台和提醒发送暂缓。

### 2026-10-27：普通语义入口的节点文件恢复

复用同一资源状态机，抽取共享设备元数据操作；普通文件日志独立于正文副本，重开/分叉仍能恢复。所有保存与迟到回执、关闭/窗口化、还原/房间交接和导出检查接统一任务门禁，设备备份包含未完成原始字节。919 项测试、20 项专项和最终构建通过；普通 Word 双成员浏览器 r2–r6、取消慢请求、七格式实际文件及浏览器 DOCX/HCDZ 回读通过。HTML 浏览器接口可导出，但 CLI 无源 HTML 仍明确不支持，未混为同一结果。详见[契约、证据与继续范围](design/hcd-semantic-node-resource-recovery.zh.md)。管理平台、提醒发送与原剩余目标仍后置。

### 2026-10-27：无源独立 HTML 导出

CLI 与浏览器鉴权 HTML 导出共用保存版本、节点快照和资源内嵌逻辑；新增大资源展开预算，保留预览默认限制，只改实际 URL 属性，不改正文或惰性业务数据。独立 HCDZ 的 r2–r6 CLI/HTTP 文件完全一致；6 MiB PNG 经正常暂存/换图后完整内嵌，原生服务停止后浏览器仍可解码。区域文档继续拒绝，失败不覆盖已有文件。307 项 Rust/CLI 检查、Clippy/fmt/构建通过，详见[契约与证据](design/hcd-standalone-html-export.zh.md)。原七阶段与此前所有未关闭要求继续，管理平台和提醒投递后置。

### 2026-10-27：Word 区域独立 HTML 与未呈现附件

区域模型 2 的 CLI/鉴权 HTTP/编辑器现在支持保留分节纸张、页眉页脚变体及规范节点载荷的独立 HTML，补齐没有 HTML 编码器时节点资源只留描述却漏掉字节的问题。9 份历史/多页导出逐字节核对、停止原生服务后的 15 页/130 段落、继承/页号重启、超长块及失败恢复验证通过；532 项相关 Rust/CLI 与 Clippy/fmt 通过。附件 data URI 字节已验，内置浏览器下载落盘未捕获；精确 Word 分页、区域其他格式、迁移和原完整目标继续，管理平台/实际提醒仍后置。见[实现、证据与边界](design/hcd-word-html-export.zh.md)。

### 2026-10-27：可编辑行内正文的精确事务绑定

将已有内部行内容器载体接入真实 PM 文字事务：按父/子正文实际存储坐标预检整批步骤，保留重复字符身份、内部光标和个人历史。12 项新增及完整 930 项前端、双构建通过；隔离浏览器两编辑器断开输入/合并/撤销保留同伴及原字符、无源 r8→r9 原生保存/完整来源回执/HCDZ 与四格式实际文件回读通过。见[实现、证据和开放边界](design/hcd-inline-binding.zh.md)。尚未启用活动签名房间、公开 SDK、属性/删除审阅；旧协议门禁与原完整目标继续，管理平台和提醒发送后置。

### 2026-10-27：行内正文内部签名保存与递归提及作者

协调器显式模式现可保存嵌套/空行内正文，签名基线与捕获绑定模型；来源捕获先通过恢复边界才提交，递归人员作者账本覆盖内部提及。9 项新增与完整 939 项前端、TypeScript/双构建通过。真实鉴权 HTTP r8→r9 提交后断 TCP、另一 Node 进程恢复签名来源树/迟到输入为r10、原请求不增版重放、只读/旧模型拒绝、一次嵌套提及事件及八份四格式实际文件/HCDZ/资源核对通过；见[实现与证据](design/hcd-inline-save.zh.md)。活动房间、属性/删除/复制、缺codec视图及公开SDK仍继续，管理平台与提醒发送后置。

### 2026-10-27：行内容器属性与正文独立协同

复用统一因果字段协议，增加独立内部属性候选、冲突选择、个人撤销、保存门禁和隐藏根迟到属性审阅；永久定义/正文载体不重写。12 项新增及完整 951 项前端、TypeScript/双构建通过；实际原生 HTTP 冲突阻断、r9 丢 TCP 响应/另一进程恢复迟到属性与正文为 r10、八份导出和无源 HCDZ/资源核对通过。见[实现与边界](design/hcd-inline-properties.zh.md)。活动房间、公共 SDK/面板、包装器删除/复制、迁移及原完整目标继续，管理平台与提醒发送后置。

### 2026-10-27：可编辑行内容器删除审阅

复用行内审阅协议增加容器回执、嵌套恢复、迟到正文/属性审阅、协调器串行恢复及个人历史保护，修复实际恢复保存暴露的隐藏正文旧来源 ID 未退休问题。15 项新增及完整 966 项前端通过；实际原生 r9 删除/丢 TCP 响应/另一进程恢复审阅/并发恢复一次/r10 保存、八份导出与 HCDZ/资源回读见[实现与验证](design/hcd-inline-deletion.zh.md)。公共 SDK、活动房间、缺 codec 视图、复制/迁移及原完整目标继续；规范 HCDZ 未包含待处理 Yjs 协作状态，跨设备恢复仍须补齐。管理平台与提醒发送后置。

### 2026-10-27：语义协作离线恢复包内核

新增独立恢复包内核，携带规范 HCDZ、待处理 Yjs/删除审阅、保留候选资源及未完成节点文件原始字节；强制规范校验和隔离候选读取，不自动合并房间。12 项新增及完整 978 项前端、双构建与 TypeScript 通过；实际文件→独立进程→签名恢复/r10 保存、八份导出、服务关闭后的纯离线读取见[实现与边界](design/hcd-semantic-recovery-archive.zh.md)。编辑页导入导出/比较确认、跨设备任务绑定、固定/区域恢复包和原完整目标仍开放，管理平台与提醒发送后置。


### 2026-10-27 编辑页恢复包比较与确认增量

普通 structure3 编辑页接入真实文件导出、隔离比较和确认合并；当前修改使旧比较失效，确认前重新授权，导入是一条个人历史动作。未完成节点文件保留私有字节并逐项处理，同包重试不复活终态取消。987 项前端、双构建、3 项原生接口测试、Clippy/格式及真实双人浏览器/r4/八种文件和离线附件验证见[实现与边界](design/hcd-semantic-recovery-ui.zh.md)。其他模型/旧 epoch/不同文档迁移、全部图片任务、公共行内容器 SDK/房间、长文和原完整目标仍开放，管理平台与提醒投递后置。


### 2026-10-27 行内容器宿主 SDK 与只读视图增量

新增独立包入口的注册器、受限导出/资源描述/迁移预览、保留正文的 NodeView 与当前 codec 历史保护。修复内层 contenteditable 产生第二焦点根；注销、重载、来源回执、宿主只读与恢复均保留正文载体。9 项新增及完整 996 项前端、双构建、实际包类型/运行时消费者、本机双视图和原生 r8→r9/四格式/HCDZ 附件历史验证见[宿主接口与证据](design/hcd-inline-host.zh.md)。暂缺新身份处理的容器 HTML 粘贴整次拒绝，避免静默降成纯文本。主编辑页/房间协商、统一菜单/属性/恢复、复制迁移、内部 AI 目标、长文和原完整目标仍继续；管理平台与提醒投递后置。


### 2026-10-27 行内容器复制与剪贴板增量

独立宿主模型 3 已接通递归副本、来源/提及新身份、结构剪贴板、HTML、剪切和明确的纯文本粘贴；部分正文保持新包装，解析或 PM 适配丢失业务节点时整次拒绝。9 项新增及完整 1005 项前端、双构建、真实双视图剪贴板/个人历史和实际包消费者/原生 r8→r9/四格式/HCDZ 附件与新来源验证见[实现与边界](design/hcd-inline-clipboard.zh.md)。主编辑页/房间/恢复协商、统一菜单、跨文档资源传输、迁移提交、内部 AI 目标、长文和原完整目标仍开放，管理平台与提醒发送继续后置。

### 2026-10-27：当前能力矩阵与 Excel 保存恢复一致性

新增[当前能力矩阵](design/hcd-current-capabilities.zh.md)，保持原完整目标和后续顺序。Excel 映射单元格接入既有设备快照、精确联合请求与不可变回执，保存/导出移入操作区，补齐冲突选择和受检个人历史；已审阅旧副本的纯远端刷新不再复活待恢复状态，新本机输入仍可发现。规范附件恢复改为读字节核验后复用，未发布资源保留暂存；附件字段变化不会强制丢弃本机属性表单。完整 1118 项前端通过，真实双人/只读浏览器、实际 XLSX 和 HCDZ 以及 native 附件复用见[实现与分层证据](design/hcd-workbook-save-recovery.zh.md)。类型/双构建以专项日志为准，未跑新 Rust 全量。输入缓冲异常恢复、批量历史、Excel 完整编辑/命令/协作、附件交互慢及原剩余范围继续；管理平台与实际提醒不做。

同批最终复核：单元格 canonical revision 防止旧本机回执遮住较新远端值；设备审阅标记独立保存、v1→v2 保留分支且关闭旧连接，写入与 flush 顺序受检。1123 项前端、TypeScript/应用/嵌入/独立 XLSX 构建全部通过。实际 r0–r12 的 13 份 XLSX、HCDZ、双人个人撤销/同格保护、只读下载及重开无重复恢复提示通过；证据见 `docs/assets/hcd-workbook-recovery-2026-10-27/validation.json`。原完整剩余目标保持开放。

### 2026-10-27 Excel 未完成输入与批量历史

单元格未确认输入增加私有缓冲及显式恢复；确认前重新核验权限和版本。多格操作按一次动作撤销/重做，受保护目标及同格协作冲突阻止整组操作。完整前端 1136 项通过，双人浏览器与实际 XLSX/HCDZ 回读见[实现和边界](design/hcd-workbook-input-batch.zh.md)。真实进程崩溃、输入法、复杂剪贴板及容量仍未验收，附件交互慢和其余格式能力继续；管理平台与实际提醒暂缓。

### 2026-10-27 附件定位相关工具栏性能

采样发现工具栏逐按钮重复重建编辑上下文，改为一次列表按标签页过滤；命令执行仍实时复核授权。隔离样本中实际完成上传失败、定位、继续、关联、保存和重开，原生及离线包回读通过。1137 项前端及应用/嵌入构建通过；性能采样与范围见[专项记录](design/hcd-resource-interaction-performance.zh.md)。其他可能的超时原因和规模压力仍待验收。

### 2026-10-27 固定版式恢复比较分页

草稿比较可分批查看全部文字对象、展开长文字并分批展示图片候选；切页发现新版本时提示重新核对，恢复前仍检查版本和权限。隔离 Excel 样例实际验证 13 格、长文字、协作者同格冲突、XLSX 与离线包回读，完整 1138 项前端通过；[记录与边界](design/hcd-recovery-review-pages.zh.md)。大量图片及其他固定格式的浏览器场景仍待验收。

### 2026-10-27 固定图片恢复比较和源导出预检

恢复比较按 revision 对照本机与服务端图片几何和预览，副本变化使用专用错误码。实际双人 PPT 图片冲突恢复保存 r2、PPTX 与 HCDZ 回读通过；源文件图片改写尚不支持，新增与实际导出共用的版本预检，浏览器提前禁用并提示语义重建或 HCD 归档。1139 项前端、双构建、原生构建及 common 两项专项通过，详见[证据与边界](design/hcd-recovery-images-export.zh.md)。Word 分节布局编辑和原完整目标继续；管理平台与提醒暂缓。

### 2026-10-27 Word 页眉变体绑定状态

修复旧分区属性栏将同一 story 的直接绑定与继承状态混为一谈的问题，按默认页、首页和偶数页分别显示。隔离 DOCX 样例在浏览器显示第二节默认页链接前节而首页独立绑定；语义 DOCX 关系和 HCDZ 历史回读通过。1139 项前端与 10 项专项通过；页眉创建、链接编辑、纸张设置及事务接入仍开放，实施约束见[Word 布局编辑计划](design/hcd-word-layout-edit-plan.zh.md)。

### 2026-10-27 Word 分节字段意图规划器

新增纯内存布局字段意图和原值验证；分节拓扑一致时保留不同字段的并发更改，同字段冲突整批拒绝，未设置值不会被预设值替代。核心库 104 项测试、Clippy 及实际导入投影只读检查通过。尚未接入协作、签名提交、恢复、编辑界面或导出，纸张设置仍不可用；详见[实施计划与验证](design/hcd-word-layout-edit-plan.zh.md)。

后续新增原生布局版本事务与独立历史校验；隔离样例验证 r4–r6、幂等重放、冲突拒绝、DOCX 纸张字段和 HCDZ 回读。尚未接入房间授权、签名协调器、客户端或界面，不可作为用户可用的纸张设置；见同一实施计划。

补充 r7 真实语义 DOCX 导出和重新导入验证方向、页边距、首页/奇偶页及页码设置；修正历史校验对非布局资源索引顺序的敏感性。核心库 104 项、Clippy 和原生构建通过。精确分页、页码重算与在线接入仍开放。

区域 store 增加内部受检布局回执接收，保留协作文本和个人历史，并拒绝拓扑及未知字段改变；当前编辑器拒绝打开尚未协商的布局版本。完整 1141 项前端测试、TypeScript 与应用/嵌入构建通过。尚未接入协调器/在线协议、布局编辑 UI 或真实双客户端，详情见同一实施计划。

服务端进一步对新版布局 head 加入旧编辑协议门禁，保留历史读取；实际原生事务样例验证旧 checkpoint、最新投影、文字编辑、图片、批注与修订入口拒绝且不新增版本，6 项区域 checkpoint 测试通过。这是进程内服务验证，布局在线写入及旧部署隔离仍开放。

追加隔离原生 HTTP 验证：旧 checkpoint/最新投影/图片/批注返回 426，历史投影和授权 DOCX 导出可读，未授权导出拒绝，manifest 和归档校验不变。布局在线保存、签名日志及旧部署隔离仍未完成。

追加显式启用的签名日志版本 2，保存布局请求与区域草稿，未知结果时阻止替换或清除请求；旧读取器、现有协调器和恢复审阅拒绝该版本。重启、迟到输入和无效/覆盖拒绝的本机测试、完整 1142 项前端回归及 TypeScript/双构建通过。尚未连接在线提交、回执处理、实际网络故障或编辑界面，见布局实施计划。

追加布局请求和原生版本记录的精确摘要匹配；实际 r5/r7 样例验证 Rust/TypeScript 摘要一致，包括 Unicode 作者及多字段请求，完整 1143 项前端测试通过。摘要本身不是签名或服务端真实性证明，在线回执及用户界面仍未接入。

追加只读原生布局签名回执查询，绑定版本、请求、作者、代次和 owner 登记的日志 hash。隔离 HTTP 的签名经 Python 和 TypeScript 核对，错误请求/租约、普通成员和未认证请求被拒绝；原生专项、前端专项和 Clippy 通过。日志内容仍由协调器负责，HTTP 样例使用合成 hash；在线写入、丢响应恢复、真实多人及页面设置 UI 仍未完成。

区域布局回执增加逐字段内容核验，拒绝未请求的页面设置变化；实际原生 r4→r5 和 r6→r7 投影通过对照，额外高度变化拒绝，区域与日志专项 29 项、完整 1143 项前端回归和 TypeScript/双构建通过。投影鉴权、日志推进和在线协调器仍待接入，详见布局实施计划。

新增停止房间时的布局回执日志推进：验签、固定版本正文及逐字段布局后在独立 Y.Doc 写入新签名基线，保留迟到输入；错误回执或租约失效不清除原请求。真实原生 HTTP 回执及签名日志在三个本机进程间验证，重开保留页眉输入；完整 1144 项前端回归与 TypeScript/双构建通过。调用方仍须提供已认证投影和停止房间/租约保护；回执持久审计、owner 新 tip 确认、在线协调与多成员 UI 仍开放。

追加回执持久审计：确认快照保留签名回执和原请求，重开重新验签并校验真实日志父节点，错误父节点即使带有效签名仍被拒绝。隔离 HTTP 测试主动登记并重复登记新 tip，owner 结果一致；完整 1144 项前端测试、TypeScript 和双构建通过。这尚未接入正式协调器或模拟 TCP 响应丢失，在线多人及 UI 继续开放。

新增停止房间后的内部布局恢复协调流程，并由受租约保护的回执接口提供固定新投影。真实本机 HTTP 和独立 Node 进程验证：owner 记录成功后由测试传输模拟丢失响应，后继 owner 重新登记已确认日志而不重复查询回执，迟到页眉输入保留。完整 1145 项前端回归、权限撤销专项、TypeScript、原生专项和 Clippy 通过。此流程尚未接入活动房间、实际 TCP 中断或浏览器 UI，详见布局实施计划。

追加 owner 记录响应的真实 TCP 中断验证：代理确认原生服务成功记录新 tip 后关闭下游连接，独立回读服务端绑定，再由另一 Node 进程接管同一签名日志，保留迟到页眉且不重复查询回执。该样例尚未覆盖布局提交响应丢失、进程强杀或活动多人房间。

新增仅供布局感知 `/2` 协调器使用的原生布局提交入口；旧协议、无租约及普通成员拒绝。隔离 HTTP 样例使用真实签名准备日志，验证布局提交和 owner 记录两次 TCP 响应丢失、原请求幂等重放、迟到页眉草稿恢复、DOCX 纸张宽度和 HCDZ。`/2` 尚无公开迁移、可用正文 checkpoint、活动多人房间或浏览器 UI，纸张设置仍未开放。

### 2026-10-27：停止房间的布局请求续提

增加内部 `submitPreparedWordLayout`，恢复已持久化但结果未知的布局请求：基线 root、权限、epoch 和 owner 日志校验通过后只提交原请求；规范头已前进则走签名回执核对，不盲目重提。专项覆盖提交前后模拟断线、重新打开日志、错误基线、版本变化和活动房间拒绝。尚未接入活动房间或 UI，本增量未做真实 TCP 验收；原目标与管理平台/提醒边界不变。

后续补充本机真实 HTTP 验证：直接调用该续提函数，原生提交后切断 TCP，另一 Node 进程接管并通过签名回执恢复，规范头不重复增长、迟到页眉草稿保留，DOCX 纸张宽度和 HCDZ 校验通过。旧 `/editor` 在布局版本上仍拒绝读取；活动协作、迁移及 UI 未接通。详见[布局计划](design/hcd-word-layout-edit-plan.zh.md)。

后续新增 `/2` 协调器受租约保护的布局 head 投影读取，旧客户端和普通成员仍被拒绝，缺租约或旧 epoch 不能读取；默认读取固定检查时的 revision。活动正文 checkpoint、迁移与 UI 仍未接通，见同一计划。

后续补充 `/2` 原生正文 checkpoint，使用独立签名版本及布局、作者、租约校验；隔离 HTTP 验证布局提交后联合保存正文和页眉页脚、精确重放、DOCX 和 HCDZ。新增块可改变分节锚点和布局哈希，客户端须接受回执重绑定。该调用尚未接入活动协调器或客户端签名日志，未完成 checkpoint 丢响应恢复与 UI，详见同一计划。

后续增加布局感知签名日志版本 3，只有已核验布局回执可无损转入，正文待提交请求与基线不可替换或清除，迟到输入可保留；隔离 HTTP 验证实际原生 `hcdsave6` 签名。正文回执确认、图片/来源重绑定、断线恢复、活动房间和 UI 仍待完成。

随后补充停止房间正文回执确认，检查签名、基线、规范内容和分区，在隔离草稿中重绑定来源、布局与已捕获图片意图。实际原生 HTTP 无图片样例验证回执确认、签名日志重开及捕获后的页眉输入保留，错误基线/正文/布局/图片回执拒绝。含图片场景和正文断线重启尚未验证，活动协调器及 UI 仍未接通。

随后增加停止房间正文请求恢复，隔离无图片 HTTP 样例实测提交和确认后 owner 登记两次 TCP 响应中断，后续独立进程精确重放/接管并保留迟到页眉。含图片、无变更回执、活动房间、UI 及跨主机继续开放，详见布局计划。

后续在含页眉图片的隔离 DOCX 验证相同两次中断：成员上传替换图片、联合提交文字和尺寸，重启后校验固定版本图片与实际 DOCX 替换字节及尺寸；捕获后的再次缩放留在未提交草稿。无变更回执、迟到图片的后续保存、活动房间、UI 和跨主机仍开放。

随后将迟到页眉与图片缩放作为新的 checkpoint 保存，核对最终 DOCX 文字、替换图片和尺寸，以及离线 HCDZ 投影/图片状态；版本 3 草稿没有回执时禁止改变基线。此流程仍由隔离测试协调，活动多人、无变更回执、UI 和跨主机保持开放。

随后补充 `/2` 无变更请求的签名回执与停止房间恢复：本机真实 TCP 丢响应后由独立进程重试，核验原请求、日志与版本，确认 pending 且不新建版本；活动房间、UI、跨主机及原完整目标仍开放。

随后统一恢复与既有 Word 协调器的草稿归属指纹，确认时只退休已捕获作者代次并保留迟到作者；未绑定内容不会被回执赋予身份。隔离原生 HTTP 图片样例覆盖不同作者、相同作者较新代次及未绑定输入，作者身份由测试构造，真实多人鉴权仍需验收。

### 2026-10-28：Word checkpoint 完整请求证明

新增只读原生签名回执，绑定完整传输请求与版本、租约日志和 root，恢复前验证；无变更回执升级到 `/2`。隔离 HTTP 验证更换作者/区域/引用/图片字段被拒绝，以及图片和无变更断线恢复。旧实验性 `/2` 确认日志不兼容、需单独迁移；活动房间和 UI 尚未启用，见[布局计划](design/hcd-word-layout-edit-plan.zh.md)。

后续补充日志发布后的栅栏检查：异步硬链接/同步期间所有权失效会报告记录已发布，由后继 owner 重读，不再误认为可以重写旧父节点。活动房间仍需解决发布期间的消息和图片合并，尚未启用。

### 2026-10-28：Excel 已写入输入缓冲的浏览器终止恢复

独立 Chrome 中，B1 未确认输入写入 IndexedDB 后强制终止进程组；重启后比较本机与服务端内容，确认恢复并正常保存至 r1。实际 XLSX 的输入、其他单元格和公式缓存及 HCDZ 解包校验通过；复现脚本、截图及限制见 [Excel 输入与恢复](design/hcd-workbook-input-batch.zh.md)。这是同机合成样例，不代表系统断电、真实输入法或跨设备恢复已验收；完整目标、管理平台及提醒的原有边界不变。

### 2026-10-28：语义恢复的多附件批量核验

普通语义恢复中的附件由串行调整为每批最多四项并行核验/暂存，批次之间重新检查写入权限和文档快照，最终仍经服务端授权后才合并。异常等待当前批次结束，不启动后续批次或合并；规范资源复用仍核验真实字节。新增专项覆盖并发、文档变化与失败，完整前端 1150 项及 TypeScript、应用/嵌入构建通过；主页面交互慢的根因及真实浏览器性能仍待测量。见 [保存恢复记录](design/hcd-workbook-save-recovery.zh.md)。

### 2026-10-28：浏览器重复导入附件复核

同一隔离协作样例的主页面两次导入恢复包；第二次确认合并期间观察到两个规范资源读取、零个归档写请求，仍只有一个待处理文件，定位显示正确当前节点，版本保持 r27。浏览器请求观察和截图见 [恢复包验证](design/hcd-inline-resource-recovery-ui.zh.md#2026-10-28重复导入浏览器核验)。后续修订页签点击仍出现自动化超时但动作生效，未找到交互缓慢根因；真实设备与不同资源状态仍需继续。

### 2026-10-28：区域日志发布后的所有权冻结

现有区域协调器在日志已发布后发现栅栏失效时不可逆冻结，防止后续检查恢复成功后旧实例继续写入；迟到内容可保留在独立恢复快照，后继实例必须审阅。实际签名日志的受控竞态测试通过；这不是活动 `/2` 房间或纸张设置 UI 完成，详见 [布局计划](design/hcd-word-layout-edit-plan.zh.md)。

### 2026-10-28：区域协作消息的冻结门禁

`beforeSync` 在租约校验后、Yjs 应用前检查协调器未冻结且仍存在，避免异步授权期间冻结的实例继续接收同步数据。60 项协调器/租约测试及 TypeScript 通过；两原生进程、四 sidecar 的本机租约交接、DOCX 和 HCDZ 回归通过。精确的在线消息时序注入和 `/2` 活动房间仍待验收，详见 [布局计划](design/hcd-word-layout-edit-plan.zh.md)。

### 2026-10-28：恢复过期时取消资源请求

普通语义恢复在协作内容变化时取消在途权限/资源请求，终止后续批次并阻止合并；已写入的本机文件任务保留。受控测试覆盖多个在途请求、变化发生在本机文件提交后及正常合并监听清理；完整前端 1153 项、最终专项 18 项及 TypeScript/应用与嵌入构建通过。不响应取消的传输仍需等待完成。详见 [保存恢复记录](design/hcd-workbook-save-recovery.zh.md)。

### 2026-10-28：恢复文件的跨窗口通知

恢复包导入的私有文件任务在本机事务提交后通知同源同用户其他窗口，导入过程中当前窗口保持 pending；并发刷新按启动顺序排除迟到旧结果。共享 IndexedDB 双客户端测试、隔离浏览器双标签页待处理状态与保存禁用通过；完整前端 1155 项、TypeScript 及应用/嵌入构建通过；通知异步，焦点刷新可能影响浏览器观察，跨设备及极短竞态不在保证范围。见 [附件恢复记录](design/hcd-inline-resource-recovery-ui.zh.md)。

### 2026-10-28：语义保存前后回读本机文件任务

普通语义保存提交前与确认返回前主动回读本机文件任务；通知丢失时仍可发现已提交任务，存储错误保护性阻断，当前内容导出通过同一保存入口。共享 IndexedDB 模拟两窗口和失败读取的专项、完整前端 1157 项及 TypeScript/应用与嵌入构建通过；回读不是原子跨窗口锁，原生卸载、历史导出及区域模式仍需统一，见 [附件恢复记录](design/hcd-inline-resource-recovery-ui.zh.md)。

### 2026-10-28：协作交接检查本机文件任务

普通语义恢复交接在本机排空和协同同步的前后回读附件任务，待处理或读取失败时不报告 ready；冻结期间本窗口也不能开始新附件操作。“使用最新”在切换协作代次前后再次检查。共享 IndexedDB 受控两窗口、25 项专项、完整前端 1158 项和 TypeScript/应用与嵌入构建通过；检查仍非跨窗口原子锁，也未覆盖实际浏览器的精确竞争时序，见 [附件恢复记录](design/hcd-inline-resource-recovery-ui.zh.md)。

### 2026-10-28：恢复提交后跟随新代次前检查设备任务

普通语义恢复的发起方回执、协作提交通知和 HTTP 代次发现统一在跟随前刷新本机正文及核对待处理文件/图片；发现问题时保留冻结的旧窗口并提供草稿恢复入口。受控双客户端测试覆盖 ready 后另一窗口添加文件、阻止切换及处理后继续；32 项专项、完整前端 1159 项及 TypeScript/应用和嵌入构建通过；这不回滚已经成功的服务端恢复，真实浏览器竞态与跨窗口原子门禁仍待验收。见 [附件恢复记录](design/hcd-inline-resource-recovery-ui.zh.md)。

### 2026-10-28：旧协作代次的本机附件继续处理

普通语义恢复面板发现同用户同文档同模型的旧代次文件，用户选择后核验文件字节和当前权限并复制为当前代次待处理任务；旧记录保留、不会自动关联，目标缺失时明确提示。隔离浏览器从旧代次复制并明确关联至现有节点保存 r28，实际资源与 HCDZ 回读通过；36 项专项、完整前端 1161 项及 TypeScript/双构建通过。跨设备、旧正文和复制与旧任务取消的原子竞争仍开放；见 [附件恢复记录](design/hcd-inline-resource-recovery-ui.zh.md)。

### 2026-10-28：本机待处理附件原文件下载

旧会话文件列表和已显示的待处理文件面板支持校验后直接下载原始字节，不上传、不关联或清除任务；原目标缺失时给出明确提示。隔离浏览器两种入口的实际下载字节、任务保留和 r27 不变通过；33 项最终专项、完整前端 1163 项及 TypeScript/应用和嵌入构建通过；不同设备和区域恢复启动页仍未验收。详见 [附件恢复记录](design/hcd-inline-resource-recovery-ui.zh.md)。

### 2026-10-28：协作图片恢复审阅入口

普通语义恢复包中的协作图片草稿可单张审阅：冲突字段须明确选择恢复包或当前已保存值，同一图片存在房间草稿时阻止恢复；提交前重新验证权限、文档状态、已保存基线和图片资源。成功后形成未保存的个人图片草稿，需另行保存，不会自动合并正文或其他图片。受控测试覆盖冲突、资源校验、协作变化和权限撤销，以及服务端接口的模拟回读；实际浏览器端到端验收尚未完成。含协作图片草稿的恢复包仍不能整包合并正文、附件及其他内容，需保留恢复包，后续补齐整体恢复流程。

### 2026-10-28：图片恢复入口本地端到端验证

在隔离的本地 DOCX 文档、原生 HTTP 服务与协作 sidecar 上，实际浏览器选择合成恢复包：同图已有房间草稿时按钮禁用；当前保存值与草稿一致时不创建操作；对不同图片资源执行恢复后界面显示一张未保存草稿，保存为 r3，服务端图片哈希及读取的资源字节与合成原文件一致。另有实际 WebSocket 客户端验证新 intent 的身份与未提交状态。测试不代表跨设备或生产验收；冲突选择的浏览器路径及含图片包的正文/附件合并仍需补齐。验证中首次脚本比较遇到协作状态变化并按预期拒绝，重建稳定测试状态后通过。

### 2026-10-28：含协作图片的恢复包单独找回附件

普通语义恢复包即使含有需要逐张处理的协作图片，也可明确选择将未完成附件复制到本机待处理列表；复制不应用包内正文或图片，后续仍需确认目标并关联。复制前重新核验权限、协作快照及附件字节；与整包恢复共用确定性任务身份，重复导入不会复活已处理任务。若复制期间取消、文档变化或存储操作返回未知结果，界面提示检查可能已保留的任务。42 项恢复与附件专项测试通过，包括实际编解码的混合恢复包、重复导入、字节损坏、撤权、协作者修改和取消；浏览器端到端流程尚未验证。包内正文的安全合并仍待实现。

### 2026-10-28：混合恢复包附件的浏览器回读

隔离 DOCX 服务的合成恢复包同时包含协作图片草稿和一个未完成附件。浏览器从恢复包复制附件后，在本机待处理面板可见；重新比较并再次复制显示已处理，不产生第二个可见任务。同浏览器另一标签页能读取该待处理项；合成目标节点不存在时，关联按钮禁用并提示保留文件，下载的文件字节与恢复包匹配；服务端文档版本保持 r1。见 [浏览器状态](assets/hcd-mixed-attachment-recovery-2026-10-28/missing-target.jpg) 和 [回读结果](assets/hcd-mixed-attachment-recovery-2026-10-28/evidence.json)。此样例没有目标节点，不证明实际关联及保存，也不代表跨物理设备或生产环境验收。

### 2026-10-28：混合恢复包附件关联与离线回读

使用加载资源节点扩展的隔离 DOCX 服务，构造同时包含图片草稿和未完成附件的恢复包。浏览器单独复制附件、定位原节点并确认关联，保存后得到 r3；服务端节点引用与资源字节、HCDZ 解包后的节点引用与资源字节均与恢复包一致，图片替换没有被附件恢复隐式提交。见 [关联界面](assets/hcd-mixed-attachment-recovery-2026-10-28/attached.jpg) 与 [回读记录](assets/hcd-mixed-attachment-recovery-2026-10-28/target-readback.json)。测试仅覆盖合成节点、单机浏览器和原生本地服务，不代表跨设备、生产或 Office 桌面应用验收；混合包的正文安全合并仍待实现。

### 2026-10-28：混合恢复包单独保留图片选择

普通语义恢复包同时含协作图片草稿及未完成的本机图片选择时，可将图片选择单独复制到本机日志，不应用正文或图片；原选择 ID 保留，未见过的任务以结果待核对状态记录，不自动上传或重放。重复复制仍按本机日志的身份与终态规则处理；权限、快照和资源字节在复制前核验，复制中取消或异常时提示检查可能已保留的任务。已有待处理图片时仍可复制附件，并明确提示先处理图片再恢复图片草稿或合并正文。38 项恢复与图片日志专项通过，覆盖混合包、重复复制、损坏、撤权及复制后取消。浏览器端到端与正文安全合并仍待验证或实现。

### 2026-10-28：混合包图片选择与附件的浏览器验证

隔离浏览器导入合成恢复包，包内同时有图片协作草稿、未完成图片选择和未完成节点附件。单独复制图片选择后，图片上传面板显示结果待核对、下载与放弃记录入口，保存禁用；重新比较时图片草稿恢复禁用，但附件复制仍可操作。另一同源标签页同时发现两项待处理任务。下载图片与包内原始字节一致，服务端 r1 和已保存图片未改变。见 [界面](assets/hcd-mixed-image-choice-recovery-2026-10-28/review.jpg) 与 [回读](assets/hcd-mixed-image-choice-recovery-2026-10-28/evidence.json)。本轮也确认上一轮 TypeScript 检查成功完成；真实跨设备、断电和混合包正文合并仍未验收。

### 2026-10-28：已同步图片历史的混合包正文合并

普通语义恢复对含协作图片草稿的文件增加保守的因果检查：只有恢复包中每项图片操作已被房间接收、包里的图片删除也已在房间生效，且比较后的可见图片草稿与房间一致，才允许正常确认合并正文和附件。提交前再次检查；未接收的图片操作、额外删除、未解析的 Yjs 更新或无法定位的垃圾回收记录仍阻止合并。34 项专项测试覆盖未知操作、删除、未解析删除集、客户端时钟碰撞、正文合并及个人撤销；这是受控测试，真实浏览器和分布式乱序验收未完成。独立设备上从未进入当前房间的图片操作仍无法随正文安全合并，不能称为混合包全面恢复。

补充本地原生 HTTP 和实际协作 WebSocket：将图片操作先同步并在房间删除后，混合恢复包的正文成功合并，未生成新的图片草稿，也未提交服务端版本。该验证未覆盖浏览器点击、双成员乱序或跨设备。测试脚本为 `scripts/hcd-mixed-recovery-body-service.mts`。

### 2026-10-28：已同步图片历史的正文合并浏览器回读

隔离 DOCX 测试中，独立 WebSocket 客户端先同步并移除图片草稿、另加当前房间正文；浏览器比较混合包时显示这段正文和包内正文，并在核验图片历史后启用合并。确认后另一成员的浏览器看到两段内容；保存至 r2 后，服务端及解包 HCDZ、离线导出 DOCX 均回读两段文字，图片替换未被提交。见 [保存界面](assets/hcd-mixed-body-recovery-2026-10-28/saved.jpg) 和 [回读结果](assets/hcd-mixed-body-recovery-2026-10-28/readback.json)。这使用本机合成文档；独立客户端写入测试正文使用 Alice 凭据，Bob 只验证接收，不代表双设备乱序或生产验收。未知图片操作仍阻止正文合并。

### 2026-10-28：附件恢复避免重复计算摘要

普通语义恢复固定附件前改为由归档接口计算一次文件 SHA-256，并在任何网络请求前核对恢复包声明的摘要和长度；原先恢复层和归档层会分别计算同一份字节。服务端仍逐次重新固定资源，不使用长期本机缓存，因此不会因资源回收而跳过必要保护。34 项附件归档、恢复和节点资源专项通过，覆盖摘要不符不发请求、权限失败、资源缺失回退及重复固定；尚无真实大附件性能基准。

后续完整前端测试共 1316 项通过；本轮测试包含多种文档与协作路径，不代表实际大附件性能或生产部署验收。

### 2026-10-28：整包恢复中断时的任务保留提示

普通语义整包恢复会先复制本机附件和图片选择，再执行文档合并。现在这些复制一旦开始，取消、协作变化或设备写入后的异常都会提示任务可能已保留，需检查相应列表；两类任务均已开始时提示检查两处。若文档事务开始后发生异常，则提示合并结果可能已发生，需核对文档，避免错误承诺未合并。受控测试覆盖文件提交后取消、图片提交后通知失败、协作者修改、两类任务混合失败及事务观察者抛错；35 项恢复专项通过。真实浏览器的中途取消和设备写入故障尚未注入验收。

### 2026-10-28：整包恢复取消后的浏览器回读

隔离测试副本在附件写入 IndexedDB 后人为延迟返回，浏览器在延迟期间点击取消：页面提示附件可能已复制、文档尚未合并；待处理面板仍列出附件，下载字节与恢复包一致，正文未进入文档，服务端保持 r1。见 [界面](assets/hcd-recovery-import-interrupted-2026-10-28/interrupted.jpg) 和 [回读](assets/hcd-recovery-import-interrupted-2026-10-28/evidence.json)。浏览器控制台未记录错误；这是测试副本的定点延迟，不代表真实设备崩溃或生产验收。上一轮类型检查进程退出码为 0，但在本轮后续测试增补之前启动。

### 2026-10-28：Excel 被拒绝粘贴的显示回滚

修复混合粘贴被拒绝时，未映射单元格原有显示值可能被界面清空的问题；回滚时保留已加载的原值和样式，数字零不会被当作空值。17 项适配器与输入缓冲专项测试通过，覆盖两个工作簿入口；该场景尚未做真实浏览器验收，也不代表未映射单元格或公式已支持编辑。

后续隔离浏览器对普通文本、已有公式结果和未映射空格进行混合粘贴，界面拒绝整次修改并保留原显示，服务端保持 r0；见[截图](assets/hcd-workbook-paste-rollback-2026-10-28/browser.png)。有显示值但缺少映射的单元格目前仍仅有模拟测试，尚无对应真实浏览器证据。

### 2026-10-28：关闭工作簿后的异步加载保护

分片读取和图片构造返回时检查适配器是否已释放，避免关闭后的网格写入、图片插入、窗口驱逐及加载状态更新。19 项适配器和输入缓冲专项通过，包括延迟分片和图片完成的受控测试；网络请求本身不会因此取消，真实浏览器卸载和断电尚未验收。

启动流程也在打开工作簿、刷新草稿及恢复可见窗口的异步步骤后检查组件是否仍存在，避免卸载后继续初始化界面或版本监听。前一次 TypeScript 检查通过，但启动流程这一后续修改仍需重新检查；对应浏览器卸载竞态尚未单独验收。

### 2026-10-28：Excel 窗口切换的迟到分片

工作簿滚动和切换表格共享窗口代次，过时分片完成时按最新窗口清理，防止旧工作表迟到后清理当前窗口或让旧分片持续驻留。当前窗口加载失败不会仅因失败清除先前窗口；23 项适配器、输入缓冲和延迟协作专项通过，包含清理后重载私有草稿，其中乱序测试使用模拟解析结果；真实浏览器大表和网络乱序仍待验收。

隔离浏览器进一步使用两张 600 行合成表，代理将第一表滚动请求中的一个分片延迟 30 秒，期间第二表正常加载；等待超过延迟后第二表仍显示，返回第一表顶部仍有断连草稿，服务端保持 r0。[第二表](assets/hcd-workbook-window-race-2026-10-28/second.png)、[草稿](assets/hcd-workbook-window-race-2026-10-28/draft.png)。日志有请求先后次序，但未记录延迟响应完成时刻；该测试不代表真实网络、内存或跨设备验收。

加入响应完成记录后重新验证：第二表请求早于旧分片的 HTTP 200 完成；旧分片完成后第二表显示和第一表草稿均保留，版本仍是 r0，见[时序记录](assets/hcd-workbook-window-race-2026-10-28/timing.json)。最新 TypeScript 检查通过；以上仍是本机合成场景，不代表真实网络或大表内存验收。
### 2026-10-28：附件恢复失败时减少无效等待

普通语义恢复的并发资源批次中，一项失败后会取消同批其他请求，保留首个错误并等待请求收尾，不继续复制文件或合并正文。36 项恢复专项通过；取消无法保证撤销服务端已完成的暂存操作，真实大附件网络耗时和浏览器并发故障仍未验收。

与资源固定和行内附件日志一起运行的 53 项相关测试也通过。
### 2026-10-28：统一资源恢复批次控制

将附件失败取消逻辑复用于固定版式恢复：一项资源失败时取消同批其余请求，等待启动的任务收尾并保留首个错误；已持久化的恢复文件仍供显式重试。普通语义、固定版式和资源重固定共 50 项专项通过；浏览器并发故障与真实网络耗时尚未验收。

补充取消时序：失败后用户取消仍等待已启动任务收尾并报告用户取消，开始前取消不发起资源工作。共用批次与两类恢复共 49 项测试通过。

隔离 PPTX 原生服务中，一份图片实际暂存后注入 403 和两个等待请求，后两者被取消；暂存图片字节回读一致，版本和根哈希未变。见[原生服务结果](assets/hcd-recovery-batch-failure-2026-10-28/native.json)。恢复文件保留仍由专项测试验证，未在本次原生服务试验中使用浏览器恢复界面。
### 2026-10-28：单次恢复的共享附件验证

两个业务节点以不同文件名和键引用相同字节时，单次普通语义恢复按内容哈希只固定一次，合并后各节点元数据保留；40 项恢复及资源固定专项通过。这是受控传输测试，重复导入仍会重新固定资源以保留服务端暂存保障。
### 2026-10-28：能力矩阵同步恢复现状

更新当前矩阵，明确工作簿恢复包可包含单元格草稿、未确认请求和输入缓冲，并补充普通语义附件的同源 Web Locks 协调及资源批次失败保护；区分不同格式、未覆盖场景和受控验收证据。Word 基础、跨设备、真实 AI、字体国际化及各格式完整创作仍保持开放。
### 2026-10-28：共享图片资源的暂存类型

恢复去重时，同一字节同时被引用为图片和普通附件，优先使用图片描述固定，避免新暂存资源返回二进制 MIME 导致图片无法显示。58 项专项及隔离原生暂存响应验证通过；已存在 `.bin` 规范索引的资源不会由此自动改类型，混合类型完整保存/导出仍待验收。见[资源类型说明](design/hcd-inline-resource-recovery-ui.zh.md)。

后续资源 HTTP 响应对 `.bin` 的受支持栅格图片签名返回正确图片 MIME，仍禁止浏览器嗅探，其他类型保持二进制；服务端专项测试正在运行。此改动不修改历史索引，不代表离线 HTML、Office 导出及完整恢复保存已验收。

独立 HTML 导出也改用相同的受限签名识别，新增 `.bin` PNG 的嵌入测试；构建和专项测试尚在运行，Office 导出及真实浏览器尚未验收。

共享类型函数的独立 Rust 测试通过，覆盖四种栅格格式、截断签名及 SVG；服务端和 HTML 文件专项仍待完成。

服务端响应专项的前一版已通过，验证 `.bin` PNG 返回图片类型、普通文件和 SVG 返回二进制且均设置 `nosniff`；该轮构建早于共用函数的重构，重构后的服务端和 HTML 测试仍需重跑。

重构后的独立 HTML `.bin` PNG 嵌入测试通过；同时修改附件列表，允许已显示图片和同哈希附件保留各自下载名。完整 HTML 专项正在运行，浏览器下载和 Office 导出尚未验收。

最新代码的独立 HTML 专项 10 项及服务端资源响应专项通过；浏览器下载、完整恢复保存与 Office 导出仍未验收。

实际生成的独立 HTML 在隔离浏览器中显示图片和两个不同附件名，图片解码成功；独立回读两个 data URL 与原始 PNG 字节一致。[截图](assets/hcd-shared-image-resource-2026-10-28/standalone-browser.png)、[回读](assets/hcd-shared-image-resource-2026-10-28/html-readback.json)。内置浏览器点击下载后的事件等待超时，实际下载仍未验收。

Chrome 扩展随后实际点击两个链接，磁盘回读均与原 PNG 字节一致，见[下载证据](assets/hcd-shared-image-resource-2026-10-28/chrome-downloads.json)。下载事件接口仍超时；完整恢复及 Office 文件仍待验收。每个下载名会在独立 HTML 中重复写入 data URL，大资源受输出上限限制。

原生语义导出增量验证：合成 HCD 中的 `.bin` PNG 导出为实际 DOCX 后，包内 PNG 字节与源一致；17 项 HTML 专项通过。此次为普通图片引用，业务节点混合类型恢复和 Office 桌面视觉仍待验收。

业务节点样例补充：图片和普通附件引用同一 `.bin` PNG 时，DOCX 语义导出所嵌入图片的名称类型与字节均正确；普通图片和业务节点两项专项通过。DOCX 静态导出不保留在线业务身份，完整恢复、历史版本及桌面视觉仍待验收。

### 2026-10-28：Word 跨节翻页与备份入口

从后续节首页向前翻页时，在目标节完成当前排版测量后进入末页，不依赖可能过期的页数缓存；备份入口上移，避免遮挡底部翻页按钮。隔离浏览器的合成文档中，第一页节为 4 页、第二节为 6 页，鼠标实测从第一节末页进入第二节首页，再返回第一节第 4 页；[截图](assets/hcd-word-page-nav-2026-10-28/section-last-page.png)。Word 纸张逻辑 7 项专项通过。浏览器分页与 Word 桌面分页仍可能不同，未验证各类复杂版式及真实多用户场景。

复核发现从第一节第 4 页直接选择第二节时，会错误沿用页码进入第二节第 4 页。现让底部节选择和可展开的节导航都定位到目标节首页；上一页跨节仍定位到前一节末页，协同定位继续使用对方页码。隔离浏览器验证两种节选择从第一节第 4 页进入第二节第 1 / 6 页，并验证上一页回到第一节第 4 / 4 页；[截图](assets/hcd-word-page-nav-2026-10-28/section-select.png)。本轮未重新验证协同跟随或 Office 桌面分页。

### 2026-10-28：附件备份等待响应头时的取消

语义图片、业务节点附件和固定版式图片的只读备份请求在等待响应头时，若底层传输未响应取消信号，也可结束等待；迟到的成功响应会尝试关闭响应流。取消后不再启动回退读取。该保护只针对读取，不改变提交请求的未知结果处理；已发出的服务端操作不因此回滚。受控传输测试覆盖取消、迟到响应和三种读取入口，与相关恢复专项共 114 项通过；真实浏览器网络环境仍需验收。

### 2026-10-28：工作簿未完成输入的放弃确认

恢复区不再通过一次点击直接清除未完成输入；先显示确认，用户取消时保留缓冲，确认只针对打开确认时的同一份缓冲，期间出现新缓冲不会被旧确认清除。隔离浏览器模拟编辑期间失去写权限，验证保留输入、取消放弃及确认清除，见[确认界面](assets/hcd-workbook-discard-input-2026-10-28/confirm.png)。工作簿输入缓冲专项 10 项通过；本次未模拟确认期间缓冲被替换的浏览器竞态，也不代表真实断电或跨设备验收。

### 2026-10-28：工作簿同格草稿与未完成输入分歧

恢复文件中同一单元格的本机草稿与未完成输入若不再对应输入开始时的内容，不自动用输入覆盖草稿；两者保留并展示，替换前需要明确确认，放弃输入仍可保留草稿。确认绑定当前缓冲及草稿，旧确认不能覆盖后来变化的内容。工作簿备份入口调整到右侧，避免遮住恢复按钮。

隔离浏览器导入人工构造的分歧备份，验证比较、取消、鼠标操作及确认后网格显示输入；阻断保存时服务端仍为 r0。[比较截图](assets/hcd-workbook-divergent-input-2026-10-28/review.png)。39 项工作簿缓冲、固定恢复与可携带恢复专项和 TypeScript 检查通过。这不是自然发生的并发交错、真实断电或跨设备验收，确认后的离线文件导出未在本次验证。

后续重新导入独立的人工构造分歧备份，选择替换后自动保存为 r1，浏览器下载实际源格式 XLSX。解包回读确认 A1 为未完成输入、B1 原文字和 A2 数值保持不变，C1 公式 `1+2` 保留；见[保存截图](assets/hcd-workbook-divergent-input-2026-10-28/saved.png)及[文件回读](assets/hcd-workbook-divergent-input-2026-10-28/xlsx-readback.json)。这仍是同机合成场景，不代表自然并发、不同物理设备或复杂工作簿验收。

同一样本再次导入分歧备份，放弃未完成输入后保留原本机草稿；该草稿与 r1 内容不同，界面要求处理同格冲突。选择保留本机内容后保存 r2，浏览器导出源格式 XLSX 并回读 A1 为本机草稿，B1、A2 和 C1 原公式保持不变。上述[文件回读](assets/hcd-workbook-divergent-input-2026-10-28/xlsx-readback.json)记录 r1/r2 两个选择的结果；它仍未覆盖自然产生分歧或不同物理设备。

### 2026-10-28：先处理同格输入再处理远端冲突

同一单元格仍有未完成输入时，暂不允许先解决该单元格的远端冲突，避免选择草稿后又将尚未审阅的输入叠加到新基线；其他单元格冲突不受此限制。界面提示先处理输入，处理后继续展示远端冲突并要求明确选择。

隔离双成员浏览器中，Bob 编辑并保存 A1 为 r1，Alice 导入人工构造的分歧备份；两个同格冲突按钮禁用。Alice 选择未完成输入后，冲突区显示该输入和 Bob 的 r1 内容，再选择保留本机内容保存 r2。浏览器导出的 XLSX 回读确认 A1、相邻 B1 和 C1 公式，见[冲突截图](assets/hcd-workbook-input-conflict-order-2026-10-28/remote-conflict.png)和[回读](assets/hcd-workbook-input-conflict-order-2026-10-28/readback.json)。28 项输入缓冲及固定恢复专项、TypeScript 检查通过；备份分歧是人工构造，非自然并发或跨设备验收。

### 2026-10-28：未完成输入与未知保存回执并存

未完成输入保留时，可单独核对原保存请求的不可变回执，不重发编辑，也不清除输入。已确认则记录原版本；查无回执不推断失败、不重新提交。核对与保存互斥，待处理输入仍阻止新保存。受控测试覆盖回执缺失、确认、请求身份及输入落盘，与固定恢复和工作簿专项共 40 项通过。

隔离浏览器及代理让 r1 保存成功后丢失响应，再输入后续内容并模拟鉴权短暂不可用；核对回执确认 r1、输入仍保留。连接恢复后将输入另存为 r2，实际下载 XLSX 回读内容及原公式；日志显示两个编辑请求、核对时没有重新提交，r1/r2 请求 ID 不同。见[核对截图](assets/hcd-workbook-receipt-buffer-2026-10-28/confirmed.png)及[回读](assets/hcd-workbook-receipt-buffer-2026-10-28/readback.json)。该场景使用本机代理和合成工作簿，不代表真实断网、跨设备或复杂工作簿验收。

后续双成员交错验证：Alice 的 A1 请求提交 r1 后丢响应，Bob 修改同格保存 r2；Alice 在 A2 产生未完成输入并模拟鉴权不可用，单独核对得到 r1 时，A1 同伴冲突和 A2 输入均保留。恢复连接后选择 A1 已保存内容，将 A2 输入恢复并保存 r3。浏览器导出 XLSX，回读 A1 为 Bob 的 r2 内容、A2 为恢复输入、C1 原公式保留；三次编辑请求和三个不同版本请求 ID 见[回读](assets/hcd-workbook-receipt-peer-2026-10-28/readback.json)，核对状态见[截图](assets/hcd-workbook-receipt-peer-2026-10-28/receipt.png)。本机同浏览器、受控代理和两格合成场景；尚未覆盖后续输入与同伴更新同一格的这一交错。

### 2026-10-28：同格协作更新不得重绘活动输入

进一步复现同格交错：Alice 的原请求结果未知并继续输入，Bob 保存同格后，远端冲突刷新会把旧草稿重新写入活动单元格；Univer 因此产生旧值的输入事件，可能清除未完成输入缓冲。现将草稿重绘延迟到单元格编辑结束或中断后，同时重新尝试处理期间积累的远端版本。30 项工作簿适配器、输入和延迟版本专项通过，其中受控适配器测试覆盖远端冲突刷新不会覆盖输入、编辑结束后恢复重绘。

浏览器真实双成员复测在修复后因浏览器自动化环境中断尚未完成，不能据此宣称该交错已经端到端解决；还需验证同格内容、撤销、保存和 XLSX 导出，以及大表加载期间的重绘。此次复现使用本机合成工作簿及受控代理。

TypeScript 检查通过；检查启动后又补充了编辑结束事件中的同一帧重绘调度，该最后一行未单独重新运行类型检查。

浏览器环境恢复后，使用包含最终调度改动的代码重新运行 TypeScript 检查，通过。新的隔离双成员工作簿中，Alice 的 A1 原请求提交 r1 后丢响应并继续输入，Bob 同格保存 r2；Alice 的输入在编辑器和本机恢复区均保留，查询回执确认 r1 后仍显示 Bob 的冲突。选择后续输入保存 r3，再个人撤销得到 r4；浏览器下载的源格式 XLSX 回读 r3 为 Alice 后续输入、r4 为 Bob 内容，两个版本的相邻单元格和原公式保持不变。见[保留状态](assets/hcd-workbook-active-conflict-2026-10-28/retained.png)及[文件回读](assets/hcd-workbook-active-conflict-2026-10-28/readback.json)。这是本机合成文档与受控代理，并未验收真实断网、跨设备或大表加载时的重绘。

继续执行个人重做并保存 r5，实际 XLSX 回读为 Alice 后续输入，原公式和相邻单元格仍保留；r1–r5 的请求身份均不同，已补充到上述文件回读。

### 2026-10-28：工作簿分片回收与活动输入

分片回收在单元格编辑期间保护该输入所属分片，其他过期分片仍可回收；无法识别编辑分片时暂时保留，编辑结束后按最新窗口再次清理。31 项适配器、输入缓冲和延迟版本专项通过，覆盖编辑分片保留、其他分片回收与结束后的清理。

最终代码使用 600 行合成工作簿，在 A1 输入时滚动至约第 181 行再返回并继续输入；断开保存后恢复连接，保存 r1 并下载源格式 XLSX，回读确认 A1 内容与 A181 原值均保留。[输入截图](assets/hcd-workbook-active-window-2026-10-28/active.png)、[文件回读](assets/hcd-workbook-active-window-2026-10-28/readback.json)。此场景未测量内存上限或真实慢网；滚动时 Univer 的活动输入框仍会贴在可视区域边缘，位置交互有待进一步优化。

补充受控延迟及跨表验证：在 A1 输入期间滚动到第 289 行再返回，代理将一个分片延迟 30 秒返回；返回后继续输入，核对保存结果并保存 r1。随后在 A1 继续输入并切换到第二张表，输入自动提交为 r2。对 r2 执行源文件导出并直接回读 XLSX：第一张表 A1 为 `Window row 1延迟窗口完成切换表`，A289 保持 `Window row 289`；第二张表 A1 和 A289 均保持原值。该验证使用本机合成双表及代理延迟，不代表真实慢网、跨设备或内存压力验收；活动输入框随滚动贴边的问题仍待修复。

### 2026-10-28：工作簿离屏编辑位置提示

编辑中的单元格滚出视野后，工作簿显示包含工作表和单元格地址的提示，并可返回原单元格继续输入；滚动本身不提交输入。隔离浏览器中编辑 `Recovery!A1`、滚动到约第 217 行、点击返回并继续输入，再切换到第二张表，保存为 r3。源格式 XLSX 回读确认第一张表 A1 包含完整输入，两张表的 A217 及第二张表的 A1 保持原值。[离屏提示截图](assets/hcd-workbook-offscreen-edit-2026-10-28/offscreen.png)。底层 Univer 的输入框仍会贴在可视区域边缘；此改动通过提示和返回入口降低位置歧义，尚未改变底层定位。冻结窗格、键盘和触屏操作尚需单独浏览器验收。

补充首行冻结与键盘验证：合成 600 行 XLSX 冻结首行，编辑 A1 后滚动时首行仍可见且不出现离屏提示；编辑 A2 滚动后提示原地址，使用 Alt + Shift + R 返回，继续输入并保存 r4。源格式 XLSX 回读确认 A1、A2 的编辑内容，A218 原值和首行冻结设置均保留。[冻结行与提示截图](assets/hcd-workbook-frozen-shortcut-2026-10-28/frozen.png)。这是本机浏览器、合成文档和单行冻结场景，冻结列、双向冻结、其他键盘布局、触屏和真实设备仍需验收。

### 2026-10-28：冻结行分片保留

复现滚动到远处后冻结首行内容被窗口回收、界面显示为空的问题。工作簿窗口加载现在将可见冻结行与主窗口一起纳入同一代次和回收集合，去重分片且不加载中间所有行；冻结视口未就绪时采用有界回退。32 项工作簿适配器和输入专项通过。隔离浏览器对 600 行首行冻结样本滚动到第 434 行，冻结行仍可见并可编辑；保存 r1 后源 XLSX 回读 A1 为编辑值、A434 不变，冻结设置保留；最终代码重开并滚动后内容仍可见，见[截图](assets/hcd-frozen-row-window-2026-10-28/retained.png)。大冻结区域、冻结列、双向冻结、真实大表内存及慢网仍需验收。

增加双向冻结的受控测试：模拟首行、首列视口共同引用同一个分片时，只读取一次，并将冻结行图片及主窗口分片一并保留；工作簿适配器 22 项通过。另生成并导入了 600 行、首行首列冻结的 XLSX 样本，HCD 分片记录两方向冻结；浏览器环境不可用，本次未能验证该样本的实际显示或编辑。上次启动的 TypeScript 检查仍在运行，其结果尚未确认。

浏览器恢复后补充双向冻结验收：600 行双表合成工作簿同时冻结首行和首列，滚动到约第 362 行和 Z 列后，冻结区域与当前行仍可见；分别编辑 A1、A362 并保存至 r2，切换到第二表再返回保持当前区域。源格式 XLSX 回读确认两处编辑、Z1/Z362 原值及双向冻结设置，见[界面](assets/hcd-workbook-both-frozen-2026-10-28/view.png)和[文件回读](assets/hcd-workbook-both-frozen-2026-10-28/readback.json)。此验证使用本机浏览器与合成文件，未覆盖真实大表内存、真实慢网或其他 Office 客户端。

上次启动的 TypeScript 检查已完成且退出码为 0。补充分片乱序受控测试：旧窗口请求迟到时，最新窗口的冻结行分片仍保留、旧分片被回收；适配器、输入缓冲及延迟版本共 35 项通过。再次尝试本机浏览器验收时浏览器启动超时，双向冻结的实际界面与文件编辑仍未验证。

### 2026-10-28：附件归档准备过程可取消

附件归档的总时限从本机读取和 SHA-256 计算开始生效；用户取消时无需等待不可中断的读取或摘要完成，迟到的准备结果不会继续发起网络请求。原字节校验、服务端重固定及提交后的未知结果规则保持不变。64 项受控资源读取、恢复、批次与节点文件专项通过，包含延迟文件读取后取消及迟到结果不上传；真实设备和大附件耗时仍需验收。

### 2026-10-28：固定版式图片任务的校验快照

固定版式图片任务写入和标记暂存时，在异步摘要前复制文件字节和原目标属性，防止调用方在摘要进行中修改对象，使校验值与保存的任务不一致。24 项固定图片、恢复包和附件专项通过，包含异步校验期间修改原字节和目标的受控回归；真实浏览器或设备崩溃场景未在本次重新验收。

前一轮附件准备过程改动的 TypeScript 检查已通过；针对本轮图片快照改动的类型检查已启动，结果另行确认。

### 2026-10-28：语义恢复包比较快照

语义恢复包比较在通过大小和作用域解析后，立即复制文件字节与会话信息；后续授权、解析、资源比较和包身份摘要使用同一份快照，避免调用方在异步比较期间修改缓冲区或会话导致比较和恢复身份不一致。63 项语义恢复与附件专项通过，包含比较启动后修改输入文件和会话的受控回归。尚未进行跨设备或浏览器中途修改文件的验收。

### 2026-10-28：固定版式恢复来源快照

固定版式恢复包的比较、分页与最终确认使用开始时捕获的源文件摘要，与已复制的包字节及会话保持同一身份；每次服务端 head 校验仍会检查当前源文件和版本。69 项固定版式与语义恢复专项通过，包括比较开始后更改调用方输入，再确认原包并回读设备草稿与图片任务。该验证使用受控请求和本机 IndexedDB 模拟，不等同浏览器、跨设备或真实服务验收。

### 2026-10-28：恢复包本机读取可取消

语义与固定版式恢复入口在读取用户选定文件时响应取消，不必等待迟到的本机读取结果；取消后不会继续启动比较。固定版式准备入口在复制包字节前先检查取消和大小，避免对超限输入再分配一份缓冲区。63 项读取、固定版式与语义恢复专项通过，包括受控延迟读取取消；浏览器取消交互及真实大文件性能尚未验收。

### 2026-10-28：业务节点附件准备可取消

普通、区域和行内容器共用的节点文件客户端在读取和计算摘要阶段响应取消；准备阶段取消后释放待处理状态，迟到的读取不会写入设备日志或发起上传。文件已进入设备事务或正文关联事务时仍等待事务完成并遵守原有的保留与确认规则。78 项节点文件、跨窗口日志及语义恢复专项通过，包含受控停滞读取与取消回归；真实浏览器和设备故障尚未验收。

### 2026-10-28：区域 Word 图片准备可取消

区域 Word 图片首次选择和恢复时重新选择文件，均在本机读取及摘要阶段响应取消或关闭；迟到结果不能创建新的预约或上传。已经写入的设备选择与服务端预约仍按原有取消、回执和不确定结果规则处理。28 项图片上传、节点附件及读取专项通过；新增重新选择文件的取消回归后，图片上传客户端 10 项通过。浏览器、真实设备故障和大文件耗时仍需验收。前一轮恢复入口 TypeScript 检查已通过；后续检查仍在运行。

### 2026-10-28：固定版式图片选择目标快照

PPT/PDF 图片选择在开始读取文件前捕获目标图片与几何信息，避免读取期间调用方修改对象后将选择绑定到新的目标。受控延迟读取测试确认保留选择时的目标，26 项图片选择、日志与恢复专项通过；实际协作者编辑、浏览器交互及设备故障尚未验收。

### 2026-10-28：图片选择关闭后释放等待

固定版式和语义图片选择在关闭时不再等待尚未完成的本机读取和摘要，迟到结果不会创建任务；已开始的设备写入仍按原事务规则完成。30 项图片客户端、日志和任务专项通过；另用两个本机模拟窗口与共享锁验证，第一窗口关闭后，第二窗口无需等待迟到读取即可继续操作且不会出现新任务。该验证不是浏览器、系统断电或跨设备验收；类型检查仍在运行。

关闭固定版式图片任务时同时清理通知订阅，迟到的清理过程不再向已关闭的广播通道发送消息。17 项固定版式/语义图片客户端与任务专项通过，双窗口锁测试使用关闭后发送即抛错的模拟通道；本次浏览器环境不可用，未做真实浏览器验证。区域 Word 图片准备改动的 TypeScript 检查已通过；后续检查仍在运行。

### 2026-10-28：语义图片事务关闭保护

语义图片客户端关闭时向正在进行的目标核验、资源暂存及同步步骤传递取消信号。若图片已经进入共享文档，仍等待设备写入步骤收尾并保留 `applying` 待核对记录，不自动重放或撤销。33 项语义、固定版式和区域 Word 图片专项通过，覆盖核验期间关闭以及应用后关闭的受控场景；若底层传输不响应取消，无法保证立即释放锁，真实浏览器及设备故障仍需验收。

后续补齐只读目标核验及排队取锁：窗口关闭时，即使只读核验传输忽略取消也不再等待其结果，不会继续暂存；尚未取得 Web Lock 的请求会取消排队。23 项语义图片和区域设备边界专项通过，包含迟到核验和排队取消。已经发送的资源暂存与已开始的设备写入仍需按原有不确定结果与事务规则收尾，不能因为停止等待只读核验而推断其回滚。真实浏览器、设备故障及协作服务仍需验收。

### 2026-10-28：语义图片任务绑定文档作用域

语义图片任务绑定创建时的文档、成员、服务端点、协作协议与设备日志；页面切换而旧客户端尚未完成清理时，旧任务不能用新会话继续核验、暂存、应用或读取任务，保存门禁保守阻断。相同作用域内的令牌刷新仍可使用新凭证。26 项作用域、图片任务和设备边界专项通过，覆盖作用域字段变化及现有取消/恢复规则；实际 React 页面切换、真实浏览器和跨设备并发仍需验收。

业务节点附件入口也增加同一作用域门禁，包含资源注册器、文档、成员、端点、协议和设备日志；归档请求完成后再次检查作用域，失效时不将结果当作当前文档任务推进。设备锁回调在实际获得锁时再次检查，旧任务及其通知不能暴露给新页面。48 项作用域、附件日志和图片客户端专项及最终 TypeScript 检查通过；React 页面切换和真实浏览器并发尚未验收。

补充隔离 React 页面和浏览器 IndexedDB 验证：文档 A 的附件处于模拟归档等待时切到文档 B，B 的任务列表为空；放行 A 的迟到响应后，返回 A 仍有一个待处理文件，读取到原始内容 `fixture attachment`。见[文档 B](assets/hcd-node-scope-switch-2026-10-28/second.png)和[原文档](assets/hcd-node-scope-switch-2026-10-28/original.png)。页面直接使用业务节点附件 hook 与真实浏览器本机存储，但归档器是测试模拟；未覆盖真实服务、图片任务、跨设备或保存导出。复现入口 `python3 scripts/hcd-inline-binding-preview.py --scope`。

同一隔离 React 页面补充语义图片验证：A 选择图片后暂停只读目标核验，切到 B 并放行忽略取消的迟到响应；B 的图片任务列表为空，暂存请求数为零。返回 A 后，待处理选择仍为 `chosen`，回读字节为 `fixture image`，见[原文档状态](assets/hcd-image-scope-switch-2026-10-28/original.png)。页面使用真实图片任务 hook、Y.Doc 和浏览器 IndexedDB，目标核验和资源暂存为模拟；该合成字节不验证图片格式，不代表真实服务、跨设备、保存或导出已验收。

### 2026-10-28：附件任务完成与取消的作用域检查

普通语义和行内容器附件客户端补充文档作用域检查：旧客户端不能在切换后继续读取、取消或开始新动作；取消读取设备记录后及关联持久化后、写入终态前再次检查。切换发生在终态写入之前时，原始待处理附件保留供审阅；若正文关联已经发生，不把错误解释为正文已回滚。39 项附件、行内容器、日志和作用域专项通过，包括受控延迟取消和持久化交错。已开始的设备终态事务仍需按事务实际结果处理，本次没有浏览器注入该竞态，也未验收真实设备故障或跨设备场景。

后续补充保存门禁与导入完成的检查：设备列表读取期间失去作用域时，待处理检查保守返回阻断；恢复附件已写入后失去作用域则报告中断，保留已导入字节，不能据此认为写入已回滚。40 项附件与日志专项通过，包含受控延迟读取和写入后切换；浏览器时序注入及真实设备故障仍待验收。

### 2026-10-28：附件扩展注册器的令牌续期

资源扩展注册器改按文档、成员、端点、协作协议、代次、格式和权限绑定；同一作用域仅刷新令牌或显示名时复用注册器，新启动的资源请求读取最新凭证。文档或权限变化仍重建注册器，旧注册器的传输入口检查原作用域。隔离 React 页面使用实际扩展提供器、附件 hook 和 IndexedDB：模拟旧凭证请求等待期间刷新令牌，任务继续并归档；下一次归档使用新凭证；切换文档后注册器更换且新文档任务为空。33 项附件与作用域专项和 TypeScript 检查通过。复现入口 `python3 scripts/hcd-inline-binding-preview.py --token`；服务响应为模拟，已发出的请求不会更换凭证，真实令牌过期、重试和生产服务尚未验收。

### 2026-10-28：Word 纸张布局读取校验

前端读取区域布局时，按原生布局约束验证纸张宽高、方向、分节类型、页边距键和范围、页码起始及格式，避免异常布局进入纸张预览；保留原生允许的负数上下边距。24 项纸张、大纲和区域布局专项及 TypeScript 检查通过，包含有效边界和异常输入。此改动只保护读取，不提供纸张设置编辑、精确分页或新建页眉页脚；未做异常布局的浏览器故障注入。

### 2026-10-28：Excel 紧凑标题栏

工作簿标题栏显示当前文档名、版本和保存状态，并与其他格式使用相近的紧凑高度；保存和导出仍在操作区，未知保存结果显示核对入口。隔离浏览器编辑 A1 自动保存到 r1，点击导出显示完成；另行使用原文件导出并回读 XLSX，确认 A1 的修改和 C1 原公式保留，只读窗口的保存按钮禁用。见[界面截图](assets/hcd-workbook-compact-header-2026-10-28/saved.png)。TypeScript 检查通过；本次为单机合成文件，未验证窄屏、生产服务或真实 Office 客户端。现有恢复/关闭门禁未改动。

随后按编辑器容器宽度调整工作簿操作区：窄容器的导出选择框保留无障碍名称，避免标签被挤成竖排，选择项和反馈可换行。隔离浏览器在 375px 容器中编辑 A1 并保存 r1、点击导出、展开恢复面板；源格式 XLSX 回读确认编辑值和原公式，见[截图](assets/hcd-workbook-narrow-2026-10-28/recovery.png)。这是桌面浏览器中的受限容器，未验证真实手机触屏或所有语言长度；保存和恢复逻辑未改动。

### 2026-10-28：Excel 在线成员与视口跟随

工作簿复用仅传 awareness 的协作房间，在右侧列出成员、工作表、选中单元格和视口起点，并支持定位和跟随；消息只包含经过范围校验的坐标，不包含单元格内容。检测跟随环；本机操作停止跟随，正在编辑或存在未完成输入时不跳转。隔离原生服务与 sidecar 的双成员浏览器验证跨表跟随、持续滚动、手动编辑后停止跟随与保存 r1；源格式 XLSX 回读第二张表 A181 的编辑值，见[截图](assets/hcd-workbook-collaboration-2026-10-28/follow.png)。15 项位置、跟随环、视口和输入缓冲专项通过。此项不提供对方单元格高亮或逐字协作；真实设备、长距离网络、重连、权限变更和多人规模仍需验收。

随后接入 Univer 的临时选区标记：仅高亮当前工作表中其他成员的选区，最多处理前 50 个连接，边框颜色与成员面板一致；不更改单元格样式或内容，成员离线或切换工作表时清除。隔离双成员浏览器在双向冻结的 600 行样本中验证 B4、滚动后 B150 的颜色标记，切换表和断开连接后的清理；标记存在期间编辑 A150 并保存 r1，源格式 XLSX 回读该内容、B150 仍不存在。见[标记截图](assets/hcd-workbook-peer-mark-2026-10-28/selection.png)。4 项位置/标记专项和 TypeScript 检查通过；尚未验证多成员重叠、冻结区域本身的标记、缩放、真实触屏与生产多实例。

选区附近进一步显示成员姓名；相同选区的标记合并，最多显示三个姓名及剩余人数，浮标不会拦截底层表格点击。隔离三成员浏览器验证同格重叠、150% 缩放、双向冻结样本中 A1 随滚动保持对齐、成员离线清理及点击浮标下方列头；标记存在时编辑 A4 并保存 r1，源格式 XLSX 回读编辑值且 B4 未写入。见[重叠截图](assets/hcd-workbook-peer-label-2026-10-28/overlap.png)和[冻结截图](assets/hcd-workbook-peer-label-2026-10-28/frozen.png)。5 项标记、位置和视口专项及 TypeScript 检查通过；标记最多处理前 50 个连接，真实触屏、更多冻结组合、跨设备和生产多实例仍需验收，工作簿内容仍是保存后同步而非逐字协作。

### 2026-10-28：语义编辑器减少重复全文扫描

语义编辑器按不可变 ProseMirror 文档快照复用业务节点和人员引用索引，选择、面板等状态变化导致的重渲染不再重复遍历相同文档；文档变化时重新构建，节点定位时如果快照已变化则重新查找。19 项引用、行内容器属性与节点资源专项及 TypeScript 检查通过。隔离主编辑页样例中修改正文后仍可选中受保护业务节点，保存至 r9，见[截图](assets/hcd-semantic-index-2026-10-28/saved.png)。该样例没有测量长文性能，也没有覆盖附件任务定位和并发冲突的浏览器路径；此前定位慢的根因仍未确认，正文仍未分段加载。

### 2026-10-28：工作簿未知提交的携带恢复验收

隔离服务提交 A1 后丢弃响应并阻断回执，后续 B1 输入与原请求一起进入恢复文件；在同机独立来源存储导入、重开和核对后，原请求对应已有 r1，后续修改另存 r2。历史请求身份及两个版本的实际源格式 XLSX、原公式均已回读，见[界面](assets/hcd-workbook-unknown-recovery-2026-10-28/saved.png)和[回读](assets/hcd-workbook-unknown-recovery-2026-10-28/readback.json)。未验证同格后续输入、不同物理设备、断电或生产网络；此次未修改产品代码。

后续验证同格第二次输入及另一成员在恢复前修改同一格：原请求经回执核对后保留后续草稿，存在并发冲突时必须明确选择，不会直接保存。修正冲突时保存按钮仍可点击的问题：未解决冲突时禁用并提示，待核对原请求仍可核对，解决冲突后恢复可用。两组隔离浏览器及源 XLSX 历史回读、11 项保存专项和 TypeScript 检查通过，见[禁用状态](assets/hcd-workbook-unknown-same-cell-2026-10-28/disabled.png)和[回读](assets/hcd-workbook-unknown-same-cell-2026-10-28/readback.json)。同机和受控代理不等于真实设备或生产网络验收。

### 2026-10-28：业务节点定位索引减少内容序列化

业务节点位置索引只读取节点身份和位置，不再为定位序列化整个容器正文；权限/编辑保护仍使用原有包含正文的完整索引。嵌套身份、位置和重复身份保护及相关协作节点共 19 项测试和 TypeScript 检查通过。合成样例包含 250 个业务容器、每个 80 段，预热后五次单机索引：完整索引约 17.6–20.9 ms，位置索引约 5.1–5.3 ms；这不是端到端性能测试。隔离主编辑页选择嵌套业务节点，归档并关联文件后保存到 r28，服务端附件哈希、长度和原始字节回读一致，见[界面](assets/hcd-node-index-performance-2026-10-28/saved.png)。未注入定位中途的协作修改，也未测真实大附件或长文的整体响应；此前操作慢的根因仍未确认。

### 2026-10-28：区域 Word 跨节附件定位

区域 Word 的附件和节点冲突定位改为等待目标区域编辑器挂载及协作投影更新，不再在 20 个动画帧后静默停止；目标已从当前区域模型删除时显示文件保留提示。等待过程中切换或卸载会取消订阅，选择节点触发的事务不会递归定位。10 项区域纸张和定位专项及 TypeScript 检查通过；受控测试覆盖超过 30 次未就绪通知、目标删除、取消和同步订阅。隔离真实区域协作浏览器中，在第二节选择 8 MiB 附件、上传期间切换第一节，再从待处理列表定位回第二节、确认关联并保存 r3；规范版本的资源长度、哈希和下载字节与原文件一致，见[保存界面](assets/hcd-word-node-locate-2026-10-28/saved.png)。该浏览器样例未注入投影延迟或并发删除，也不表示创建页眉页脚或布局编辑已开放。

后续在隔离的双成员区域房间验证删除目标：Alice 暂存 8 MiB 附件并切离第二节，Bob 删除目标并保存 r3；Alice 的关联和保存被阻止，定位明确提示目标不存在，从本机下载的附件与原字节一致。另开同来源窗口仍能看到待处理文件，r2 含原节点、r3 及语义 DOCX 已移除节点而正文保留，见[提示](assets/hcd-word-node-deleted-2026-10-28/missing.png)和[回读](assets/hcd-word-node-deleted-2026-10-28/readback.json)。本次是在定位前删除，不是定位等待期间的精确时序注入，也不代表跨设备或生产验收。

测试发现空文件或超过 8 MiB 的选择未写入设备日志，但属性面板错误宣称文件仍待处理。现于选择后、读取和归档前给出未记录未上传的明确提示；其他归档异常提示先检查本机任务，找不到时重新选择，避免对设备写入结果作无依据保证。隔离区域浏览器确认超限提示，并再次选择恰好 8 MiB 文件成功关联保存及回读；24 项节点文件专项和 TypeScript 检查通过，见[超限提示](assets/hcd-word-node-deleted-2026-10-28/oversize.png)。

### 2026-10-28：节点文件写入结果不确定时重新发现

节点文件设备写入已开始但调用报错时，不再仅删除内存任务：通知同源窗口后重新读取设备日志；如果写入其实已经完成，恢复为可下载的待处理文件；若读取失败则显示存储问题并维持保存门禁。文件写入明确完成后，在发出跨窗口通知前先将完整任务放入当前窗口，因此通知抛错也不会让任务缺少可下载的原始字节。43 项普通、区域和行内节点文件/日志专项及 TypeScript 检查通过，包含模拟写入提交后报错、日志读取失败、通知失败和原文件回读。测试使用 fake IndexedDB 和受控故障注入，未在真实浏览器或物理设备上模拟写入完成后报错；本机窗口锁不覆盖跨设备。

后续补充浏览器 IndexedDB 验收：隔离页面使用实际区域设备日志和节点文件客户端，在事务完成后主动注入异常；发起窗口重新发现一项 `chosen` 任务，同源第二窗口通过通知也看到任务，两个夹具的模拟保存按钮均因客户端待处理状态而禁用。第二窗口读取到原文件文本，刷新后任务和原文仍在，未触发网络上传。[重开状态](assets/hcd-node-uncertain-browser-2026-10-28/reopened.png)；复现入口 `python3 scripts/hcd-inline-binding-preview.py --uncertain-resource`。此为浏览器真实 IndexedDB 加人为故障注入的内部夹具，不是主编辑页或系统断电、跨物理设备、生产服务验收。

### 2026-10-28：区域 Word 编辑目标跟随可见区域

区域 Word 在切节、切换页眉页脚模式或页面变体时，命令上下文只引用当前可见且处于编辑模式的区域；上一节或已退出编辑的页眉页脚不再使格式、节点或提及命令保持可用。实际隔离浏览器复现了切节后旧格式按钮仍可点击的问题；最终代码切节后立即禁用，点击新正文后恢复。正文和页脚各输入一段、退出页脚编辑并保存 r2，语义 DOCX 回读确认新正文、页脚和其他节正文保留，见[切节状态](assets/hcd-word-active-region-2026-10-28/switched.png)。11 项区域选择和纸张专项与 TypeScript 检查通过；真实 Office/WPS、协作延迟下的所有切换时序尚未验收，纸张设置与新建页眉页脚仍未开放。

页眉页脚编辑时，操作区持续显示当前区域、节、实际首页／偶数页／默认页面类型及链接前一节状态，并保留关闭入口，切换工具栏后仍可返回正文。9 项纸张与页面类型专项及 TypeScript 检查通过；隔离区域 Word 房间中编辑首页页眉、切换到开始工具栏、返回并修改正文后联合保存 r2，语义 DOCX 回读确认两处内容分别写入页眉和正文；第二节首页显示链接前一节，见[继承状态](assets/hcd-word-story-context-2026-10-28/inherited.png)。该验证不包含真实 Office/WPS 或跨设备验收，创建缺失页眉页脚和取消链接仍未开放。

共享页眉页脚还会提示修改影响所有关联位置：包括在原节编辑而后续节继承，以及同节不同变体引用同一内容的情况；暂时未启用的变体仍计入关联，避免之后开启时意外看到修改。10 项纸张与共享绑定专项及 TypeScript 检查通过。隔离两节房间中修改第一节首页页眉，第二节继承位置即时显示修改和提示，保存 r2 后语义 DOCX 的一个页眉部件包含新内容，见[共享提示](assets/hcd-word-shared-notice-2026-10-28/inherited.png)。本次未验证真实 Office/WPS 或多设备，提示不提供取消链接功能。

### 2026-10-29：Excel 批量草稿保存前冲突提示

批量草稿保存前的目标检查如果收到服务端明确的版本变化、已有单元格、受保护目标或源文件问题，现在显示相应提示；此时还没有登记或发送保存请求，草稿保持原样。保存请求已经登记或发出后的失败不使用这些检查阶段提示，仍保留原请求并按未知结果流程核对，避免将可能已提交的请求误报为未提交。18 项批量草稿、客户端和提示分类专项及 TypeScript 检查通过，包含检查阶段零提交与提交后保留请求；尚未做真实浏览器交互验收。


### 2026-10-30：区域 Word 首版屏幕分页接入

修复未接线分页模块导致的 TypeScript 阻断，将显示层排除区和纸张/页眉页脚 surface 接入普通区域入口。单段正文保持同一协作模型，主页面 4 页、保存 r2、撤销 1 页/重做 4 页和 25% 缩放已有真实 Chrome 证据；Bob 后缀、第三页页眉原位编辑保存 r4、实际 DOCX 及 HCDZ r0–r4 回读通过。分页元数据不改变 Yjs 字节或个人历史。真实发现并修复末页估算和重新测量时暂收一页的焦点跳动；独立引擎夹具验证复杂块完整回退、撤销恢复及新增十段增长为 5 页。准确测试/构建和限制见[本批记录](design/hcd-word-page-flow.zh.md)及[验证汇总](assets/hcd-word-page-flow-2026-10-30/validation.json)。Alice 同伴输入后的撤销发生浏览器焦点超时，未确认，不能当通过；仍按节切换，复杂分页、跨节连续布局、计算域、目录、真正分段及所有格式目标继续，管理平台和提醒后置。
