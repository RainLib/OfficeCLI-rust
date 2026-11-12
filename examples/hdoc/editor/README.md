# HCD reference editor and core service

This example runs a self-hosted Tiptap/Yjs editor against the `hcd/2` core API. DOCX, HTML, Markdown, and TXT use the semantic editor. PDF and PPTX use the fixed-layout, window-loaded viewer; both can place and edit positioned text boxes. XLSX uses the Univer adapter for mapped cell values, formulas, and bounded cell merging. The formula bar can turn an existing editable value into a native formula; see [the SUM acceptance steps](../../../docs/acceptance/hcd-xlsx-formula-from-value.md). HCD revisions are immutable; semantic editing creates `hcd-patch/4` checkpoints and does not write browser HTML into a bundle.

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

The header search button and `Cmd/Ctrl+F` search all text in the current document. DOCX, HTML, Markdown, and TXT search the live editor content, including edits that have not reached an HCD save point. PDF, PPTX, and XLSX search verified HCD text nodes through `GET /v1/documents/{id}/search?q=...&revision=...` with a document-scoped read token. Results can open an unloaded page or worksheet; PDF raster assets and scanned text without OCR remain outside the text search index. The API returns at most 200 matches and limits each search to 10,000 text chunks or 256 MiB of decoded HTML.
The XLSX cross-sheet browser result is shown in `docs/screenshots/hcd-content-search-xlsx.jpg`.

To verify the service with an imported bundle, start `hdoc serve` and run:

```bash
TOKEN=$(HCD_TOKEN_SECRET='the-same-private-secret' target/debug/officecli hdoc issue-token \
  --document-id demo-docx --scope read --json | jq -r '.data.token')
curl -fsSG -H "Authorization: Bearer $TOKEN" --data-urlencode 'q=Number' \
  http://127.0.0.1:8766/v1/documents/demo-docx/search | jq '{revision, hits: (.hits | length)}'
```

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

PDF and PPTX text boxes use the same Tiptap/ProseMirror editing core as DOCX, scoped to one fixed-page text node. PDF patches still store plain text, so the strict box schema prevents formatting from being silently lost. A selected PPTX run can change bold, italic, underline, font size, and sRGB color with `hcd-patch/30`; source-backed export writes those direct DrawingML run properties. Select a mapped text node, type, undo with `Cmd/Ctrl+Z`, and save; the updated page and revision should appear immediately. The reference screenshot is `docs/screenshots/hcd-fixed-tiptap-text-box.jpg`.

PDF editing mounts Tiptap inside the selected canonical page text element in the sandboxed preview frame. The page raster is masked at that element while editing, so the text appears once at its page position; save from the top bar or use `Cmd/Ctrl+Enter`, and use `Esc` to cancel. The direct-node screenshot is `docs/screenshots/hcd-pdf-direct-node-edit.jpg`.
After inserting a PDF text box, select it to move it with the top handle or resize it with the lower-right handle. Each release saves a `hcd-patch/23` revision with the same nodeId. Source PDF text remains text-editable but its original geometry is not moved; see `docs/acceptance/hcd-pdf-textbox-geometry.md` for the command sequence and screenshot.
An HCD-created PDF text box can also be removed with the upper-right × button or the toolbar action. `hcd-patch/24` removes it from the current view and source map while preserving old revisions; source-backed export stops replaying its earlier edits. See `docs/acceptance/hcd-pdf-textbox-delete.md` for reproduction and before/after screenshots.

