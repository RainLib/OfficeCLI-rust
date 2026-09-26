# HCD reference editor and core service

This example runs a self-hosted Tiptap/Yjs editor against the `hcd/2` core API. DOCX, HTML, Markdown, and TXT use the semantic editor. PDF and PPTX use the fixed-layout, window-loaded viewer; both can place and edit positioned text boxes. XLSX uses the Univer adapter for mapped cell values and bounded cell merging. HCD revisions are immutable; semantic editing creates `hcd-patch/4` checkpoints and does not write browser HTML into a bundle.

## Local run

Build `officecli` from the repository root, then use three terminals with the **same** `HCD_TOKEN_SECRET` value (at least 32 bytes). The core API, collaboration sidecar, and Vite UI bind to loopback by default.

```bash
cargo build -p officecli
mkdir -p /tmp/hcd-editor-demo/sources
target/debug/officecli hdoc import examples/word/numbering-showcase.docx \
  --output /tmp/hcd-editor-demo/demo-docx.hcd --document-id demo-docx
HCD_TOKEN_SECRET='replace-with-a-private-random-secret-at-least-32-bytes' \
  target/debug/officecli hdoc serve --root /tmp/hcd-editor-demo --bind 127.0.0.1:8766
```

```bash
(cd examples/hdoc/xlsx-univer-viewer && npm ci)
cd examples/hdoc/editor
npm ci
HCD_TOKEN_SECRET='the-same-private-secret' npm run sidecar
```

```bash
cd examples/hdoc/editor
npm run dev -- --port 8767
```

Issue a document-scoped token and open `http://127.0.0.1:8767/`:

```bash
HCD_TOKEN_SECRET='the-same-private-secret' target/debug/officecli hdoc issue-token \
  --document-id demo-docx --scope write --user-id editor-1 --display-name 'Editor 1'
```

Use `--scope read` for a read-only session. The service rejects its checkpoint and patch requests with HTTP 403, and the sidecar marks its WebSocket connection read-only. Tokens expire after at most one hour. Keep the signing secret outside the repository.

### Local acceptance gallery

For browser acceptance, set `HCD_DEMO_ROOT` to the same private service root and pass the same signing secret to Vite. The development server lists only bundles whose IDs match the local gallery fixtures and issues one-hour, document-scoped tokens on click. This gallery is absent from the production build. Sample tokens are not retained in session storage.

```bash
HCD_DEMO_ROOT=/tmp/hcd-editor-demo HCD_TOKEN_SECRET='the-same-private-secret' \
  npm run dev -- --host 127.0.0.1 --port 8767
```

For example, import a local PDF under a gallery ID and place its immutable source next to the bundles so the PDF's source-backed download works:

```bash
target/debug/officecli hdoc import "$PDF_SOURCE" \
  --output /tmp/hcd-editor-demo/accept-physics-pdf-v2.hcd \
  --document-id accept-physics-pdf-v2
cp "$PDF_SOURCE" /tmp/hcd-editor-demo/sources/accept-physics-pdf-v2.pdf
```

The other fixture IDs are listed in `vite.config.ts`. DOCX/Markdown/TXT cards edit semantic blocks; PDF/PPTX cards edit mapped text on fixed pages; XLSX cards edit mapped cell values. The gallery screenshot is at `docs/screenshots/hcd-acceptance-gallery.jpg`.

The built-in app uses the Vite proxy for `/v1`. Products can import `EmbeddedHcdEditor` from `@officecli/hcd-reference-editor/react` and pass an API base URL, collaboration WebSocket URL, document ID, and token. Each editor keeps one ProseMirror document and one Yjs document; offscreen blocks use CSS `content-visibility` and fixed-layout assets load by viewport.

PDF and PPTX text boxes use the same Tiptap/ProseMirror editing core as DOCX, scoped to one fixed-page text node. Their current patch protocol stores plain text only, so the strict box schema prevents formatting from being silently lost. Select a mapped text node, type, undo with `Cmd/Ctrl+Z`, and save; the updated page and revision should appear immediately. The reference screenshot is `docs/screenshots/hcd-fixed-tiptap-text-box.jpg`.

