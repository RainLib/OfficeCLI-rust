# OfficeCLI Workspace

这是当前默认业务应用的入口：V2 管理台、账号登录、文件版本库、逐文件权限、编辑器、协作服务和内置业务 Provider。与外部系统接入共用 `/officecli-provider/v1` 契约和 Rust 发布链路，不依赖测试 fixture，也无需用户粘贴管理或文档令牌。

## 构建与启动

需要 Node.js 24.13+、Rust 构建工具，以及当前平台支持的浏览器。构建阶段安装依赖；运行阶段只使用 Node.js、OfficeCLI 二进制和已构建的本地资源，不运行 npm、Vite 或 tsx。

在仓库根目录执行：

```bash
npm ci --prefix examples/hdoc/admin-app
npm ci --prefix examples/hdoc/editor
npm ci --prefix examples/hdoc/xlsx-univer-viewer
cargo build -p officecli --bin officecli
node apps/workspace/scripts/build.mjs
```

构建输出 `apps/workspace/dist/`，包含单页后台、编辑器及 worker/异步资源、独立打包的协作 sidecar 和当前平台的 OfficeCLI。设置 `OFFICECLI_BIN` 可选择发行二进制，设置 `OFFICECLI_WORKSPACE_DIST` 可指定构建目录。默认使用本次构建前已存在的 debug 二进制，脚本不会自动编译 Rust。

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
2. 上传自己的文档，或新建 TXT、Markdown、HTML。上传接受 DOCX、XLSX、PPTX、PDF、HTML、Markdown、TXT、PNG、JPEG、WebP；具体编辑和导出能力仍取决于格式与实际内容。
3. 在文件详情为成员选择只读、编辑、文件管理员角色，并单独调整查看、编辑、下载、导出、复制、打印、历史、恢复、主题和业务回写权限。角色调整、停用与密码重置会结束该用户的全部业务登录会话。
4. “进入编辑器”先在服务端兑换绑定文件与真实用户的短期会话。编辑保存形成 HCD 修订；“回写业务系统”才生成新的业务文件版本。恢复历史形成新 HCD 修订，不会直接替换已确认的业务版本。
5. 在“字体目录”登记本地字体及许可证，创建不可变主题，并在文件详情指定。主题更新先进入工作区修订，检查后再回写。
6. “业务事件”显示已验签并持久接收的提交通知；“操作记录”显示账号、权限与文件业务审计。同步提交回执是业务版本的依据，Webhook 延迟或重复不另建文件版本。

管理员和文件负责人拥有文件的全部操作；普通成员只看到明确授权的文件。内置部署目前是单信任域、单实例，不提供共享多租户隔离或任意多副本扩容。

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

运行资源已本地构建并由同一个站点提供，不需要在线 npm 或开发服务器。默认强制 `HCD_AI_ENABLED=false`，在任何个人配置发现前关闭模型读取，并清除继承的模型 key 与远端存储选择；宿主模式 AI/MCP 委托尚未开放。内网模型接入仍是待办，当前不能将导出或 AI 的权限定义当作相应格式能力已经实现。

**完整断网发行包尚未完成验收。** 当前证据为：干净浏览器拦截非 loopback 请求，验证默认应用的登录、字体/主题、编辑和回写。尚不包括全格式、全部浏览器、目标网 OS/字体依赖、运行时分发、备份迁移工具及升级回滚。不要把这项验证解释为全新断网机器的完整交付承诺。

备份前停止 Workspace 并等待子进程退出，再完整备份 root（含 SQLite WAL/SHM、engine、staging 与 keys），按同样路径恢复并启动。密钥应受限保管；仅备份最终文件或仅备份 SQLite 都无法恢复完整编辑状态。当前未提供在线一致性备份或自动升级迁移命令，禁止跨不兼容 schema 直接写库。

## 验证

```bash
npm test --prefix apps/workspace
cargo test -p officecli --bin officecli hdoc_server::integration:: --offline
# 先完成上述构建。也可省略此环境变量，使用 Playwright 已安装的 Chromium。
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:acceptance --prefix apps/workspace
```

验收启动隔离临时 root 与随机端口，使用随机密码和密钥，结束后停止自己创建的进程。临时 root 保留用于诊断，不作为可继续登录的业务工作区交付。结果与截图写入 `docs/acceptance/hcd-default-workspace-v1/`，可通过 `OFFICECLI_WORKSPACE_ARTIFACTS` 改写路径；`OFFICECLI_SKIP_BROWSER=1` 仅运行接口验证，报告会明确标识浏览器未验收。

[产品职责与 WPS 参考](../../docs/hcd-product-integration-v1.zh.md) · [外部 Provider 验收](../../docs/acceptance/hcd-provider-integration-v1.zh.md) · [默认 Workspace 验收](../../docs/acceptance/hcd-default-workspace-v1.zh.md)
