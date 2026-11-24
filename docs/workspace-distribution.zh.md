# Foldly 工作台部署与桌面打包

Linux 工作台和 macOS Electron 桌面端共用原生引擎、Web 编辑器、HCD 格式及协作协议。每次交付使用同一版本和同一份编辑器构建产物。按目标系统和 CPU 构建原生引擎，并核对两端的 `release.json` 中引擎版本与协议指纹。

Linux 工作台启用账号、团队项目、文件权限、分享和业务回写。桌面只启动本机工作区，使用独立的 SQLite、文件目录、签名密钥和本地会话。团队管理、分享、AI、MCP 和业务回写由桌面服务端关闭。两端可通过导入和导出原生文件交换内容。

## 下载 0.1.34

| 适用平台 | 工作台包 |
| --- | --- |
| Linux ARM64 | [Linux ARM64 工作台归档](https://github.com/RainLib/Foldly/releases/download/v0.1.34/foldly-workspace-0.1.34-linux-arm64.tar.gz) |
| Linux x86_64 | [Linux x86_64 工作台归档](https://github.com/RainLib/Foldly/releases/download/v0.1.34/foldly-workspace-0.1.34-linux-x86_64.tar.gz) |
| macOS Apple Silicon | [Electron 离线测试包（ad-hoc 签名）](https://github.com/RainLib/Foldly/releases/download/v0.1.34/foldly-desktop-0.1.34-macos-arm64.zip) |

将归档和工作台校验清单保存在同一目录。Linux 用 `sha256sum --ignore-missing -c WORKSPACE-SHA256SUMS` 校验，macOS 用 `shasum -a 256 --ignore-missing -c WORKSPACE-SHA256SUMS` 校验。[工作台校验清单](https://github.com/RainLib/Foldly/releases/download/v0.1.34/WORKSPACE-SHA256SUMS) · [GitHub Release v0.1.34](https://github.com/RainLib/Foldly/releases/tag/v0.1.34)

## Docker Compose 云端工作台

默认的 `docker compose up` 会启动 `workspace`、`postgres`、`proxy` 和一个独立的 `collaboration` 实例。工作台依赖 PostgreSQL 并启动 OfficeCLI 文档引擎，协作实例单独运行 Yjs/Hocuspocus。引擎和至少一个协作实例就绪后，工作台才会通过启动检查。编辑器、管理后台和 `/collaboration` WebSocket 从 Caddy 的同一个入口访问。

工作台镜像包含 Office 模板和 PDF 渲染依赖。工作台与协作实例使用同一镜像的两个命令。文档、修订和持久化的 Yjs 状态位于 `workspace_data` 卷，业务数据库位于 `foldly_postgres` 卷，Caddy 证书位于 `caddy_data` 卷。协作实例仅挂载工作台自动生成的内部凭证，并通过私有网络上的工作台接口访问引擎。部署需要 Docker Engine 和 Docker Compose 2.24.4 或以上，以支持数据库配置合并。[Docker Compose 文件合并](https://docs.docker.com/reference/compose-file/merge/)

容器中的 Chromium 以 `node` 用户运行。Compose 加载固定版本的 seccomp 配置，为 PDF 渲染沙箱提供用户命名空间支持。[Playwright v1.65.1 的配置](https://github.com/microsoft/playwright/blob/v1.65.1/utils/docker/seccomp_profile.json)

### 从当前源码启动

在仓库根目录为新部署准备 `.env`、管理员密码和 PostgreSQL 密钥。下面的 `read` 会隐藏键入的工作台管理员密码，密码至少 12 个字符。已有部署沿用自己的项目名和密钥文件，并按下文选择原来的数据库配置。

```bash
cp .env.example .env
mkdir -p .secrets
chmod 700 .secrets
read -r -s FOLDLY_INITIAL_PASSWORD
(
  set -eC
  umask 077
  printf '%s\n' "$FOLDLY_INITIAL_PASSWORD" > .secrets/foldly-admin-password
  openssl rand -hex 24 > .secrets/foldly-database-admin
  openssl rand -hex 24 > .secrets/foldly-database-password
  printf 'postgresql://foldly:%s@postgres:5432/foldly\n' \
    "$(cat .secrets/foldly-database-password)" > .secrets/foldly-database-url
)
unset FOLDLY_INITIAL_PASSWORD

docker compose up --build -d --wait
docker compose ps
docker compose top workspace collaboration
curl --fail http://localhost:7400/workspace/api/status
```

在浏览器访问 `http://localhost:7400/workbench/`，用 `FOLDLY_ADMIN` 和刚设置的密码登录。用两个有编辑权限的账号打开同一份 DOCX，核对一端的编辑会同步到另一端，再点「保存点」并导出。管理员可访问同站点的 `/admin`。默认入口仅监听服务器本机。

### 协作实例扩容与故障切换

在同一个 Compose 项目中扩到两个副本。后续执行 `up` 时继续传入所需的副本数。

```bash
docker compose up -d --no-build --wait --scale collaboration=2
docker compose ps collaboration
docker compose logs --tail 100 workspace collaboration
```

工作台按文档 ID 分配协作实例。同一份文档的用户进入同一房间，增加副本时已分配的房间保留原实例。实例失联后，客户端通过原入口重连。工作台先更换该文档的写入凭证，引擎据此拒绝旧实例的写入，再让新实例恢复已持久化的 Yjs 状态。已落盘但尚未形成文档修订的内容，会在房间恢复后进入保存流程。

浏览器先通过工作台的登录或分享会话，协作实例随后核对当前文档、编辑权限和协作版本。通过 API 嵌入编辑器的客户端应使用编辑会话返回的完整 `collabUrl`，包括其中的路由参数。更新镜像后刷新已打开的编辑页。

此拓扑用于单主机 Compose。工作台与文档引擎各运行一个实例，协作副本分摊不同文档的长连接和计算。操作备份时，工作台让在线协作实例暂停接收新修改并保存已接收的编辑，再通过引擎写入屏障取得数据快照。快照包括文档、修订、Yjs 状态及业务数据库，可以按下方的恢复流程导入新项目。

在独立的测试项目中验证双人编辑、故障切换和 PostgreSQL 快照恢复。需要 Node.js 24.13 或以上、Docker Compose，以及安装了依赖和 Chromium 的编辑器测试环境。[重连后的工作台截图](acceptance/compose-collaboration.png)

```bash
npm ci --prefix examples/hdoc/editor
npm exec --prefix examples/hdoc/editor -- playwright install chromium
npm run --prefix apps/workspace test:compose-collaboration
```

### 构建并推送双架构镜像

发布到 GitHub Container Registry 的 `ghcr.io/rainlib/foldly-workspace`。本地发布使用有 `write:packages` 权限的 classic token。首次推送后检查 Package 可见性为 Private。构建器需要支持 `linux/amd64` 和 `linux/arm64`，两种架构共用同一份编辑器资源。Docker Desktop 自带跨架构运行支持，独立 Linux 构建机可使用能运行这两种架构的 Buildx 构建器。[GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) · [Docker 多平台构建](https://docs.docker.com/build/building/multi-platform/)

```bash
docker login ghcr.io --username RainLib
FOLDLY_IMAGE="ghcr.io/rainlib/foldly-workspace:$(git rev-parse --short HEAD)"
docker buildx build --platform linux/amd64,linux/arm64 \
  --tag "$FOLDLY_IMAGE" --push .
docker buildx imagetools inspect "$FOLDLY_IMAGE"
```

公开发布时，在 Package settings 的可见性设置中将包改为 Public，再用无 GHCR 凭据的 Docker 客户端拉取同一标签验证。[GitHub Package 可见性设置](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility#configuring-visibility-of-packages-for-your-personal-account)

### 从 GHCR 镜像部署

把 `docker-compose.yaml`、`.env.example` 和 `deploy/workspace/` 放到服务器的部署目录，按上面的方式准备 `.env` 和密码文件。将域名的 DNS 指向服务器，开放 TCP 80 和 443。从 `v0.1.34` 标签取得部署文件，在 `.env` 使用该版本的双架构 GHCR 镜像。

```dotenv
FOLDLY_IMAGE=ghcr.io/rainlib/foldly-workspace:0.1.34
FOLDLY_PUBLIC_URL=https://foldly.example.com
FOLDLY_PROXY_SITE=foldly.example.com
FOLDLY_LISTEN_ADDR=0.0.0.0
FOLDLY_HTTP_PORT=80
FOLDLY_HTTPS_PORT=443
```

```bash
docker compose pull
docker compose up -d --no-build --wait
curl --fail https://foldly.example.com/workspace/api/status
docker compose logs --tail 100 workspace collaboration proxy
```

公开镜像可以直接拉取。若 Package 仍是私有的，先执行 `docker login ghcr.io`，使用有 Package 读取权限的 GitHub 账号和带 `read:packages` 的 classic token 登录。Compose 按服务器架构拉取镜像。更新时先备份，再更换 `FOLDLY_IMAGE` 的标签或清单摘要，重新拉取并启动。`docker compose down` 保留已有数据卷。使用同一个 Compose 项目名管理同一部署。

使用已构建的双架构镜像归档时，先导入归档，再在 `.env` 中指定归档内的镜像名。

```bash
docker image load -i /path/to/foldly-workspace.docker.tar.gz
docker compose up -d --no-build --wait
```

管理员登录 `/admin` 管理用户、角色、文件权限和业务回写。

编辑器的 AI 默认关闭。通过 `.foldly.runtime.env` 设置 `OFFICECLI_AI_ENABLED=true`、`OPENAI_API_KEY` 和 `HCD_OPENAI_MODEL`，兼容接口可另设 `HCD_OPENAI_BASE_URL`。该文件应只允许部署账号读取。

工作台的全局 AI 使用独立的模型配置。首次初始化时，在 `.env` 设置 `FOLDLY_SELECTION_MCP=true`，再通过 `.foldly.runtime.env` 设置 `OFFICECLI_WORKBENCH_OLLAMA_MODEL` 和容器可访问的 `OFFICECLI_WORKBENCH_OLLAMA_URL`。

### 数据库与文件存储

业务数据库保存账号、会话、权限、分享、文件和版本索引。原文件保存在工作区的 `objects/`，修订和协作数据保存在 `engine/`。云端业务库可选 SQLite、PostgreSQL 15+ 或 MySQL 8.4+（InnoDB）。生产部署优先使用 PostgreSQL，已有 MySQL 基础设施可直接使用 MySQL。Electron 使用应用资料目录中的独立 SQLite 工作区，支持离线读写。

每个工作区使用独立数据库，由一个工作台实例持有。PostgreSQL 使用 UTF-8 的专用库及其 `public` schema。连接应直连数据库，或使用保留会话的代理。内置引擎继续使用本地工作区目录。独立 HCD 引擎的 PostgreSQL 和 S3 设置用于引擎数据。

#### 随 Compose 启动 MySQL

新建 MySQL 部署时，在 `.env` 设置以下文件列表。首次生成密钥时，沿用上面的三个数据库密钥文件名，把连接地址设为 `mysql://foldly:<数据库用户密码>@mysql:3306/foldly`。Compose 会启动 MySQL、工作台、协作服务和 Caddy，后续继续使用 `docker compose up -d --build --wait`。

```dotenv
COMPOSE_FILE=docker-compose.yaml:deploy/workspace/compose.mysql.yaml
```

工作台使用专用的 `foldly` 数据库账号。PostgreSQL 和 MySQL 使用各自的数据卷。已有 PostgreSQL 或 MySQL 部署更新时沿用原来的项目名、Compose 文件选择和密钥文件。

#### 使用 SQLite 或连接已有的数据库

已有 SQLite 或接入托管数据库的 Compose 部署，在更新版本前用以下文件列表指定原有存储。SQLite 部署继续使用原项目和 `workspace_data` 卷。新建 SQLite 部署只需准备工作台管理员密码。

```dotenv
COMPOSE_FILE=docker-compose.yaml:deploy/workspace/compose.external.yaml
FOLDLY_DATABASE=sqlite
```

使用已有的 PostgreSQL 或 MySQL 时，把 `FOLDLY_DATABASE` 设为对应类型。在仅部署账号可读的 `.foldly.runtime.env` 中设置 `FOLDLY_DATABASE_URL`，使用 `postgresql://user:password@host:5432/database?tls=true` 或 `mysql://user:password@host:3306/database?tls=true` 格式。账号和密码中的保留字符需要 URL 编码。启用 TLS 时验证服务证书和主机名，如需私有 CA，可把证书挂载到容器内并配置 `FOLDLY_DATABASE_URL_CA_FILE`。

二进制发行包直接启动时，首次用 `workspace init --database postgres …` 或 `workspace init --database mysql …`。连接地址可从 `FOLDLY_DATABASE_URL_FILE` 读取。多租户可以用 `--database-url-env` 给每个工作区指定独立的环境变量名，并使用对应的 `<变量名>_FILE` 文件。配置只记录数据库类型、连接变量名和绑定 ID，地址和密码由环境或文件提供。

### 带入已有云端工作空间

在现有 Linux 工作台上用 `workspace backup` 生成快照，或从运行中的 Compose 项目导出。备份包含文档、账号、权限和密钥，将其存到受保护的位置。

```bash
FOLDLY_BACKUP_NAME="foldly-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$FOLDLY_BACKUP_NAME"
docker compose exec -T workspace foldly backup \
  --root /var/lib/foldly/workspace --output "/tmp/$FOLDLY_BACKUP_NAME"
docker compose exec -T workspace foldly verify-backup --backup "/tmp/$FOLDLY_BACKUP_NAME"
docker compose cp "workspace:/tmp/$FOLDLY_BACKUP_NAME/." "$FOLDLY_BACKUP_NAME/"
docker compose exec -T --user node workspace rm -r "/tmp/$FOLDLY_BACKUP_NAME"
```

恢复前将 `.env` 中的 `FOLDLY_PUBLIC_URL` 和 `FOLDLY_INTERNAL_PORT` 设为备份工作区的原始地址和端口。下例使用已构建的工作台镜像，恢复到新的 PostgreSQL Compose 项目。在新服务器启动，或先停用占用同一端口的原入口。备份目录需要让镜像内的 `node` 用户（UID 1000）可读。

```bash
FOLDLY_BACKUP=/absolute/path/to/verified-backup
docker compose -f docker-compose.yaml -p foldly-restored up -d --wait postgres
docker compose -f docker-compose.yaml -p foldly-restored run --rm --no-deps \
  --volume "$FOLDLY_BACKUP:/backup:ro" workspace \
  restore --backup /backup --root /var/lib/foldly/workspace --database postgres
docker compose -f docker-compose.yaml -p foldly-restored up -d --no-build --wait
```

用原账号登录并核对文件与权限。后续用 `-p foldly-restored` 管理这个部署。首次启动的密码文件由 Compose 挂载，已恢复的工作空间使用备份中的账号。

#### 切换业务数据库

SQLite、PostgreSQL、MySQL 都使用相同的工作区快照格式。备份会协调文档与协作写入，封存业务记录、文件对象、修订和签名密钥。计划切换时先暂停旧部署的用户入口，取得并校验最终快照，再停止旧工作台。保留源目录、源数据库和快照，直到目标通过验收。

下面把快照恢复到一个使用 PostgreSQL 的新 Compose 项目。`.env.postgres` 保留原访问域名和端口，并通过 `FOLDLY_DATABASE_ADMIN_PASSWORD_FILE`、`FOLDLY_DATABASE_PASSWORD_FILE` 和 `FOLDLY_DATABASE_URL_FILE` 指向目标部署的密钥文件。`FOLDLY_IMAGE` 指向已构建的工作台镜像。

```bash
foldly_target() {
  docker compose --env-file .env.postgres -p foldly-postgres \
    -f docker-compose.yaml "$@"
}
foldly_target up -d --wait postgres
foldly_target run --rm --no-deps --volume "$FOLDLY_BACKUP:/backup:ro" workspace \
  restore --backup /backup --root /var/lib/foldly/workspace --database postgres
foldly_target up -d --no-build --wait
```

MySQL 使用对应 Compose 配置，先启动 `mysql`，再用 `--database mysql` 恢复。SQLite 使用 `compose.external.yaml` 和 `--database sqlite` 恢复。托管数据库使用同一附加配置及对应的数据库类型和连接地址。恢复需要独立的新目录，网络数据库需要空库。导入在目标事务中逐表读回校验，成功后才发布新工作区配置。登录目标核对项目成员、原文件、历史版本和现有编辑内容，然后切换入口。若在目标尚未承接新写入时需要回退，停用目标并重新启用源部署。

归档版的 `install/upgrade/rollback` 控制器通过复制本地数据实现版本切换，适用于 SQLite。使用 PostgreSQL 或 MySQL 的部署用 Compose 或 `workspace start --root` 运行，并在升级前留存已验证的工作区快照。

## 构建共用资源

在构建机准备 Node.js 24.13+、Rust 工具链和[工作台的前端依赖](../apps/workspace/README.zh.md#构建与启动)。在同一源码版本和 Cargo 锁文件下构建各平台引擎。先在一台构建机生成编辑器、协作和模板资源，再把输出目录复制到另一构建机。

```bash
cargo build --release -p officecli --bin officecli
OFFICECLI_BIN="$PWD/target/release/officecli" \
  OFFICECLI_WORKSPACE_DIST="$PWD/dist/workspace-assets" \
  node apps/workspace/scripts/build.mjs
```

各平台在自己的资源副本中用本平台的 `target/release/officecli` 替换 `officecli`。保留其余资源逐文件一致，尤其是字体、OCR、前端 worker 和协作脚本。封装机需要已解包、与目标平台匹配的 Node.js 发行目录，其中有 `bin/node` 和 `LICENSE`。打包脚本从构建依赖收集第三方许可。

## Linux 工作台包

选择与服务器 CPU 匹配的 ARM64 或 x86_64 归档。使用有 glibc 的发行版。运行中的工作台使用包内 Node.js 和原生引擎，并从同一站点提供静态资源。

### ARM64 打包

```bash
npm ci --prefix apps/workspace
FOLDLY_VERSION=0.1.34
FOLDLY_LINUX_KIT="foldly-workspace-${FOLDLY_VERSION}-linux-arm64"
node apps/workspace/scripts/package.mjs \
  --version "$FOLDLY_VERSION" \
  --node-runtime /opt/node-v24 \
  --assets "$PWD/dist/workspace-linux-assets" \
  --output "$PWD/dist/$FOLDLY_LINUX_KIT"
tar -C dist -czf "dist/$FOLDLY_LINUX_KIT.tar.gz" "$FOLDLY_LINUX_KIT"
```

### x86_64 打包

在 Linux x86_64 构建机上运行，或使用 `linux/amd64` 容器。使用与目标服务器兼容的 glibc 构建环境，本次使用 Debian 12。准备 Linux x64 版 Node.js 发行目录和同版本的共用资源，沿用 ARM64 构建时的 `Cargo.lock`。下面从已解包的 ARM64 工作台复制 `app/dist`，保留编辑器、协作脚本和模板的原始字节。

```bash
npm ci --prefix apps/workspace
FOLDLY_VERSION=0.1.34
FOLDLY_COMMON_ASSETS=/path/to/foldly-workspace-0.1.34-linux-arm64/app/dist
FOLDLY_X86_NODE=/opt/node-v24-linux-x64
FOLDLY_LINUX_KIT="foldly-workspace-${FOLDLY_VERSION}-linux-x86_64"

mkdir -p dist
FOLDLY_X86_ASSETS="$(mktemp -d "$PWD/dist/workspace-linux-x86_64-assets.XXXXXX")"
cp -a "$FOLDLY_COMMON_ASSETS/." "$FOLDLY_X86_ASSETS/"
cargo build --locked --release -p officecli --bin officecli
install -m 755 target/release/officecli "$FOLDLY_X86_ASSETS/officecli"
strip --strip-debug "$FOLDLY_X86_ASSETS/officecli"
node apps/workspace/scripts/package.mjs \
  --version "$FOLDLY_VERSION" \
  --node-runtime "$FOLDLY_X86_NODE" \
  --assets "$FOLDLY_X86_ASSETS" \
  --output "$PWD/dist/$FOLDLY_LINUX_KIT"
tar -C dist -czf "dist/$FOLDLY_LINUX_KIT.tar.gz" "$FOLDLY_LINUX_KIT"
"$PWD/dist/$FOLDLY_LINUX_KIT/workspace" release-info
```

清单的 `platform` 应为 `linux`，`arch` 应为 `x64`。核对共用资源的 SHA-256、引擎版本和协议指纹与 ARM64 包一致。

### 部署到 Linux 单机

准备服务账号 `foldly`、持久目录 `/srv/foldly` 和域名 `foldly.example.com`。将归档解包到该账号可读的目录。以下以 x86_64 为例，ARM64 使用对应的解包目录。命令由 `foldly` 运行，`/srv/foldly` 需可写，初次安装时 `/srv/foldly/live` 由安装命令创建。

```bash
cd /srv/foldly/releases/foldly-workspace-0.1.34-linux-x86_64
./workspace release-info
read -r -s -p "Foldly 初始管理员密码: " FOLDLY_INITIAL_PASSWORD
export FOLDLY_INITIAL_PASSWORD
./workspace install --deployment /srv/foldly/live \
  --public-url https://foldly.example.com --bind-host 127.0.0.1 \
  --port 7400 --engine-port 7401 --collab-port 7402 \
  --password-env FOLDLY_INITIAL_PASSWORD
unset FOLDLY_INITIAL_PASSWORD
```

使用 systemd 托管前台进程。将下列内容保存为 `foldly.service` 并执行 `sudo systemctl daemon-reload` 和 `sudo systemctl enable --now foldly.service`。日志用 `journalctl -u foldly.service` 查看。

```systemd
[Unit]
Description=Foldly Workspace
After=network.target
RequiresMountsFor=/srv/foldly

[Service]
User=foldly
Group=foldly
ExecStart=/srv/foldly/live/workspace start
Restart=on-failure
KillMode=mixed
TimeoutStopSec=140

[Install]
WantedBy=multi-user.target
```

TLS 在同机反代终止。保留浏览器的 Host，转发 WebSocket 升级和事件流。以下 Caddy 配置将内部 Provider、事件、对象传输和备份接口留在回环地址。通过 `curl --fail https://foldly.example.com/workspace/api/status` 检查就绪，然后以真实账号打开 `/workbench/` 验证编辑与导出。[Caddy 反向代理文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

```caddyfile
foldly.example.com {
	@internal path /officecli-provider/* /officecli-events/* /workspace/objects/* /workspace/internal/*
	respond @internal 404
	reverse_proxy 127.0.0.1:7400
}
```

通过 `/srv/foldly/live/workspace deployment-status` 获取活动数据 ID。用发行目录里的 `workspace backup --root /srv/foldly/live/workspaces/<活动数据ID> --output <新的备份目录>` 取点，再用 `workspace verify-backup --backup <备份目录>` 校验。备份目录含密钥，权限随服务账号管理。

升级用 `/srv/foldly/live/workspace upgrade --release <新发行目录>`，随后重新检查健康接口和实际文档。回退用 `/srv/foldly/live/workspace rollback`。回退以程序和数据为一组，新版期间的写入留在新版数据目录。备份、恢复和多工作区命令见[工作台手册](../apps/workspace/README.zh.md#在线备份与恢复)。

## macOS Electron 离线包

在目标架构的 Mac 上，先用共用编辑器资源和 macOS 引擎封装工作台，再用已校验的 Electron 官方压缩包生成桌面归档。Apple Silicon 示例使用 Electron 44.9.1。[Electron 官方发行](https://github.com/electron/electron/releases/tag/v44.9.1)

```bash
npm ci --prefix apps/workspace
node apps/workspace/scripts/package.mjs \
  --version 0.1.34 --node-runtime /opt/node-v24 \
  --assets "$PWD/dist/workspace-assets" --output "$PWD/dist/macos-workspace-0.1.34"
node apps/desktop/package-macos.mjs \
  --release "$PWD/dist/macos-workspace-0.1.34" \
  --electron-zip /path/to/electron-v44.9.1-darwin-arm64.zip \
  --electron-sha256 ff597552c9c7b0b16c39a7fb93a346ee7148afbd372ebcf0c18415482c49fbea \
  --output "$PWD/dist/foldly-desktop-0.1.34-macos-arm64.zip"
```

解包后打开 `Foldly Desktop.app`。首次启动创建本机用户，数据存放在 `~/Library/Application Support/Foldly Desktop/workspace/`。从首页用「导入文件」打开原生文件。编辑可用「保存点」落盘，原格式副本从文件操作菜单导出。正常关闭窗口或按 ⌘Q 时，应用先保存编辑器中的草稿，再等待本机协作服务完成落盘。保存失败时会保留窗口并显示错误。

正式对外分发时，使用项目的 Developer ID 签名并完成 Apple 公证。[Electron macOS 签名文档](https://www.electronjs.org/docs/latest/tutorial/code-signing)

原生 Office 导出使用包内引擎。高保真 Word 转 PDF 使用单独的 Chromium、Chrome 或 Edge，Linux 可用 `OFFICECLI_PDF_BROWSER` 指定。保存和导出支持范围沿用现有编辑器能力。

## 复验工作台产物

将 Linux 包解开后，在同架构的 Linux 上运行以下验收。驱动需要 Playwright 浏览器和 Python 3，并对安装后的工作台执行打开、修改、导出重开、升级和回滚。若要断网验收，将解包目录和测试驱动挂入 `--network none` 的容器，确认外网探针失败。

```bash
OFFICECLI_RELEASE_PACKAGE=/path/to/unpacked-linux-workspace \
OFFICECLI_RELEASE_NATIVE_VERIFY=1 \
  npm run test:deployment --prefix apps/workspace
```

在 Mac 上对 ZIP 运行以下验收。脚本解包并检查签名，使用独立临时用户目录。两次都验证桌面权限边界、原生文件打开、Word 保存和导出，以及编辑后立即退出再重开。第一次使用交付包的默认 Chromium 沙箱。第二次由 macOS 的回环网络策略限制整个进程树，测试启动器用 `--no-sandbox` 避免 Chromium 重复安装 Seatbelt 沙箱。外网探针必须返回 `EPERM`。

```bash
FOLDLY_DESKTOP_PACKAGE=/path/to/foldly-desktop-0.1.34-macos-arm64.zip \
  npm run test:desktop --prefix apps/workspace
FOLDLY_DESKTOP_KERNEL_OFFLINE=1 \
FOLDLY_DESKTOP_PACKAGE=/path/to/foldly-desktop-0.1.34-macos-arm64.zip \
  npm run test:desktop --prefix apps/workspace
```
