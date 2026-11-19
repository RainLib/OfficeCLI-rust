# 分享与匿名访问验收

日期：2026-11-16。

使用随机端口、随机账号凭据和独立临时 root，运行实际 SQLite Provider、Rust 引擎、协作 sidecar 与构建后的浏览器界面。样例文件由验收创建；未修改现有业务文件，也未验证外网部署或新的离线发行环境。

| 检查 | 结果 |
| --- | --- |
| Rust 全工作区测试 | 1,089 通过，0 失败 |
| `cargo fmt --all -- --check` | 通过 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过 |
| Workspace 单测 | 11 通过 |
| 编辑器单测 | 26 通过 |
| 受权限调整影响的文档界面回归 | 17 通过 |
| 图片工作台回归 | 9 通过 |
| Word 独立读者与 Agent 修改回归 | 1 通过，使用脚本化模型 |
| 管理台、编辑器、嵌入包和 sidecar 构建 | 通过 |
| 默认 Workspace 与匿名分享端到端验收 | 通过 |

核心验证：

1. 未登录访问私有文件被拒绝；仅通过链接分享的文件不出现在公开目录。
2. 无效链接及伪造用户 ID 被拒绝；临时访客由服务端分配 UUID，不同浏览器身份不同，同一浏览器刷新后保持身份。
3. 只读访客可以阅读，不能写入、发布、恢复历史或进入管理接口；各格式按会话权限呈现界面，不提供编辑/预览切换。
4. 两个匿名浏览器能够协作、保存和刷新恢复内容。单个作者的保存点显示其临时身份，多人共同保存保留协作服务作者。
5. 权限降级使已打开的访客变成只读；链接轮换使旧链接与旧会话失效；关闭分享会移除公开入口。
6. 公开目录及手机页面可直接打开；手机页面无横向溢出，显示自己的访客编号。
7. 匿名图片编辑者能够旋转并实际保存图片；界面不显示未授权的转换、AI、历史和业务发布操作。
8. 原生图片编辑继续支持格式转换、草稿恢复、浏览器/API 崩溃恢复及候选应用。

复跑核心验收：

```bash
npm test --prefix apps/workspace
cargo test --workspace --quiet
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
# 已构建 Rust 二进制及前端依赖后执行。
cargo build -p officecli --bin officecli
OFFICECLI_BIN="$PWD/target/debug/officecli" npm run build --prefix apps/workspace
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:acceptance --prefix apps/workspace
```

默认验收会运行 [verify-sharing.mjs](../../apps/workspace/scripts/verify-sharing.mjs)。浏览器安装在其他位置时修改 `HCD_BROWSER_PATH`；有 Playwright 自带 Chromium 时可省略该变量。

记录与截图位于 [hcd-sharing-v1](hcd-sharing-v1/)。界面回归日志保留实际命令和测试名称，便于复跑相同选择；完整前端 E2E 套件未在本轮全部运行。

[设计画板与导出图](../design/officecli-sharing-v1/README.md) · [权限与临时身份说明](../../apps/workspace/README.zh.md)
