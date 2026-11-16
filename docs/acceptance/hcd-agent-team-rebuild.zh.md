# Harness 多 Agent 与 PPT 整稿重建验收

2026-11-15。本次解决“要求推翻重做 PPT，却只改了标题”的问题。现在 PPTX 的“整份 PPT 重做”会规划全稿、并行制作新页、审核正文与共享事实、验证原生导出，再替换旧页。自动方式识别重做要求时也会忽略过期的标题选区；明确选择“编辑内容”则保留原有局部修改语义。

## 使用

在 AI 工作台底部选择任务方式，以及 1–4 位协同 Agent。选择“整份 PPT 重做”，输入例如：

> 推翻原有内容，重新制作完整的寿司介绍 PPT，价格为280，以北海道食材为灵感。自己起品牌名字，制作3页，包含介绍、食材风味与品味体验。每一页都要重新制作。

服务端实际调用 Responses API。Harness 负责规划、分配独立身份、认领资源、续租、提交、回读、验收与释放；模型无法自行扩大权限、变更锁归属或宣告工作已完成。普通协作编辑使用原有工具循环，每位成员每次最多 32 轮；整个团队最多执行 1200 秒。并行编辑遇到全局 revision/epoch 冲突时仍需重新读取并规划。

`POST /v1/documents/{id}/agent-runs` 接受 `{task, agentCount: 3, mode: "auto" | "edit" | "rebuild", target?}`。`GET` 返回共享事实、成员分工、认领状态、租约到期时间、共享发现和实际提交修订。任务仅发起者可读取/停止；任务仍绑定一个文档。

HTTP 与 stdio MCP 的 `hcd_agent_run` 同样支持启动、查看、列出和停止团队。团队成员通过 `hcd_team_context` 读取共享上下文，通过 `hcd_team_share` 发布发现。内置成员不能递归启动团队。

## 协作与替换保障

- 30 秒工作租约，由 Harness 每 4 秒续租；完成、失败、取消均释放。过期租约不能复活；成员不能释放其他成员的锁。
- 段落、节点、页面及全文锁检查重叠关系。直接映射文字节点写入也必须遵守上层段落/页面锁；成员不能借用另一种工具越界写入。人仍可编辑，实际写入受 revision、hash、epoch 和未同步草稿守卫保护。
- 新稿各页先独立制作，草稿租约不锁住原稿。内容必须包含标题、引导语与 2–3 段正文；校验失败最多进行 3 次生成，将具体错误和上一版传回同一页的模型请求。持续只改标题或缺少售价不能通过验收。
- 新稿先在隔离副本中执行原生页面操作并验证 PPTX 导出。原稿含不支持的结构（如自定义放映）时，在实际写入前拒绝。正式提交前再次检查原稿版本，制作期间人工修改会阻止过期稿覆盖。
- 正式替换回放已验证的版本化操作，并比较最终页面 hash。多个修订逐次提交，可从历史恢复；取消或提交期间遇到错误时保留已提交修订。这不是跨进程原子事务。
- 画布保留独立 Agent 指针、无边框操作区域、扫光和完成反馈；工作台展示待操作、正在操作、完成和成员分工。已提交后的动画明确标记为回放。

## 验证与产物

真实模型 `gpt-5.4-mini` 已通过三 Agent 浏览器验收，独立生成 3 页后替换全部旧页。导出 XML 检查确认恰好 3 页，每页包含可编辑的 DrawingML 标题/引导语/正文，售价 280 保留，所有租约已释放。首次实测曾因正文不符合约束停止；补上有限校验修正后复验通过，没有降低正文验收标准。

- [真实模型生成的寿司 PPTX](hcd-openai-agent-harness/sushi-rebuilt.pptx)
- [桌面工作区](hcd-openai-agent-harness/sushi-team-workspace.png)、[手机工作区](hcd-openai-agent-harness/sushi-team-mobile.png)
- [本次验证记录](hcd-openai-agent-harness/team-summary.json)

使用仓库公开 `textboxes-basic.pptx` 验证，未向模型发送用户合同。此示例为统一文字版式，不代表已实现任意商业演示稿的视觉设计、素材生成、母版、动画和复杂布局。

复现命令（可用 `OFFICECLI_BIN`、`CARGO_TARGET_DIR` 指向已有构建位置）：

```bash
cargo +1.90.0 build -p officecli
cargo +1.90.0 test -p officecli --bin officecli
cargo +1.90.0 clippy -p officecli --all-targets -- -D warnings
cargo +1.90.0 fmt --all -- --check
cd examples/hdoc/editor
export OFFICECLI_BIN="$PWD/../../../target/debug/officecli"
# 本地未安装 Playwright Chromium 时可配置 HCD_BROWSER_PATH。
npm run test:workspace
npm run test:workspace -- agent-harness.spec.ts --grep 'slide workers repair|full PPT rebuild rejects'
HCD_TEST_REAL_OPENAI=1 npm run test:workspace -- agent-harness.spec.ts --grep 'full PPT rebuild uses'
```

可重复回归覆盖：独立分工与共享发现、越界拒绝、映射节点绕锁拒绝、工作锁过期与释放、其他身份不能取消、人工编辑竞态、自动识别忽略旧标题选区、无效正文修正、持续只返标题/遗漏售价不改原稿、原生导出预检与 MCP 两种传输。

团队和锁当前保存在同一 API 进程内，尚不支持多实例分布式租约、任务持久化/重启恢复和通用跨文档团队编排。整稿重建当前针对 PPTX；其他格式继续使用各自已支持的编辑工具。

后续交互修正见 [Agent 移动轨迹与预览稳定性](hcd-agent-motion.zh.md)：独立的连续移动轨迹、名称标签、播放状态隔离、原生定位锚点复用及固定页面就地更新。
