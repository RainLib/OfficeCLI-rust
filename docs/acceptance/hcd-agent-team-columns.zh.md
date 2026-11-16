# Excel 多 Agent 分列编辑验收

复现任务：`修改 HW1 列+1 和HW2 偶数+5 Rank 要进行*2`，协同人数设置为 4。

原失败记录的计划阶段报“团队计划包含未知或重复认领的工作区域”，没有提交修订，示例表仍为 r0。原因是工作区域使用渲染分片 ID，同一工作表的不同列可能共享一个分片；计划校验拒绝重复认领后，没有向模型反馈并重新规划。

## 修复

- XLSX 按工作表的列生成稳定工作区域，提供表头、单元格、原生数值和公式上下文；绘图继续使用各自的分片区域。
- 列锁覆盖该列的映射节点，以及获授权创建的新单元格。不同列可以并行；跨列、跨表、整块覆盖、跨列合并、锁过期后的写入继续受到校验。
- 规划使用允许的资源 key 枚举，并最多尝试 3 次；未知 key 和重复认领会分别返回具体错误及上次计划。仍无有效计划时，停止在写入前。
- 4 是并发上限。本任务只需要 HW1、HW2、Rank 三个修改分工，公式依赖的重新计算不需要额外修改分工。
- 数值算术使用 `xlsx.number.set` / `hcd-patch/29`，保留数值类型及格式；Rank 使用公式替换，保留原表达式。纯文字批次与包含公式的批次使用对应协议。
- 尚未生成分工时显示规划状态或“分工未生成”，不再显示 `0/0`。

## 验证结果

公开夹具为 `assets/showcase/gradebook.xlsx`，HW2 的“偶数”按数值判断。

真实模型 `gpt-5.4-mini` 完成三个分工，提交 3 个修订，最后全部释放工作锁。逐单元格及原生 XLSX XML 校验得到：

- C4:C18 共 15 个原生数值各加 1。
- D4:D18 中 8 个偶数值各加 5，奇数保持原值。
- K4:K18 共 15 个 Rank 公式在原表达式上乘以 2，保留可编辑公式。
- 其他单元格的文本和公式保持原值；全部原有单元格的样式索引保留，Analytics 工作表单元格未修改。
- 公式计算状态通过新读 `/sheets/0` 验证；原生导出直接核对数字类型和公式表达式，不将导入缓存作为计算依据。

真实模型期间出现过一次参数位置错误和版本冲突，随后重新读取并修正，最终通过全部结果断言。确定性测试还主动生成重复区域和未知区域的错误计划，验证两次反馈修复后才启动工作；持续错误的计划不会写入。

本次验证：Rust 143 项、浏览器 Agent harness 35 项、真实模型任务 1 项全部通过；格式检查、Clippy、编辑器应用和嵌入构建通过。浏览器回归包含此前的光标连续轨迹、稳定画布、操作动画、多人 MCP 编辑、取消和锁释放。

## 复验命令

从仓库根目录构建二进制，再运行编辑器测试；`OFFICECLI_BIN` 指向实际构建产物。

```sh
cargo +1.90.0 build -p officecli
cargo +1.90.0 test -p officecli --bin officecli
cargo +1.90.0 clippy -p officecli --all-targets -- -D warnings
cargo +1.90.0 fmt --all -- --check
cd examples/hdoc/editor
npm run test:workspace -- agent-harness.spec.ts
HCD_TEST_REAL_OPENAI=1 npm run test:workspace -- agent-harness.spec.ts --grep 'four-worker spreadsheet'
npm run build
```

真实模型测试需要服务端模型配置，只加载公开夹具。可通过 `HCD_BROWSER_PATH` 指定本地 Chrome。

## 产物

- [真实模型摘要及修改明细](hcd-openai-agent-harness/team-columns/summary.json)
- [真实模型导出的 XLSX](hcd-openai-agent-harness/team-columns/columns-edited.xlsx)
- [协作任务完成截图](hcd-openai-agent-harness/team-columns/spreadsheet-team-completed.png)
- [浏览器回归记录](hcd-openai-agent-harness/team-columns/browser-regression.log)
- [真实模型记录](hcd-openai-agent-harness/team-columns/real-model.log)
- [Rust 测试记录](hcd-openai-agent-harness/team-columns/rust-tests.log)

本地验收服务仍为 `http://127.0.0.1:58402/?locale=zh-CN`。API 已切换到修复后的二进制；原 `accept-xlsx` 文档保持 r0，可刷新后重新提交任务。
