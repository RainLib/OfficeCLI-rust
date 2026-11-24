# OfficeCLI Workspace

这是当前默认业务应用的入口：V2 管理台、账号登录、匿名分享、文件版本库、逐文件权限、编辑器、协作服务和内置业务 Provider。与外部系统接入共用 `/officecli-provider/v1` 契约和 Rust 发布链路，不依赖测试 fixture，也无需用户粘贴管理或文档令牌。

## 构建与启动

需要 Node.js 24.13+、Rust 构建工具，以及当前平台支持的浏览器。构建阶段安装依赖；运行阶段只使用 Node.js、OfficeCLI 二进制和已构建的本地资源，不运行 npm、Vite 或 tsx。

在仓库根目录执行：

```bash
npm ci --prefix examples/hdoc/admin-app
npm ci --prefix examples/hdoc/editor
npm ci --prefix examples/hdoc/xlsx-univer-viewer
npm ci --prefix examples/hdoc/embed-host
npm ci --prefix apps/workspace
cargo build --release -p officecli --bin officecli
npm run build --prefix apps/workspace
```

构建输出 `apps/workspace/dist/`，包含单页后台、编辑器及 worker/异步资源、独立打包的协作 sidecar 和当前平台的 OfficeCLI。设置 `OFFICECLI_BIN` 可选择发行二进制，设置 `OFFICECLI_WORKSPACE_DIST` 可指定构建目录。默认优先使用已构建的 release 二进制，缺少时才回退到 debug；脚本不会自动编译 Rust。日常使用和性能验证请构建 release，debug 保留完整调试开销。

`npm run typecheck --prefix apps/workspace` 检查工作台的 TypeScript 源码。源码入口可用 Node.js 24.13+ 直接启动。独立发行包和 Docker 镜像使用编译后的 `app/cli.mjs` 和运行模块。数据库驱动按工作区所选后端加载。

Word 的原格式下载优先保留原 OOXML 包，并将支持的正文、表格行列和合并变化写回正文；不会自动改用有损语义重建。PDF 使用与编辑器分页预览相同的字体、分节和页眉页脚规则，并验证导出页数、每页纸张尺寸和文字；中文部首等字形别名的 Unicode 映射按预览正文校正，保持原有绘制内容。该 PDF 路径需要服务器安装 Chromium/Chrome/Edge，也可用 `OFFICECLI_PDF_BROWSER` 指定可执行文件；缺少排版引擎或一致性校验失败时会停止导出，不会返回替代版式。浏览器以临时独立配置运行，文档资源内联且不允许文档发起网络请求。

初始化密码由环境变量提供，没有默认账号密码。先将 `OFFICECLI_BOOTSTRAP_PASSWORD` 注入当前终端，再执行：

```bash
node apps/workspace/cli.mjs init \
  --root /srv/officecli-workspace \
  --public-url http://127.0.0.1:7400 \
  --admin admin
unset OFFICECLI_BOOTSTRAP_PASSWORD
node apps/workspace/cli.mjs start --root /srv/officecli-workspace
```

打开 `http://127.0.0.1:7400` 登录。开发机可以把 root 换为自己可写的绝对路径。密码为 12–1024 个字符且 UTF-8 不超过 1024 字节；使用 `--password-env NAME` 指定其他注入变量。重复 init 拒绝覆盖已有业务库或身份。

默认前台端口 7400、引擎 7401、协作 7402；可在 init 时通过 `--engine-port`、`--collab-port` 指定。后两者只监听 loopback。非 loopback 的 `--public-url` 必须为 HTTPS origin；由部署侧的 TLS 反向代理转发到本机 HTTP，且支持 `/collaboration` WebSocket upgrade，保留原始 Host。CLI 自身不终止 TLS。端口、origin 与服务身份保存在 root 中，启动不会根据临时环境重新签发密钥。

## 使用流程

