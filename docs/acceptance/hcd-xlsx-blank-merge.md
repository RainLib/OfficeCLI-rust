# XLSX blank range merge

`hcd-patch/26` merges a selected blank range even when its upper-left cell has no HCD node. The server creates one stable editable anchor node, checks every covered cell for content and overlapping merges, and commits one revision. Sparse rows may omit empty HTML cells. The reference Univer editor selects the range and uses **开始 → 合并单元格**; **拆分单元格** uses the existing unmerge patch. Existing anchors continue to use `hcd-patch/6`.

The synthetic gradebook shows [selected B2:C3](../screenshots/hcd-xlsx-blank-merge-before.png), [merged r2](../screenshots/hcd-xlsx-blank-merge-after.png), and [split r3](../screenshots/hcd-xlsx-blank-merge-split.png). Browser interaction advanced r1 → r2 → r3; the r2 source-backed XLSX contained both `B2:C3` and the pre-existing `B8:C9` merge. The user's usage CSV was used only for the local real-file export check, not in screenshots.

```bash
cargo build -p officecli
cargo test -p hcd-formats merges_blank_anchor_and_unmerges_with_source_backed_export
cargo test -p hcd-formats merges_sparse_blank_cells_beyond_the_rendered_row_tail
cargo test -p hcd-formats blank_merge_rejects_nonempty_and_overlapping_cells_without_advancing_head
mkdir -p /tmp/hcd-xlsx-blank-merge-accept
python3 - <<'PY'
import csv
from openpyxl import Workbook
from openpyxl.styles import PatternFill
root = '/tmp/hcd-xlsx-blank-merge-accept'
book = Workbook(); sheet = book.active; sheet.title = 'Usage'
with open('/Users/houshuai/Downloads/open-review-usage-2026-09.csv', encoding='utf-8-sig', newline='') as source:
    for row in csv.reader(source): sheet.append(row)
sheet['A5'] = 'Blank merge acceptance'
for row in sheet['D5:E6']:
    for cell in row: cell.fill = PatternFill('solid', fgColor='EAF3FF')
book.save(f'{root}/source.xlsx')
PY
target/debug/officecli hdoc import /tmp/hcd-xlsx-blank-merge-accept/source.xlsx \
  --output /tmp/hcd-xlsx-blank-merge-accept/real.hcd --document-id real-blank-merge
python3 - <<'PY'
import gzip, json
from pathlib import Path
root = Path('/tmp/hcd-xlsx-blank-merge-accept'); bundle = root / 'real.hcd'
manifest = json.loads((bundle / 'manifest.json').read_text())
def read(href):
    path = bundle / href
    with (gzip.open(path, 'rt') if path.suffix == '.gz' else path.open()) as stream:
        return json.load(stream)
sheet_id = read(read(manifest['indexRootHref'])['children'][0])['chunks'][0]['grid']['sheetId']
patch = {'schemaVersion': 'hcd-patch/26', 'documentId': 'real-blank-merge',
         'patchId': 'merge-blank-D5-E6', 'baseRevision': 0,
         'operations': [{'op': 'xlsx.merge.blank', 'sheetId': sheet_id,
                         'startRow': 5, 'startColumn': 4, 'endRow': 6, 'endColumn': 5}]}
(root / 'merge.json').write_text(json.dumps(patch))
PY
target/debug/officecli hdoc apply /tmp/hcd-xlsx-blank-merge-accept/real.hcd \
  --patch /tmp/hcd-xlsx-blank-merge-accept/merge.json --expected-revision 0
target/debug/officecli hdoc validate /tmp/hcd-xlsx-blank-merge-accept/real.hcd
target/debug/officecli hdoc export /tmp/hcd-xlsx-blank-merge-accept/real.hcd \
  --source /tmp/hcd-xlsx-blank-merge-accept/source.xlsx \
  --output /tmp/hcd-xlsx-blank-merge-accept/source-backed.xlsx
target/debug/officecli hdoc export /tmp/hcd-xlsx-blank-merge-accept/real.hcd \
  --to xlsx --output /tmp/hcd-xlsx-blank-merge-accept/semantic.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
root = '/tmp/hcd-xlsx-blank-merge-accept/'
for filename in ['source-backed.xlsx', 'semantic.xlsx']:
    sheet = load_workbook(root + filename).active
    assert 'D5:E6' in set(map(str, sheet.merged_cells.ranges))
    assert sheet['A5'].value == 'Blank merge acceptance'
assert load_workbook(root + 'source-backed.xlsx').active['D5'].fill.fgColor.rgb == '00EAF3FF'
PY
```

Observed locally: the real XLSX merged previously absent `D5:E6`, passed bundle validation, and exported with `High` fidelity against the source. A further text splice into D5 and split produced r3: both source-backed exports retained the original D5 fill; r2 retained the text and merge, while r3 retained the text and removed the merge. The source-free export had `Semantic` fidelity and did not retain the source fill. Blank merge currently requires its rows in one materialized HCD cell window and at least one mapped cell in that window.
