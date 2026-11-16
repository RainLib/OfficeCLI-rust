# PPT 左右面板对齐设计稿

依据 [PPT 编辑页设计](../design/officecli-workspace-v2/previews/04-pptx-edit.png) 和 [AI 抽屉设计](../design/officecli-agent-workspace/HRzgj.png) 调整。沿用统一背景、圆角抽屉和浅色 / 深色主题。

## 左侧幻灯片目录

- 使用实际文档缩略图、两位页码和当前页强调边框；可点击定位画布。
- 直接拖动缩略图排序，显示插入位置；复制、删除和拖动手柄在 hover / 键盘聚焦时出现，触摸设备保持按钮可达。
- 也可用 `Alt + ↑ / ↓` 排序；预览和历史版本不提供修改操作。
- 任意距离的拖拽只生成一次修订，支持撤销、重做、重新打开及导出后保留顺序。遇到过期修订或冲突时不留下错误的前端排序。
- 后端新增 `hcd-patch/48` 的 `pptx.slide.reorder { chunkId, targetIndex }`，`targetIndex` 为最终的零基位置；兼容原有相邻移动协议，拆分成多个 chunk 的幻灯片整体移动。

## 右侧属性与协作

- PPT 增加“形状属性”抽屉，按设计组织为“文本 / 布局 / 协作”。选择画布文字自动打开属性，顶栏也提供入口。
- 字号、字重、粗斜体、下划线、颜色、横纵向对齐，以及 X / Y / W / H 均调用实际保存接口；位置和尺寸以 pt 显示。
- 展示选中文字的实际字体；可切换字体范围遵循文档已有的钉住主题字体。文字草稿未保存时禁用属性修改，避免覆盖草稿。
- 保存属性后恢复当前选择，可以连续操作。切换协作面板保留属性分类和聊天草稿。
- AI 抽屉同步收敛标题、模型行、标签和状态区样式，保留聊天、工具展开与协作功能。
- 左右收起继续完全释放空间；右侧展开按钮仍在“导出”右侧。手机使用浮层抽屉，支持 Escape 关闭并恢复按钮焦点。

## 验证方式

在仓库根目录运行；浏览器测试使用隔离的临时文档，不修改本地演示文档。

```bash
cargo test -p hcd-core pptx_slide_
cargo test -p hcd-formats moving_a_page_writes_the_slide_list
cargo fmt --all -- --check
npm --prefix examples/hdoc/editor run build
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm --prefix examples/hdoc/editor run test:workspace -- e2e/workspace.spec.ts \
  --grep 'PPT thumbnail drag|PPT shape properties|collapsed sidebars|appearance follows|dark workspace|context menu uses|mobile drawers dismiss|workspace drawers,|phone workspace|all seven formats|canvas zoom|workbook preview|document tabs retain|workspace reload restores|fixed history saves|history uses the selected|agent commits preserve preview'
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm --prefix examples/hdoc/editor run test:workspace -- e2e/agent-harness.spec.ts \
  --grep 'Pen chat drawer|Codex-style chat|chat composer handles|chat preserves history|right-click and slash'
```

新增浏览器用例实际完成首张拖至末张、API 顺序核对、撤销重做、复制删除、重载、409 拒绝和只读检查；属性用例实际保存字号 32、居中和 X=90pt，并检查协作草稿保留与 390px 布局。Rust 测试另核对跨多页移动的一次修订、非法目标、过期修订，以及源 PPTX 导出顺序。

结果：17 项工作区回归、5 项聊天回归、14 项核心幻灯片测试和 1 项源文件导出测试通过；TypeScript、独立站和嵌入构建、Rust 格式检查通过。日志：[工作区](hcd-ppt-panels/workspace-17.log)、[聊天](hcd-ppt-panels/chat-5.log)、[核心](hcd-ppt-panels/core-14.log)、[导出](hcd-ppt-panels/export.log)、[构建](hcd-ppt-panels/build.log)、[格式](hcd-ppt-panels/fmt.log)。

截图：[浅色属性](hcd-ppt-panels/ppt-shape-properties-light.png)、[深色属性](hcd-ppt-panels/ppt-shape-properties-dark.png)、[悬停操作](hcd-ppt-panels/ppt-panels-dark-hover.png)、[协作抽屉](hcd-ppt-panels/ppt-collaboration-dark.png)、[手机抽屉](hcd-ppt-panels/ppt-properties-mobile-dark.png)。

本次针对 PPT 目录与形状属性，PDF 复用页面目录外观。触摸拖动已实现，浏览器自动化覆盖桌面拖动与手机布局，尚未单独自动化验证真实触摸拖动。
