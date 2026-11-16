# 多文档工作空间刷新恢复验收

多文档标签原先仅在 React 内存中保存，刷新后回到连接表单。本次恢复已打开标签、原活动文档或文档库，以及每个文档的预览/编辑、聚焦、折行、修订选择/对比、侧栏和画布缩放状态。关闭标签后再刷新不会重新打开它。

访问凭证沿用原连接表单的 `sessionStorage` 存储范围，仅用于当前浏览器标签的刷新恢复，不写入 `localStorage`。恢复时逐个请求真实 `/auth` 和 manifest，不采用缓存的 scope、epoch 或 format。每个恢复请求有 15 秒超时；过期或暂不可用文档进入待恢复列表，其他文档仍然打开。可重试、输入新令牌重新连接或移除失败记录。只读令牌仍强制只读。

当前最多记录 50 个标签；会话缓存和视图缓存均使用版本键并检查输入类型。浏览器禁用存储或额度已满时，连接、编辑和缩放仍可使用，但不承诺刷新恢复。

## 浏览器验证

```bash
cargo +1.90.0 build -p officecli
cd examples/hdoc/editor
npm run build
OFFICECLI_BIN="$PWD/../../../target/debug/officecli" npm run test:workspace -- --grep 'workspace reload|workspace restoration|document tabs'
```

macOS 可加 `HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`。

用例实际打开 TXT 与 PDF，设置不同缩放、TXT 预览模式，刷新后检查两个标签、活动 PDF、独立缩放和只读预览恢复；关闭 PDF 后再次刷新确认只剩 TXT。另一个用例写入伪造的缓存 `scope=write`、`format=xlsx`、`epoch=999`，但凭证实际仅能读 TXT，恢复结果仍为 TXT 只读；另一个有效签名但已过期的凭证单独失败，更换新令牌后成功连接。

额外验证浏览器拒绝访问 storage，以及写入时出现 quota 错误两种场景：仍可连接、编辑和缩放，关闭标签不会抛出异常。协同依赖 lib0 在初始化时会探测 storage getter；若环境在 getter 可用时单独使所有 `getItem` 调用抛异常，lib0 的环境模块仍可能加载失败，此类运行期存储失效未纳入已支持范围。

## 未完成边界

这项改动恢复会话入口和界面状态，不等于浏览器端内容持久化。已传到 sidecar 的共享 Y.Doc 可继续按现有服务端状态恢复；尚未同步的离线输入、表格窗口草稿、进程崩溃及旧 epoch 草稿合并仍需独立建设和验收。浏览器会话彻底结束后的凭证续期不在本次范围内。

最新验证：[40 项服务端、35 项前端回归与构建结果](hcd-major-gaps/summary.json)。

[刷新后保持预览与缩放的截图](hcd-major-gaps/workspace-restored-tabs.png)。
