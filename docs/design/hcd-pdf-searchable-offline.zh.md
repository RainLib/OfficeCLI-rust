# HCD 离线 PDF：保留画面并恢复文字检索

后续更新（2026-10-25）：本文末尾留存的 ASCII85+Flate 导入与源子集字体新增字符写入反例已修复，并用实际 CLI/HTTP 新中文和 emoji 保存复验。当前新增发现的文字框/混合字体回写差异继续保留。最新状态见 [PDF 输入与字体保存](hcd-pdf-input-and-font-save.zh.md)。

日期：2026-10-25。接续上一批实际发现的“没有原始 PDF 时，离线再导出只有页面图像”问题。本批修复无源 PDF 的搜索/选择/复制文字层，保留原生归档、保存和协同协议。

## 行为与实现

`.hcdz` 解包后，即使没有原始 PDF，也可将固定布局 PDF 再导出为保留页面画面、同时带可检索文字的 PDF。文字来自**所选已提交版本**中的规范文字节点；当前版本和历史版本分别读取对应的不可变正文及资源。没有文字节点的扫描页不会生成文字，本批不运行 OCR。

页面视觉仍使用已合成的页面 PNG/JPEG。其上增加 PDF rendering mode 3 的不可见文字，按节点的页面坐标、裁切后尺寸、旋转和字符宽度设置矩阵。分片延续到原页面，不能漏掉后续文字、重复整页或新增空页。文字层不绘制替换字形，不改变已保存的画面。

字体按需子集化并使用明确的 CID→Unicode 映射，包含非 BMP 字符的 UTF-16 映射。不可见层中缺少可见字形的字符也保留独立 Unicode 身份；这些字体带专用标记，不能被正常可见文字的字体复用、覆盖检查和字体选择逻辑选中。每次处理一个 HTML 分片和当前字体缓存；原有 JPEG 压缩流直接嵌入，PNG 仍逐页处理。

同时修复 PDF 文字宽度估算：简单字体也可以通过 ToUnicode 将字节码映射到中文等字符，必须按源字节码查 `/Widths`，不能按 Unicode 值套用默认拉丁字宽。实际中文夹具中的 6 个汉字从错误的 42pt 框恢复为 84pt，避免搜索选区只有画面中文字的一半宽。

## 兼容范围

| 项目 | 结果 |
|---|---|
| 已有原生文字节点 | 无源再导出可检索、选择、复制；读取所选已保存版本 |
| 页面画面 | 不变；真实输出逐页与移除文字层后的图像 PDF 做像素比较 |
| 同页 continuation 分片 | 合并到同一输出页，文字保留一次 |
| 扫描页 | 保留画面；没有 OCR 文字时仍无文字层 |
| 原始向量、字体排版和 PDF 对象树 | 不重建；本路径仍报告 `VISUAL` |
| 原始字体/对象编辑、PDF 标签与无障碍结构、数字签名 | 不声称恢复这些能力；搜索层不等同原生 PDF 对象重建 |
| `.hcd` / `.hcdz`、协同版本、保存版本 | 格式不变；查看和导出不新增文档版本 |

保真报告使用 `HCD_PDF_RASTER_TEXT_EXPORT`，列明页面数与文字节点数，继续明确图像静态化、原始字体和对象结构丢失的范围。报告不会再将“可选择文字层”记为丢失。

## 已验证的证据

- `pdf-handler` 46 项、`hcd-formats` 48 项、OfficeCLI 内联 157 项测试通过；新增验证 Unicode/非 BMP/无可见字形映射、可见字体隔离、分片、扫描页、非法和缺失几何拒绝，以及简单字体字宽。另外 19 项多格式和 3 项 HTML 转换集成测试通过，共 273 项相关原生测试；clippy 全目标检查和构建通过。
- 五页合成 PDF：0°、90°、180°、270° 四种旋转和裁切，外加仅图像扫描页。导入强制每块 1 个对象，覆盖同页多个 continuation。
- 创建 r1 真实保存，再打包、解包到没有 `sources` 的独立目录。r0 与 r1 分别包含自己的正文，旧版不出现新版文字，新版不保留被替换旧文字。
- Poppler 实际抽取中文成功；`-bbox-layout` 的每个单词边界落在对应页面的规范文字框内，覆盖所有旋转。扫描页无文字层。
- 两个版本的 10 个页面渲染后，像素均与仅保留页面图像流的基线完全相同。
- 新启动的隔离原生 HTTP 服务使用只读令牌导出，实际返回的 PDF 可抽取 r1 已保存中文；保真级别仍为 `VISUAL`。导出和校验前后原始 manifest 字节不变。
- 先前工作区夹具的 Word r2 / PPT r0 / PDF r0 文件检查重新通过，原图和正文保留；离线 PDF 的 `Original` 现在可抽取。

本批没有改前端行为，未重跑前端套件；上一批的 494 项前端测试和构建是当时的证据。本批不声称生产部署、跨平台或真实 Office/PDF 客户端交互已验收。

证据：[文件检查记录](../assets/hcd-pdf-search-2026-10-25/pdf-search-evidence.json)、[r0 PDF](../assets/hcd-pdf-search-2026-10-25/offline-r0.pdf)、[r1 PDF](../assets/hcd-pdf-search-2026-10-25/offline-r1.pdf)、[r1 页面画面](../assets/hcd-pdf-search-2026-10-25/offline-r1-page1.png)。复验：

```sh
cargo test -p pdf-handler -p hcd-formats --offline
cargo test -p officecli --bin officecli --offline
cargo clippy -p officecli -p pdf-handler --all-targets --offline -- -D warnings
cargo build -p officecli --offline
python3 scripts/hcd-pdf-search-verify.py
```

脚本依赖本机 `reportlab`、`pypdf`、Pillow 和 Poppler；只使用合成文档、本机隔离服务与有时限的只读令牌，不触达生产或外部 Provider。

## 仍待处理

本次核对还保留了两个具体兼容缺口，不能据此认定所有 PDF 路径完成：

1. 现有导入器对 ReportLab 默认的 ASCII85+Flate 页面内容流报 `corrupt deflate stream`。有效的合成反例已归档在 [ASCII85 输入](../assets/hcd-pdf-search-2026-10-25/ascii85-content-source.pdf)；本批主夹具用未压缩内容流隔离验证导出，输入解码需另行修复。
2. 原 PDF 使用子集字体时，CLI 的 `hdoc apply text.splice` 对源字体中没有的新字符仍会报不可编码；本批保存夹具使用原字体已具备的字符。不可见层的完整 Unicode 保留已通过独立原生字体测试，但不代表所有源字体写入场景已经完成。

XLSX/其余属性与编辑模式命令、复杂块/自定义 marks、结构化 AI 与固定布局 AI、设备和生产验收继续留在总实施清单。管理平台和提醒发送不在本阶段。
