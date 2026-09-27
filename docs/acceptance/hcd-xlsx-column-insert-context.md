# XLSX 左右插列与行列菜单验收

使用真实示例 `assets/showcase/budget-tracker.xlsx`。其 Overview 工作表包含公式、条件格式、合并标题、显式列宽和图表。原先在 C 列左侧插入会返回 `middle column insertion requires a workbook without formulas`。

```bash
cargo test -p hcd-formats xlsx::tests --lib
cargo fmt -- --check
cd examples/hdoc/editor && npm run build
```

以下命令复现核心服务的插列和导出路径：

```bash
mkdir -p /tmp/hcd-column-insert-check
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-column-insert-check/budget.hcd --document-id budget-column-check
sheet_id=$(target/debug/officecli hdoc get-index-page /tmp/hcd-column-insert-check/budget.hcd 0 --json \
  | jq -r '.data.indexPage.chunks[] | select(.grid.sheetName=="Overview") | .grid.sheetId' | head -1)
jq -n --arg sheetId "$sheet_id" '{schemaVersion:"hcd-patch/13",documentId:"budget-column-check",patchId:"insert-left-of-c",baseRevision:0,actor:{},operations:[{op:"xlsx.column.insert",sheetId:$sheetId,beforeColumn:3}],metadata:{}}' \
  > /tmp/hcd-column-insert-check/left.json
target/debug/officecli hdoc apply /tmp/hcd-column-insert-check/budget.hcd \
  --patch /tmp/hcd-column-insert-check/left.json --expected-revision 0
target/debug/officecli hdoc validate /tmp/hcd-column-insert-check/budget.hcd
target/debug/officecli hdoc export /tmp/hcd-column-insert-check/budget.hcd \
  --source assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-column-insert-check/edited.xlsx
```

导出的 Overview 中，C 列为空；原 C8:F8 移到 D8:G8，总额公式为 `SUM(D8:G8)`；标题合并区域为 `A1:I1`，原 `H8:H14` 条件格式移到 `I8:I14`，图表锚点右移一列。原 revision 0 保留。

浏览器验收：在 `http://127.0.0.1:8903/` 打开同一预算表副本，选中 C 列时，[插入工具栏仅显示列操作](../screenshots/hcd-xlsx-column-selected.png)，右键也只有左插、右插、删除列；选中第 8 行时，[插入工具栏仅显示行操作](../screenshots/hcd-xlsx-row-selected.png)，在该行单元格内右键也只有行操作。普通单元格仍提供两类操作。分别在 C 左侧和 H 右侧插入后得到 r2，HCD 校验有效，源文件导出保持公式、合并区域、列宽和图表。插入后选择位置与滚动位置保持不动；点击表格会关闭右键菜单。
