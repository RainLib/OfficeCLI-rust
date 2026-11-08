# 文字标记的 HTML 回读、剪贴板与保存

2026-10-26。继续自定义文字 mark 的实际导出兼容；完整七阶段目标仍在进行，管理平台和提醒发送后置。

## 行为

- 原生 HTML 导入识别单个 `data-hcd-custom-mark` 和文本上的 `data-hcd-custom-marks` 数组。只有数组时也能恢复标记；两种表达同时存在时校验作用域内的载荷一致。未知业务 version 原样保留，缺少业务 codec 时由编辑器只读展示。
- 所有载荷沿用 `hcd.mark/1` 的类型、JSON、大小、样式和最多8种重叠限制。孤立的 fallback 标记、非 span 元数据、重复/乱序类型、矛盾数组、代码块中的标记和坏样式拒绝，失败不发布 manifest。
- 导入生成新文档的来源 ID，保留实际 UTF-8 源文字字节区间，不沿用外部 HTML 的来源声明。同 type 内层值替换外层值，不残留旧 fallback；普通直接文字格式在 fallback 内侧，仍可覆盖它。
- 原生导入保留 span 上受限的粗体、斜体、下划线、删除线和六位十六进制颜色/背景色。重复 CSS 声明取最后一个合法值；不复制任意 CSS、事件或外部来源身份。报告明确其余 CSS/布局的转换边界。
- 粘贴先在脱离正文的 template 内校验和规范化元数据，再交给编辑器解析。数组-only 和嵌套多个标记均落到文字叶子上；矛盾内容整次拒绝并提示。粘贴去除旧来源/块身份，之后走正常协同、保存和个人撤销。
- 编辑区的 fallback 使用独立 CSS 变量，避免浏览器重新读取 DOM 时把显示样式变成普通加粗、下划线或背景色。复制序列化器仍输出普通静态 CSS，外部应用无需编辑器样式表就能显示；再次粘贴时不会把该 fallback 重复解析为直接格式。
- 普通文字颜色解析支持浏览器 CSSOM 的 `rgb(r,g,b)`、三位/六位 hex，统一成六位 hex；不接受带透明度、变量或可执行值。
- 新段落不继承上一段的来源默认值和来源 mark。原段落已有文字身份保留，新段落的粘贴/输入由正常保存建立独立来源。

未改变 wire7、结构3、coordinator4、envelope2、mention1 或 mark 模型1。旧文档无需迁移；原有模型/权限门禁继续生效。

## 实际发现与修复

先新增失败测试，确认旧 HTML 导入会丢弃 mark 能力及业务载荷。实际浏览器又发现两处独立问题：邻段编辑会把 fallback 混入普通格式；在段尾 Enter 后复制粘贴会借用未修改根的来源 ID，native 以400拒绝保存。本机草稿仍保留，没有错误显示已保存。

旧夹具保留为[失败摘要](../assets/hcd-mark-html-roundtrip-2026-10-26/pre-fix-failure.json)，检查后主动停止。修复后使用新的隔离夹具进行以下全部正式验证，未重启服务；失败记录不计入通过的五次 checkpoint。

| 版本 | 实际浏览器操作与核对 |
|---|---|
| r1 | 导入两种已注册标记和未知 version17；普通颜色123456与 fallback 分开 |
| r2 | 粘贴仅含数组元数据的两种 mark，保留普通文字色123456和背景dcebfa；旧假来源 ID 未进入保存 |
| r2 不变 | 粘贴矛盾载荷，整次拒绝，不出现待拒绝文字、不新增 checkpoint |
| r3 | Bob 在原段落尾部补充文字；相邻标记的普通格式没有污染 |
| r4 | Alice 撤销自己的粘贴；Bob 输入仍保留。native 文本修改保留了原已清空文字载体的零长度来源/格式，未显示成正文 |
| r5 | 重做，**r3.blocks == r5.blocks**，含来源和 hash |
| r6 | Cmd+C、Enter、Cmd+V 复制已有带 mark/颜色的文字，新段落来源独立；正常保存 |

实际系统剪贴板含两种 mark、RGB普通颜色及静态 fallback，没有编辑区 CSS 变量。实际 native r1–r6 均核对载荷、格式、未知版本、原文来源和复制后独立来源；五条首次 checkpoint 全200。新无 codec 只读窗口显示完整内容，四段带标记文字均显示友好的只读说明。

源格式未修改的 r1 HTML 导出与不可变源文件字节精确相等。本轮没有把新增块后的 HTML 当作源格式精确重写；浏览器选择当前内容转换并下载的 HTML 实际重新导入，全部块内容/文字/mark/普通格式相同，来源 ID 按新文档重新生成。源格式不支持的方式在 UI 禁用；DOCX 提示静态化且不保留业务数据，HTML 提示保留嵌入数据。

无源 HCD 归档的 r1–r6 投影精确相等，实际 DOCX/PPTX/PDF/Markdown 文字回读通过；PDF一页已渲染目检。实际浏览器 DOCX 的粗体、下划线、123456文字色、fff2a8/dcebfa背景色从 OOXML 核对，业务 ticket 未混入文档。

证据：[实际文件核验](../assets/hcd-mark-html-roundtrip-2026-10-26/file-evidence.json)、[最终编辑器](../assets/hcd-mark-html-roundtrip-2026-10-26/editor-final-r6.png)、[只读窗口](../assets/hcd-mark-html-roundtrip-2026-10-26/reader-r6.png)、[无效粘贴](../assets/hcd-mark-html-roundtrip-2026-10-26/invalid-paste-final.png)、[实际剪贴板](../assets/hcd-mark-html-roundtrip-2026-10-26/editor-copy-final.html)、[PDF整页](../assets/hcd-mark-html-roundtrip-2026-10-26/pdf-r6.png)、[检查摘要](../assets/hcd-mark-html-roundtrip-2026-10-26/validation.json)。

## 复现

```sh
cargo test -p hcd-formats --lib
cargo clippy -p hcd-formats --all-targets -- -D warnings
cargo build -p officecli
cd examples/hdoc/editor
npm test
npm run build
```

在仓库根启动隔离夹具，按上表完成实际操作并下载 HTML/DOCX：

```sh
python3 scripts/hcd-mention-preview.py --custom-marks --checkpoint-probe \
  --source-html docs/assets/hcd-mark-html-roundtrip-2026-10-26/source.html \
  --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-mark-html-final
python3 scripts/hcd-mark-html-files.py <root>/private.json <downloaded.html> <downloaded.docx>
python3 scripts/hcd-mark-html-audit.py <root>/private.json <failed-root>/private.json
```

642项前端、53项 hcd-formats 测试、TypeScript/独立/嵌入/native 构建、相关 all-targets Clippy、fmt及diff检查通过。验收完成后仅移除夹具控件、改用同一组声明式定义，页面刷新后仍是r6；个人历史验证发生在刷新前，不声称跨刷新恢复个人undo。

本次是文本 mark 的回读，不等于任意 HTML/CSS、图像资源、人员/自定义业务节点、只读表格的业务数据已经完整回导。原生导入颜色仍限六位 hex，浏览器剪贴板颜色规范化另有RGB/短hex支持。可编辑行内容器、mark属性候选/迁移、复杂注释范围、长文容量/压缩/GC以及其余原目标继续。没有真实 Office、真实 AI、服务重启、数据库多实例、所有 IME/设备或生产验收。