PDF editing mounts Tiptap inside the selected canonical page text element in the sandboxed preview frame. The page raster is masked at that element while editing, so the text appears once at its page position; save from the top bar or use `Cmd/Ctrl+Enter`, and use `Esc` to cancel. The direct-node screenshot is `docs/screenshots/hcd-pdf-direct-node-edit.jpg`.
After inserting a PDF text box, select it to move it with the top handle or resize it with the lower-right handle. Each release saves a `hcd-patch/23` revision with the same nodeId. Source PDF text remains text-editable but its original geometry is not moved; see `docs/acceptance/hcd-pdf-textbox-geometry.md` for the command sequence and screenshot.
An HCD-created PDF text box can also be removed with the upper-right × button or the toolbar action. `hcd-patch/24` removes it from the current view and source map while preserving old revisions; source-backed export stops replaying its earlier edits. See `docs/acceptance/hcd-pdf-textbox-delete.md` for reproduction and before/after screenshots.

PPTX uses the same in-frame text editing, keeping the shape's font and color at its slide position. The slide outline opens by default with its own visibility preference, and unloaded slides reserve the measured slide height instead of a generic page height. The reference screenshot is `docs/screenshots/hcd-pptx-direct-slide-edit.jpg`.
Select a positioned PPTX text shape to reveal a move handle above it and a resize handle at its lower right. Releasing either handle saves a `hcd-patch/17` revision. Save any pending text first. The source-backed PPTX export retains the new coordinates; see `docs/acceptance/hcd-pptx-shape-geometry.md` for commands and screenshots.
An HCD-created PPTX text box also has a delete button. `hcd-patch/27` removes the box from the current slide and source map while keeping its historical revision. Original slide shapes remain protected. See `docs/acceptance/hcd-pptx-textbox-delete.md` for the command sequence and browser screenshots.

The XLSX canvas keeps its Univer cell editor and now uses the same fixed document header, view controls, appearance panel, export control, and status bar as the other formats. Double-click an existing cell or press F2 to edit its content. The reference screenshot is `docs/screenshots/hcd-xlsx-unified-chrome.jpg`.

For XLSX, select a rectangular range and choose **开始 → 合并单元格**. `hcd-patch/6` saves the merge in one immutable revision, updates the visible Univer grid, and writes `mergeCells` during source-backed and source-free semantic XLSX export. The upper-left cell must be mapped and editable; every covered cell must be empty, and the range must fit one HCD cell window. The service rejects overlap and content loss. Source-free export preserves merged ranges and cell coordinates but rebuilds workbook styles and flattens sheets into one semantic sheet. The browser acceptance screenshot is `docs/screenshots/hcd-xlsx-merge-cells.png`.

Choose **开始 → 拆分单元格** on a merge created in HCD to restore individual cells. `hcd-patch/11` keeps the anchor text and node ID, restores the original styles of covered empty cells, and removes the merge from the next source-backed XLSX export. Original source merges remain protected because their covered cells may contain hidden values. The merged and split browser states are `docs/screenshots/hcd-xlsx-unmerge-merged.png` and `docs/screenshots/hcd-xlsx-unmerge-after.png`.

Reproduce the split with the real workbook:

```bash
cargo test -p hcd-core splitting_merge_restores_empty_cell_style_and_column_order
cargo test -p hcd-formats unmerges_hcd_created_cells_and_exports_without_merge
cargo test -p hcd-formats refuses_to_split_source_merge_that_may_hide_cells
mkdir -p /tmp/hcd-unmerge-accept/sources
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-unmerge-accept/accept-xlsx.hcd --document-id accept-xlsx
cp assets/showcase/budget-tracker.xlsx /tmp/hcd-unmerge-accept/sources/accept-xlsx.xlsx
# Start hdoc serve and the Vite gallery with HCD_DEMO_ROOT=/tmp/hcd-unmerge-accept.
# In Settings, select A1:B1, merge, then split the selected merged cell.
target/debug/officecli hdoc validate /tmp/hcd-unmerge-accept/accept-xlsx.hcd
target/debug/officecli hdoc export /tmp/hcd-unmerge-accept/accept-xlsx.hcd \
  --source assets/showcase/budget-tracker.xlsx --output /tmp/hcd-unmerge-accept/split.xlsx
target/debug/officecli hdoc export /tmp/hcd-unmerge-accept/accept-xlsx.hcd \
  --source assets/showcase/budget-tracker.xlsx --revision 1 \
  --output /tmp/hcd-unmerge-accept/history-r1.xlsx
unzip -p /tmp/hcd-unmerge-accept/split.xlsx xl/worksheets/sheet3.xml | rg -q 'mergeCell ref="A1:B1"' && exit 1 || true
unzip -p /tmp/hcd-unmerge-accept/history-r1.xlsx xl/worksheets/sheet3.xml | rg -q 'mergeCell ref="A1:B1"'
```

