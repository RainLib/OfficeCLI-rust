# 编辑区图片、表格去除额外容器装饰

2026-11-15。复杂内容的 NodeView 原先添加了底色、左边框、内外边距、说明文字，以及占据正文一行的表格编辑按钮。iframe 还叠加了内边距；Word 原始页面样式也可能在内部重复产生 96 px 的页边距。

本次移除这些额外装饰，图片和表格继续使用规范内容与源样式渲染。编辑区外层已提供纸张及页边距，内部 iframe 只呈现内容，不再重复绘制页面。高度取自内容本身，不再添加额外空白或在 2400 px 处截断。保留原表格边框、底色、合并单元格和图片尺寸。

表格编辑入口不占正文空间，鼠标悬停或键盘聚焦时浮现；触屏保留可见入口。复杂内容仍在原有沙箱内显示，修改继续通过已有表格编辑与节点操作提交。

## 验证

在 `examples/hdoc/editor` 运行，`OFFICECLI_BIN` 指向包含 HCD 服务的二进制：

```sh
npm run build
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm run test:workspace -- workspace.spec.ts \
  --grep 'complex Word tables|Word table text editing|Word table drafts|Word source grids|dark table dialog' \
  --output /tmp/hcd-unwrapped-tables-final
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm run test:workspace -- agent-harness.spec.ts \
  --grep 'generated images insert and export natively in (md|html|docx)' \
  --output /tmp/hcd-unwrapped-images-final
```

- 前端独立页面与嵌入构建通过；日志 `/tmp/hcd-unwrapped-build-final.log`。
- 表格 5 项通过：无卡片、无内部额外边距、工具浮现不改变高度；文字编辑、保存、合并单元格、源文本样式、协同冲突草稿保护继续有效。
- Markdown、HTML、DOCX 图片 3 项通过：真实生成服务桩、插入、修改、原生导出、重新导入与画布显示；验证无额外容器装饰，iframe 高度与内容一致。
- `git diff --check` 通过。

## 截图

- [Word 表格：无卡片，悬停时显示编辑入口](hcd-inline-complex-content/table-edit.png)
- [Word 图片：保留源尺寸，直接放在正文中](hcd-inline-complex-content/image-edit.png)
