# Word 活动页眉页脚事务：提交、重试与房间安装

后续状态：正常创建确认、设备完整原请求和取消/核对现已接通，详见[正常创建与恢复](hcd-word-story-requests.zh.md)。下文保留本篇批次当时的范围和证据。

日期：2026-10-30。实际侧车已接预检、提交和确切轮次查询。后续正常区域页已完成受固定版本证明约束的自动 story 桥接、个人内容历史及设备交接，见[正常会话衔接](hcd-word-story-session.zh.md)；创建确认、完整请求持久化和取消核对仍未开放。管理平台和提醒发送继续后置。

## 请求与能力

- `word-active-story-preview` 继续只读生成受审阅候选。
- `word-active-story-submit` 接受严格的 `{epoch,pending,reviewHash}`，限定 1 MiB 输入、900 KiB 候选。复制目标由原编号确定，当前只允许原生预检支持的复制选择；未知扩展不降级复制。
- `word-active-story-status` 接受 `{epoch,transactionId}`，只返回当前进程的该轮状态，不泄露候选内容。读成员可查询，读取输入后再次核对当前授权；缓存不存在表示需要签名恢复，不能证明未提交。
- 提交和状态查询须声明区域 2、布局 1、节点 7 和 `X-HCD-Word-Story-Version: 1`。活动成员还须通过独立 `hcdWordStory=1` 声明理解 story 切换。本批最初的普通页面未宣告这一能力。后续完成受固定版本证明约束的正常会话桥接后，`/2` 普通页面才加入声明；旧页面仍会被拒绝。

页面字段和 story 共用 `WordActiveTopology` 的有界阶段/重试内核，但各自使用独立 pending 类型、错误前缀和状态 schema。story 的缓存身份同时包含完整候选与审阅摘要，不伪造页面字段请求。完成记录独立保留，后续被拒绝的请求不能立即挤掉正在被成员查询的旧轮次。

## 提交顺序

1. 核对当前请求人的写权限；按确切编号协调所有在线写/读成员 prepare/ready。旧客户端或未完成输入/上传的成员不能被绕过。
2. 关闭新包准入，等待已接纳包与日志落盘，再次同步核对成员就绪，暂时保持旧房间。
3. 核对基准版本、布局、取消标记和实际继承来源。在尚未封存准备记录时，从原生源重新生成候选；审阅摘要、全部候选内容或来源不一致便释放本次未准备操作，不创建规范版本。
4. 准备并发布原签名请求。提交结果未知时保留确切身份和事务门禁；重试从确认过的阶段继续，不重新创建编号或把错误当作未提交。
5. 验证原生签名回执，推进签名日志，退役确切旧宿主；在同一租约/日志下暂存新宿主。核对安装、head 和文档副本后才重新开放准入并启用自动保存。

布局感知 owner 的租约维护请求现显式声明 story 能力，避免原生 head 从布局模型推进后，旧的续期声明被安全门禁拒绝。声明仍限显式启用的区域 `/2` 服务；原生 owner 的服务身份、epoch、租约及日志链检查保持有效。

## 实际验收

完整前端 1882 项、24 项活动阶段/请求/预检/HTTP 专项、TypeScript 及独立版/嵌入版构建通过。原生二进制沿用记录的 SHA-256，未重新构建或重跑 Rust 全工作区/Clippy。第三方构建指令与包体积提示保持开放。

实际原生服务、实际侧车和明确声明能力的 Socket 客户端验证：

- 只读提交被拒绝，旧成员未声明 story 能力时拒绝进入事务；错误审阅摘要和篡改复制内容均不准备、不推进 head。
- 两名成员的迟到正文草稿保留；服务端成功后由本机代理截断 TCP 响应，原完整请求再次提交只创建一次独立页脚。读成员能查询确切 story 轮次。
- 客户端显式使用全新文档重新加入新房间，双成员正文仍在，三角色继续保存至 r3；旧请求在后续正文保存后仍返回原事务版本，其他成员不能冒用原操作人。[服务验证](../assets/hcd-word-active-story-submit-2026-10-30/service.json)
- 首次联测发现旧 owner 声明导致续期被拒绝，已提交 story 留在签名日志；修正声明后复用原私有服务目录和接口地址启动新进程，通过原编号执行停房签名恢复，重复恢复不增加版本，原发起人之外的成员被拒绝，双方草稿随后保存至 r3。[失败后的原请求恢复](../assets/hcd-word-active-story-submit-2026-10-30/lease-failure-recovery.json)
- 普通 Chrome 页面在 story 文档上继续使用页面设置，三角色自动恢复，自己的内容撤销/重做保留同伴，设备备份和刷新重开通过。这验证的是页面字段桥接回归，不能替代 story 自动桥接。[正常页面回归](../assets/hcd-word-active-story-submit-2026-10-30/page-regression/browser.json)

普通编辑页重新加入后还验证了独立页脚文字修改、三角色共享、保存及刷新重开，最终 r9 的 DOCX 独立部件和 HCDZ r1–r9 回读通过；这不代表创建操作本身有正常 UI。[普通页脚编辑](../assets/hcd-word-active-story-submit-2026-10-30/story-edit/browser.json)、[文件回读](../assets/hcd-word-active-story-submit-2026-10-30/story-edit/editor-files.json)

文件复跑脚本现先在自有临时目录打包、解包和校验，再发布 `.hcdz`。此前复跑对已有输出执行不覆盖的 `pack` 导致拒绝，已保留失败日志；修正后三份复跑均成功。

两份实际 DOCX 均核对独立页脚的真实部件关系和复制文字、双方正文各一次；其他节绑定与页面字段在 story 提交时不变，原 DOCX 字节未覆盖。固定 r3 的 HCDZ 全历史解包一致；页面回归另验证 r3–r8、实际撤销/重做 DOCX 与设备备份。[服务文件](../assets/hcd-word-active-story-submit-2026-10-30/service-files.json)、[恢复文件](../assets/hcd-word-active-story-submit-2026-10-30/lease-failure-recovery-files.json)、[页面文件](../assets/hcd-word-active-story-submit-2026-10-30/page-regression/file-readback.json)

本轮证据不覆盖真实输入法、外部 Office/WPS 外观、不同物理设备、真实网络及多实例。测试客户端在 story 后手动建立新传输，没有验证保留原视图/个人历史的自动 story 切换。完整命令、源码与产物摘要见[验证清单](../assets/hcd-word-active-story-submit-2026-10-30/validation.json)。

## 复现与开放项

```bash
python3 scripts/hcd-word-layout-browser.py --clean --story-source --allow-restart
# 使用打印的隔离 root，依次执行并等待退出。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-active-story-submit.mts ROOT OUTPUT
python3 scripts/hcd-word-active-story-submit-files.py ROOT OUTPUT
node scripts/hcd-word-page-controls-browser.mjs ROOT OUTPUT/page-regression
python3 scripts/hcd-word-live-rebind-files.py ROOT OUTPUT/page-regression
```

后续必须接通正常创建/取消链接确认、浏览器原请求及取消/核对。按确切 story 证明保留个人历史的新区域桥接和设备交接，现已有后续正常 Chrome 与文件证据，见[会话说明](hcd-word-story-session.zh.md)。进程丢失后的通用已完成请求查询、所有丢响应/关闭/刷新交错也仍需补齐；当前仅证明以上确切恢复样本。“恢复链接到前一节”的原生事务尚缺，不能用创建独立副本代表双向切换。旧协议迁移、精确分页、正文加载及其他格式与生产服务的原目标不变。
