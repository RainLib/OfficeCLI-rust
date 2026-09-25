# XLSX merged ranges and grid shifts

The command sequence uses the supplied `open-review-usage-2026-09.csv`, converted to XLSX with one extra merged note. The [editor screenshot](../screenshots/hcd-xlsx-merged-grid-shift.png) uses a separate synthetic gradebook so the supplied data is not published; it shows the note moved to merged range `B5:C6` after inserting a row.

Before the source-view reference fix, the `hdoc export` command at revision 2 below failed with `grid shift cannot retain activeCell=A1`; the same command now succeeds without removing the source workbook's default selection. Revision 3 moves that selection to `B1`, and revision 4 returns it to `A1`.

```bash
cargo build -p officecli
cargo test -p hcd-formats grid_shifts_keep_untouched_merges_in_hcd_and_source_export
mkdir -p /tmp/hcd-merged-grid
python3 - <<'PY'
import csv
from openpyxl import Workbook
w = Workbook(); s = w.active
with open('/Users/houshuai/Downloads/open-review-usage-2026-09.csv', encoding='utf-8-sig', newline='') as source:
    for row in csv.reader(source): s.append(row)
s['A4'] = 'Validation merged note'
s.merge_cells('A4:B5')
w.save('/tmp/hcd-merged-grid/source.xlsx')
PY
target/debug/officecli hdoc import /tmp/hcd-merged-grid/source.xlsx \
  --output /tmp/hcd-merged-grid/accept.hcd --document-id merged-grid-accept
python3 - <<'PY'
import gzip, json
from pathlib import Path
root = Path('/tmp/hcd-merged-grid'); bundle = root / 'accept.hcd'
manifest = json.loads((bundle / 'manifest.json').read_text())
def read(path):
    path = bundle / path
    return json.loads(gzip.open(path, 'rt').read()) if path.suffix == '.gz' else json.loads(path.read_text())
sheet_id = read(read(manifest['indexRootHref'])['children'][0])['chunks'][0]['grid']['sheetId']
operations = [
    ('hcd-patch/12', 'xlsx.row.insert', {'beforeRow': 4}),
    ('hcd-patch/14', 'xlsx.row.delete', {'row': 1}),
    ('hcd-patch/13', 'xlsx.column.insert', {'beforeColumn': 1}),
    ('hcd-patch/15', 'xlsx.column.delete', {'column': 1}),
]
for rev, (schema, op, values) in enumerate(operations):
    patch = {'schemaVersion': schema, 'documentId': 'merged-grid-accept',
             'patchId': f'merged-grid-{rev}', 'baseRevision': rev,
             'operations': [{'op': op, 'sheetId': sheet_id, **values}]}
    (root / f'patch-{rev}.json').write_text(json.dumps(patch))
PY
for rev in 0 1 2 3; do
  target/debug/officecli hdoc apply /tmp/hcd-merged-grid/accept.hcd \
    --patch /tmp/hcd-merged-grid/patch-$rev.json --expected-revision $rev || exit 1
  target/debug/officecli hdoc validate /tmp/hcd-merged-grid/accept.hcd || exit 1
  target/debug/officecli hdoc export /tmp/hcd-merged-grid/accept.hcd \
    --source /tmp/hcd-merged-grid/source.xlsx --revision $((rev + 1)) \
    --output /tmp/hcd-merged-grid/export-$rev.xlsx || exit 1
done
target/debug/officecli hdoc export /tmp/hcd-merged-grid/accept.hcd \
  --to xlsx --output /tmp/hcd-merged-grid/semantic.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
from pathlib import Path
root = Path('/tmp/hcd-merged-grid')
for rev, (expected, active) in enumerate((('A5:B6', 'A1'), ('A4:B5', 'A1'), ('B4:C5', 'B1'), ('A4:B5', 'A1'))):
    sheet = load_workbook(root / f'export-{rev}.xlsx', data_only=True).active
    assert set(map(str, sheet.merged_cells.ranges)) == {expected}
    assert sheet[expected.split(':')[0]].value == 'Validation merged note'
    assert sheet.sheet_view.selection[0].activeCell == active
    assert sheet.sheet_view.selection[0].sqref == active
semantic = load_workbook(root / 'semantic.xlsx', data_only=True).active
assert set(map(str, semantic.merged_cells.ranges)) == {'A4:B5'}
PY
```

For the browser screenshot, import a synthetic gradebook as gallery document `accept-xlsx`, merge `B4:C5`, insert a row before row 4, open **插入**, and select the moved merge. A separate browser run against the converted CSV clicked **在选中行前插入**: the editor advanced from revision 3 to 4, and source-backed export retained the note at `B5:C6`. Edits inside the merge return `Unsupported` and leave the revision unchanged; the Rust test covers all four row/column cases. The source-backed export now moves ordinary `topLeftCell`, `activeCell`, and `sqref` references with the grid. This acceptance does not cover formulas, drawings, tables, frozen panes, or non-cell view references.