PPTX uses the same in-frame text editing, keeping the shape's font and color at its slide position. The Home tab sets bold, italic, underline, size, and color on the selected run and saves `pptx.run.format`. The slide outline opens by default with its own visibility preference, and unloaded slides reserve the measured slide height instead of a generic page height. The reference screenshot is `docs/screenshots/hcd-pptx-direct-slide-edit.jpg`.
Select a positioned PPTX text shape to reveal a move handle above it and a resize handle at its lower right. Releasing either handle saves a `hcd-patch/17` revision. Save any pending text first. The source-backed PPTX export retains the new coordinates; see `docs/acceptance/hcd-pptx-shape-geometry.md` for commands and screenshots.
An HCD-created PPTX text box also has a delete button. `hcd-patch/27` removes the box from the current slide and source map while keeping its historical revision. Original slide shapes remain protected. See `docs/acceptance/hcd-pptx-textbox-delete.md` for the command sequence and browser screenshots.
A box aligns as a whole. `hcd-patch/46` `pptx.shape.align` takes a `nodeId` and `align.horizontal` (`left`/`center`/`right`/`justify`/`distributed`) and/or `align.vertical` (`top`/`center`/`bottom`), and the Home tab's second PPT band posts it from eight buttons — 左对齐 · 居中 · 右对齐 · 两端对齐 · 分散对齐 and 顶端对齐 · 垂直居中 · 底端对齐, grouped under `形状对齐`. It is addressed by a text node because that is what the editor can select; what moves is the shape holding it, which is how a deck without paragraph ids still gets an honest control. Every `<p class="hcd-slide-text">` in the box takes the horizontal value as `text-align` and the frame takes the vertical one as `display:flex;flex-direction:column;justify-content:…`, and the frame is marked `data-hcd-align-edited="true"` with `data-hcd-horizontal`/`data-hcd-vertical` beside it — the only record that separates `distributed` from `justify`, since the importer folds the two together. An axis the request leaves out keeps the value the box already carries, so a second click moves one side and leaves the other, and a request that would rewrite nothing is refused (`PPTX shape alignment is unchanged`) instead of costing a revision. Source-backed export writes the same two things into the part: `algn` on every `a:pPr` of that shape — synthesized as the paragraph's first child when the source had none, replaced rather than doubled when it did, with `marL`, `indent`, and `buChar` left in place — and `anchor` on its `a:bodyPr`, both found by the shape id the mark carries, so an untouched box exports byte for byte. The run's own hash does not move: alignment lives on the frame, not on the text under it. The viewer needed no change — it already draws `text-align` from the source paragraph and the flex band from the shape's vertical anchor — so the client side is the buttons, the read-back that greys the axis a box already holds, and the note. See `docs/acceptance/hcd-pptx-shape-align.md` for the four-revision run, the per-shape part diffs, and the refusals.
A new revision can add a slide. `hcd-patch/41` `pptx.slide.add` takes no arguments: HCD reads the page size off the slides it already has, numbers the new slide part past the highest one it knows, and appends one empty page, so the outline and the chunk count grow by one and the page is editable at once. The patch refuses a presentation with no slide to take the size from, and one whose slides disagree on it. The insert tab's 新增幻灯片 button posts the patch, then re-reads the manifest and the last index page, because the new page is a chunk the editor never fetched. A text box placed on that page lands in it as the slide's first shape, and the empty-page placeholder goes away with it. Source-backed export writes the slide as a part the source package never had — a blank `<p:sld>` drawing from the layout the last existing slide uses, with its own `ppt/slides/_rels/slideN.xml.rels` — and rewrites only `[Content_Types].xml`, `ppt/_rels/presentation.xml.rels`, and `ppt/presentation.xml` to list it. A package that has no slide layout to point at, a slide part name the source already uses, or a presentation without its `sldIdLst` fails the export by naming what is missing instead of writing a half-built deck. The refusal is about writing that package, not about the revision: HCD keeps the added page either way. Re-importing a deck that did export recovers the same chunk id, so later patches keep addressing that slide.