An empty cell in a loaded row can now receive its first value directly in Univer, including up to 256 columns after that row's last materialized cell. `hcd-patch/7` creates a stable HCD node for that address; later edits use the normal text patch, and source-backed XLSX export inserts the new `<c>` element or fills an existing empty styled cell. Paste into multiple new cells remains separate work. To reproduce with `assets/showcase/budget-tracker.xlsx`, open the Settings sheet, type `HCD blank cell edit` into B3, press Enter, validate the bundle, then download XLSX. `xl/worksheets/sheet3.xml` must contain B3 as an inline string. Entering `Browser tail edit` in F3 checks the row-tail case. Browser screenshots are `docs/screenshots/hcd-xlsx-blank-cell-edit.png` and `docs/screenshots/hcd-xlsx-tail-cell-edit.png`.

The **插入 → 在末尾新增行** action uses `hcd-patch/8` to append one empty row after the last materialized row of a nonempty worksheet. It commits an HCD revision, enables direct editing of the new row, and source-backed XLSX export adds a corresponding OOXML `<row>` with any subsequently edited cells. The action preserves existing cell addresses.

The **插入 → 在选中行前插入** action uses `hcd-patch/12` to insert an empty row before an existing row. HCD keeps mapped node IDs stable, records the original source cell addresses, shifts later rows across chunk windows, and retains historical revisions. Source-backed XLSX export moves the original OOXML rows and cell references, then writes new HCD cells at their current addresses. It supports merged ranges outside the insertion point and ordinary sheet selections; formulas, drawings, charts, validation, tables, defined names, and frozen panes still require separate rewriting. The browser screenshot is `docs/screenshots/hcd-xlsx-insert-middle-row.png`.

The **插入 → 在选中列前插入** action uses `hcd-patch/13` to insert an empty column before an existing column in the same plain value workbook scope. HCD shifts the visible cells and source anchors across all row windows; source-backed export moves original OOXML cell addresses and materializes newly edited cells in the inserted column. Explicit column widths and other coordinate-dependent features are rejected until they can be moved safely. The browser screenshot is `docs/screenshots/hcd-xlsx-insert-middle-column.png`.

The **插入 → 删除选中行** action uses `hcd-patch/14` to delete a materialized row and move later rows up. It preserves the source workbook and all historical HCD revisions. Confirm the action in the browser, then use the revision view to recover the original row if needed. Source-backed XLSX export omits deleted source rows and their edited cells. Merged ranges outside the deleted row and ordinary sheet selections move with the grid; formula, drawing, chart, table, validation, defined-name, and frozen-pane restrictions remain. The browser acceptance screenshot is `docs/screenshots/hcd-xlsx-delete-middle-row.png`.

The **插入 → 删除选中列** action uses `hcd-patch/15` to remove one column and move later cells left across all HCD row windows. It keeps stable node IDs for surviving cells and retains the deleted values in historical revisions. Source-backed XLSX export rewrites cell addresses and omits deleted cells. Merged ranges outside the deleted column and ordinary sheet selections move with the grid; formula, drawing, table, validation, defined-name, explicit column-width, and frozen-pane references still require separate rewriting. The browser acceptance screenshot is `docs/screenshots/hcd-xlsx-delete-middle-column.png`.

Row and column insertion/deletion move an existing merged range when the entire range is on the shifted side of the edit. An edit inside a merge is rejected and the UI asks the user to split it first. Source-backed export rewrites `mergeCells` and ordinary source `topLeftCell`, `activeCell`, and `sqref` references from the HCD revision; source-free semantic export retains the resulting merge. Formula, drawing, and frozen-pane restrictions still apply. The real-data command sequence is [merged grid acceptance](../../../docs/acceptance/hcd-xlsx-merged-grid-shift.md); its browser screenshot is `docs/screenshots/hcd-xlsx-merged-grid-shift.png`.

