# HCD/2 存储与体积优化

新导入的 HCD 默认使用 `hcd/2`。`manifest.json`、`styles.css`、revision 记录和资产索引仍可直接读取；HTML 分片、source map、annotation 与索引对象按 `--storage-codec gzip`（默认）压缩为 `.gz`。`--storage-codec none` 可生成同一协议的未压缩对象，用于调试或外部存储已做压缩的场景。内容地址和 descriptor hash 均基于解压后的规范字节；读写与校验同时限制存储字节和解压后字节。旧 `hcd/1` 包仍可由当前读取器打开，但如需新存储结构应从原源文件重新导入。

同一源文件以 `gzip` 和 `none` 导入时，nodeId、HTML hash 与 map hash 相同。`rootHash` 包含 descriptor 中的对象路径；两种 codec 使用不同的文件后缀，因此 rootHash 不相同。

source map 的逻辑格式继续使用 JSON。对 20 个 XLSX map 的列式 JSON 试算，gzip 后仅从 149.5 KB 降到 139.5 KB；额外约 9.9 KB 的收益不足以抵消 schema、随机访问和跨语言解析复杂度。后续若 map 成为主要占用，可再评估二进制编码；当前优先优化 HTML、图片和 revision 增量。

索引由每页 128 个 descriptor 的内容寻址页和 128 路索引树组成。revision 只写发生变化的页及通向根节点的路径，历史 revision 继续引用原来的不可变对象。`indexRootHref` 是当前 revision 的索引根；`indexPrefix` 保留给旧包读取器。Java 服务可按 revision 调用 `hdoc get-index-page` 和 `hdoc get-chunk --json`，只读取所需页与分片；两个命令返回解压后数据，并检查所访问对象的长度与 hash。静态参考 viewer 可直接解压 `.gz` 对象并校验内容地址。客户端不得把 `.gz` 原始字节当作 HTML 或 JSON。

PDF 页面视觉层使用 `--pdf-raster-mode auto|lossless|lossy`：`lossless` 保留 PNG；`lossy` 总是编码 JPEG；默认 `auto` 在 JPEG 至少节省 15% 且整页 PSNR 不低于 35 dB 时使用 JPEG，否则使用 PNG。`--pdf-raster-quality` 范围为 70–100，默认 92。页图是只读预览资产，有损页数会写入 fidelity warning；源 PDF 仍由外部保存，source-backed 导出继续核对源文件 SHA-256。PDF 文字 patch 在预览中显示覆盖层，属于近似排版，patch 结果会明确给出 warning。

诊断命令：

```bash
officecli hdoc stats document.hcd --json
officecli hdoc get-index-page document.hcd 0 --revision 3 --json
officecli hdoc get-chunk document.hcd 12 --revision 3 --json
officecli hdoc gc document.hcd --json
officecli hdoc gc document.hcd --delete --json
```

`stats` 列出分类存储与解压后字节、当前 revision 新增字节及未引用对象。`gc` 默认只列出可清理对象；`--delete` 获取写锁、完整校验当前包并扫描所有历史 revision 的引用后，仅清理不被任何 revision 引用的内容寻址对象。已暂存但尚未应用的图片资产不会被自动清理。

## 验证命令与结果

```bash
officecli hdoc import examples/excel/pivot-tables.xlsx --output /tmp/pivot-gzip.hcd --json
officecli hdoc validate /tmp/pivot-gzip.hcd --json
officecli hdoc stats /tmp/pivot-gzip.hcd --json
officecli hdoc import examples/hdoc/pdf-raster-quality.pdf --output /tmp/pdf-auto.hcd --json
officecli hdoc import examples/hdoc/pdf-raster-quality.pdf --output /tmp/pdf-lossless.hcd --pdf-raster-mode lossless --json
officecli hdoc import examples/hdoc/pdf-raster-quality.pdf --output /tmp/pdf-lossy.hcd --pdf-raster-mode lossy --pdf-raster-quality 70 --json
officecli hdoc apply /tmp/pdf-auto.hcd --patch examples/hdoc/pdf-text-patch.json --expected-revision 0 --json
officecli hdoc render-html /tmp/pdf-auto.hcd --revision 1 --chunk-limit 1 --output /tmp/pdf-edited.html --screenshot /tmp/pdf-edited.png --json
cargo test -p hcd-core -p hcd-docx -p hcd-formats --offline
```

63,668 字节的 `pivot-tables.xlsx` 导入后，gzip HCD 实际文件总量为 255,732 字节，未压缩 HCD 为 1,180,831 字节；校验通过。PDF 验证页包含 6–12 pt 字、细表格线和图形：PNG 193,176 字节，默认 auto JPEG 136,161 字节（PSNR 49.82 dB），强制质量 70 JPEG 98,099 字节（PSNR 39.27 dB）。[三种模式的页面对照](../examples/hdoc/pdf-raster-quality-comparison.png)可用于逐项检查细字和线条。

PDF 文本 patch 的[实际预览截图](../examples/hdoc/pdf-text-edit-preview.png)显示更新后的标题，橙色虚线与悬停提示标记近似覆盖；patch 结果同时返回 `PDF_EDITED_TEXT_OVERLAY_APPROXIMATE` warning。稳定 nodeId、source-backed 导出、无源导出和旧 revision 读取均已在样例上核对。

断电模拟在两 revision 包中写入一个损坏的孤儿 `.html.gz`：`hdoc gc` 先列出该 29 字节文件，`--delete` 后文件消失，revision 0 分片仍可读取且整包校验通过。core 测试同时覆盖 gzip 截断、尾部伪数据、解压膨胀、伪造 descriptor 长度/hash 和历史索引对象保留。

对已有 163 页 HCD 中的全部 PNG 页面资产，使用与导入器相同的 Rust JPEG 编码器和门槛离线试算：158 页选中 JPEG，页图总量从 68,083,396 降到 28,539,945 字节，选中页最低 PSNR 为 37.45 dB。该样例的原 PDF 未随 HCD 包保存，因此整包重新导入后的真实总量、峰值内存与总耗时尚未验收。现有文本分片 gzip 试算约 2.17 MB，按资产试算估算 HCD/2 总量约 31 MB。

性能边界：上述单页 PDF 导入在本机分别耗时约 5.18 秒（lossless）、5.53 秒（auto），峰值常驻内存约 24 MB、30 MB；已编辑单页 PDF 的无源 PDF 导出耗时 46.56 秒、峰值约 773 MB。对仓库中仅 638 字节的单页 `examples/test.pdf` 做无源导出，也耗时约 41 秒、峰值约 887 MB，说明主要瓶颈在现有 HTML→PDF 引擎，而非 JPEG 页图大小。不能据此推断 163 页大文件的表现；大 PDF 的真实导入和无源导出仍需持有原件后单独验收。