A revision can also take a page out. `hcd-patch/42` `pptx.slide.delete` is addressed by the chunk that holds the page — `chunkId`, the thing the editor already knows, because the row it shows a delete control for is the row whose chunk it read. A slide is not one row of the index: the importer writes a page as a section naming its source part, and a slide whose table is split repeats that section across chunks, so the patch resolves the chunk to its part and drops every chunk that names it. Their text nodes leave with them, the surviving chunks are renumbered, and the index is repacked; a deck can therefore lose an index page, which is why the outline's ✕ 删除 control re-reads every index page the editor had loaded instead of splicing one row out. The patch refuses a chunk it cannot find, a chunk that is not a page, and the last page of a deck, since a presentation with no slides is not a file PowerPoint opens. Source-backed export drops the part, the relationship list it owned, the `<p:sldId>` in the presentation, the `Relationship` in `ppt/_rels/presentation.xml.rels`, and the `[Content_Types].xml` override, and it refuses rather than leaving a dangling address: a deck with custom shows or sections, and any page whose speaker notes point back at it, are refused by naming the file that stands in the way. Media, layouts and charts that only the deleted page used stay in the package unreferenced, and the report records that. A page this history both added and deleted cancels before either half runs, so the export comes back byte for byte. Re-importing a deck that did export keeps the surviving pages under the chunk ids the editor already held.

A revision can also move a page one place. `hcd-patch/43` `pptx.slide.reorder` takes the same `chunkId` plus a `direction` of `up` or `down`: HCD groups the index into pages exactly as a deletion does — consecutive chunks naming one source part are one page — and trades that page with its neighbour, so nothing enters or leaves the deck and only the order the pages are listed in changes. The patch refuses a deck with one slide, a page already at the end it asks for, a chunk that is not a page, and a patch that both moves and removes a slide. The outline's ↑ 上移 and ↓ 下移 controls post it from a page head — a continuation row is the same page again, not a second page the deck could place elsewhere — and the client can settle the two bounds it can see: up is out of reach on the first row, and down on the last row once every chunk has been read. Like a deletion it re-reads every index page the editor had loaded, because a swap renumbers both pages rather than the one row. Source-backed export writes `ppt/presentation.xml`'s `<p:sldIdLst>` to the order the HCD index holds, with each entry keeping the `id` it was written with, because a slide's id is not its position; the wanted entries are resolved through `ppt/_rels/presentation.xml.rels`, so a deck whose list order and relationship order disagree is reordered by the deck. A custom show keeps naming the pages it named, since a move permutes ids that stay valid; a deck that groups its slides in sections is refused, because a section lists its own pages — a bound no bundle reaches today, since the importer cannot read a sectioned deck at all. A page HCD created moves through the deck it joined, and a page moved and moved back writes no `presentation.xml` at all: the package stays byte-identical and the report stays `EXACT` with no reorder warning.

A revision can also duplicate a page. `hcd-patch/44` `pptx.slide.copy` takes the same `chunkId` and resolves it to a page exactly as a deletion or a move does, then clones every chunk that carries it: the copy stands right behind the page it was made from, holds the same text and the same shapes under ids of its own, and is numbered past every slide part the index or any revision's additions, copies, and removals mention. Its chunk ids, its node ids, and its map entries are re-derived from the new part name, so text on the copy is addressable and editable on its own — an edit made to the original after the copy was made does not reach the copy, an edit made to the copy does not reach the original, and the page it was copied from is left untouched. What a copy is written from is the bound worth naming: the export writes the new part out of the page the *source package* holds, so the patch refuses a page HCD created with `hcd-patch/41` — a copy is itself a page HCD created, so a copy cannot be copied again — and a page an earlier revision already rewrote in HCD, each time naming the part and the reason. Copying an edited page would need the part as of the revision that made the copy, which a bundle does not keep. The outline row's ⧉ 复制 control posts the patch and re-reads the index the way a deletion does, with one difference: a copy only ever adds chunks, so a deck whose every chunk had been read re-reads the whole list, because the copy can start an index page of its own, while a deck still being scrolled keeps its own frontier. Source-backed export writes the slide part and its relationship list from the page it was made from — byte for byte when nothing wrote on the copy after it was made — and appends one entry to `[Content_Types].xml`, `ppt/_rels/presentation.xml.rels`, and `ppt/presentation.xml`. A copy this history also wrote on has no part in the source package to rewrite in place, so it is rebuilt onto the page it was made from: the source's own bytes, which is what the copy was written from, not whatever a later revision has since said about that page. The `PPTX_SLIDE_COPY` warning names which of the two the package holds. Where that entry stands is not decided there: the same list rewrite a move uses puts the copy behind its original, so the bounds of a move are bounds of a copy too, and a deck that groups its slides in sections is refused. A copied page keeps only the relationships a deck shares — the layout it draws from, the media that is the same picture on both pages, an embedded font the package carries once. A list that points at anything else, a notes page or a chart or an embedded object or a tag list, would leave two pages naming one resource, which is a package an application repairs on opening, so the export refuses and names the relationship and the target it cannot duplicate. A page whose own list the package never carried is given an empty one, so its name resolves the way the original's does. Two cases fall out of the same ledger: a page copied and then deleted again inside one history cancels, so nothing is written for it and the package comes back byte for byte, and a copy whose original a later revision deletes keeps what that page said when the copy was made, because the copy is written from the source before the source's own entry is taken away — a move, in all but name.

