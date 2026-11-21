# 图文制作、页数约束与图片编辑验收

2026-11-15。本次修复“要求至少 10 页，实际只有 4 页”和制作过程不可见的问题，并接入真实图片生成。

## 本地验证

工作台：<http://127.0.0.1:58402/?locale=zh-CN>。在本地验收文档中打开“中文发音 · 图文课件”（`accept-pronunciation`）。演示服务使用临时目录；访问地址以运行时输出为准。

- [真实模型生成的 10 页中文发音课件](hcd-document-production/chinese-pronunciation.pptx)
- [真实课件的编辑画布](hcd-document-production/real-canvas.png)
- [制作完成界面](hcd-document-production/real-completed.png)
- [真实任务、页数、资源和模型记录](hcd-document-production/real-result.json)
- [原生 PPTX 重新导入后的校验结果](hcd-document-production/real-validation.json)
- [制作过程与 GLSL 占位效果](hcd-document-production/production-glsl.png)（隔离脚本模型验收截图）
- [图片资源工作室](hcd-document-production/image-studio.png)（隔离脚本模型验收截图）

真实任务使用用户配置的 `gpt-6.1-sol`，4 位 Agent，在约 297 秒内完成 10 页课件；独立图片模型 `gpt-image-2` 生成了 10 张不同的 1536×1024 插图。原生文件的全部 XML/关系文件可解析，恰好包含 10 页、10 张插图，标题和教学正文为可编辑 DrawingML 文本，租约全部释放。标题和正文独立于位图插图保留为可编辑文本。图片生成有不绘制文字的提示约束，但位图内部的偶发标签或错误仍需人工检查，不能把图片内元素当作可编辑文字。

## 行为调整

- 页数由 Harness 独立解析和检查，不由协同人数决定。在计划、草稿、最终页面及原生文件重新打开时核对；不足页数不能显示完成。支持 1–40 页，超出范围明确报错。区分“当前只有4页”“制作3页”和“每一页”“第一页”等语境。
- 草稿先在独立副本中制作，完成正文、插图和原生导出验收后回放版本化操作。制作期间原文改变会阻止过期稿覆盖；正式回放仍是多个受保护修订，并非跨修订原子事务。
- 画布展示规划、制作内容与图片、整稿验收、写入核对的实际阶段。页卡展示已起草/待制作内容、真实资源状态和独立 Agent 位置，可收起回到文档。草稿预览是制作视图，不承诺与最终原生排版逐像素相同。
- 图片占位预先保留宽高比，等待/生成/失败/停止分别展示。GLSL 由 WebGL 动画时钟驱动，不以 React 逐帧重建文档；离屏、后台暂停，并尊重减少动态效果设置。无 WebGL 时保留静态占位。图片预览延迟加载。
- 图片生成只暂存资源，不修改文档。插入、替换和改尺寸使用 revision、visualHash、协同 epoch、人工草稿及工作锁检查。只读用户不能生成/写入，其他用户不能停止别人的任务；同文档读者可以查看共享图片。
- 图片生成失败、取消或校验失败不插入假图；MCP 和内置 Agent 使用同一图片任务与修订通道。新增图片正确进入原生 DOCX/PPTX/XLSX 包关系及媒体列表，PDF 写入实际图像，Markdown/HTML 导出为可移植的嵌入资源。
- 修复 Office XML 带 UTF-8 BOM 时新增关系插入位置偏移，以及图片节点误走文字查询、流式图片改尺寸后变成绝对定位的问题。Markdown/HTML 导出的嵌入 PNG/JPEG 重新打开时会恢复为真实图片，保留尺寸并拒绝执行原始活动 HTML。

## 格式范围

