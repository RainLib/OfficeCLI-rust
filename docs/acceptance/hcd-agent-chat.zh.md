# Agent 对话界面验收

2026-11-15。本次调整编辑器右侧 Agent 面板，以 Codex 风格的对话流展示任务和结果。

## 界面和交互

- 使用右对齐的用户消息和简洁的 Agent 回复，取消多层任务卡片堆叠。回复支持 Markdown 列表、表格、代码块、链接和复制。
- 聊天区域统一滚动；输入框固定在底部。执行过程归入对应任务，执行时展开，结束后折叠。工具记录、公式和错误详情可继续展开。
- 协作者集中到可展开的入口，保留定位；多 Agent 分工、共享发现、工作锁和释放状态可查看。外部 MCP Agent 的操作队列保留在对话区域。
- 输入框支持 Enter 发送、Shift+Enter 换行和中文输入法保护。任务方式和 1–4 Agent 人数设置默认收起。提交等待期间新输入的草稿不会被上一条请求清空。
- 阅读历史消息时，轮询更新保持阅读位置；“回到最新”可恢复跟随。手机宽度下输入框和人数设置仍可操作。
- 完成、停止、未完成与实际提交修订分别展示；同伴提交成功不能掩盖其他 Agent 未提交的修改。
- Markdown 不执行原始 HTML，危险链接协议被过滤，外部图片以说明文字展示。Markdown 渲染独立于画布回放时钟，避免重复解析。

过程状态通过现有轮询更新，回复按服务端实际返回展示。

## 截图

以下截图使用隔离测试工作区和模拟 Agent 回复，仅验证展示行为；其中表格与修订号属于测试数据。

- [桌面聊天](hcd-agent-chat/agent-chat-desktop.png)
- [手机宽度与协同人数设置](hcd-agent-chat/agent-chat-mobile.png)
- [部分失败与已提交修订](hcd-agent-chat/agent-chat-partial-failure.png)

## 验证

在 `examples/hdoc/editor` 运行；`OFFICECLI_BIN` 指向当前已构建的 OfficeCLI 二进制，`HCD_BROWSER_PATH` 指向本机 Chrome。测试使用隔离文档副本和脚本模型服务。

```sh
npm run build
npm run test:workspace -- agent-harness.spec.ts agent-run-status.spec.ts --grep 'full PPT rebuild uses|Rank formulas double|continuous|operation queue and borderless|four-worker spreadsheet|persistently invalid spreadsheet|conflict|Codex-style|chat composer|chat preserves|failure|recovered'
npm run test:workspace -- agent-harness.spec.ts agent-run-status.spec.ts --grep 'Codex-style|chat composer|chat preserves|a peer commit|fresh reads|focus parameter|permission, ownership'
```

- TypeScript、应用构建和嵌入包构建通过。
- [相关回归 15 项通过](hcd-agent-chat/regression-15.log)：PPT 整稿重做、多 Agent 表格编辑、Rank 公式与总数、连续移动轨迹、画布保持、操作队列及无选中框回放。
- [最终复验 7 项通过](hcd-agent-chat/final-7.log)：聊天与 Markdown、输入和设置、等待期间草稿保护、历史滚动、停止任务、部分失败及错误解释。

以上为相关范围验证，不代表本次重新验证了所有文档格式的完整编辑与转换能力。
