# 无源独立 HTML 导出

2026-10-27。补齐[普通节点资源恢复验收](hcd-semantic-node-resource-recovery.zh.md)中确认的 CLI 差异：`hdoc export --to html` 现在可以直接读取 HCD 保存版本，生成不依赖原 Office 文件、节点注册器或资源服务的 HTML。浏览器鉴权导出使用同一个函数。管理平台和提醒投递未涉及。

## 使用与实际行为

```bash
officecli hdoc export document.hcd --revision 6 \
  --to html --output document-r6.html \
  --fidelity-report document-r6-fidelity.json
```

不传 `--source` 即走此路径。显式提供同格式原 HTML 的源文件时，仍使用已有源文件重写路径；`render-html` 继续作为检查/预览命令，不改变其默认资源路径和展开限制。

- `hdoc_export_html.rs` 同时服务 CLI 与鉴权 HTTP，复用保存版本的样式、顺序、节点可读快照及内嵌元数据。未接受的 AI 建议、Awareness 光标和服务端运行状态不在保存版本中，不会被额外加入文件。
- 图片或链接的实际 `src`、`href`、`xlink:href` 若引用规范资源，读取当前选定版本的资产索引，校验长度、SHA-256 和实际用于输出的字节后内嵌成 data URI。重复引用复用校验/编码结果。
- 只修改资源属性；正文、未知扩展业务 JSON 和其他属性中出现同样的字符串不会被替换。缺少运行时扩展也无需删除节点：可读快照可用于展示，原有惰性业务载荷仍保留在节点数据属性中。
- 通过完整的显式分片窗口验证所选版本的索引、样式及资产根。缺版本、未知资源、内容损坏或根摘要变化都失败，不能悄悄改为导出最新版本。
- 单资源最多 64 MiB，编码缓存与整个文件最多 256 MiB。编码分配前检查预算；转换分片及最终写出也受限。普通预览保留原来的 8 MiB 转换分片上限，独立 HTML 导出才显式允许有界资源展开。
- CLI 先写同目录临时文件，完整生成并 flush 后才发布，生成失败不留下半个最终文件。已有 Word 区域文档仍拒绝 HTML，避免丢失页眉、页脚和节设置；应使用 DOCX 或 HCDZ。

HTML 的可读呈现属于语义转换。已有惰性节点/引用数据可以保留，但在线关系查询、协同历史、完整附件集合和重新编辑的全部能力仍需 HCD。只有实际呈现/链接引用的资源字节会内嵌；没有被呈现的附件不因其 metadata 存在就自动进入 HTML。精确 Word 分页和原 Office 其他包部件也不承诺还原。完整离线数据与资源继续使用 HCDZ。

## 证据

隔离运行目录：`target/hcd-preview-runtime/hcd-html-export-eunx_2j9`。输入是上一轮普通 Word 的实际 HCDZ，解包后没有原 DOCX 或扩展宿主。重新启动独立鉴权原生服务进行对比，不重启用户预览。

| 检查 | 结果 |
|---|---|
| r2–r6 | 按版本输出原名称/同伴新名称、资源关联/撤销/重做状态，原节点惰性载荷逐个相等 |
| CLI 与 HTTP | 五个版本的 HTML 逐字节一致，HTTP 仍拒绝匿名请求 |
| 内嵌资源 | 所有图片地址为 data URI，解码后资源摘要与保存版本一致 |
| 大图 | 合成 PNG 经正常暂存/哈希换图进入 HCD；PNG 为 6,294,463 字节，Base64 URI 为 8,392,642 字符，超过旧预览分片限制，CLI/HTTP 均完整导出且一致 |
| 浏览器解码 | 原生服务停止后，仅用静态文件服务打开 HTML；普通资源正常解码，大图 naturalWidth/naturalHeight 为 2048×1024，控制台无错误 |
| 区域文档 | CLI 和 HTTP 明确拒绝；已有目标文件仍保留原始内容 |
| 原文件 | 各规范版本保持不变，原生校验通过；大图原 DOCX 在 materialize 后删除，HTML 不再需要它 |

大图验收没有放宽 HTML 导入器的 2 MiB 单标签限制。最初把大图放进导入标签被正确拒绝；正式验收改用正常图片暂存与换图命令，将大图片作为独立有摘要的资源进入 HCD。

8 项新增专项覆盖精确资源、重复引用、大资源展开及预览默认值、损坏/未知资源、根摘要、未知扩展载荷、未来版本拒绝，以及文本/业务数据保护和编码预算。相关单元检查为 hcd-core 97 项、officecli 187 项，CLI 命令及多格式回归为 4+19 项，共 307 项通过。`cargo clippy -p hcd-core -p officecli --lib --bins -- -D warnings`、构建与全工作区格式检查通过。没有新增前端 UI 逻辑，因此未重复前一轮的 919 项前端检查。

证据在 `docs/assets/hcd-html-export-2026-10-27/`：实际 r6 HTML、大图 HTML、保真说明、文件及浏览器结果、截图、日志和源码摘要。

## 复核

```bash
cargo test -p hcd-core -p officecli --lib --bins
cargo test -p officecli --test hdoc_cli --test hdoc_multi_format
cargo clippy -p hcd-core -p officecli --lib --bins -- -D warnings
cargo fmt -- --check
cargo build -p officecli
python3 scripts/hcd-html-export-verify.py --preview
```

脚本使用仓库中的实际普通/区域 HCDZ，以及自有合成大图；文件都写在隔离目录。输出静态预览地址，不打印或归档成员 token。原生验收服务在静态浏览器审阅之前停止。

当前保留边界：完整目标仍未完成。区域 HTML/PDF/Markdown 导出、跨设备/旧 epoch 未完成文件转移、旧房间迁移、未来行内容器和区域自定义标记、精确分页/长节虚拟化、远端状态与真实模型集成继续推进。浏览器字体、原 Office 精确排版和生产部署未在本轮验收。

## 2026-10-27 区域模型后续

本专题最初验证时区域 HTML 尚被拒绝。后续已为模型 2 接入分节纸张、页眉页脚和独立资源文件，当前验证脚本同步改为校验成功导出；旧模型仍拒绝。未在目标 HTML 快照中呈现的节点资源也会携带字节和下载链接。实现及新增验收见[区域 HTML](hcd-word-html-export.zh.md)，此前证据保留为当时结果。
