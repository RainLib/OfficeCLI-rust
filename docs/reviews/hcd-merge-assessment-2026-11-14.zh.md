# 字体与 PPTX/XLSX 分支合并评估

评估日期：2026-11-14。结论针对下面固定的提交，不随分支后续移动自动更新。

> 后续进展：已按用户要求在 `feature/hcd-font-format-integration` 完成两条分支的集成修复和自动化验证，结果见 [集成验收记录](../acceptance/hcd-font-format-integration.md)。本文保留合并前评估时点的发现，文中“尚未完成”“本次没有提交”等表述均指前期评估阶段。

| 对象 | 提交 | 状态 |
|---|---|---|
| `main` / `origin/main` | `7916bb354aaa9b25cb7c3d5270a6a2f441d84878` | 已 fetch，并将本地 main 从 `45a2b75` 快进到此处 |
| `ao/hcd-sass/font-catalog` | `f375ca1240249f2a7866958a137cbc5a70401e3a` | 本地、远程一致；相对共同基点新增 53 个提交 |
| `ao/hcd-ppt-xlsx/wps-parity` | `7de74be9702ac3875433c9a9f40fc3198329e507` | 本地、远程一致；相对共同基点新增 55 个提交 |

两个功能分支的共同基点都是 `45a2b75`。最新 main 的两个提交修复 DOCX bookmark 范围拆分中的混合 run 内容，并调整测试位置；workspace 版本已为 `0.1.31`。本次没有将功能分支合入 main，没有修改其原工作区，也没有 push、提交报告或创建 PR。

## 合并结论

**两条线都有可复用成果，各自与最新 main 的试合并均无文本冲突，自动化测试通过；字体线另有发布工具链下的新增 Clippy 错误。两条线同时进入 main 还需要专门的集成修改，当前不能直接连续 merge。**

| 比较 | Git 文本合并 | 功能验证 |
|---|---|---|
| main + 字体分支 | 无冲突 | 全工作区 848 项测试通过；Rust 1.90 严格 Clippy 不通过 |
| main + 格式分支 | 无冲突 | 全工作区 799 项测试通过；Rust 1.90 严格 Clippy 通过 |
| main + 格式分支 + 字体分支 | 7 个文件、35 处冲突 | 核心代码的加法型冲突合好后，还复现了一个不在冲突文件里的编译错误；完整组合尚未构建、测试 |

仓库 `CONTRIBUTING.md` 要求一 PR 一个原子能力。两条长期分支都含多个可独立合并/回退的功能，因此适合作为集成来源，再按能力组织 PR，不宜各自打成一个大功能 PR。

## 当前已经建设到哪里

| 方向 | 已实现的主要闭环 | 本次观察到的边界 |
|---|---|---|
| 字体目录 | 本机不可变字体修订、字体 blob、主题槽位、文档默认主题与 pin/unpin、主题退役、引用保护删除、审计、许可证到期提示、管理台 | 明确是 same-machine catalog；不是现成的跨机器字体分发/租户系统 |
| 编辑器字体 | 加载主题字体；固定页面节点的 `text.font` / `text.font.clear`；语义编辑器块级 Latin / East Asia / bidi 字体 | 不等同于任意富文本选区的逐字符字体编辑；块级与节点级路径要分别验收 |
| 字体导出 | HTML 字体；DOCX/PPTX 主题注册和允许时嵌入；源 DOCX/PPTX 节点字体回写；语义 PDF 正文字体；源 PDF 文本换字及预检 | XLSX 注册主题字体名但不嵌入字库；节点 `text.font` 的 source-backed XLSX 导出仍主动拒绝。语义 PDF 主题正文字体选择要求候选覆盖全文，不应理解为完整的多脚本主题排版 |
| PPTX 编辑 | run 粗体/斜体/下划线/字号/颜色、形状水平/垂直对齐；幻灯片新增、删除、移动、复制及有源导出 | 复制仍拒绝已由 HCD 改写/创建的页；备注、图表、嵌入对象等页专有关系不在当前复制范围内；分节 deck 仍有导入/导出边界 |
| XLSX 编辑 | 单元格格式/对齐/边框/数字格式；工作表改名、新增、删除；冻结窗格；行列移位联动窗格、命名区域、筛选和验证；保护信息保留；源文件未写出的空行定位 | 不是完整 Excel/WPS 引擎；复杂跨表公式、部分 drawing/table/pivot 等结构仍有拒绝条件，需要按样本逐项扩大 |

格式分支的主要价值是加深已有 PPTX/XLSX 的编辑与导出支持，而非增加一批新的文件扩展名。