The XLSX canvas keeps its Univer cell editor and now uses the same fixed document header, view controls, appearance panel, export control, and status bar as the other formats. Double-click an existing cell or press F2 to edit its content. The Home tab can set bold, italic, underline, font size, font color, and fill on a mapped cell. `hcd-patch/31` stores `xlsx.cell.format`; source-backed export clones that cell's style in `xl/styles.xml` and leaves every other cell on its original style index. The same Home tab sets left, center, or right alignment, top, center, or bottom alignment, wrap, and a thin or cleared border through `hcd-patch/32` `xlsx.cell.layout`. A later layout edit is written onto the same cloned style as an earlier font or fill edit. Number formats use `hcd-patch/33` `xlsx.cell.numberFormat`: built-in codes such as `0.00`, `0%`, and `yyyy-mm-dd` reuse Excel's format ids, and a custom code is appended to `numFmts` on that same cloned style. A worksheet tab is renamed with `hcd-patch/34` `xlsx.sheet.rename`, addressed by `sheetId`. HCD stores the new tab name on the worksheet chunks and rewrites the formulas it holds; source-backed export renames the tab in `xl/workbook.xml` and rewrites formulas, defined names, chart references, worksheet hyperlinks, and internal relationship targets that named the old tab, so only the parts that referenced it are rewritten. Several renames replay in revision order, so `A → B → C` lands on `C`. A workbook whose pivot tables, external links, slicers, timelines, query tables, data model, or connections name a worksheet cannot be reached by that rewrite, so a source-backed export of a renamed workbook that contains them fails instead of exporting a half-renamed file. A blank worksheet is added with `hcd-patch/35` `xlsx.sheet.add`: HCD mints the tab's grid id, numbers its worksheet part past the highest one the source workbook has, gives it one window that covers no rows, and starts a new index page when the last one is already full. The first row of that window takes a cell straight away, so the tab is editable without a source row to clone. Source-backed export adds `xl/worksheets/sheetN.xml` as a part the source archive never had and rewrites only `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, and `[Content_Types].xml` to list the tab; re-importing the exported workbook recovers the same `sheetId`, so later edits keep addressing that tab. A worksheet is deleted with `hcd-patch/36` `xlsx.sheet.delete`, also addressed by `sheetId`: HCD drops that tab's chunks, renumbers the surviving index pages, and re-folds the root hash, shifting the stored sheet position of every tab behind the hole so later patches still resolve their worksheet. Formulas stored in the surviving chunks that named the deleted tab collapse to `#REF!`. Source-backed export removes the `<sheet>` entry, the worksheet part, its relationship, and its `[Content_Types].xml` override, lowers every `definedName/@localSheetId` that pointed past the deleted tab, drops `xl/calcChain.xml`, and marks the workbook `fullCalcOnLoad` so the broken references are recomputed on open. A revision that only cancels a delete leaves all three control parts byte-identical. The patch itself refuses only the last visible worksheet; the other bounds are caught at export, which names the part it cannot rewrite safely instead of producing a half-deleted file — a workbook whose pivot tables, external links, slicers, timelines, query tables, data model, or connections name that tab, or a drawing, table, or comments part attached to the deleted tab's own relationships. A source-free export of the same revision still works.