Selecting 2–100 adjacent rows or columns before one of the four **插入** tab grid actions now saves one `hcd-patch/25` revision for the whole selection. The selection's rows or columns shift together; earlier revisions remain readable. The [range acceptance](../../../docs/acceptance/hcd-xlsx-selected-grid-range.md) contains a real CSV-derived workbook command sequence, source-backed and source-free export checks, and browser screenshots.

The source-free semantic XLSX exporter leaves blank HTML table cells absent from worksheet XML and writes HCD merged ranges into `mergeCells`, preserving empty cell values, sparse row/column positions, and merges. It still rebuilds workbook styles and opaque parts semantically; use source-backed export when those properties matter.

Pasting a range that contains both existing cells and empty cells now saves one `hcd-patch/19` revision. Each new cell gets a stable node ID. A paste containing a formula, a read-only cell, or more than 10000 changes is restored locally rather than partly committed. See the [real workbook acceptance commands and screenshot](../../../docs/acceptance/hcd-xlsx-range-paste.md).

An existing ordinary XLSX formula can be edited directly in Univer. `hcd-patch/20` saves the expression and source-backed export keeps an OOXML formula while requesting recalculation. See the [real workbook commands and browser screenshots](../../../docs/acceptance/hcd-xlsx-formula-edit.md). Complete, bounded shared-formula groups with safely translatable A1 references now support single-member editing; source-backed export expands the edited group into independent formulas. Array formulas and unsupported shared groups remain read-only. See the [budget workbook acceptance](../../../docs/acceptance/hcd-xlsx-shared-formula-edit.md).

An empty XLSX cell can receive one new formula with `hcd-patch/21`. The source-backed XLSX download preserves it as a native formula and requests recalculation. See the [product catalog commands and screenshot](../../../docs/acceptance/hcd-xlsx-formula-create.md).

An XLSX range paste can mix editable text cells, empty cells, existing formulas, and new formulas in one `hcd-patch/22` revision. See the [real workbook commands and browser screenshots](../../../docs/acceptance/hcd-xlsx-formula-range-paste.md).

Verify existing merges with the real workbook and the screenshot above:

```bash
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx --output /tmp/budget-merge.hcd --document-id budget-merge
target/debug/officecli hdoc export /tmp/budget-merge.hcd --to xlsx --output /tmp/budget-merge-semantic.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
source = load_workbook('assets/showcase/budget-tracker.xlsx').active
exported = load_workbook('/tmp/budget-merge-semantic.xlsx').active
assert set(map(str, source.merged_cells.ranges)) == set(map(str, exported.merged_cells.ranges))
PY
```

For the supplied `open-review-usage-2026-09.csv` workbook, select B1 and choose **插入 → 删除选中列**. The browser download has three rows and eleven columns; each value in original C:L appears in B:K, and the deleted B values are absent. Exporting revision 0 still yields all twelve original columns. Reproduce with CLI:

```bash
cargo test -p hcd-formats middle_column_deletion_shifts_all_windows_and_preserves_history
cargo test -p hcd-formats deleting_implicit_blank_column_moves_source_cells_left
cargo test -p hcd-formats deleting_filled_inserted_column_clears_dirty_node
cargo test -p hcd-formats deleting_all_columns_keeps_empty_rows_and_valid_bundle
python3 - <<'PY'
import csv
from openpyxl import Workbook
workbook = Workbook(); sheet = workbook.active
with open('/Users/houshuai/Downloads/open-review-usage-2026-09.csv', encoding='utf-8-sig', newline='') as source:
    for row in csv.reader(source): sheet.append(row)
workbook.save('/tmp/hcd-middle-row-real.xlsx')
PY
target/debug/officecli hdoc import /tmp/hcd-middle-row-real.xlsx \
  --output /tmp/hcd-column-delete-check.hcd --document-id hcd-column-delete-check
python3 - <<'PY'
import gzip, json
from pathlib import Path
root = Path('/tmp/hcd-column-delete-check.hcd')
manifest = json.loads((root / 'manifest.json').read_text())
with gzip.open(root / manifest['indexRootHref'], 'rt') as source: tree = json.load(source)
with gzip.open(root / tree['children'][0], 'rt') as source: page = json.load(source)
patch = {'schemaVersion': 'hcd-patch/15', 'documentId': 'hcd-column-delete-check',
         'patchId': 'delete-real-column-b', 'baseRevision': 0,
         'operations': [{'op': 'xlsx.column.delete',
                         'sheetId': page['chunks'][0]['grid']['sheetId'], 'column': 2}]}
Path('/tmp/hcd-column-delete-check.patch.json').write_text(json.dumps(patch))
PY
target/debug/officecli hdoc apply /tmp/hcd-column-delete-check.hcd \
  --patch /tmp/hcd-column-delete-check.patch.json --expected-revision 0
target/debug/officecli hdoc validate /tmp/hcd-column-delete-check.hcd
target/debug/officecli hdoc export /tmp/hcd-column-delete-check.hcd \
  --source /tmp/hcd-middle-row-real.xlsx --revision 1 --output /tmp/hcd-column-delete-current.xlsx
target/debug/officecli hdoc export /tmp/hcd-column-delete-check.hcd \
  --source /tmp/hcd-middle-row-real.xlsx --revision 0 --output /tmp/hcd-column-delete-original.xlsx
target/debug/officecli hdoc export /tmp/hcd-column-delete-check.hcd \
  --to xlsx --revision 1 --output /tmp/hcd-column-delete-semantic.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
source = list(load_workbook('/tmp/hcd-column-delete-original.xlsx', read_only=True, data_only=True).active.values)
current = list(load_workbook('/tmp/hcd-column-delete-current.xlsx', read_only=True, data_only=True).active.values)
semantic = list(load_workbook('/tmp/hcd-column-delete-semantic.xlsx', read_only=True, data_only=True).active.values)
assert len(current) == 3 and len(current[0]) == 11
assert current == [row[:1] + row[2:] for row in source]
assert semantic == current
PY
```

