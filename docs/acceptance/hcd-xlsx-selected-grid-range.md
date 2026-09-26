# XLSX selected row and column ranges

`hcd-patch/25` applies 2–100 adjacent row or column insertions/deletions in one HCD revision. The Univer **插入** toolbar uses the selected range height for rows and width for columns. One selected row or column continues to use the existing single-shift patch. Crossing a merged range is rejected before the head advances; a merge entirely after the selected range moves with the grid. The same formula, drawing, chart, table, validation, defined-name, frozen-pane, and explicit-column-width restrictions as the single-shift operations still apply.

The [selected range](../screenshots/hcd-xlsx-selected-grid-range-before.png) and [saved result](../screenshots/hcd-xlsx-selected-grid-range-after.png) are a synthetic gradebook. The browser selected rows 2–3 and clicked **在选中行前插入**. The UI advanced from r0 to r1, the source-backed export placed Alice in A4 and moved the merge from B6:C7 to B8:C9. The real-file commands below use the user-supplied usage CSV; no real usage data appears in the screenshots.

```bash
cargo build -p officecli
cargo test -p hcd-formats selected_grid_ranges_commit_once_and_export_all_four_shifts
cargo test -p hcd-formats selected_row_range_crosses_chunk_boundary
cargo test -p hcd-formats selected_grid_range_rejection_preserves_head
cargo test -p hcd-formats selected_row_delete_removes_annotations_for_deleted_cells
cargo test -p hcd-formats selected_grid_range_can_delete_every_materialized_row
mkdir -p /tmp/hcd-xlsx-grid-range-accept
python3 - <<'PY'
import csv
from openpyxl import Workbook
root = '/tmp/hcd-xlsx-grid-range-accept'
book = Workbook(); sheet = book.active
with open('/Users/houshuai/Downloads/open-review-usage-2026-09.csv', encoding='utf-8-sig', newline='') as source:
    for row in csv.reader(source): sheet.append(row)
sheet['A5'] = 'Range shift validation'
sheet.merge_cells('A5:B6')
book.save(f'{root}/source.xlsx')
PY
target/debug/officecli hdoc import /tmp/hcd-xlsx-grid-range-accept/source.xlsx \
  --output /tmp/hcd-xlsx-grid-range-accept/accept-usage-xlsx.hcd \
  --document-id accept-usage-xlsx
python3 - <<'PY'
import gzip, json
from pathlib import Path
root = Path('/tmp/hcd-xlsx-grid-range-accept')
bundle = root / 'accept-usage-xlsx.hcd'
manifest = json.loads((bundle / 'manifest.json').read_text())
def read(href):
    path = bundle / href
    with (gzip.open(path, 'rt') if path.suffix == '.gz' else path.open()) as stream:
        return json.load(stream)
sheet_id = read(read(manifest['indexRootHref'])['children'][0])['chunks'][0]['grid']['sheetId']
steps = [('row', 'insert', 2), ('row', 'delete', 2),
         ('column', 'insert', 1), ('column', 'delete', 1)]
for revision, (axis, action, start) in enumerate(steps):
    patch = {'schemaVersion': 'hcd-patch/25', 'documentId': 'accept-usage-xlsx',
             'patchId': f'real-grid-{revision}', 'baseRevision': revision,
             'operations': [{'op': 'xlsx.grid.range', 'sheetId': sheet_id,
                             'axis': axis, 'action': action, 'start': start, 'count': 2}]}
    (root / f'patch-{revision}.json').write_text(json.dumps(patch))
PY
for revision in 0 1 2 3; do
  target/debug/officecli hdoc apply /tmp/hcd-xlsx-grid-range-accept/accept-usage-xlsx.hcd \
    --patch /tmp/hcd-xlsx-grid-range-accept/patch-$revision.json \
    --expected-revision $revision || exit 1
  target/debug/officecli hdoc validate /tmp/hcd-xlsx-grid-range-accept/accept-usage-xlsx.hcd || exit 1
  target/debug/officecli hdoc export /tmp/hcd-xlsx-grid-range-accept/accept-usage-xlsx.hcd \
    --source /tmp/hcd-xlsx-grid-range-accept/source.xlsx --revision $((revision + 1)) \
    --output /tmp/hcd-xlsx-grid-range-accept/export-$revision.xlsx || exit 1
done
target/debug/officecli hdoc export /tmp/hcd-xlsx-grid-range-accept/accept-usage-xlsx.hcd \
  --to xlsx --output /tmp/hcd-xlsx-grid-range-accept/semantic.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
root = '/tmp/hcd-xlsx-grid-range-accept'
for revision, (merge, cell) in enumerate([('A7:B8', 'A4'), ('A5:B6', 'A2'),
                                           ('C5:D6', 'C2'), ('A5:B6', 'A2')]):
    sheet = load_workbook(f'{root}/export-{revision}.xlsx').active
    assert set(map(str, sheet.merged_cells.ranges)) == {merge}
    assert sheet[cell].value == 'summary'
final = load_workbook(f'{root}/export-3.xlsx').active
original = load_workbook(f'{root}/source.xlsx').active
for row in original:
    for cell in row:
        if cell.value is not None: assert final[cell.coordinate].value == cell.value
semantic = load_workbook(f'{root}/semantic.xlsx').active
assert set(map(str, semantic.merged_cells.ranges)) == {'A5:B6'}
assert semantic['A2'].value == 'summary'
PY
```

Observed: each patch advanced the head exactly once; validation passed after every revision; four source-backed exports reported `High` fidelity; the source-free export reported `Semantic` fidelity. The final source-backed workbook has the same populated cell values and merged range as the source.
