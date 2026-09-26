# HCD reference editor and core service

This example runs a self-hosted Tiptap/Yjs editor against the `hcd/2` core API. DOCX, HTML, Markdown, and TXT use the semantic editor. PDF and PPTX use the fixed-layout, window-loaded viewer. XLSX uses the Univer adapter for mapped cell values and bounded cell merging. HCD revisions are immutable; semantic editing creates `hcd-patch/4` checkpoints and does not write browser HTML into a bundle.

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

PPTX uses the same in-frame text editing, keeping the shape's font and color at its slide position. The slide outline opens by default with its own visibility preference, and unloaded slides reserve the measured slide height instead of a generic page height. The reference screenshot is `docs/screenshots/hcd-pptx-direct-slide-edit.jpg`.

The XLSX canvas keeps its Univer cell editor and now uses the same fixed document header, view controls, appearance panel, export control, and status bar as the other formats. Double-click an existing cell or press F2 to edit its content. The reference screenshot is `docs/screenshots/hcd-xlsx-unified-chrome.jpg`.

For XLSX, select a rectangular range and choose **开始 → 合并单元格**. `hcd-patch/6` saves the merge in one immutable revision, updates the visible Univer grid, and writes `mergeCells` during source-backed XLSX export. The upper-left cell must be mapped and editable; every covered cell must be empty, and the range must fit one HCD cell window. The service rejects overlap and content loss. Use the original immutable XLSX for download; source-free XLSX export now rejects merged cells explicitly instead of silently discarding them. The browser acceptance screenshot is `docs/screenshots/hcd-xlsx-merge-cells.png`.

An empty cell in a loaded row can now receive its first value directly in Univer, including up to 256 columns after that row's last materialized cell. `hcd-patch/7` creates a stable HCD node for that address; later edits use the normal text patch, and source-backed XLSX export inserts the new `<c>` element or fills an existing empty styled cell. A completely new row and paste into multiple new cells remain separate structural work. To reproduce with `assets/showcase/budget-tracker.xlsx`, open the Settings sheet, type `HCD blank cell edit` into B3, press Enter, validate the bundle, then download XLSX. `xl/worksheets/sheet3.xml` must contain B3 as an inline string. Entering `Browser tail edit` in F3 checks the row-tail case. Browser screenshots are `docs/screenshots/hcd-xlsx-blank-cell-edit.png` and `docs/screenshots/hcd-xlsx-tail-cell-edit.png`.

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

For PDF, **插入 → 新增文字框** places a plain-text box on the original page. Type in place, save, then click the box again to edit it. The `hcd-patch/5` `pdf.text.insert` operation assigns a stable node ID and records page coordinates; PDF export draws the box at those coordinates. The rendered fixture export is at `docs/screenshots/hcd-pdf-text-insert-export.png`. This operation adds text to an existing page; it does not add a PDF page. Lines and tables in a raster-backed PDF remain page artwork rather than editable table cells, so PDF cell merging is not supported by this operation.

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

To verify positioned PDF text insertion and later editing without the source PDF:

```bash
cargo test -p officecli --test hdoc_multi_format pdf_inserted_text_box_can_be_reedited_and_exported_without_source
```

In the browser, insert, delete, and reorder paragraphs, save, view an older revision, restore it, and confirm the editor reconnects. Open two write sessions with different `--user-id` values to verify live sync and presence. Repeat with a read token to verify editing is disabled. Use a 100-page DOCX to check end-to-end input, scrolling, and memory; use a large PDF to check window loading and rotated pages.

For fixed-format collaboration, open the same PDF, PPTX, or XLSX document in two windows. Save a mapped PDF/PPTX text node or XLSX cell in the second window and verify the first window advances its revision and displays the new value. Repeat with the same `--user-id` in both windows and verify the collaborator menu shows one person and two windows. Disconnect the sidecar briefly and verify the 15-second manifest poll still catches the committed revision.

For rich-text acceptance, select paragraph text, apply an `https://` link from the toolbar, undo and redo it, and save. Export HTML and confirm the link and text survive. Right-click the same selection, choose **复制选中内容**, and verify the clipboard contains the complete selected text. The link dialog accepts `http://`, `https://`, and `mailto:` URLs, matching server validation.

Markdown documents with quotes, fenced code, tables, or other unsupported structure retain those regions as read-only blocks in the editor. Their ordinary headings, paragraphs, and lists remain editable in the same document. Export keeps the read-only regions intact.