Reproduce the deletion with the supplied CSV converted to XLSX:

```bash
cargo test -p hcd-formats middle_row_deletion_shifts_windows_and_preserves_history
cargo test -p hcd-formats deleting_only_worksheet_row_keeps_empty_grid_window
cargo test -p hcd-formats deleting_previously_inserted_and_filled_row_clears_dirty_node
python3 - <<'PY'
import csv
from openpyxl import Workbook
w = Workbook(); sheet = w.active
with open('/Users/houshuai/Downloads/open-review-usage-2026-09.csv', encoding='utf-8-sig', newline='') as source:
    for row in csv.reader(source): sheet.append(row)
w.save('/tmp/hcd-middle-row-real.xlsx')
PY
target/debug/officecli hdoc import /tmp/hcd-middle-row-real.xlsx \
  --output /tmp/hcd-row-delete-check.hcd --document-id hcd-row-delete-check
python3 - <<'PY'
import gzip, json
from pathlib import Path
root = Path('/tmp/hcd-row-delete-check.hcd')
manifest = json.loads((root / 'manifest.json').read_text())
with gzip.open(root / manifest['indexRootHref'], 'rt') as source: tree = json.load(source)
with gzip.open(root / tree['children'][0], 'rt') as source: page = json.load(source)
patch = {'schemaVersion': 'hcd-patch/14', 'documentId': 'hcd-row-delete-check',
         'patchId': 'delete-real-row-2', 'baseRevision': 0,
         'operations': [{'op': 'xlsx.row.delete',
                         'sheetId': page['chunks'][0]['grid']['sheetId'], 'row': 2}]}
Path('/tmp/hcd-row-delete-check.patch.json').write_text(json.dumps(patch))
PY
target/debug/officecli hdoc apply /tmp/hcd-row-delete-check.hcd \
  --patch /tmp/hcd-row-delete-check.patch.json --expected-revision 0
target/debug/officecli hdoc validate /tmp/hcd-row-delete-check.hcd
target/debug/officecli hdoc export /tmp/hcd-row-delete-check.hcd \
  --source /tmp/hcd-middle-row-real.xlsx --revision 1 --output /tmp/hcd-row-delete-current.xlsx
target/debug/officecli hdoc export /tmp/hcd-row-delete-check.hcd \
  --source /tmp/hcd-middle-row-real.xlsx --revision 0 --output /tmp/hcd-row-delete-original.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
head = list(load_workbook('/tmp/hcd-row-delete-current.xlsx', read_only=True).active.values)
history = list(load_workbook('/tmp/hcd-row-delete-original.xlsx', read_only=True).active.values)
assert len(head) == 2 and len(head[0]) == 12
assert [row[0] for row in head] == ['row_type', 'repository']
assert [row[0] for row in history] == ['row_type', 'summary', 'repository']
PY
```

