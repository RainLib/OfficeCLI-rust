# Agent 操作提示与冲突恢复

用户看到的“拒绝”此前合并了不同情况：定位参数错误、版本冲突、工作区域越界、权限不足和未保存的人类草稿。它既可能只是一次辅助定位失败，也可能意味着实际修改尚未提交。

## 最新失败记录

检查本地 `accept-xlsx` 的实际任务及单元格，发现：

- `hcd_activity` 收到 `sheet-column:...` 或工作表 ID 作为 `nodeId`，返回 400；这些 ID 不是画布上的映射节点。
- 其他 Agent 提交后，旧版本上的写入返回 409。原循环只用文字提醒重新规划；模型仍可反复返回结束消息。对同一次未解决的冲突重复计数后，任务提示“版本持续变化”，实际并没有发生同样次数的新冲突。
- 当前任务停在 r2。HW1 尚未加值，Rank 公式已经翻倍。HW2 被标记为完成，但逐格检查发现计划中的预计算结果有误：D5 的 82 未加值，D8 的 85 反而被改成 90。不能根据成员的“已完成”标签认定用户目标正确。

该记录的摘要保存在 [reported-failure.json](hcd-openai-agent-harness/conflict-recovery/reported-failure.json)。本次没有自动重跑或修改这个已部分执行的文档，避免重复变更；更新服务前后核对单元格数据完全一致，见 [local-service.json](hcd-openai-agent-harness/conflict-recovery/local-service.json)。

## 改动

1. 冲突后由 harness 使用工具选择约束执行恢复：先读取最新 auth 和全部失败目标，再提交自己尚未完成的修改。历史修订读取不算恢复读取；同伴已完成的分工不能接管或重复执行。
2. 恢复次数按实际发生的冲突计数，仍有工具轮数、超时、取消、版本、哈希及锁校验。没有直接把旧补丁换成新版本重放。
3. 工具事件携带成员身份。界面只用同一成员的成功操作解除其失败提示，不能用 Agent B 的成功掩盖 Agent A 的失败。
4. 区分“文档版本已更新”“操作参数需要调整”“超出分工范围”“访问权限不足”和“等待未保存内容”，在展开的操作记录内显示具体原因。辅助定位失败与未提交的文档修改分别说明。
5. MCP 节点参数增加节点 ID 格式说明和约束，补充数值操作的完整参数示例，明确 `precondition.nodeHash` 的位置和各批次协议。
6. 数值列的规划上下文不再包含可被错误预计算的原数值和公式缓存。规划仅分配区域并描述变换，执行成员必须从最新读取的原数值计算；偶数/奇数按值判断，除非用户明确要求按行。
7. 计划通过明确的工作类型区分编辑和只读复核；编辑任务中的独立只读分工会被退回重新规划，防止为凑人数认领无关列。单个成员失败时等待其他独立成员完成并释放锁，再汇总各自结果，保留真实的部分成功状态。

## 验证

真实模型使用独立公开夹具，不修改用户当前的 r2 文档。断言包含每个 HW1/HW2 数值、未涉及单元格、Rank 原表达式、公式计算状态、工作锁释放、修订作者和原生 XLSX 数值类型及公式。

```sh
cargo +1.90.0 test -p officecli --bin officecli
cargo +1.90.0 clippy -p officecli --all-targets -- -D warnings
cargo +1.90.0 fmt --all -- --check
cd examples/hdoc/editor
npm run test:workspace -- agent-harness.spec.ts agent-run-status.spec.ts
HCD_TEST_REAL_OPENAI=1 npm run test:workspace -- agent-harness.spec.ts --grep 'four-worker spreadsheet'
npm run build
```

设置 `OFFICECLI_BIN` 指向实际构建产物；可通过 `HCD_BROWSER_PATH` 指定本地 Chrome。真实模型需要服务端模型配置。

Rust 144 项通过；浏览器完整回归 39 项、最终相关回归 13 项通过，并单独验证了延迟成员在同伴失败后仍能完成。真实模型最终在独立副本上通过全部逐格及原生导出断言。Clippy、格式、应用与嵌入构建通过。

- [真实模型结果及恢复事件](hcd-openai-agent-harness/conflict-recovery/verified-run.json)
- [验证后的原生 XLSX](hcd-openai-agent-harness/conflict-recovery/verified-columns.xlsx)
- [完成截图](hcd-openai-agent-harness/conflict-recovery/verified-team.png)
- [完整浏览器回归](hcd-openai-agent-harness/conflict-recovery/browser-39.log)
- [最终相关回归](hcd-openai-agent-harness/conflict-recovery/final-regression-13.log)
- [延迟成员失败隔离](hcd-openai-agent-harness/conflict-recovery/peer-failure-isolation.log)
