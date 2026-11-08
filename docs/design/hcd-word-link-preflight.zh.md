# Word 链接前一节：活动房间只读预检

后续原生进展：[协作链接事务与签名回执](hcd-word-link-transactions.zh.md)已补原生提交、确切重放及混合历史文件验证；活动侧车的提交阶段、签名恢复和普通确认界面仍未完成。下文记录只读预检本批的实际范围。

2026-10-30。接续独立页眉页脚的正常创建；本批为恢复“链接前一节”增加必要的活动房间预检。尚未开放正常链接确认和提交，不迁移旧协议。管理平台与提醒发送继续后置。

## 预检行为

侧车 `POST /v1/documents/{id}/collaboration/word-active-link-preview` 仅接受当前写成员，要求显式 `/2`、布局及链接版本声明。请求只包含当前 epoch、节、页眉/页脚、default/first/even 变体和确切编号；姓名由当前鉴权解析，不接受调用方指定作者。

预检回答将保留哪个原独立区域、继承哪个前节区域，以及影响哪些后续节。沿同一变体追溯前节，影响范围止于下一处直接绑定；其他变体不变。前节没有对应变体时，结果为空白；相同区域的冗余绑定被移除时，可以没有内容变化。第一节及已经继承的区域不能再次链接。

这条路径复用已有区域，不复制前节图片，也不删除原独立区域、其内容或资源。预检不能授权丢弃草稿、提交、取消编号、提升签名日志或更换房间。

## 一致性与权限

- 原生 `word/link-preflight` 仅允许已鉴权的协作服务，要求 coordinator 7、布局、story、link 声明；在真实 HTTP 中间件中登记精确路由，其他写接口仍受原有门禁约束。
- 原生核对当前 epoch、`/2`、owner/租约/日志摘要、作者当前权限、固定版本及布局摘要。核心候选读取持有 bundle 锁，返回固定 revision/root 与候选布局摘要，不创建版本。
- 侧车使用当前活动 owner，不重载共享日志。独立计算预期影响，与原生返回的文档、编号、root、原/新区域、顺序及候选摘要逐项核对，最终审阅身份绑定作者、版本、epoch 和 coordinator。
- 对原独立区域和将继承区域均比较规范投影与活动内容；任一区域有未保存文字、图片意图或 reserved/staged/interrupted 上传任务时拒绝。其他正文草稿保留。异步核验后再次检查来源、版本、权限和所有权。
- 固定投影及预检响应有大小限制；原生请求从响应头到正文共用 30 秒等待上限。未知响应、权限变化和迟到版本不能成为有效审阅结果。

## 验证及边界

前端完整 **1914 项**测试、TypeScript 和 standalone/embed 构建通过；原生新增 **5 项**预检测试及既有 **10 项**链接规划测试通过，新原生二进制已构建。新增 HTTP 用例经过真实本机监听器与访问中间件，不只直接调用处理函数。第三方 `use client` 与包体积提示仍存在。

真实原生/侧车与两名写成员、一名只读成员的 Socket 验收使用两份隔离 DOCX：

1. 第二节独立图片页眉，前节同变体为空；重复预检稳定且不增加版本，只读成员与缺链接声明客户端被拒绝。
2. 将图片页眉设为前节继承来源，第二节使用另一独立页眉；预检支持已有图片来源。
3. 正文草稿共享后仍可预检，未保存内容未丢失；原独立区域草稿及前节来源草稿分别使预检拒绝，保存后重新预检正常。
4. 普通内容保存分别推进至 r3/r4，区域绑定始终未变。下载的 DOCX/HCDZ 逐文件回读验证正文标记、页眉文字、原图片字节及每个所测版本的一致性。

首轮实际联测因未登记服务路由被拒绝，已保留失败记录并修复、重新构建及重启独立夹具后验证。测试开发时遗漏 `std::fs` 导致的编译失败亦有记录。所选包 all-targets Clippy **未通过**：错误位于本轮未修改的 `flow_regions.rs` 布尔式和默认字段初始化，以及 `structure.rs` 测试中的切片 clone；不将其报告为已通过。完整日志、源码与二进制摘要见[验证清单](../assets/hcd-word-link-preflight-2026-10-30/validation.json)。

这些是本机合成 DOCX、实际服务/Socket/文件证据，没有正常链接 UI、链接提交、浏览器鼠标交互、真实 IME、外部 Word/WPS、物理设备、生产或多实例验收。DOCX/HCDZ 是预检后普通内容保存的结果，不是已经应用链接的导出证明。

## 复现

```bash
cargo test -p officecli --offline --bin officecli word_link_preflight
cargo test -p hcd-core --offline flow_story_link
cargo build -p officecli --offline
python3 scripts/hcd-word-layout-browser.py --clean --story-source
# 在另一个终端，使用上一命令打印的自有 ROOT：
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-active-link-preview.mts ROOT OUTPUT
python3 scripts/hcd-word-active-link-preview-files.py ROOT OUTPUT
# 图片继承样本另起独立夹具：
python3 scripts/hcd-word-layout-browser.py --clean --story-source --link-source
```

完成后停止自有夹具并确认子进程退出，再删除其私有目录；不能把 `private.json`、令牌、服务密钥或签名日志复制进证据目录。

## 继续工作

链接尚需完整签名事务与恢复日志、原生回执和确切编号核对/取消、在线成员停写与房间替换、设备持久请求及明确影响的正常确认界面。必须先补齐链接与其他内容/页面修改混合历史的 DOCX 和离线导出，再开放提交；既有原生旧链接事务不是可直接复用的在线发布接口。

独立区域复杂资源复制、区域/页面结构自身历史、旧协议迁移、分页、目录/域更新，以及其余格式的创作、保存恢复、字体和部署验收继续属于[完整能力清单](hcd-current-capabilities.zh.md)。