To reproduce the column action with the same `/tmp/hcd-middle-row-real.xlsx` source from the commands below, import it with a fresh document ID, select B1, choose **插入 → 在选中列前插入**, validate, and download XLSX. `openpyxl` should report three rows and thirteen columns; B1:B3 should be empty, and every source value in B:L should appear in C:M. The browser download was reopened and all 36 source values matched their shifted addresses. The focused checks are:

```bash
cargo test -p hcd-formats middle_column_insertion_preserves_ids_history_and_exported_addresses
cargo test -p hcd-formats middle_column_insertion_shifts_all_row_windows
cargo test -p hcd-formats middle_column_insertion_rejects_explicit_source_widths
```

Reproduce with `open-review-usage-2026-09.csv` converted to `/tmp/hcd-middle-row-real.xlsx` using `openpyxl` (three rows, twelve columns):

```bash
cargo test -p hcd-formats middle_row_insertion_preserves_node_ids_history_and_exported_addresses
cargo test -p hcd-formats middle_row_insertion_shifts_across_chunk_windows
cargo test -p hcd-formats xlsx::tests
cargo build -p officecli
python3 - <<'PY'
import csv
from openpyxl import Workbook
w = Workbook(); s = w.active; s.title = 'Usage'
with open('/Users/houshuai/Downloads/open-review-usage-2026-09.csv', encoding='utf-8-sig', newline='') as source:
    for row in csv.reader(source): s.append(row)
w.save('/tmp/hcd-middle-row-real.xlsx')
PY
mkdir -p /tmp/hcd-row-insert-accept/sources
target/debug/officecli hdoc import /tmp/hcd-middle-row-real.xlsx \
  --output /tmp/hcd-row-insert-accept/accept-usage-xlsx.hcd --document-id accept-usage-xlsx
# Start hdoc serve and Vite with HCD_DEMO_ROOT=/tmp/hcd-row-insert-accept.
# Open the Usage card, select A2, choose 插入 → 在选中行前插入, then 准备下载.
target/debug/officecli hdoc validate /tmp/hcd-row-insert-accept/accept-usage-xlsx.hcd
target/debug/officecli hdoc export /tmp/hcd-row-insert-accept/accept-usage-xlsx.hcd \
  --source /tmp/hcd-middle-row-real.xlsx --output /tmp/hcd-middle-row-real-export.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
s = load_workbook('/tmp/hcd-middle-row-real-export.xlsx', read_only=True).active
assert s.max_row == 4 and s.max_column == 12
assert s['A2'].value is None and s['A3'].value == 'summary'
PY
```

The **插入 → 撤销末尾空行** action uses `hcd-patch/10` to remove the final row only when HCD appended it after the original source range and it remains empty. It does not delete source rows or rows containing cells or formatting. The preceding revision remains readable and exportable; the new revision's source-backed XLSX export omits the removed row. To verify, append row 16 after editing A15 in the Settings sheet, leave row 16 empty, then undo it. Attempting to undo row 15 must fail because A15 contains text. The reference screenshot is `docs/screenshots/hcd-xlsx-remove-empty-tail.png`.

The **开始 → 列宽 → 设置列宽** action uses `hcd-patch/9` for the selected column (1–255 Excel width units, two decimal places). The HCD grid updates every window of that worksheet, while source-backed XLSX export splits any covering `<col>` range so neighboring columns retain their widths. On the real `assets/showcase/budget-tracker.xlsx` Settings sheet, select B1 and set its width to `28`. The reference screenshots are `docs/screenshots/hcd-xlsx-column-width-before.png` and `docs/screenshots/hcd-xlsx-column-width-after.png`. After export, `xl/worksheets/sheet3.xml` must include `<col min="2" max="2" width="28.00" customWidth="1"/>` while A and C remain at width 18. This adjusts layout without moving cell addresses; inserting and deleting columns remain separate work.

The **开始 → 行高 → 设置行高** action uses `hcd-patch/18` for one materialized row (1–409 points, two decimal places). It updates the HCD grid and source-backed XLSX row height; source-free semantic XLSX export does not yet preserve this physical dimension. Browser and real-data validation are in [the row-height acceptance](../../../docs/acceptance/hcd-xlsx-row-height.md).

