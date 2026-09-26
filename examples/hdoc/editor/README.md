# HCD reference editor and core service

This example runs a self-hosted Tiptap/Yjs editor against the `hcd/2` core API. DOCX, HTML, Markdown, and TXT use the semantic editor. PDF and PPTX use the fixed-layout, window-loaded viewer. XLSX uses the existing Univer adapter in read-only mode. HCD revisions are immutable; the editor creates `hcd-patch/4` checkpoints and does not write browser HTML into a bundle.

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

The built-in app uses the Vite proxy for `/v1`. Products can import `EmbeddedHcdEditor` from `@officecli/hcd-reference-editor/react` and pass an API base URL, collaboration WebSocket URL, document ID, and token. Each editor keeps one ProseMirror document and one Yjs document; offscreen blocks use CSS `content-visibility` and fixed-layout assets load by viewport.

## Storage and save flow

- `hdoc import` defaults to `hcd/2`, gzip text objects, and PDF `auto` raster selection. `hdoc stats BUNDLE` reports compressed categories, revision growth, and unreferenced objects. `hdoc validate BUNDLE` verifies content and revision roots.
- The first semantic edit creates an editor projection at revision 1. Browser edits sync through one Hocuspocus instance. Yjs state is persisted through the Rust API, and HCD checkpoints are created after 30 seconds idle or 60 seconds continuous activity, on manual save, and before export. Recently edited state can be lost if the sidecar and database fail before persistence finishes.
- Restore and external structure patch operations advance a collaboration epoch. Stale rooms, state writes, and checkpoints are rejected; active editor clients reconnect to a new room. Historical HCD revisions remain readable.
- Source-backed same-format export needs the immutable source in `ROOT/sources/<documentId>.<format>`. Semantic DOCX export after structure edits rebuilds layout and reports fidelity. Source-free PDF export from fixed-layout revision 0 embeds the HCD page rasters with visual fidelity; it does not recreate selectable text or vector objects.

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

In the browser, insert, delete, and reorder paragraphs, save, view an older revision, restore it, and confirm the editor reconnects. Open two write sessions with different `--user-id` values to verify live sync and presence. Repeat with a read token to verify editing is disabled. Use a 100-page DOCX to check end-to-end input, scrolling, and memory; use a large PDF to check window loading and rotated pages.

For rich-text acceptance, select paragraph text, apply an `https://` link from the toolbar, undo and redo it, and save. Export HTML and confirm the link and text survive. Right-click the same selection, choose **复制选中内容**, and verify the clipboard contains the complete selected text. The link dialog accepts `http://`, `https://`, and `mailto:` URLs, matching server validation.
