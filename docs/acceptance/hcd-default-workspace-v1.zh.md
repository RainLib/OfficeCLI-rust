# 默认 OfficeCLI Workspace · 阶段 B 验收

日期：2026-11-15。默认业务应用位于 [`apps/workspace`](../../apps/workspace/README.zh.md)，复用 V2 / Soft Canvas 管理台和原有编辑器。内置业务 Provider 是真实 SQLite/不可变文件实现；原阶段 A 的故障注入 fixture 继续单独用于外部接入测试。

## 本轮交付

- 账号登录使用 scrypt 密码散列、HttpOnly/SameSite Cookie 与 CSRF/origin 校验；显式初始化管理员，无默认密码。登录结果会重新检查并发的密码变更与停用。
- 用户创建、管理员/成员角色、停用、密码重置与最后一名管理员保护；停用、角色调整与密码重置撤销既有业务会话。
- 上传业务文件，新建 TXT/Markdown/HTML；搜索与格式筛选，负责人、访问权限、业务版本和更新时间显示实际数据。
- 逐文件 viewer/editor/manager 授权，独立限制查看、编辑、下载、导出、打印、复制、历史、恢复、主题与业务回写；普通成员只见共享文件。
- 详情展示不可变业务版本与最近回写 HCD 修订，按权限下载；编辑器继续提供 HCD 历史和恢复。恢复生成新修订，不直接改写业务版本。
- 字体登记、许可证、不可变主题及逐文档主题指定复用既有目录接口；Workspace Cookie 由同源后端换成短期管理授权，浏览器无需配置管理 token。
- 编辑器自动兑换短期文档会话并在到期前续期，保持编辑器、协作状态及未保存草稿；API、发布与下载使用最新凭据。
- prepare/upload/commit/status 经相同 Provider 协议完成业务保存；校验长度、SHA-256、权限及 expectedVersion CAS，重复 publicationId 返回原始回执。原始源版本保持不变。
- 回写通知验签、nonce 防重放、持久接收及 eventId 去重；管理页展示已接收通知和业务审计。同步回执确认业务版本，通知不推进文件 head。
- 管理台、编辑器、worker 和协作 sidecar 本地打包，同源 HTTP/API/WebSocket 入口；强制关闭默认 AI，禁止隐式读取开发机个人模型配置。

## 复现

在仓库根目录执行，构建步骤及初始化参数见 [Workspace README](../../apps/workspace/README.zh.md)：

```bash
cargo build -p officecli --bin officecli --offline
node apps/workspace/scripts/build.mjs
npm test --prefix apps/workspace
cargo test -p officecli --bin officecli hdoc_server::integration:: --offline
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:acceptance --prefix apps/workspace
```

Node 行为测试覆盖并发业务版本冲突、重复提交、prepare 后撤权、源版本保留、签名/body/path 绑定、nonce 重放、退出后实时鉴权与加密兑换恢复。文档服务 Rust 测试共 85 项通过，其中 integration 模块 6 项覆盖身份绑定、旧 token 绕过、关闭会话、根目录身份与损坏记录保护。

验收脚本使用隔离临时目录、随机端口/密码/密钥，启动真实 Rust 引擎、独立打包的 sidecar 与 Chrome。先验证接口、原始/最终文件内容和重启恢复，再通过浏览器完成账号、文件、权限、编辑与回写流程；另以新浏览器上下文验证只读成员。会话续期通过推进浏览器时钟触发真实服务端刷新，并检查原编辑器 DOM 与未保存文本仍在。此次修复了先指定主题再首次编辑时，协作服务错误地以 revision=0 判断投影初始化的问题；现在按 structurePatch 能力判断并以当前修订初始化，回归流程覆盖指定主题后编辑/回写。外部 Provider 的原有故障注入和浏览器验收也再次通过。

当前结果以 [`validation.json`](hcd-default-workspace-v1/validation.json) 为准；`browserVerified` 区分是否执行浏览器。前端 admin、standalone editor、embed 与 sidecar 构建通过。构建保留依赖 use-client/chunk size 提示和当前 macOS 既有 linker unwind 提示。

## 页面证据

- [桌面文档](hcd-default-workspace-v1/documents-desktop.png)
- [账号管理](hcd-default-workspace-v1/users-desktop.png)
- [文件授权](hcd-default-workspace-v1/file-access-desktop.png)
- [字体主题](hcd-default-workspace-v1/themes-desktop.png)
- [编辑器业务回写](hcd-default-workspace-v1/editor-publication-desktop.png)
- [业务事件](hcd-default-workspace-v1/events-desktop.png)
- [部署设置](hcd-default-workspace-v1/settings-desktop.png)
- [手机文档](hcd-default-workspace-v1/documents-mobile.png)
- [手机深色](hcd-default-workspace-v1/documents-mobile-dark.png)

## 范围与剩余工作

使用方保管源文件与已确认业务版本，OfficeCLI 保存 HCD/资产/协作/映射/发布/outbox。内置 Provider 按同样边界实现默认业务；接入客户系统时替换 Provider。每个 root 对应一个信任域、一个应用，当前只支持单实例。

这次浏览器验收禁止非 loopback 资源请求，覆盖默认后台、TXT 编辑/回写、字体/主题与只读预览。它不等于全新断网机器上的全格式发行验收：Node/OS 运行时交付、全部字体与 PDF/表格资源、全格式首开、系统级出口/DNS 审计、安装包清单、备份迁移和升级回滚仍需阶段 C 完成。状态接口与验收报告均将 `offlineReleaseVerified` 保持为 false。

内置模式目前显式关闭 AI，未开放内网模型委托或 MCP 委托；不通过开启个人模型环境变量绕过业务授权。业务事件页展示已持久接收的提交通知，不代表已实现引擎 outbox 的死信重放管理。自动发布恢复 worker、完整事件运维、客户业务版本的可视化合并，以及宿主评论/分享/重命名等可选组仍未交付。

Node 应用自身无第三方运行时安装需求，但需要预构建的当前平台 OfficeCLI、Node.js 24.13+ 与完整 dist。不能只复制单个后台 HTML，不能只备份最终文件，也不能直接用旧 schema 的程序写入新业务库。