The Home tab also holds a band of the sheet still. `hcd-patch/45` `xlsx.sheet.freeze` takes `sheetId`, `rows`, and `columns`, and the four ribbon buttons post it: 冻结首行 keeps the frozen columns it already has and sets rows to 1, 冻结首列 does the same on the other side, 冻结窗格 reads the split off the cell the cursor stands on the way Excel does, and 取消冻结 sends `0`/`0`. The freeze is stored on the chunks, not on the revision record: the patch rewrites the pane vocabulary onto *every* `cells` window of that worksheet and marks the window `data-hcd-pane-edited="true"`, so a sheet whose part the history never touched is exported byte for byte, and a sheet it did touch keeps the split through later revisions that rebuild the same part. Source-backed export writes one `<pane>` into each edited window — `xSplit`/`ySplit`, `topLeftCell` at the first free cell, `activePane` in the camelCase the package uses, `state="frozen"` — replacing whatever pane the source part carried, and a release takes the pane out and puts the source's own `<selection>` back. Splits run to Excel's own limits (`rows` ≤ 1048575, `columns` ≤ 16383, `topLeftCell` at `XFD1`); past that the patch refuses to leave a sheet with no scrolling room. A request that would rewrite nothing is refused rather than recorded, so there is no revision that changes nothing: `XLSX worksheet already freezes {rows} rows and {columns} columns`, `XLSX worksheet has no frozen panes to release`. 取消冻结 leaves the edit marker in place, which is what tells a later rebuild that this sheet's panes belong to HCD. The shift path reads a pane the source workbook wrote as the counts it is: a row inserted at or above the last frozen one widens the band and one inserted below leaves it alone, a deleted row inside the band narrows it, and `topLeftCell` moves with the same shift the selection moves by, so an insert at the top of a 1×1 freeze exports `<pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/>` instead of failing. A band cannot be moved off the sheet either — a pane pushed past 1048575 rows or 16383 columns is refused — and a split the counts do not describe is refused before the archive is touched: `horizontalSplit`/`verticalSplit` (a split measured in twips has no row to grow) and a split count that is not a whole number both fail as `grid shift cannot update a worksheet pane …`. A pane HCD wrote itself used to ride through the shift untouched; the shift moves that band now too, so the counts on the chunks and the pane in the part tell the same story. The patch applies the export's rule verbatim — a row or column inserted at or above the last frozen one widens the band by exactly how many moved, one inserted below leaves it alone, a row or column deleted inside it narrows it — and asks *every* `cells` window of the shifted sheet, not only the windows whose own rows moved, because the export refuses a sheet whose windows disagree (`XLSX HCD frozen pane differs between windows`). An edited window gets the whole vocabulary rewritten, so `data-hcd-pane-top-left-cell` moves to the first free cell along with it; a window the importer filled moves only its two counts and keeps the corner it read, which the export recomputes anyway. A band emptied to zero releases the counts the way 取消冻结 does and the edit marker stays, either way. Counts that cannot be read leave that window alone instead of failing the patch, but a band that cannot grow past the sheet stops the patch before the revision is recorded — `XLSX frozen band grows past the worksheet it freezes` — while a pane no window counted still stops the export. The viewer feeds only `data-hcd-frozen-rows`/`-columns` to Univer as `xSplit`/`ySplit`, so a shift moves the frozen band in the grid without a reload, and because a history freeze replaces the source's pane wholesale, an unreadable source pane never stops a sheet the history froze. The browser acceptance run, the four exported pane shapes, and the per-revision chunk and part diffs are in `docs/acceptance/hcd-xlsx-sheet-freeze.md`.

