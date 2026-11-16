# 表格结构、空白段落与撤销验收

分支：`feature/hcd-font-format-integration`。

## 操作效果

- DOCX、HTML、Markdown 编辑模式下，悬停或聚焦表格时，行 `＋` 固定显示在表格左侧，列 `＋` 固定显示在表格顶部；它们分别对齐当前行、列的结束边界。`⋯` 菜单放在表格左上角外侧。单元格内部不放操作按钮，不增加选中框或编辑包装层。支持上下插行、左右插列、删除当前行/列；最后一行或一列不能删除。
- 表格与顶部、左侧按钮之间的空白也属于悬停范围，跨越 iframe 边界或停在间隙中不会收起。离开整个操作范围后延迟 800 毫秒收起，同一组入口最多保留一个隐藏定时器。按钮获得焦点或菜单展开时保持显示；菜单展开后移过其他单元格不更换操作目标，点击外部或按 Escape 关闭菜单。
- 「插入 → 插入表格」提供 8×6 快选与自定义行列数。新表格和新增行列的单元格为空，可直接输入。单表最多 1000 行、128 列、10000 个逻辑格。
- 「＋ 新增段落」在当前块之后插入空白段落并放置光标，不写入“新段落”。
- 开始/插入工具栏的撤销与重做、`⌘/Ctrl+Z`、`⌘/Ctrl+Shift+Z` / `Ctrl+Y` 使用同一入口，表格内快捷键也接入。文字、表格结构、固定布局编辑、工作表与图片编辑的本地历史各有默认 20 步上限。新操作清空重做分支，关闭/重开不持久化撤销栈。

## 协作与局部更新

表格结构提交前确认共享 checkpoint，再读当前 revision 与 blockHash，提交服务端生成的表格操作。服务端核对 epoch、pending 草稿与 Agent 团队锁。并发修改导致整批拒绝，不会部分写入。新增节点使用与普通编辑节点一致的 source-map 元数据。

`table.edit` 调整跨越操作边界的 rowspan/colspan、colgroup 与行列条纹；删除纵向合并的起始行时，将仍有效的合并内容移到下一行。隐藏的 DOCX vMerge 延续格转成规范的 HTML 合并网格。不完整网格、超限跨度和分片表格结构修改会拒绝，保留原文档。

撤销结构操作使用 `table.restore` 从服务端不可变历史恢复目标块；撤销插入使用带 hash 的 `table.delete`。不接收客户端 HTML，不回滚整份文档。其他块上的协作者修改继续保留；同一表格已有不同后续内容时拒绝覆盖撤销。文字撤销继续使用当前 Yjs 房间内属于本人的操作；外部版本切换后不把旧房间的文字历史重放到新房间。

NodeView 在结构变化时保留 iframe，以 `patchPreviewDom` 对规范表格做节点协调；文字输入继续修改实际 Text 节点。悬停控件放在 iframe 的同级外层，与表格共享滚动和缩放坐标，避免表格靠近 iframe 边缘时将按钮裁切或挤入单元格；不改变表格尺寸，也不能进入保存或导出。浏览器测试验证按钮位于表头与左侧、切换单元格和画布缩放后的定位、iframe 与原段落/run 身份，以及长表格滚动位置。

## 复现

仓库根目录运行，脚本只导入公开样例到新的临时目录：

```bash
cargo build -p officecli
python3 docs/acceptance/hcd-table-structure-undo/verify_tables.py
```

CLI 检查行列：`31×2 → 32×2 → 32×3 → 31×3 → 32×3`，随后新建空白 `2×3` 表格，验证 bundle 并导出 DOCX。

```bash
cargo test -p hcd-core structure::
cargo test -p officecli --bin officecli hdoc_server
cargo fmt --all -- --check
cd examples/hdoc/editor
./node_modules/.bin/tsx --test src/opaqueTable.test.ts src/textRunEdits.test.ts
npm run build
HCD_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  ./node_modules/.bin/playwright test e2e/workspace.spec.ts \
  --grep 'table hover controls|insert ribbon creates|tables insert through|twenty local history' \
  --reporter=line
```

新增浏览器用例覆盖：行列增删与合并保留、原位新单元格输入、双窗口同步、结构撤销/重做、空白段落输入、插入表格撤销/重做、保存重开、DOCX 导出行列与文字、HTML/Markdown、旧 epoch 拒绝、只读隐藏控件、段落删除快捷键及 20 步截断。导出检查等待保存完成后读取，避免检查到旧 revision。

## 范围

结构修改后的 DOCX 使用语义导出，会重建文档布局；不承诺复杂源排版或 ZIP 部件字节保真。仅修改已有表格文字的源格式导出路径不变。合并/拆分单元格、任意表格样式调整及任意分片表格重组不在本次开放范围内。

完整 `cargo clippy -p hcd-core --all-targets -- -D warnings` 仍被此前 `patch.rs:11152` 的 `collapsible_match` 警告阻塞；不改动该图片操作逻辑。临时放行这一项 lint 后通过，新增表格代码未报告其他 lint。

## 执行结果

16 项核心结构测试、59 项服务端测试、3 项协作/run 测试通过；14 项浏览器回归全部通过。前端独立及嵌入式构建、Rust 格式与 diff 检查通过。PPT 排序撤销/重做回归还发现缩略图遮挡悬停按钮，已为操作栏明确层级并验证复制/删除也可点击。

此次调整另已验证 4 项相关浏览器回归：表头/左侧入口定位（含 90%、100%、110% 画布缩放）、行列操作与协同、插入与导出、只读隐藏及撤销上限；独立与嵌入式前端构建通过。在原演示服务上用独立测试文档验证增行、增列、删列、撤销/重做与刷新持久化，无失败 patch 请求，11 份已有文档的 manifest 保持不变。

悬停保持回归额外模拟鼠标缓慢移过左侧及顶部间隙，分别停留 1.1 秒，再移到按钮上停留 1.1 秒，确保入口仍可点击；验证菜单展开后移过其他单元格保持展开、Escape 关闭，以及移出操作范围后自动收起。

验收截图：[表头与左侧入口](hcd-table-structure-undo/table-header-left-controls.png)、[长表左侧按钮](hcd-table-structure-undo/table-hover-actions.png)、[插入选择器](hcd-table-structure-undo/insert-table-picker.png)、[空表直接输入](hcd-table-structure-undo/inserted-table-edit.png)。