1. 在“用户与角色”创建成员；管理员也可以重置密码、调整角色或停用成员，最后一个管理员受到保护。
2. 上传自己的文档，或新建 TXT、Markdown、HTML。上传接受 DOCX、XLSX、CSV、TSV、PPTX、PDF、HTML、Markdown、TXT、PNG、JPEG、WebP；具体编辑和导出能力仍取决于格式与实际内容。
3. 在文件详情为成员选择只读、编辑、文件管理员角色，并单独调整查看、编辑、下载、导出、复制、打印、历史、恢复、主题和业务回写权限。角色调整、停用与密码重置会结束该用户的全部业务登录会话。
4. “打开文档”在服务端兑换绑定文件与访问者的短期会话，按实际权限直接查看或编辑。界面不提供编辑/预览权限切换。编辑保存形成 HCD 修订；“回写业务系统”才生成新的业务文件版本。恢复历史形成新 HCD 修订，不会直接替换已确认的业务版本。
5. 在“字体目录”登记本地字体及许可证，创建不可变主题，并在文件详情指定。主题更新先进入工作区修订，检查后再回写。
6. “业务事件”显示已验签并持久接收的提交通知；“操作记录”显示账号、权限与文件业务审计。同步提交回执是业务版本的依据，Webhook 延迟或重复不另建文件版本。

管理员在「服务管理 → 回写任务」可核对原任务号、工作区修订、预期和当前业务版本。核对回执使用已登记的发布归属，发起人退出后仍可确认已经发生的提交。重试待处理的原任务会重新核验发起人的权限，并使用同一修订和任务号。遇到版本冲突时可下载两份内容，或把保留的回写稿另存为独立业务文件。重复另存会返回同一副本。未送达的通知可从原任务重投，使用原事件 ID。

管理员和文件负责人在当前工作区管理文件，普通成员只看到获授权的文件。登录后打开「应用接入」可查看本工作区的租户标识、应用标识、访问地址与 AI 开关。

## 统一工作台

