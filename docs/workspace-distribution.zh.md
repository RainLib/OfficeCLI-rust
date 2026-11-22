# Foldly 工作台部署与桌面打包

Linux 工作台和 macOS Electron 桌面端共用原生引擎、Web 编辑器、HCD 格式及协作协议。每次交付使用同一版本和同一份编辑器构建产物。按目标系统和 CPU 构建原生引擎，并核对两端的 `release.json` 中引擎版本与协议指纹。

Linux 工作台启用账号、团队项目、文件权限、分享和业务回写。桌面只启动本机工作区，使用独立的 SQLite、文件目录、签名密钥和本地会话。团队管理、分享、AI、MCP 和业务回写由桌面服务端关闭。两端可通过导入和导出原生文件交换内容。

## 下载 0.1.32

| 适用平台 | 工作台包 |
| --- | --- |
| Linux ARM64 | [Linux ARM64 工作台归档](https://github.com/RainLib/Foldly/releases/download/v0.1.32/foldly-workspace-0.1.32-linux-arm64.tar.gz) |
| Linux x86_64 | [Linux x86_64 工作台归档](https://github.com/RainLib/Foldly/releases/download/v0.1.32/foldly-workspace-0.1.32-linux-x86_64.tar.gz) |
| macOS Apple Silicon | [Electron 离线测试包（ad-hoc 签名）](https://github.com/RainLib/Foldly/releases/download/v0.1.32/foldly-desktop-0.1.32-macos-arm64.zip) |

将归档和工作台校验清单保存在同一目录。Linux 用 `sha256sum --ignore-missing -c WORKSPACE-SHA256SUMS` 校验，macOS 用 `shasum -a 256 --ignore-missing -c WORKSPACE-SHA256SUMS` 校验。[工作台校验清单](https://github.com/RainLib/Foldly/releases/download/v0.1.32/WORKSPACE-SHA256SUMS) · [GitHub Release v0.1.32](https://github.com/RainLib/Foldly/releases/tag/v0.1.32)

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
FOLDLY_VERSION=0.1.32
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
FOLDLY_VERSION=0.1.32
FOLDLY_COMMON_ASSETS=/path/to/foldly-workspace-0.1.32-linux-arm64/app/dist
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
cd /srv/foldly/releases/foldly-workspace-0.1.32-linux-x86_64
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
node apps/workspace/scripts/package.mjs \
  --version 0.1.32 --node-runtime /opt/node-v24 \
  --assets "$PWD/dist/workspace-assets" --output "$PWD/dist/macos-workspace-0.1.32"
node apps/desktop/package-macos.mjs \
  --release "$PWD/dist/macos-workspace-0.1.32" \
  --electron-zip /path/to/electron-v44.9.1-darwin-arm64.zip \
  --electron-sha256 ff597552c9c7b0b16c39a7fb93a346ee7148afbd372ebcf0c18415482c49fbea \
  --output "$PWD/dist/foldly-desktop-0.1.32-macos-arm64.zip"
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
FOLDLY_DESKTOP_PACKAGE=/path/to/foldly-desktop-0.1.32-macos-arm64.zip \
  npm run test:desktop --prefix apps/workspace
FOLDLY_DESKTOP_KERNEL_OFFLINE=1 \
FOLDLY_DESKTOP_PACKAGE=/path/to/foldly-desktop-0.1.32-macos-arm64.zip \
  npm run test:desktop --prefix apps/workspace
```
