# XLSX insertion with formulas and a chart

`assets/showcase/budget-tracker.xlsx` reproduces the former 422 response: the Overview sheet has formulas, a conditional formatting formula, merged cells, and a chart. Before this change, inserting before row 9 failed with `middle row insertion requires a workbook without formulas`.

Run the focused checks:

```bash
cargo test -p hcd-core xlsx_formula --lib
cargo test -p hcd-formats budget_workbook_row_insertion_preserves_formulas_merges_and_chart --lib
cargo test -p hcd-formats xlsx::tests --lib
cargo fmt -- --check
```

Reproduce the CLI path with an isolated bundle. The Overview `sheetId` is derived from the document ID and should not be copied from another import.

```bash
mkdir -p /tmp/hcd-row-insert-check
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-row-insert-check/budget.hcd --document-id budget-row-insert-check
sheet_id=$(target/debug/officecli hdoc get-index-page /tmp/hcd-row-insert-check/budget.hcd 0 --json \
  | jq -r '.data.indexPage.chunks[] | select(.grid.sheetName=="Overview") | .grid.sheetId' | head -1)
jq -n --arg sheetId "$sheet_id" '{schemaVersion:"hcd-patch/14",documentId:"budget-row-insert-check",patchId:"insert-before-overview-row-9",baseRevision:0,actor:{},operations:[{op:"xlsx.row.insert",sheetId:$sheetId,beforeRow:9}],metadata:{}}' \
  > /tmp/hcd-row-insert-check/insert.json
target/debug/officecli hdoc apply /tmp/hcd-row-insert-check/budget.hcd \
  --patch /tmp/hcd-row-insert-check/insert.json --expected-revision 0
target/debug/officecli hdoc validate /tmp/hcd-row-insert-check/budget.hcd
target/debug/officecli hdoc export /tmp/hcd-row-insert-check/budget.hcd \
  --source assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-row-insert-check/edited.xlsx
```

Inspect `xl/worksheets/sheet1.xml` in the export: the former `G9` is now `G10` with `SUM(C10:F10)`, the total is at `G16` with `SUM(G8:G15)`, `A1:H1` stays merged, and conditional formatting covers `H8:H15`. In `xl/drawings/drawing1.xml`, chart anchor rows become 18 and 36. The chart's cached series remain as in the source workbook; source-backed export reports when formula or chart recalculation is needed.

Browser acceptance used a copy of the existing revision 4 `accept-xlsx` bundle at `http://127.0.0.1:8883/`. Selecting A9 and choosing **插入 → 在选中行前插入** produced revision 5 with an empty row 9, Marketing at row 10, a moved chart, and an **已保存** status. The original revision 4 and live `8873` document were left intact.