登录后从 `/workbench/` 进入同一窗口的首页和文件标签。文档、表格、演示和白板可直接新建，PDF 与图片通过文件库打开。右侧全局 AI 支持同时读取或编辑所勾选的正文、单元格和白板对象；明确勾选的追加范围可以在文末或白板空白处落笔。标签上的彩色箭头跟随实际写入，文件回执带修订号。设置与用户管理仍在 `/admin`。[操作示例](../../examples/hdoc/embed-host/README.md#多标签工作台)

配置工作台模型后，可在同一指令中安排有依赖的步骤，例如先更新表格，再把保存结果整理到 Word 和白板。先审核表格的修改，保存后才会看到后续文件的预览。若协作者先更新了目标文件，可重新核对原选区，或在该文件中选择范围后点「用当前选区」。新预览需要再次确认，已保存的文件回执会保留。

对正文选句的 AI 改写与 AI 新增段落，可在任务回执中单独撤销；其他人后来在同段输入的可区分内容和格式会保留。新的表格任务也支持在同格补写后撤销 AI 文字；XLSX 保留原生文字格式，数字恢复和未被后续编辑的新建格清理一次提交。插行后按单元格身份定位。匹配有歧义、AI 原字或格式已被改动，或协作服务已接收的输入尚未保存时会拒绝撤销。适用范围、限制和双账号验证见[正文与表格撤销验收](../../docs/acceptance/hcd-workbench-selective-undo.zh.md)。

Word 当前审阅显示在正文页旁边，批注与对应原文一起滚动、缩放；点击卡片可定位原文，回复和解决状态保存在原生审阅数据中。原生 DOCX 导出重开验证见[页边批注验收](../../docs/acceptance/hcd-word-margin-comments.zh.md)。

Word 表格可通过边缘菜单向右或向下合并；按住 Shift 点击另一格可选择矩形区域后合并。拆分时内容留在第一格，其余格可直接输入。操作进入同一套撤销/重做，原格式下载保留各来源单元格的段落、文字格式和无关部件；分片或切过已有合并格的选区会拒绝，保留当前内容。

恢复多个标签时，后台表格的内部输入框不会取得其他文件或全局 AI 的键盘焦点。其选区与滚动恢复继续在自己的工作簿中执行，Word 批注定位和已经展开的文件菜单保持可用。

PPTX 支持常见占位符继承版式和母版的坐标、文字格式与主题字体，包括中文字体。原位改字、拖动占位符、母版背景、共享文字样式和基础动画均通过原件导出重开验证。母版文字支持标题、正文和其他文字的 1–9 级字体、字号、颜色及加粗等格式，保留版式与局部覆盖，见[母版文字验收](../../docs/acceptance/hcd-pptx-master-text.zh.md)。完整母版图形、复杂主题效果和高级动画仍有边界，见[占位符与母版继承验收](../../docs/acceptance/hcd-pptx-placeholder-inheritance.zh.md)。

在白板便签、备注或回复输入 `@`，从候选中选中有权访问该文件的成员。保存后，接收方可在工作台顶栏「@我」跨白板查看未读提及。点击提醒会定位便签，或展开并定位评论消息。已读状态按账号持久保存，移动对象或编辑提及周围的文字会沿用原提醒。移除提及、删除对象或撤回文件访问权限后，对应提醒从可见列表中移除。

工作台打开时定期检查已保存的白板修订，未变更的白板只核对修订号。`npm run test:acceptance --prefix apps/workspace` 通过两套真实浏览器会话验证通知、定位、重启后的已读状态和权限撤回。

## 单独嵌入与外部 Agent

「应用接入」中的文档与白板入口能各自打开一个编辑器。业务系统也可以直接挂载 React 组件，用 `chatPanel` 接入自己的聊天栏或隐藏聊天，用 `onSelectionChange` 取得实际选中的文字范围或白板对象。

要开放选区 MCP，新建工作区时添加 `--selection-mcp`，既有工作区在自己的 `config.json` 中设置 `"selectionMcp": true` 后重启。拥有该文件查看、编辑和 AI 三项权限的成员可以签发最长五分钟的选区凭据。外部 Agent 可读取选区、按段落替换文字或修改所选白板对象。工作区检查文件、修订、协作代次、成员和有效会话，写入产生可追踪的 HCD 修订。外部模型由宿主选择，内置 AI 开关独立配置。

构建后执行 `npm run demo --prefix examples/hdoc/embed-host`，即可在一个独立的本地业务系统中体验。示例准备了可编辑的 Word 和原生白板，并提供能在单独进程运行的 MCP 客户端。[业务工作台](http://fold.localhost:4417/embed-example/) · [组件、授权与客户端接入说明](../../examples/hdoc/embed-host/README.md)

## 用一个入口承载多个工作区

每个工作区分配一个域名。共享监听器按已登记的 Host 将 HTTP、白板事件流和协作 WebSocket 交给同一个工作区。工作区各自持有业务数据库、源文件、HCD 编辑引擎、协作进程和签名密钥。云端每个工作区可选 SQLite、PostgreSQL 或 MySQL，远程数据库使用独立的数据库和连接配置。两家公司可以使用相同的账号名、文件名或调用方会话 ID。公开目录、分享权限、Agent 任务和编辑回执均归属于文件所在的工作区。

下面的示例使用两个本机域名和同一个公开端口。在仓库根目录执行，先向环境注入两套独立的管理员密码。

```bash
mkdir -p ./workspace-data
node apps/workspace/cli.mjs init --root ./workspace-data/studio \
  --name 山岚设计室 --tenant-id studio --app-id office --password-env STUDIO_ADMIN_PASSWORD \
  --public-url http://studio.localhost:7400 --port 7410 --engine-port 7411 --collab-port 7412
node apps/workspace/cli.mjs init --root ./workspace-data/press \
  --name 白露编辑部 --tenant-id press --app-id office --password-env PRESS_ADMIN_PASSWORD \
  --public-url http://press.localhost:7400 --port 7420 --engine-port 7421 --collab-port 7422
```

将以下内容保存为 `./workspace-data/tenants.json`。相对路径从清单所在目录解析。

```json
{
  "workspaces": [
    { "root": "./studio", "ai": true },
    { "root": "./press" }
  ]
}
```

```bash
node apps/workspace/cli.mjs start --tenants ./workspace-data/tenants.json --port 7400
```

示例中可分别打开 [山岚设计室](http://studio.localhost:7400) 和 [白露编辑部](http://press.localhost:7400)。每个工作区使用独立的浏览器域名和登录状态。部署到业务域名时使用 HTTPS，在 TLS 代理保留原始 Host，并转发 WebSocket 升级及白板事件流。内部三个端口监听回环地址。为指定工作区开放 AI 编辑时，同时设置宿主环境变量 `OFFICECLI_AI_ENABLED=true`、配置模型并将该工作区的 `ai` 设为 `true`。用户仍需具备相应的文件权限。

既有工作区可用原 root 和已持久化的租户、应用标识继续运行。共享入口在启动时核对域名、租户与应用的组合、监听地址、数据目录及密钥。工作区启动后，某一租户的子服务退出会使该租户暂时不可用，其余租户继续服务。当前扩展单位是整个工作区，每个租户使用自己的引擎与数据目录。

双工作区浏览器验收保留了[接入页截图](../../docs/acceptance/hcd-workspace-tenants-v1/tenant-integration.png)、[公开文件库截图](../../docs/acceptance/hcd-workspace-tenants-v1/public-library.png)和[逐项结果](../../docs/acceptance/hcd-workspace-tenants-v1/validation.json)。

## 分享与匿名访问

文件负责人、管理员或具有文件管理权限的成员，可从文件详情或文档顶部打开“分享”。访问范围与访客权限分别设置：

| 访问范围 | 访问方式 | 是否需要登录 |
| --- | --- | --- |
| 仅受邀成员 | 文件负责人在“管理受邀成员”授予账号权限 | 需要使用获授权的账号 |
| 持链接的人 | 打开 `/s/<文件 ID>#<随机凭证>`；不会出现在公开目录 | 不需要 |
| 公开访问 | 从 `/public` 公开目录或 `/p/<文件 ID>` 打开 | 不需要 |

公开文件库并列展示文档与白板，可按文件名同时搜索。每一项显示实际访客权限，分别进入对应的文档或白板编辑器。

链接与公开访问可设为“可查看”或“可编辑”，并可选择 1 天、7 天、30 天或长期有效。设置只在保存后生效。可随时降级权限、重置链接或改回“仅受邀成员”；权限更新会关闭旧访客会话，已打开的浏览器会重新核对权限。仅复制现有链接不会重置会话或延长有效期。

匿名访问者由服务器分配 UUID 和“访客 XXXX”显示名，不能自行提交他人的用户 ID。临时身份通过独立的 HttpOnly Cookie 在同一浏览器内保留 24 小时；不同浏览器、清除 Cookie 或身份到期后会获得新 ID。临时身份不能登录为正式成员，也不会出现在成员授权列表中。访客加入、分享变更保留业务审计；单人协同修改的修订显示其经过认证的身份，多人共同形成的保存点保留协作服务作者，避免归给单个人。

访客的权限限于查看、复制，以及分享者明确开放的编辑；不附带历史、恢复、下载、导出、AI、业务回写或成员管理权限。引擎仍使用签名的逐文档会话执行权限检查，宿主代理另行核对临时 Cookie、分享授权及会话是否关闭。分享凭证放在 URL fragment 中；服务端只存哈希和加密副本。

接口入口：`GET /workspace/api/public/files`、`POST /workspace/api/shared/<文件 ID>/open`，以及需要文件管理权限的 `GET/PUT /workspace/api/files/<文件 ID>/sharing`。打开分享文档只接受浏览器生成的会话 UUID；链接凭证通过 `X-Workspace-Share` 提交。写入分享设置继续要求已登录会话、同源请求和 CSRF 校验。

## 数据与离线边界

```text
root/
  config.json             站点与端口配置
  keys.json               独立持久签名/传输密钥
  business.sqlite         用户、会话、ACL、业务版本、提交回执、已收事件与审计
  objects/                按 SHA-256 保存的不可变源文件和最终版本
  staging/                尚未确认提交的业务文件
  engine-integration.json 自动生成的引擎接入配置（只存密钥环境变量名）
  engine/                 OfficeCLI HCD、源基线、协作、映射、发布与事件 outbox
```

外部接入时，客户业务 Provider 替换账号、权限与源/最终版本的权威来源；OfficeCLI 继续持久保存 HCD 和协作数据。内置 Provider 也实施精确源版本读取、上传校验、expectedVersion CAS、幂等提交和结果查询。源版本不会被回写覆盖。

运行资源已本地构建并由同一个站点提供，不需要在线 npm 或开发服务器。AI 默认关闭，在个人配置发现前设置 `HCD_AI_ENABLED=false` 并清除继承的模型 key；远端存储配置继续隔离。通过 `OFFICECLI_AI_ENABLED=true` 启动时，自由画布可以使用现有模型配置，并要求 Provider 授予 `document.view`、`document.edit`、`document.ai` 三项权限。访客不获得 AI 权限。选区 MCP 通过独立的 `--selection-mcp` 配置和逐文件权限提供文档、表格与白板操作。

启用 AI 时，内置 Provider 只授权实际传给引擎的 `HCD_OPENAI_MODEL`；外部 Provider 必须显式返回 `constraints.modelIds`，空名单拒绝模型调用。任务启动及后续每次调用均重新校验。

自由画布基于 Excalidraw，首页或「白板空间」中的「新建白板」可创建 `.excalidraw`。支持自由绘制、对象编辑、多人协作、框选对象或空白区域后交给 AI、历史恢复，以及原生文件/PNG 导出。回写业务系统保留可继续编辑的原生场景。模块边界、事务协议与能力限制见 [自由画布接入说明](../../docs/hcd-canvas-v1.zh.md)。

## 离线发行与版本切换

Docker Compose、Linux 归档、HTTPS 反代和 macOS Electron 离线包的部署与验收命令见[工作台部署与桌面打包](../../docs/workspace-distribution.zh.md)。

在构建机器准备当前平台的 OfficeCLI、已锁定的前端依赖、构建后的静态资源和 Node.js 发行目录。封装命令会把 Node.js、原生引擎、协作与 MCP、界面、模板和第三方许可随包复制，并生成带平台、版本、协议指纹和逐文件 SHA-256 的 `release.json`。

```bash
npm run package --prefix apps/workspace -- \
  --version 0.1.31 --node-runtime /opt/node-v24 --output /tmp/fold-0.1.31
```

把发行目录复制或归档到与包匹配的系统和 CPU。安装使用包内运行时，启动机只需要系统基础库和支持的浏览器。包内静态资源由工作区同源提供。AI 在首次安装时默认关闭。

```bash
/media/fold-0.1.32/workspace release-info
/media/fold-0.1.32/workspace install --deployment /srv/fold \
  --public-url http://127.0.0.1:7400 --password-env FOLD_INITIAL_ADMIN_PASSWORD
/srv/fold/workspace start
/srv/fold/workspace deployment-status
/srv/fold/workspace upgrade --release /media/fold-0.1.33
/srv/fold/workspace rollback
```

`install --backup <校验通过的备份目录>` 可用已有工作区来建立托管部署，保留原地址、账号和文件版本。每个托管部署管理一个工作区。多工作区可分别安装，并由内网入口按域名转发。`start --tenants` 仍支持从同一进程启动非托管的租户清单。

升级先验证发行包，随后保存已同步的协作修改，等待已受理的写入结束。旧版退出后封存升级前数据，新版在独立副本上运行迁移。引擎版本、协议指纹与协作服务通过检查后才发布新版本，切换期间访问可能暂不可用。新版在发布前启动失败时，管理进程自动用以前的数据和发行包恢复服务。

`rollback` 将服务切回记录中的上一组发行和数据。当前版本的数据会先封存并保存在独立目录，回滚后的文件视图对应上一版留存的数据。用 `rollback --to <数据版本 ID>` 可固定目标，重复执行同一个目标会保留其激活状态。`deployment-status` 显示当前和上一组标识，`operations/` 保存切换记录，`backups/` 保存切换前的快照。当前内置工作区支持在现有存储主版本内升级，无法读取的存储版本会在切换前被拒绝。

`npm run test:deployment --prefix apps/workspace` 用 `OFFICECLI_RELEASE_PACKAGE` 指定发行目录。测试在隔离数据目录验证首次安装、浏览器冷启动、真实迁移、启动失败自动恢复及回滚。macOS 命令进程通过系统策略限制为 loopback。Linux 验收可把包和测试夹具放入 `--network none` 的容器。

设置 `OFFICECLI_RELEASE_NATIVE_VERIFY=1` 会在安装后的工作台实际操作透视表、条件格式、OCR、图片图层、PPTX 母版文字与 Word 表格合并/拆分，再继续升级、失败恢复和回滚。验证驱动使用 Python 3 标准库生成原生 PPTX 夹具、读取导出的 XML，产品运行本身不依赖 Python。可用 `OFFICECLI_RELEASE_NATIVE_CASE=word`（或 `pivots`、`conditions`、`ocr`、`layers`、`pptx`）单独诊断一项；省略则完整执行六项。当前 macOS 与 Linux ARM64 发行、完整断网操作及在线备份的结果见[当前发行验收](../../docs/acceptance/hcd-workspace-release-current.zh.md)。

## 在线备份与恢复

在运行 Workspace 的主机上操作，每个 `--root` 对应一个租户。快照包含业务数据库、原文件与版本、项目和权限、编辑修订、协作状态、回写暂存与回执，以及当前配置和签名密钥。取点时系统先落盘已同步的协作修改，等待已受理的写入完成。取点期间的新写入会返回可重试的 `503`，读取业务库的请求可能需要等待数据库快照。原有协作连接会在取点完成后继续同步。复制到指定目录和逐文件校验在开放写入后进行。

```bash
node apps/workspace/cli.mjs backup --root ./workspace-data --output /backup/fold-2026-11-20
node apps/workspace/cli.mjs verify-backup --backup /backup/fold-2026-11-20
node apps/workspace/cli.mjs restore --backup /backup/fold-2026-11-20 --root ./workspace-restored
node apps/workspace/cli.mjs start --root ./workspace-restored
```

用已有父目录下的新路径作为备份目标和恢复目标。恢复校验每个文件的 SHA-256、快照数据库完整性和文件版本对应的对象。用 `restore --database postgres` 或 `restore --database mysql` 可以导入空的目标数据库，省略参数则恢复为 SQLite。恢复保留原域名和端口，同机启动恢复实例前须腾出这些监听地址。服务账号应限制备份目录的访问权限，因为其中含密钥。外部 Provider 管理的业务数据库和文件使用其自身的备份流程。[数据库接入与切换](../../docs/workspace-distribution.zh.md#数据库与文件存储)

设置 `FOLDLY_TEST_POSTGRES_URL_FILE` 和 `FOLDLY_TEST_MYSQL_URL_FILE` 指向两个空验收数据库的连接文件，再运行 `npm run test:databases --prefix apps/workspace`。该命令将同一工作区依次恢复到 PostgreSQL、MySQL 和 SQLite，并在每次恢复后验证登录、权限、原件、编辑发布和导出。

`npm run test:backup --prefix apps/workspace` 使用真实工作区和两页协作编辑器，验证在线读写时的取点、备份损坏拒绝、异目录恢复、DOCX 导出及原回写任务续跑。

## 验证

```bash
npm test --prefix apps/workspace
npm run test:workbench-pptx --prefix apps/workspace
# 需先安装 fixtures/native-office/requirements.txt 中的测试依赖和 Poppler。
npm run test:workbench-native --prefix apps/workspace
npm run test:embed --prefix apps/workspace
cargo test -p officecli --bin officecli hdoc_server::integration:: --offline
# 打包后的自由画布验收；模型为本地脚本，不消耗外部 API Key。
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  node apps/workspace/scripts/verify-canvas.mjs
# 双租户验收使用真实引擎、浏览器和本地测试模型，可用 OFFICECLI_TENANT_ARTIFACTS 指定截图及结果目录。
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:tenants --prefix apps/workspace
# 先完成上述构建。也可省略此环境变量，使用 Playwright 已安装的 Chromium。
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:acceptance --prefix apps/workspace
```

长文档表格性能回归使用 release 引擎，测量点击新增行/列到新单元格重新可编辑的完整耗时，并检查操作全程的滚动位置和排版：

```bash
OFFICECLI_BIN="$PWD/target/release/officecli" HCD_TABLE_MAX_LATENCY_MS=1000 \
  npm run test:workspace --prefix examples/hdoc/editor -- --grep 'long Word table insertion'
```

验收启动隔离临时 root 与随机端口，使用随机密码和密钥，结束后停止自己创建的进程。临时 root 保留用于诊断，不作为可继续登录的业务工作区交付。结果与截图写入 `docs/acceptance/hcd-default-workspace-v1/`，可通过 `OFFICECLI_WORKSPACE_ARTIFACTS` 改写路径；`OFFICECLI_SKIP_BROWSER=1` 仅运行接口验证，报告会明确标识浏览器未验收。

浏览器验收还覆盖分享面板、独立匿名浏览器的只读与协同编辑、临时身份恢复、修订作者、权限降级、链接轮换、停止公开分享和手机端布局。顶部不显示“可编辑／可查看”；左右面板停靠在当前编辑器内，保留原有圆角与间距，正常占位，不覆盖正文。左栏在右上角收起，右栏在左上角收起；关闭后从两侧固定窄轨恢复。展开、收起只调整正文可用宽度，不重新创建编辑器。手机面板使用内容列，关闭后返回原正文，没有画布遮罩。底部保留访客编号。当前设计见 `docs/design/officecli-workspace-v2.pen` 的 81–86 号画板及 [圆角停靠面板 V2](../../docs/design/officecli-docked-panels-v2/README.md)。

[产品职责与 WPS 参考](../../docs/hcd-product-integration-v1.zh.md) · [外部 Provider 验收](../../docs/acceptance/hcd-provider-integration-v1.zh.md) · [默认 Workspace 验收](../../docs/acceptance/hcd-default-workspace-v1.zh.md)