For a real-file check, import `assets/showcase/budget-tracker.xlsx` as `accept-xlsx`, open the Settings sheet, choose **插入 → 在末尾新增行**, and type `Browser appended row` into A15. The first action creates r1 and the cell edit creates r2. The reference screenshots are `docs/screenshots/hcd-xlsx-row-append.png` and `docs/screenshots/hcd-xlsx-row-append-edited.png`. Verify the downloaded workbook with:

```bash
mkdir -p /tmp/hcd-xlsx-append/sources
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-xlsx-append/accept-xlsx.hcd --document-id accept-xlsx
cp assets/showcase/budget-tracker.xlsx /tmp/hcd-xlsx-append/sources/accept-xlsx.xlsx
# Start the core API and Vite gallery with HCD_DEMO_ROOT=/tmp/hcd-xlsx-append as shown above.
# Use the Settings sheet, append row 15, and edit A15 before validating and exporting.
target/debug/officecli hdoc validate /tmp/hcd-xlsx-append/accept-xlsx.hcd
target/debug/officecli hdoc export /tmp/hcd-xlsx-append/accept-xlsx.hcd \
  --source assets/showcase/budget-tracker.xlsx --output /tmp/hcd-xlsx-append/exported.xlsx
unzip -p /tmp/hcd-xlsx-append/exported.xlsx xl/worksheets/sheet3.xml | rg 'A15|Browser appended row'
```

Reproduce the merge and download check with the repository workbook:

```bash
cargo test -p hcd-formats merges_empty_xlsx_cells_in_hcd_and_source_backed_export
mkdir -p /tmp/hcd-xlsx-merge/sources
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-xlsx-merge/accept-xlsx.hcd --document-id accept-xlsx
cp assets/showcase/budget-tracker.xlsx /tmp/hcd-xlsx-merge/sources/accept-xlsx.xlsx
# Start the core API, sidecar, and Vite gallery as described above with HCD_DEMO_ROOT=/tmp/hcd-xlsx-merge.
# In the Settings sheet, select A1:B1, click 合并单元格, then prepare and download XLSX.
target/debug/officecli hdoc validate /tmp/hcd-xlsx-merge/accept-xlsx.hcd
target/debug/officecli hdoc export /tmp/hcd-xlsx-merge/accept-xlsx.hcd \
  --source assets/showcase/budget-tracker.xlsx --output /tmp/hcd-xlsx-merge/exported.xlsx
unzip -p /tmp/hcd-xlsx-merge/exported.xlsx xl/worksheets/sheet3.xml | rg 'mergeCell ref="A1:B1"'
```

PDF, PPTX, and XLSX sessions now share the document's collaborator list and committed HCD revisions. Open the same document in two browser windows: saving a PDF/PPTX text box or an XLSX cell in one window updates the other window's revision and visible page or cell without a reload. Multiple windows with the same user ID appear as one person with a window count. Fixed-layout edits commit through the Rust patch API; Hocuspocus announces the committed revision, and each client re-reads its visible HCD objects. These formats do not merge unsaved keystrokes in Yjs: concurrent edits to the same old revision receive a patch conflict and must be retried. Read tokens can receive updates but cannot submit patches or revision announcements. The reference screenshot is `docs/screenshots/hcd-fixed-grid-collaboration.jpg`.

For PDF, **插入 → 新增文字框** places a plain-text box on the original page. Type in place, save, then click the box again to edit it. The `hcd-patch/5` `pdf.text.insert` operation assigns a stable node ID and records page coordinates; both source-backed and source-free PDF export draw the box at those coordinates. Source-backed export now adds the new PDF text object after rewriting mapped source text; older builds could report success while omitting the new box. The rendered fixture export is at `docs/screenshots/hcd-pdf-text-insert-export.png`. This operation adds text to an existing page; it does not add a PDF page. Lines and tables in a raster-backed PDF remain page artwork rather than editable table cells, so PDF cell merging is not supported by this operation.

Source-backed export places the same white masks behind new text boxes that the HCD page preview and source-free PDF use. The masks cover underlying content visually; original source PDF text remains extractable, so this is not redaction. The fidelity report includes `HCD_PDF_VISUAL_MASK_NOT_REDACTION` when masks are written.

## Storage and save flow