字体能力主要位于 `hcd-core/src/catalog.rs`、`hcd-formats/src/theme_fonts.rs`、`pdf-handler/src/font_retarget.rs`、`officecli/src/hdoc_server.rs` 和管理台。格式能力主要位于 `hcd-core/src/patch.rs`、`hcd-formats/src/{pptx,xlsx}.rs`、`oxml/src/archive.rs` 及编辑器。字体分支净比较为 88 个文件、+26,615/-407 行；格式分支为 51 个文件、+32,239/-9,561 行，包含测试、文档、生成页面、lockfile 和重排代码，不能将行数直接视为业务逻辑规模。

## 必须处理的集成问题

### 1. 无文本冲突的目录代码会编译失败（已复现）

字体分支的 [`catalog.rs:1778`](https://github.com/RainLib/OfficeCLI-rust/blob/f375ca1240249f2a7866958a137cbc5a70401e3a/crates/hcd-core/src/catalog.rs#L1778) 在 pin/unpin 时直接创建 `RevisionRecord`。格式分支向该类型新增了以下字段：

```text
sheet_renames, sheet_additions, sheet_removals,
slide_additions, slide_removals, slide_reorders, slide_copies
```

`catalog.rs` 是字体分支新增文件，Git 不会对它报告冲突。将合并树中 `hcd-core/src/lib.rs` 与 `patch.rs` 的加法型冲突按两边内容并集处理，再仅检查 hcd-core，得到：

```text
error[E0063]: missing fields `sheet_additions`, `sheet_removals`,
`sheet_renames` and 4 other fields in initializer of `types::RevisionRecord`
  --> crates/hcd-core/src/catalog.rs:1778:18
```

集成时主题修订应为这些字段显式填入空列表，并检查所有 `RevisionRecord` 构造点。这里是组合后的集成缺陷，两条分支单独构建均没有这个错误。

### 2. PPTX 导出需要组合两套行为，不能整段选择一边

两个分支共同修改 16 个文件，其中以下 7 个发生文本冲突：

| 文件 | 冲突处数 | 处理重点 |
|---|---:|---|
| `crates/hcd-core/src/lib.rs` | 4 | 同时保留 schema 常量、加载和测试 |
| `crates/hcd-core/src/patch.rs` | 1 | 同时接纳两边版本白名单；继续保留各操作专属版本约束 |
| `crates/hcd-formats/src/common.rs` | 1 | 合并公共 XML 工具 import，并保留字体回写支持判断 |
| `crates/hcd-formats/src/pptx.rs` | 20 | 字体、run 格式、形状对齐、页面新增/删除/复制的导出与报告统一 |
| `crates/hcd-formats/src/xlsx.rs` | 5 | 保留表格编辑能力、字体导出拒绝规则和两边测试，尤其避免截断大段新增测试 |
| `examples/hdoc/editor/src/FixedViewer.tsx` | 3 | TextNode 字段并集；字体样式加载与幻灯片目录操作共存 |
| `examples/hdoc/editor/src/sourceLocale.tsx` | 1 | 两边文案并存 |

PPTX 的 `rewrite_text_part` 两边扩展了不同参数与事件处理状态：一边写字体，一边写格式、对齐及页面结构。新增文本框也分别增加了 `font` 与 `format/align` 字段。删除页面时还需要清除对应字体写回请求；复制页面的修改要以原页面为输入写到新部件。这些路径必须一起设计并做组合回归。

字体操作目前使用 `hcd-patch/37`；格式分支使用 `30–36`、`41–46`。**这两个分支之间没有编号撞车，不应为了解文本冲突随意重新编号。** 已产生历史 patch 的编号必须保持含义稳定。文档格式 `hcd/2` 与操作格式 `hcd-patch/*` 是不同层次。

### 3. 字体分支不满足当前发布工具链的 Clippy 门禁（已复现）

`.github/workflows/build.yml` 使用 Rust 1.90.0 并执行 `cargo clippy --all-targets -- -D warnings`。用同版本在字体合并快照上执行 workspace 严格检查，新增的 [`font_retarget.rs:440`](https://github.com/RainLib/OfficeCLI-rust/blob/f375ca1240249f2a7866958a137cbc5a70401e3a/crates/pdf-handler/src/font_retarget.rs#L440) 触发 `clippy::manual_range_contains`：

```rust
if !scale.is_finite() || scale < MIN_HORIZONTAL_SCALE || scale > MAX_HORIZONTAL_SCALE {
```

可保持有限数检查，将边界判断改为 `!(MIN_HORIZONTAL_SCALE..=MAX_HORIZONTAL_SCALE).contains(&scale)`，然后重跑完整门禁。该文件是字体分支新增，属于分支需要修复的问题。诊断性地仅放行 `manual_range_contains` 后，字体快照的 Rust 1.90 workspace Clippy 通过；本次没有修改该分支源码。格式分支在同样 Rust 1.90 工具链下的完整 workspace Clippy 已通过。

### 4. 通过测试不等于完成 WPS 保真验收

本次实际执行了 Rust 测试和前端构建，没有启动浏览器重跑全部场景，也没有在真实 WPS/Office 应用里打开导出文件。格式分支带有 9 篇新增验收记录和 7 张新增截图，可用于复验入口；例如 `docs/acceptance/hcd-pptx-slide-copy.md` 明确记录了重叠 hitbox 阻挡副本正文点击的限制，以及复制资源和分节限制。这是分支记录中的已知问题，不是本次浏览器复测的发现。

字体分支新增文档主要是管理台 README，尚缺与其多个功能对应的集中验收说明和新增截图。准备功能 PR 时需按贡献规则补充；当前 GitHub 查询未发现以这两个分支为 head 的 PR。

## 验证记录

测试环境：macOS arm64；默认 Rust/Cargo `1.99.1`。每个测试工作区都是“最新 main + 单条功能分支”的隔离合并快照，保留 main 的 bookmark 修复和版本更新。复用了已有编译缓存与前端 node_modules，没有修改原分支源码；本次未执行全新 `npm ci`。

| 检查 | 字体 + main | 格式 + main |
|---|---|---|
| `cargo test --workspace` | 848 通过，0 失败、0 忽略 | 799 通过，0 失败、0 忽略 |
| `cargo fmt --all -- --check` | 通过 | 通过 |
| 编辑器 `npm run build` | 通过，包含 embed 构建 | 通过，包含 embed 构建 |
| 字体新增 TS 测试 | `themeCss.test.ts`、`blockFont.test.ts` 通过 | 不适用 |
| 管理台 `npm run build` | 通过 | 不适用 |
| XLSX Univer viewer `npm run build` | 未单独运行 | 通过 |
| 默认工具链严格 Clippy | 未通过；最新 main 对照也复现已有诊断 | 未通过；最新 main 对照也复现已有诊断 |
| Rust 1.90 workspace `cargo check --locked` | 通过 | 未单独运行 |
| Rust 1.90 workspace 严格 Clippy | 不通过：新增 `font_retarget.rs:440` | 通过 |

Clippy 对照复现的现有诊断包括 `oxml/src/xml_util.rs` 的排序、`pdf-handler` 的 `chunks_exact`、`hcd-core/src/patch.rs` 的 `collapsible_match`。临时放行这三类后还遇到已有 handler 的 loop/filter 诊断和 `textual.rs` 的 unwrap 诊断；这不是严格 lint 全绿证明，集成 PR 仍需以约定工具链跑完整门禁。

字体分支 `git diff --check` 另报告管理台生成 HTML 的 5 处行尾空格，格式分支此检查通过。管理台重建只观察到内嵌显示时间变化，已在隔离工作区恢复生成文件。

原始合并输出、测试及构建日志保存在本机临时评估目录，位置由 `/tmp/officecli-merge-review-current` 记录；关键结论和复现命令保留在本报告中。

## 推荐的合并组织

建议先让格式线的基础能力落地，再将字体线适配到新的修订模型和 PPTX writer。原因是格式线已经改变了页面/工作表生命周期，字体的写回请求需要遵循这些生命周期。

下表每行是一组依赖顺序，**不是一个大 PR**。其中每个可独立回退的能力仍应独立成 PR；测试与该能力的验收材料随同提交。

| 顺序 | 能力组 | 可拆分的原子提交范围 |
|---|---|---|
| 1 | OOXML 包与索引基础 | 新增部件；删除部件；按页重写索引。与首个消费者的依赖明确记录 |
| 2 | XLSX 格式与工作表生命周期 | 单元格格式、布局、数字格式分别提交；工作表改名、新增、删除分别提交 |
| 3 | XLSX 窗格与移位修复 | 冻结能力；源窗格移位；canonical 窗口带宽同步；命名区域；筛选/验证；保护信息；缺失行定位，分别按根因提交 |
| 4 | PPTX 编辑与页面生命周期 | run 格式、形状对齐；页面新增、删除、移动、复制分别提交 |
| 5 | 字体目录与文档修订 | 字体/主题目录；文档 pin 与历史；主题退役/引用保护；管理端对应闭环按能力拆分 |
| 6 | 字体编辑与格式导出 | 节点字体及清除；块级字体；DOCX、PPTX、PDF 的导出按目标格式拆分；同步修复组合处字段和 writer |
| 7 | 运营能力 | 审计、审计筛选、许可证临期提醒、导出预检等分别提交 |

不建议直接按时间逐个 cherry-pick 完 108 个提交：有些提交是前一功能的修正、文档或号段调整，应先整理依赖和最终能力边界。可先在本地集成分支完成全量对齐，作为验证终点，再按上述依赖准备可审查的 PR。

## 接下来如何建设

**P0：先稳定集成与回归，再继续扩大功能面。** 修复字体分支新增 Clippy 错误、完成上述字段修复与 7 文件合并；对组合运行完整 Rust、前端和浏览器验收。最少覆盖：

- PPTX 同一文字框连续设置主题字体、粗体/颜色、对齐，再有源导出、重新导入，检查属性同时存在。
- 新建文字框后设置字体和对齐；复制原页面后修改副本字体和格式；删除已改字体的页面；撤销/恢复各步骤并导出对应旧修订。
- XLSX 设置格式后改名、冻结、插删空行/列、保存导出并重新导入，检查公式、命名区域、筛选、验证、窗格及保护信息。
- 文档 pin/unpin 后再执行页面/工作表操作及 revision restore，检查主题、stylesHref、root hash 和结构记录一致。
- 字体许可证允许/禁止/过期、字形不足、源 PDF 多 stream/Form XObject 等情况，核对预检、实际导出及 fidelity report 的一致性。

**P1：建立合并门禁和能力契约。** `.github/workflows/build.yml` 当前仅在 `v*` tag 上运行，PR 缺少同等自动验证。增加 PR 检查，统一 Rust 版本和依赖锁定策略；将实际存在的集成测试、编辑器、管理台、Univer viewer 纳入检查。`Cargo.lock` 当前被忽略，需明确单二进制发布的可复现依赖策略。维护“格式 × 操作 × 预览 × 有源导出 × 无源导出 × 历史恢复”的支持矩阵，让 UI 提前说明拒绝条件。统一管理 patch 编号，后续再把版本/操作定义接入生成的前后端类型与契约校验。

**P2：补用户最容易撞到的格式边界。** 优先修复 PPTX 分节导入和重叠 hitbox；再扩展复制已编辑/新增页及备注、图表等关系的处理。XLSX 以现有真实工作簿回归为入口，逐类扩展跨表公式、图表、table/pivot 参与结构编辑的范围，持续验证导出后重开，而不只验证 ZIP/XML 可读。

**P2：明确字体交付边界。** 目前 bundle 存 themeRevisionId，字体字节留在外部目录。跨机器打开或迁移时需随目录备份，或在许可证允许下设计可携带资产及缺失字体诊断。现有 catalog 的引用扫描与删除/GC 没有统一事务锁，需验证并发创建主题/字体修订与删除、pin 与删主题之间的竞态，再决定锁和发布协议；这是代码审查提出的待验证风险，本次未执行并发复现。若要用于多实例部署，再设计共享存储和权限边界。

**P3：在行为稳定后拆大模块。** 将 `patch.rs` 中格式操作、PPTX/XLSX 的 source writer、catalog 的持久化/引用/审计分离；用公共 revision 构造入口降低漏字段风险。更新 AGENTS.md 的现状说明：实际 workspace 已有 11 个 crate，`officecli/tests/` 也已有集成测试，与旧文档的 7 crate、无集成测试描述不同。此类整理应独立提交，便于定位功能回归。

## 复验入口

以下命令只读比较，不合入 main：

```bash
git fetch origin --prune
git merge-tree --write-tree 7916bb3 f375ca1
git merge-tree --write-tree 7916bb3 7de74be
git merge-tree --write-tree 7de74be f375ca1
```

最后一条应报告同样 7 个冲突文件。为了包含最新 main 的修复，本次完整比较还分别用前两条生成的树创建了临时双亲 commit，再比较两个临时 commit；冲突文件集相同。

单条功能线在包含最新 main 的隔离工作区内验证：

```bash
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

前端验证在各自目录执行 `npm ci && npm run build`。字体编辑器额外执行 `./node_modules/.bin/tsx src/themeCss.test.ts` 与 `./node_modules/.bin/tsx src/blockFont.test.ts`。本次复用了已有 node_modules，因此全新安装仍属于正式 PR 门禁需要补跑的验证。
