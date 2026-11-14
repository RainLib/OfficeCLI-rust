# HCD 字体与 PPTX/XLSX 集成验收

日期：2026-11-14。集成分支：`feature/hcd-font-format-integration`。

本记录覆盖两条功能分支在最新 main 基础上的实际合并。前期独立评估及后续建设建议见 [合并评估](../reviews/hcd-merge-assessment-2026-11-14.zh.md)，其中“尚未完成组合验证”等描述属于合并前的历史状态。

## 合并来源

| 来源 | 固定提交 |
|---|---|
| `main` / `origin/main` | `7916bb354aaa9b25cb7c3d5270a6a2f441d84878` |
| `ao/hcd-ppt-xlsx/wps-parity` | `7de74be9702ac3875433c9a9f40fc3198329e507` |
| `ao/hcd-sass/font-catalog` | `f375ca1240249f2a7866958a137cbc5a70401e3a` |

先合并格式分支，再合并字体分支，均使用 merge commit 保留来源历史。集成工作在新分支上完成。

## 集成修复

- 解决 7 个文件的冲突，保留两边 schema、操作版本、前端字段、工具栏和原有测试。字体继续使用 `hcd-patch/37`，格式操作的既有版本号保持原义。
- 为主题 pin/unpin 创建的 `RevisionRecord` 补齐工作表及幻灯片生命周期字段；补齐组合后的测试 manifest 字段。
- PPTX 字体与 run 格式共用有界事件缓冲；同时支持字体、字号、粗体、颜色和形状对齐。保留 field run、无可写 run、未闭合 run 的处理。
- PPTX 新建文字框同时写入字体、格式和对齐；复制页在原始源部件上应用副本修改，删除页同步移除字体写回请求。
- PPTX 改色时替换旧 fill，并按 DrawingML 顺序把 fill 写在字体节点之前，避免重复 fill 或合并后生成错误顺序。
- XLSX 保留格式及结构编辑能力，同时保留字体导出边界：带节点字体 pin 的 source-backed 导出明确拒绝，clear 后可以继续导出。
- 修复字体分支 `font_retarget.rs` 的 `manual_range_contains`，满足发布工具链的严格 Clippy。

## 组合回归

新增在 `crates/hcd-formats/src/pptx.rs` 的两个测试：

1. `integrated_copy_fonts_format_and_alignment_survive_export_delete_and_restore`：复制源幻灯片，修改副本字体、字号、颜色、粗体和水平/垂直对齐；导出验证属性同时存在、原页未变、fill 只有一个且顺序正确；重新导入并校验；删除原页后副本保持修改；恢复旧修订后恢复原页及副本原始样式。
2. `integrated_inserted_text_box_combines_font_format_and_alignment`：新建文字框同时带字体、颜色、粗体与水平/垂直对齐，验证写出值及 XML 节点顺序。

复验：

```bash
cargo +1.90.0 test -p hcd-formats --lib integrated_
cargo +1.90.0 test -p hcd-formats --lib source_export_still_refuses_a_pinned_cell_font
```

第二条是保留的字体分支用例，也随完整工作区测试通过；同时检查拒绝时不产生输出文件，以及 clear 后恢复导出。

## 完整验证结果

环境：macOS arm64，Rust/Cargo 1.90.0，与 `.github/workflows/build.yml` 的发布工具链一致。Rust 构建复用本机编译缓存；三个前端均重新执行 `npm ci`。

| 检查 | 结果 |
|---|---|
| `cargo +1.90.0 test --workspace` | **946 通过，0 失败，0 忽略**，包含单元测试和实际存在的 CLI 集成测试 |
| `cargo +1.90.0 fmt --all -- --check` | 通过 |
| `cargo +1.90.0 clippy --workspace --all-targets -- -D warnings` | 通过 |
| editor：`npm ci`、`npm run build` | 通过，包含 embed 构建 |
| editor：`themeCss.test.ts`、`blockFont.test.ts` | 通过 |
| admin-app：`npm ci`、`npm run build` | 通过 |
| xlsx-univer-viewer：`npm ci`、`npm run build` | 通过 |
| 冲突文件测试名称并集检查 | 两条来源分支原有测试均保留 |

Rust 完整复验命令：

```bash
cargo +1.90.0 fmt --all -- --check
cargo +1.90.0 clippy --workspace --all-targets -- -D warnings
cargo +1.90.0 test --workspace
```

分别在 `examples/hdoc/editor`、`examples/hdoc/admin-app`、`examples/hdoc/xlsx-univer-viewer` 目录运行：

```bash
npm ci
npm run build
```

编辑器目录额外运行：

```bash
./node_modules/.bin/tsx src/themeCss.test.ts
./node_modules/.bin/tsx src/blockFont.test.ts
```

管理台生成 HTML 已验证重建，只产生构建时间变化，因此保留字体分支的原始产物。该产物内依赖生成的 CSS 模板字符串继承了 5 处空白行行尾空格，未手改生成文件；排除该文件后 `git diff --check` 通过。

## 验收范围与后续

本次完成源码集成、自动化回归和前端构建，没有在浏览器中重新走完所有交互，也没有在真实 WPS/Office 中打开导出文件，不据此宣称视觉保真完成。

下一步优先使用真实样本验收字体与页面/工作表操作的连续编辑、导出重开和撤销恢复，再补充 PR 自动门禁与格式能力矩阵。PPTX 复制已编辑页、分节及页专有关系，XLSX 节点字体源文件回写，以及字体目录跨机器交付仍沿用评估报告列出的能力边界，未在本次集成中扩展。
