# HCD 单文件离线归档（2026-10-25）

后续更新（2026-10-25）：无源 PDF 再导出已补入现有规范文字的不可见搜索/复制层，扫描页不运行 OCR；下文此前记录的静态 PDF 检索缺口已被此增量修复。完整范围、文件证据及输入解码/字体写入剩余缺口见 [离线 PDF 文字层](hcd-pdf-searchable-offline.zh.md)。

本轮在原生 HCD 目录之上增加 `.hcdz` 单文件传输格式。编辑器“导出”操作区可以下载选定保存版本及其历史、自定义节点、富文本子树、格式快照和已提交资源。无需先做管理平台。

## 用户行为

- 导出格式选择“HCD 离线归档”，当前编辑内容先走正常保存；上传未完成、保存失败或冲突未解决时不能把草稿冒充归档。
- 历史预览下载固定历史 revision；包内最高版本是该 revision，后续版本和后续版本才引入的资源不进入包。
- 页面明确说明归档携带历史。业务节点和关联身份按原生方式保留，不报告为通用 Office 静态化。
- 归档只含 canonical 已提交文档。访问名单、令牌、共享协同状态、请求回执和暂存上传不复制。下载不会分享文档或扩展权限。
- 下载支持取消、期限和已有导出并发上限。服务端完成打包后重新检查访问权限，响应禁止共享缓存。

`.hcdz` 现在通过 CLI 解包为原生 HCD 目录，随后使用现有读取、验证、预览和导出命令。浏览器直接打开本地文件、完整离线冷启动和资源缓存仍未接入，不把归档能力描述为离线桌面编辑器。

## 格式与一致性

ZIP 根目录仅有 `hcd-archive.json` 和 `bundle/` 内文档对象。元数据使用 `hcd-archive/1`，声明 documentId、revision、每个对象的相对路径、实际字节长度和 SHA-256；不序列化宿主回调或服务端配置。

打包持有现有文档写锁复制一致快照，随后释放源锁并验证私有副本，再写临时归档并以不可覆盖方式发布。只沿 manifest、每代索引、chunk、source map、annotation 和 revision asset index 收集依赖，保留每一代的资源，不扫描并复制整个服务目录。修复了旧存储统计引用遍历用当前 indexPageCount 读取历史索引的问题，历史页数按其 revision 读取。

解包验证版本、对象集合、文件数、长度、SHA-256、当前 HCD 模型和所有历史 root/依赖。哈希读取跨历史复用；当前版本验证通过不能掩盖已经不用的旧 chunk 损坏。完成后才发布新目录。已有文件/目录不能被覆盖，失败清理私有临时内容。

ZIP 解码前校验 ZIP32/ZIP64 原始目录计数和范围，避免库分配无界记录；解码后计数再比较，防止重名目录记录被库合并而漏检。拒绝重复、越界、非 UTF-8/危险相对路径、符号链接和特殊文件。仅提取清单中预期的普通文档对象，完成后与 canonical 引用集合再次比较。

边界：最多 100,000 个文档对象，每对象 256 MiB，总解码 2 GiB，归档清单 16 MiB，ZIP 目录 64 MiB；HTTP 下载另限 256 MiB。Mac 本地验证通过；Linux/Windows 的目录发布路径仍需对应平台验收。源 Office/PDF 原文件及额外字体如果本来位于服务端 `sources/`，不会自动装入原生包；需要原文件的保真回写仍需显式提供匹配的 source。已有 canonical 资源和支持的语义导出不依赖在线宿主 codec。

## 使用与验证

输出目标必须不存在，父目录需已存在。

```sh
cargo build -p officecli
target/debug/officecli hdoc pack /path/mentions-docx.hcd \
  --output /path/mentions-docx.hcdz --revision 14 --json
target/debug/officecli hdoc unpack /path/mentions-docx.hcdz \
  --output /path/new/mentions-docx.hcd --json
target/debug/officecli hdoc validate /path/new/mentions-docx.hcd --json
target/debug/officecli hdoc export /path/new/mentions-docx.hcd \
  --output /path/offline.docx --to docx --revision 14 --json
```

本地隔离资源样例沿用[资源与富文本文档](hcd-node-resources-and-rich-content.zh.md)的准备步骤。当前样例保存到 r14 后执行：

```sh
python3 scripts/hcd-portable-archive-verify.py /absolute/owned-root/private.json
cargo test -p hcd-core -p officecli --lib --bins
cargo clippy -p hcd-core -p officecli --all-targets -- -D warnings
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
```

探针对命名样例只做读取和新产物生成：比较 CLI/HTTP 的归档清单、所有对象 hash、全部历史记录和完整 editor projection；验证 r6 归档不包含 r7 以后内容；无宿主/网络读取解包目录并导出实际 DOCX。浏览器下载再解包回读单独记录。凭证不进入证据文件。

管理平台、实际提醒发送、任意 custom mark、复杂格式往返、浏览器离线启动和生产多实例的原范围继续保留。


## 本地验收结果

前端 482 项、核心 74 项、CLI 154 项相关回归通过；最终归档专项 8 项通过，涵盖原始目录计数、ZIP64、重复/危险路径、符号链接、旧历史损坏、资源和既有目标保护，以及文档缩小后的旧索引页保留。TypeScript、独立版/嵌入版构建、Clippy/fmt 和差异空白检查通过。

真实浏览器下载 r14，解包后 73 个对象、全部 15 代 revision、4 个业务节点和 3 份资源与源文档一致；再次离线导出实际 DOCX，正文各出现一次、两处图片仍是实际嵌入对象。r6 包最高版本为 r6，未来历史不进入包。所有检查后源 head 仍为 r14。

- [实际 CLI、HTTP、浏览器文件及离线导出证据](../assets/hcd-offline-archive-2026-10-25/archive-file-evidence.json)
- [构建、测试和源码摘要](../assets/hcd-offline-archive-2026-10-25/archive-validation.json)
- [导出成功及资源保留界面](../assets/hcd-offline-archive-2026-10-25/archive-download.png)

上述为 Mac 本地验证。没有以本轮归档验证代替生产、多实例、其他平台或浏览器离线编辑的验收。