For XLSX, select a rectangular range and choose **开始 → 合并单元格**. `hcd-patch/6` saves the merge in one immutable revision, updates the visible Univer grid, and writes `mergeCells` during source-backed and source-free semantic XLSX export. The upper-left cell must be mapped and editable; every covered cell must be empty, and the range must fit one HCD cell window. The service rejects overlap and content loss. Source-free export preserves merged ranges and cell coordinates but rebuilds workbook styles and flattens sheets into one semantic sheet. The browser acceptance screenshot is `docs/screenshots/hcd-xlsx-merge-cells.png`.

The same operations are available by right-clicking the worksheet canvas. The HCD menu offers merge, split, and insert/delete for the selected rows or columns; it reuses the toolbar's revision and permission checks. Right-clicking the sheet tabs or using read-only mode leaves the native browser menu alone. See `docs/acceptance/hcd-xlsx-context-menu.md` for the real-workbook command sequence and screenshot.

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

The **插入 → 在选中行前插入** action uses `hcd-patch/12` to insert an empty row before an existing row. HCD keeps mapped node IDs stable, records the original source cell addresses, shifts later rows across chunk windows, and retains historical revisions. Source-backed XLSX export moves the original OOXML rows and cell references, then writes new HCD cells at their current addresses. It updates safely parsed A1 formulas, conditional formatting formulas, merged ranges outside the insertion point, two-cell picture/chart anchors, and the defined names in `xl/workbook.xml` that ranged over the edited worksheet: `'Order Form'!$A$1:$D$25` exports as `$A$1:$D$26` under a row inserted at row 3, a whole-row or whole-column address moves its two endpoints, and everything else the name holds — the quoted or bare tab spelling, the `$` markers, the separators between areas — is copied rather than re-spelled. A name scoped by `localSheetId` has its bare addresses counted against that worksheet. Unsupported cross-sheet formulas, charts linked by formulas to the edited sheet, validation, tables, and other unhandled coordinate-bearing source constructs remain rejected by the export safety checks, and so does a defined name whose endpoints this counter cannot read — a formula value, a bare address on a global name, an address the shift would push past the sheet — with the name itself in the message: `XLSX grid shift cannot update the defined name {name}`. Nothing that used to be refused is now allowed except the names the counter can actually move. The [defined-name acceptance](../../../docs/acceptance/hcd-xlsx-grid-shift-defined-names.md) holds the real workbook command sequence, the per-revision address table, and the before/after against the pre-fix binary. The browser screenshot is `docs/screenshots/hcd-xlsx-insert-middle-row.png`.

The **插入 → 在选中列前插入** action uses `hcd-patch/13` to insert an empty column before an existing column in the same plain value workbook scope. HCD shifts the visible cells and source anchors across all row windows; source-backed export moves original OOXML cell addresses and materializes newly edited cells in the inserted column. Explicit column widths and other coordinate-dependent features are rejected until they can be moved safely. The browser screenshot is `docs/screenshots/hcd-xlsx-insert-middle-column.png`.

The **插入 → 删除选中行** action uses `hcd-patch/14` to delete a materialized row and move later rows up. It preserves the source workbook and all historical HCD revisions. Confirm the action in the browser, then use the revision view to recover the original row if needed. Source-backed XLSX export omits deleted source rows and their edited cells. Formulas, merged ranges, conditional formatting, and two-cell chart/picture anchors on the edited sheet move with the grid. The real workbook acceptance is [XLSX structural deletion](../../../docs/acceptance/hcd-xlsx-structure-delete.md).

