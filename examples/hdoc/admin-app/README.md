# OfficeCLI 管理后台

按 `docs/design/officecli-workspace-v2.pen` 的 49–65 号画板实现，沿用 V2 / Soft Canvas 的浅灰画布、圆角内容区与深色模式。管理台由 `officecli hdoc serve` 在 `/admin` 提供，使用 React、TypeScript、Tailwind v4 和本地 UI 组件。

后续正式 Workspace 的内置/外部业务 Provider、HCD 与最终文件的数据职责、细粒度权限、回写状态及完全离线交付要求，见[产品化设计](../../../docs/hcd-product-integration-v1.zh.md)。默认业务应用已通过 [`apps/workspace`](../../../apps/workspace/README.zh.md) 提供账号登录、业务文件版本库与权限管理，无需手填 token。下文保留直接连接 Rust 服务的管理工具用法。

## 页面与权限

- 工作空间：概览、文档筛选与批量主题、文档详情与修订、导入导出、AI 任务。
- 品牌资源：字体家族与许可证、上传登记、主题槽位、预览、修订与引用管理。
- 服务管理：当前管理会话、CLI 签发命令、目录操作记录、实际服务信息与编辑器入口设置。

管理会话使用 `document-id=*`、`scope=admin`，可读取后台元数据、管理字体主题并指定文档主题。正文预览和下载使用对应文档的 read 或 write 令牌，修改内容、恢复历史和停止 AI 任务使用 write 令牌；停止任务还要求签名中的 user-id 与发起人一致。导入使用独立的 upload 令牌。

令牌存入当前标签的 sessionStorage。编辑器地址作为浏览器偏好存入 localStorage；打开文档通过校验来源、窗口与一次性标识的消息交接令牌，URL 不包含凭证。编辑器需要连接同一文档服务，默认入口为 `http://127.0.0.1:8767/`。

导入导出记录保存在服务的 jobs 目录，仅展示最新 500 项，并说明损坏与截断情况；AI 任务展示当前服务进程的最近 200 项，服务重启后不会作为长期历史保留。任务不显示推算百分比。批量主题逐项反馈，使用修订前置条件防止覆盖并发更新；恢复历史创建新修订。

## 构建与开发

在此目录执行：

```bash
npm ci
npm run build
HCD_ADMIN_API=http://127.0.0.1:8766 npm run dev -- --port 8769
```

构建会将 JS 和 CSS 内联到已纳入版本管理的 `embed/index.html`。在仓库根目录执行 `cargo build -p officecli`，重启目标服务后，`/admin` 使用新页面。请修改 `src/` 后重新构建。

在服务使用的同一环境中签发管理令牌，然后通过页面的“管理令牌”入口连接：

```bash
officecli hdoc issue-token --document-id '*' --scope admin --user-id local-admin --ttl-seconds 3600
```

## 验证

先在仓库根目录构建 `cargo build -p officecli`，在编辑器目录执行 `npm ci`，再在此目录执行：

```bash
npm run test:workspace
```

验证脚本启动独立临时目录和随机端口的文档服务、编辑器，结束后清理。验证真实导入、字体登记、权限隔离、批量主题、版本冲突与恢复、文件下载、编辑器交接、手机导航和会话清除。截图和结果输出到 `docs/acceptance/hcd-admin-workspace/`，可用 HCD_ADMIN_ARTIFACTS 指定其他目录。

Rust 验证在仓库根目录执行：

```bash
cargo test -p hcd-core catalog::tests
cargo test -p officecli --bin officecli hdoc_server::admin::tests
```

## 宿主接入建设进度

外部 Provider 会话、权限、精确版本导入、手动业务回写与提交事件已接入现有 V2 编辑链路。[启动配置、复现命令与真实验收](../../../docs/acceptance/hcd-provider-integration-v1.zh.md)。正式默认业务 Provider 已位于 [`apps/workspace`](../../../apps/workspace/README.zh.md)，账号/文件/权限/业务回写的验证见[默认应用验收](../../../docs/acceptance/hcd-default-workspace-v1.zh.md)。完整断网发行包仍待建设；外部接入 fixture 不作为默认应用。