- `hdoc import` defaults to `hcd/2`, gzip text objects, and PDF `auto` raster selection. `hdoc stats BUNDLE` reports compressed categories, revision growth, and unreferenced objects. `hdoc validate BUNDLE` verifies content and revision roots.
- The first semantic edit creates an editor projection at revision 1. Browser edits sync through one Hocuspocus instance. Yjs state is persisted through the Rust API, and HCD checkpoints are created after 30 seconds idle or 60 seconds continuous activity, on manual save, and before export. Recently edited state can be lost if the sidecar and database fail before persistence finishes.
- Restore and external structure patch operations advance a collaboration epoch. Stale rooms, state writes, and checkpoints are rejected; active editor clients reconnect to a new room. Historical HCD revisions remain readable.
- Source-backed same-format export needs the immutable source in `ROOT/sources/<documentId>.<format>`. Semantic DOCX export after structure edits rebuilds layout and reports fidelity. PDF download defaults to a page-image PDF matching the current HCD revision: edited text boxes are drawn over bounded white masks on the original page image. The visual result keeps page dimensions but the mask, font metrics, and placement are approximate, so inspect the exported PDF before delivery. Select **保留源 PDF（修订位置近似）** to keep the original PDF structure; this requires the immutable source. The page-image PDF does not recreate the original selectable text or vector objects.
- After preparing any PDF download, **预览导出 PDF** fetches the actual exported PDF and renders its pages with PDF.js. Use this print preview for DOCX/Markdown/TXT conversions, whose editor view does not promise physical page matching. The adjacent download link uses the same revision, format, source mode, and five-minute ticket.

## Optional PostgreSQL and S3 durability

Set `HCD_DATABASE_URL`, `HCD_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` before `hdoc serve`. Set `HCD_S3_ENDPOINT` for a compatible private store. This mode uploads immutable HCD objects and the external source before a PostgreSQL compare-and-swap advances the document head; on startup it hydrates the local cache. It is designed for one collaboration sidecar instance. Configure network isolation, TLS termination, and backups in the host deployment.

## Reproducible checks

```bash
cargo test -p hcd-core
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
(cd examples/hdoc/xlsx-univer-viewer && npm ci)
(cd examples/hdoc/editor && npm run build)
```

For the edited PDF page-image export, the repository fixture and patch are reproducible:

```bash
target/debug/officecli hdoc import examples/hdoc/pdf-raster-quality.pdf --output /tmp/hcd-pdf-visual.hcd
target/debug/officecli hdoc apply /tmp/hcd-pdf-visual.hcd --patch examples/hdoc/pdf-text-patch.json --expected-revision 0
target/debug/officecli hdoc export /tmp/hcd-pdf-visual.hcd --revision 1 --output /tmp/hcd-pdf-visual-r1.pdf
pdftotext -layout /tmp/hcd-pdf-visual-r1.pdf - | head -1
```

The first extracted line should start with `Edited:`. The rendered page is shown in `docs/screenshots/hcd-edited-pdf-visual-export.jpg`.

To verify positioned PDF text insertion, later editing, and export with or without the source PDF:

```bash
cargo test -p officecli --test hdoc_multi_format pdf_inserted_text_box_can_be_reedited_and_exported_without_source
```

In the browser, insert, delete, and reorder paragraphs, save, view an older revision, restore it, and confirm the editor reconnects. Open two write sessions with different `--user-id` values to verify live sync and presence. Repeat with a read token to verify editing is disabled. Use a 100-page DOCX to check end-to-end input, scrolling, and memory; use a large PDF to check window loading and rotated pages.

For fixed-format collaboration, open the same PDF, PPTX, or XLSX document in two windows. Save a mapped PDF/PPTX text node or XLSX cell in the second window and verify the first window advances its revision and displays the new value. Repeat with the same `--user-id` in both windows and verify the collaborator menu shows one person and two windows. Disconnect the sidecar briefly and verify the 15-second manifest poll still catches the committed revision.

For rich-text acceptance, select paragraph text, apply an `https://` link from the toolbar, undo and redo it, and save. Export HTML and confirm the link and text survive. Right-click the same selection, choose **复制选中内容**, and verify the clipboard contains the complete selected text. The link dialog accepts `http://`, `https://`, and `mailto:` URLs, matching server validation.

Markdown documents with quotes, fenced code, tables, or other unsupported structure retain those regions as read-only blocks in the editor. Their ordinary headings, paragraphs, and lists remain editable in the same document. Export keeps the read-only regions intact.
