# 画布悬浮面板验收

日期：2026-11-16。使用本机隔离的样例数据、构建后的 Workspace、Rust 引擎及协作 sidecar 验证。

| 检查 | 结果 |
| --- | --- |
| 文档面板、七种格式、深浅主题、手机、PPTX 属性与状态保留 | 9 通过 |
| 图片工作台、草稿与崩溃恢复 | 9 通过 |
| Word 读者及格式保留、Agent 聊天收起和专注模式 | 2 通过，使用脚本化模型 |
| 编辑器单测 | 26 通过 |
| Workspace 单测 | 11 通过 |
| 管理台、编辑器、嵌入包、sidecar 构建 | 通过 |
| 默认 Workspace 与匿名分享端到端验收 | 18 项通过 |
| Rust 全工作区测试 | 1,089 通过，0 失败 |
| `cargo fmt --all -- --check` | 通过 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过 |

验证覆盖：顶部不显示权限标签、面板入口和工具按钮；左右面板在画布范围内且低于格式工具栏；展开和收起不改变画布尺寸或编辑器 DOM 实例；面板草稿、大纲和阅读位置保留；手机遮罩、Escape 和焦点返回正常；匿名访客按分享授权查看或编辑，底部显示临时编号。PPTX 曾出现面板高度超过画布的问题，现统一使用实际画布高度，七种格式均检查上下边界。

实际页面截图：

- [匿名桌面编辑](hcd-floating-panels-v1/guest-desktop.png)
- [匿名手机编辑](hcd-floating-panels-v1/guest-phone.png)
- [桌面共用面板](hcd-floating-panels-v1/document-panels.png)
- [手机深色面板](hcd-floating-panels-v1/phone-panel-dark.png)
- [手机 PPTX 属性](hcd-floating-panels-v1/phone-properties-dark.png)

复跑界面检查（在 `examples/hdoc/editor` 执行）：

```bash
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:workspace -- workspace.spec.ts \
  --grep 'floating panels stay|shared side panels match|mobile drawers dismiss|PPT shape properties|all seven formats use|workspace drawers, focus|workspace reload restores|appearance follows|dark workspace keeps'
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:workspace -- image-workspace.spec.ts
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:workspace -- agent-harness.spec.ts \
  --grep 'Word mixed inline edits preserve|Pen chat drawer preserves draft'
node --import tsx --test src/*.test.ts
```

后端、构建和分享检查的命令见 [分享验收](hcd-sharing-v1.zh.md)。[日志与结果](hcd-floating-panels-v1/) 保留本轮命令和测试名称；完整前端 E2E 套件未在本轮全部执行。Pen 内实际页面的 DOM 核对通过；其截图接口超时，因此此处实际截图来自同一构建的 Playwright 验收。

[Pen 设计与复用方式](../design/officecli-floating-panels-v1/README.md)