The **插入 → 删除选中列** action uses `hcd-patch/15` to remove one column and move later cells left across all HCD row windows. It keeps stable node IDs for surviving cells and retains the deleted values in historical revisions. Source-backed XLSX export rewrites cell addresses and omits deleted cells. Formula references to a deleted cell become `#REF!`, matching spreadsheet deletion semantics. Merged ranges, explicit numeric column widths, conditional formatting, and two-cell chart/picture anchors are adjusted.

Row and column insertion move a merge only when the entire range is on the shifted side; insertion inside a merge is rejected. Deletion shrinks an intersected merge and retains a blank anchor when its first row or column is deleted. Source-backed export rewrites `mergeCells` and ordinary source `topLeftCell`, `activeCell`, and `sqref` references from the HCD revision; source-free semantic export retains the resulting merge. A defined name that ranged over the edited worksheet moves on the deletion shifts too, so a row deleted inside `'Data'!$3:$9` leaves `$3:$8` rather than a name that still points at a row that is gone. Structural deletion still rejects unsupported cross-sheet formulas, charts linked by formulas to the edited sheet, tables, pivots, one-cell/absolute drawing anchors, hidden or specially styled columns, and other source constructs that cannot be shifted safely. The older insertion command sequence is [merged grid acceptance](../../../docs/acceptance/hcd-xlsx-merged-grid-shift.md).

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

The **插入 → 在选中行后插入 1 行** and cell right-click **在下方插入 1 行** actions insert below the selected row (or below the bottom row of a selection). They use `xlsx.row.insert` within the materialized worksheet and `xlsx.row.append` at its tail. Inserting above or below keeps the current cell selection and scroll position instead of scrolling the inserted row to the top. A selection beyond the last stored row is already an editable blank grid, so select the last stored row to append there. For a real workbook check:

```bash
mkdir -p /tmp/hcd-xlsx-insert-below/sources
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-xlsx-insert-below/accept-xlsx.hcd --document-id accept-xlsx
cp assets/showcase/budget-tracker.xlsx /tmp/hcd-xlsx-insert-below/sources/accept-xlsx.xlsx
# Start the core API and Vite gallery with HCD_DEMO_ROOT=/tmp/hcd-xlsx-insert-below as shown above.
# In Overview, scroll until row 8 is in the middle, select A8, then right-click > 在下方插入 1 行.
# Check A8 remains selected at the same screen position, A9 is blank, and the old row 9 is now row 10.
target/debug/officecli hdoc validate /tmp/hcd-xlsx-insert-below/accept-xlsx.hcd
target/debug/officecli hdoc export /tmp/hcd-xlsx-insert-below/accept-xlsx.hcd \
  --source assets/showcase/budget-tracker.xlsx --output /tmp/hcd-xlsx-insert-below/exported.xlsx
python3 - <<'PY'
from zipfile import ZipFile
from xml.etree import ElementTree as ET
with ZipFile('/tmp/hcd-xlsx-insert-below/exported.xlsx') as archive:
    root = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    ns = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    assert root.find(".//x:c[@r='A9']", ns) is None
    assert root.find(".//x:c[@r='A10']", ns) is not None
    assert any(name.startswith('xl/charts/chart') and name.endswith('.xml') for name in archive.namelist())
PY
```

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

## Editor language

The UI defaults to English (`en-US`). Open the standalone editor with `?locale=zh-CN` (or `?lang=zh-CN`) to set the initial locale. Its language selector is available on the login page, in the semantic editor's Settings panel, and in fixed-layout/workbook previews; a manual choice is saved in browser storage. Supported locales are `en-US`, `en-GB`, `zh-CN`, `zh-TW`, and `zh-HK`. The corresponding regional date formatting and Univer workbook locale follow the selected value. Source document content is never translated.

For an embedded editor, pass `locale="zh-CN"` and optionally `onLocaleChange={setLocale}` to synchronize the host's language selector. The embedded editor defaults to `en-US` when the prop is omitted and does not write a browser-wide preference. Its locale selector remains available inside the editor.