| 格式 | 当前相关能力 | 本次仍有的边界 |
| --- | --- | --- |
| PPTX | 原生文字编辑、整稿重做、图文制作、指定页插图、多 Agent 协作 | 使用有限的图文版式模板；未覆盖所有母版、图表及复杂对象 |
| DOCX | 段落/样式和映射表格文字编辑、协作、新增行内插图及尺寸调整 | 新图添加到文档末尾；复杂浮动对象和源文件图片改写有保护限制 |
| XLSX | 单元格与公式编辑、计算、独立列分工、工作表插图和尺寸调整 | 未声明支持所有公式、图表、宏或外部数据源 |
| PDF | 映射文字和新增对象编辑、协作、按页插图 | 不是通用排版重流系统；扫描件没有自动 OCR，文字替换保真仍有边界 |
| Markdown / HTML | 结构化内容编辑、协作、末尾行内插图、嵌入图片导出/重新导入 | 不加载远程图片；原始活动 HTML 被过滤；重新导入后的源图片改写仍受限制 |

完整“推翻原稿→规划全稿→并行制作→原生验收→替换”的制作管道目前针对 PPTX。其他格式接入通用 Agent/MCP 编辑与图片资源工作室，不等于已经实现所有复杂对象的无损编辑与整稿重排。

图片任务/Agent 运行记录目前保存在服务内存中，服务重启后不恢复这些记录；已提交文档修订和资源保留。图片生成默认两路并发。DOCX/Markdown/HTML 的当前插图语义为文档末尾行内添加，界面仅提供末尾目标，核心同样拒绝提前分块的插入，避免预览与原生导出位置不一致。

## 配置与调用

文本默认模型已改为 `gpt-6.1-sol`，可用 `HCD_OPENAI_MODEL` 显式覆盖。图片模型用 `HCD_OPENAI_IMAGE_MODEL`，默认 `gpt-image-2`；`HCD_OPENAI_IMAGE_BASE_URL` 可配置单独的 Images API 地址，默认沿用文本 API 的基础地址。密钥仅由服务端读取。

UI 的“生成配图”默认开启。API/MCP 显式传入 `generateImages: true` / `generate_images: true`：

```json
{"task":"推翻原稿，讲解中文发音，至少10页，每页包含发音要领与跟读练习，并生成插图。","mode":"rebuild","agentCount":4,"generateImages":true}
```

独立图片工具为 `hcd_generate_image` 和 `hcd_image_jobs`。生成后轮询至 ready，使用实际 `assetHash`，通过 `hcd-patch/47` 的 `image.insert` 写入指定 `chunkId`；随后用 `hcd-patch/3` 的 `image.replace` / `image.geometry` 和最新 `visualHash` 编辑。PPTX/XLSX 使用 EMU；PDF/流式文档使用 pt。流式文档目标必须为 body 区域的最后一个分块，不会误插到页眉/页脚。

## 验证方法

Rust 使用当前项目要求的 `cargo +1.90.0`：

```sh
cargo +1.90.0 test -p officecli -p hcd-core -p hcd-docx -p hcd-formats --lib --bins
cargo +1.90.0 clippy -p officecli -p hcd-core -p hcd-docx -p hcd-formats --all-targets -- -D warnings
cargo +1.90.0 fmt --all -- --check
```

在 `examples/hdoc/editor` 运行，`OFFICECLI_BIN` 指向最新已构建二进制，`HCD_BROWSER_PATH` 指向本机 Chrome：

```sh
npm run build
npm run test:workspace -- agent-harness.spec.ts
npm run test:workspace -- agent-harness.spec.ts --grep 'generated images|production pipeline'
```

浏览器场景使用公开样例的隔离副本和脚本模型，验证 4 页错误计划修复成 10 页、实际 WebGL 帧变化、原生页数/图片/可编辑文字/标题样式、6 种格式图片生成/替换/缩放/导出/重新导入、权限与取消、锁释放、公式及多 Agent 冲突恢复、连续轨迹和稳定画布。真实模型课件及其原生重新导入校验独立记录于上方文件。

- [浏览器全量 47 项通过](hcd-document-production/browser-47.log)
- [Rust 512 项通过](hcd-document-production/rust-512.log)
- [TypeScript、应用和嵌入包构建](hcd-document-production/ui-build.log)

Clippy 与格式检查通过；末尾插图约束另做文本格式单元测试及图片链路复验。
