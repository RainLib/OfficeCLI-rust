# Word 新增独立区域后的正常会话衔接

后续状态：正常创建确认、设备完整原请求和取消/核对现已接通，详见[正常创建与恢复](hcd-word-story-requests.zh.md)。下文保留本篇批次当时的范围和证据。

2026-10-30。活动 story 创建仍由侧车 API 发起；普通区域 Word `/2` 现能自动接收该轮变化，保留本地视图、个人内容历史和设备日志。管理平台及提醒发送继续后置。

## 核验与交接

- 正常 `/2` 传输明确声明 `hcdWordStory=1`；`/1` 不声明，也不自动迁移。
- 断连保留确切轮次。先查页面状态；仅明确的缓存缺失才查询独立 story 状态。未知结果要求签名恢复，不将其解释为未提交。
- 新传输使用空 Y.Doc。story 轮次另外读取原生固定版本 `r-1`、`r`：历史用成员鉴权读取，当前 head 仍须经活动 owner 的固定基线接口取得；不把 owner 凭据交给浏览器。
- 核对轮次命名的新部件、唯一新增绑定、原区域/评论/修订未变及新块身份，拒绝其他结构变化。新传输还必须包含完整旧视图状态；私有迟到输入、异步证明、损坏或无关模型不能直接桥接。
- 合并新区域之前卸载旧 ProseMirror 视图，保留同一个本地文档和个人 UndoManager；旧全文不作为新传输种子。之后只转发增量，再交接设备日志和新控制器。

没有修改原有 `sameWordSessionTopology` 的拒绝规则。新增区域必须携带独立的固定版本证明；页面字段仍走原路径。新增区域自身的结构撤销、页面字段历史不由本次内容历史验证证明。

## 原生投影与日志记录竞争

实际首轮 Chrome 已自动切换，但后续 Bob 保存的版本写入原生后，基线核验失败并超时，Alice/只读成员已看到该版本。失败记录保留在 `copied-footer`，不能算通过。

新增 `WordRoomLease.readProjection`：只用于固定版本 `/editor` 读取，等待当前日志控制请求；409 后仅当**同一仍有效租约已经确认日志 tip 改变**才重新读取。未变化的拒绝、403/426/5xx、所有权失效均不重试，次数有界；没有重试写操作或放宽原生签名检查。受控测试复现旧 tip 被拒绝、新 tip 确认后重读成功，以及各拒绝边界。

首轮没有记录原生拒绝正文，因此没有将日志竞争认定为该次失败的唯一原因。修正后的全新原生/侧车/Chrome 样本完成了下面的全流程，仍需继续不同网络和设备的故障验收。

## 验证

[真实浏览器结果](../assets/hcd-word-story-session-2026-10-30/copied-footer-lease/service.json)：API 创建继承页脚的独立副本；普通 Chrome 三角色自动切换、未刷新、个人撤销/重做保留同段落同伴输入。切换后直接编辑新页脚，其他两窗看到相同内容，保存到 r7；下载设备文件并刷新重开。

[实际文件回读](../assets/hcd-word-story-session-2026-10-30/copied-footer-lease/service-files.json)：独立页脚部件与引用、两位正文作者、只在新页脚出现的新增文字、实际撤销/重做 DOCX；HCDZ r1–r7 解包逐版本一致；`/6` 设备备份按实际成员/端点身份读取，保留正文和新区域。

[截图](../assets/hcd-word-story-session-2026-10-30/copied-footer-lease/independent-story-after-rebind.png)展示新页脚编辑结果；没有将整个工具栏/浮层几何视为完成验收，跨区域选区浮层的显示仍需复核。另一轮复制含图片页眉被 `word-story-source-unsupported` 拒绝，未创建新区域，保留在本目录首轮记录；这项能力继续开放。

专项 40 项、最终完整前端 1891 项，以及含 TypeScript 的独立版/嵌入版构建通过；源文件和产物摘要见[验证清单](../assets/hcd-word-story-session-2026-10-30/validation.json)。原生使用既有二进制，没有重建或重跑 Rust 全工作区。

```bash
python3 scripts/hcd-word-layout-browser.py --clean --story-source
# 使用上一步的自有隔离 root，两个命令依次执行并等待退出。
node scripts/hcd-word-story-session-browser.mjs ROOT OUTPUT --footer
python3 scripts/hcd-word-active-story-submit-files.py ROOT OUTPUT
```

正常创建确认、浏览器完整请求持久化、取消与原请求核对、恢复链接前一节、复杂资源复制、旧模型迁移、精确分页、跨物理设备及多实例继续；当前证据不扩大到这些范围。完整原目标及各格式清单见[当前能力矩阵](hcd-current-capabilities.zh.md)。
