# HCD reference editor and core service

This example runs a self-hosted Tiptap/Yjs editor against the `hcd/2` core API. DOCX, HTML, Markdown, and TXT use the semantic editor. PDF and PPTX use the fixed-layout, window-loaded viewer. XLSX uses the Univer adapter. A write token can edit mapped workbook cells and mapped PDF or PPTX text runs; those saves are `hcd-patch/1` `text.splice` operations stamped with the signed-in user. Other open windows receive saved revisions through `/v1/documents/{id}/events/ws`, an authenticated native API WebSocket that does not occupy an HTTP/1.1 request slot. Formula cells stay locked. PDF text with an available verified source is rebuilt and rerendered through the same path used by native export, retaining source color, page rotation and background. Without the source, text uses an explicitly approximate raster/overlay fallback. Imported Word tracked changes can be accepted or rejected from the revision panel, and a reply can be appended to an imported comment region. Those decisions rewrite HCD and reject source-backed export. HCD revisions are immutable. Text changes inside unchanged runs, including text inside read-only tables, headers, footers, footnotes, endnotes, and other opaque blocks, create source-anchored text patches. Color and highlight changes create `hcd-patch/2` `node.style` operations. Structural changes and cleared colors create `hcd-patch/4` checkpoints. Checkpoints record the signed-in user, or every collaborator who typed since the previous save when the sidecar writes the snapshot. Mapped images can be replaced from the Insert tab or the fixed-layout viewer. Fixed-layout/section replacements stage a resource into workspace-owned drafts and commit with pending text and geometry in one `/edits` transaction; the image inspector Save button saves the full pending set. Uploads block save/close/export, and receipts validate both actual resource identity and geometry before clearing any draft. These modes journal scoped per-window snapshots and exact pending attempts; unknown outcomes query an immutable receipt before the same request may be resent. The editor does not write browser HTML into a bundle. Source-backed export rejects presentation styles and Office image replacements before writing. PDF image edits rebuild the selected source placement and rerender the affected page before publishing the revision; native PDF export replays the same edits.

## Local run

Build `officecli` from the repository root, then use three terminals with the **same** `HCD_TOKEN_SECRET` value (at least 32 bytes). The core API, collaboration sidecar, and Vite UI bind to loopback by default.

```bash
cargo build -p officecli
mkdir -p /tmp/hcd-editor-demo/sources
target/debug/officecli hdoc import examples/word/numbering-showcase.docx \
  --output /tmp/hcd-editor-demo/demo-docx.hcd --document-id demo-docx
cp examples/word/numbering-showcase.docx /tmp/hcd-editor-demo/sources/demo-docx.docx
HCD_TOKEN_SECRET='replace-with-the-same-private-random-secret-32-bytes' \
  target/debug/officecli hdoc serve --root /tmp/hcd-editor-demo --bind 127.0.0.1:8766
```

```bash
(cd examples/hdoc/xlsx-univer-viewer && npm ci)
cd examples/hdoc/editor
npm ci
HCD_TOKEN_SECRET='replace-with-the-same-private-random-secret-32-bytes' npm run sidecar
```

```bash
cd examples/hdoc/editor
npm run dev -- --port 8767
```

Issue a document-scoped token and open `http://127.0.0.1:8767/`:

```bash
HCD_TOKEN_SECRET='replace-with-the-same-private-random-secret-32-bytes' target/debug/officecli hdoc issue-token \
  --document-id demo-docx --scope write --user-id editor-1 --display-name 'Editor 1'
```

Use `--scope read` for a read-only session. The service rejects its checkpoint and patch requests with HTTP 403, and the sidecar marks its WebSocket connection read-only. Tokens expire after at most one hour. Keep the signing secret outside the repository.

The built-in app uses the Vite proxy for `/v1`. Products can import `EmbeddedHcdEditor` from `@officecli/hcd-reference-editor/react` and pass an API base URL, collaboration WebSocket URL, document ID, and token. Each editor keeps one ProseMirror document and one Yjs document; offscreen blocks use CSS `content-visibility` and fixed-layout assets load by viewport.

## Local draft recovery

The full semantic editor journals Yjs updates to IndexedDB before connecting a recovered draft to a collaboration provider. Cache identity includes service endpoints, document, user and collaboration epoch, never the bearer token. A separate local status reports transaction completion or failure; it does not imply a canonical server save. Current-epoch pending drafts require an explicit comparison/recovery choice. Recovery refetches current authenticated server state and merges CRDT content while preserving server-owned receipt/schema authority. Older epochs and retained branches remain downloadable, never automatically joined to a new room.

Each update is bounded to 8 MiB and a journal to 64 MiB / 100000 records. Compaction merges every tab's stored updates in one transaction. Storage errors preserve existing records and offer retry or explicit operation without local backup. Backups conservatively remain on disk; safe retention cleanup is pending. `.hcd-draft` is a recovery artifact containing CRDT and image references, not a self-contained Office file or offline resource archive. Authentication/server access is still needed to reopen the application. Fixed-layout and section modes use the separate snapshot journal described below. Workbook mode does not yet have equivalent protection.

The local regression closed/reopened a real browser page, restored pending text/image/geometry over a newer collaborator revision, saved and reread actual DOCX media and dimensions. Renderer/OS crash, storage eviction and production operation are unverified. See [evidence](../../../docs/assets/hcd-workbench-2026-10-23/word-local-draft-browser-evidence.json).

### Fixed-layout and section recovery

`FixedSaveController` persists an exact captured request before its first HTTP submission. Network failure or invalid response retains that identity and pins the captured drafts. Retry first calls `POST /edits/receipt` with the same patch. The server verifies the full canonical payload against immutable history and the authenticated author, returning `missing` or `committed`; display-name changes use the original recorded attribution. Receipt lookup is read-only and can be performed by the same author's read token. Only an authenticated writer may resend the original request. A confirmed request clears only its captured values; later input and later remote conflicts remain.

The fixed journal stores complete text/image snapshots and pending requests in IndexedDB. Its scope includes authenticated user, API/collaboration endpoints, document and immutable source hash. Fixed edits do not join semantic Yjs epochs, so ordinary section saves advancing a semantic epoch do not strand subsequent input. Every mounted window owns a different branch. Recovery forks a new branch; retained copies remain downloadable and are not automatically restored again. Dirty targets, including offscreen text, are refreshed from authenticated APIs. Source hashes accompany downloaded `hcd-fixed-recovery/1` `.hcd-draft` files; tokens, preview URLs and credentials do not.

A full snapshot is limited to 8 MiB; at most 64 nonempty branches and 64 MiB of loaded copies are accepted. Empty acknowledged state removes only its owner's branch. There is no automatic cleanup of other windows or retained copies. A failed complete snapshot preserves the previous durable copy; a later complete successful snapshot may restore local backup health. A new request is not submitted when its configured journal cannot record it. Storage failures offer a backup retry or explicit continuation without device backup, both at startup and during editing. The warning and draft download remain visible; memory-only mode does not promise recovery after the page closes. Server-confirmed saves remain valid if persisting the local acknowledgement fails; the old disk attempt resolves to the same immutable receipt on reopen.

Cold startup still requires server authentication and the current source identity. Uploaded resources remain in the authenticated server resource store; the journal contains hashes, not all image payloads. An upload interrupted before staging completes must be selected again. Real local browser verification covered response loss after commit, later input, full-page close/reopen, receipt resolution without a new revision, retained unsubmitted image drafts, backup download and actual PPTX export. Renderer/OS crash, storage eviction, production deployment and equivalent workbook recovery remain unverified. See [browser evidence](../../../docs/assets/hcd-workbench-2026-10-23/fixed-recovery-browser-evidence.json).

## Extensibility and editor AI design

The current embed API does not expose arbitrary extensions, custom menus or AI providers. Basic selection and context menus are built in; the semantic snapshot codec rejects unknown node types. [The design analysis](../../../docs/design/hcd-editor-extensions-and-ai.zh.md) specifies a shared command registry, Notion-style interaction, versioned custom content, per-format conversion policies and provider-independent AI suggestions. [The delivery plan](../../../docs/design/hcd-editor-delivery-plan.zh.md) adds task gates, server-backed default person mentions, reference indexing and future reminder contracts. Those APIs and interactions remain planned, not shipped; reminder delivery is out of scope.

## Editor language

The UI defaults to English (`en-US`). Open the standalone editor with `?locale=zh-CN` (or `?lang=zh-CN`) to set the initial locale. Its language selector is available on the login page, in the semantic editor's Settings panel, and in fixed-layout/workbook previews; a manual choice is saved in browser storage. Supported locales are `en-US`, `en-GB`, `zh-CN`, `zh-TW`, and `zh-HK`. The corresponding regional date formatting and Univer workbook locale follow the selected value. Source document content is never translated.

For an embedded editor, pass `locale="zh-CN"` and optionally `onLocaleChange={setLocale}` to synchronize the host's language selector. The embedded editor defaults to `en-US` when the prop is omitted and does not write a browser-wide preference. Its locale selector remains available inside the editor.

## Storage and save flow

- `hdoc import` defaults to `hcd/2`, gzip text objects, and PDF `auto` raster selection. `hdoc stats BUNDLE` reports compressed categories, revision growth, and unreferenced objects. `hdoc validate BUNDLE` verifies content and revision roots.
- The first semantic room initialization creates an editor projection at revision 1. Browser edits sync through Hocuspocus rooms named `<documentId>:<epoch>:typography2:save4`. One room coordinator serializes manual and automatic checkpoints (30 seconds idle / 60 seconds continuous activity). The browser sends a digest/request ID, not a full HTTP snapshot. Save, close and export require an acknowledgement covering the current content; a newer canonical head alone cannot authorize an older draft.
- The coordinator pins a signed base revision/root and persists the CRDT before committing. Only signed commits in that same lineage may advance a persisted base during restart recovery. Checkpoint IDs include an exact snapshot identity and full HMAC; replay returns the original saved revision/projection even if head has advanced. Captured CRDT block handles receive canonical IDs, so a replacement at the same array index cannot inherit an unrelated ID. Newer edits and contributors remain pending.
- Full `/checkpoints` and current `/collaboration/state` writes require service coordinator protocol 4; old browsers and sidecars receive 426. Binary persistence also requires `X-HCD-Coordinator-Version: 4` and `X-HCD-State-Hash: <previous hash|none>`; GET returns `x-hcd-state-hash`. A competing stale owner receives 412, retains a recovery copy and stops canonical saving. Publish API, sidecar and browser updates together. Fixed presence rooms are unchanged.
- Invisible source marks retain canonical text identities through typing, adjacent equal-style runs, partial font-size changes and code blocks. Inherited and explicitly selected sizes are distinct. Paste removes foreign source IDs, inheriting the insertion source only for inline paste. The server checks block membership and source ordering; native DOCX text/size edits use source patches rather than a whole-block rebuild. Other formatting or structural edits can still require rebuilding. Signed version-1, version-2 and version-3 receipts migrate against their verified immutable base; ambiguous pending text retains a recovery copy rather than guessing its source. Internal identity reconciliation does not mark visible content as edited.
- Restore and external edits can advance a collaboration epoch. Local binary files are stored per epoch; the legacy unversioned filename migrates on first access. Reset archives the previous binary and never loads it as the next generation. PostgreSQL resets archive and advance the epoch in one transaction. Clients retain the old CRDT and show a conflict instead of silently replacing a pending draft. Historical HCD revisions remain readable.
- Conflict recovery can download a `.hcd-draft` CRDT backup, inspect the latest saved text, and preserve a local HTTP recovery copy before explicitly opening the latest room. This path also works when the stale WebSocket/sidecar is unavailable. **Revisions → Draft recovery copies** lists the latest 50 server copies. `GET/POST /collaboration/recovery` and `GET /collaboration/recovery/{id}` use the document's read/write authorization; old-epoch recovery cannot alter the current room or canonical body. The backup references document assets rather than packaging them, and selective merge/import is not implemented. Automatic browser-disk offline recovery remains open; edits can be lost if every copy terminates before persistence finishes.
- The export control defaults to source-backed mode for the original format and shows the exporter's fidelity level. This needs the immutable source in `ROOT/sources/<documentId>.<format>`. Text edits that keep the original run topology can be written back to the source; structural or formatting edits require semantic rebuild, which can change DOCX pagination and layout. Source-free PDF export embeds the current page rasters when every visual edit has been composited; it rejects the raster shortcut for unpainted text/image overlays or presentation styles, and it does not recreate selectable text or vector objects.
- PPTX and PDF share a compact workbench: slide/page thumbnails, one fitted canvas, a context-sensitive properties panel, and a zoom/status bar. Click text to edit the selected object; click an image to inspect replacement and geometry controls. Save and Export live in the ribbon. Pane dividers support pointer dragging and arrow keys. Workbook cells save from the Univer grid. Fixed/section workspaces save pending mapped text and image geometry together through `POST /v1/documents/{id}/edits` (`hcd-patch/3`, only `text.splice` and `image.geometry`). The complete batch must pass revision and original nodeHash/visualHash preconditions; an image conflict cannot partially commit the text. The text-only `/text` endpoint remains available.
- Fixed/section image position drafts live at workspace scope across image/page/panel changes. Close, export, mode changes, layout upgrades and browser navigation check both text and image drafts, including saves in flight. Remote image conflicts preserve local dimensions and offer an explicit choice; removed images retain copyable/discardable drafts. Dirty images refresh individually through `GET /images/{nodeId}` rather than loading all document images. Drafts are in memory and do not survive refresh or process termination. Full Word mode now shares image position/size intents in the Yjs document and submits them with the complete semantic checkpoint. Save, close, mode changes and export require an acknowledgement covering both. Image replacement still uses its separate write path and remains to be integrated.
- Server checkpoint transactions now accept optional `images: [{ nodeId, geometry, assetHash?, precondition: { visualHash } }]`. Supplying `assetHash` atomically promotes a previously staged or already indexed image together with body and geometry; staging itself does not advance the canonical revision. Source text/size, presentation style, semantic block edits and mapped image geometry can commit as one revision; image-only changes are supported. The signed attempt binds both exact bodies, and replay returns images from the saved immutable revision. `hcd-patch/4` also accepts `image.geometry` and `image.replace` within semantic block batches; the latter accepts optional geometry under the same original visual precondition. Asset bytes are checked before commit, and revision-specific indexes preserve historical images. The full Word UI and sidecar submit these combined geometry and replacement intents through save protocol 4. Insert → Image properties opens a scrollable inspector rather than placing detailed controls inside the compact ribbon. Independent intent IDs retain concurrent values; disjoint fields merge, overlapping values require an explicit choice. Before rebasing a late offline intent, the coordinator reads its original and current immutable images. Signed pre-commit attempt metadata restores captured block identities and image acknowledgements after a lost response. Full Word replacement uploads bind their baseline before the asynchronous request, then register a shared asset intent without a separate canonical write. Pending uploads block save/export/close and opening the latest room; later unseen edits remain independent. Identical resource choices can merge, while differing choices retain explicit candidates. Candidate previews load on demand through document-scoped authenticated asset or staging reads, with abort and object-URL cleanup. Staging descriptors pin upload resources against bundle GC, including drafts not yet indexed by a revision. Upload publication uses the bundle write lock; malformed pin metadata prevents destructive GC. Pins are currently retained conservatively; lease/cancel cleanup remains open. Geometry and resource identities are both checked before acknowledging a captured save. Fixed and section workspaces still use the legacy replacement write. Browser-disk offline recovery and image undo/redo also remain open. Reproduce the backend contract with `python3 scripts/hcd-word-image-transaction.py` after building the binary.
- Image replacement and legacy single-image geometry requests now require `{ expectedRevision, expectedVisualHash, ... }`. A missing visual precondition returns 428, a stale image returns 409, and a read-only token returns 403. Update clients with the API. Source-backed PPTX export still rejects edited images; semantic rebuild exports current geometry but does not guarantee all original layout, masters or animations.

## Optional PostgreSQL and S3 durability

Set `HCD_DATABASE_URL`, `HCD_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` before `hdoc serve`. Set `HCD_S3_ENDPOINT` for a compatible private store. This mode uploads immutable HCD objects and the external source before a PostgreSQL compare-and-swap advances the document head; on startup it hydrates the local cache. It is designed for one collaboration sidecar instance. Configure network isolation, TLS termination, and backups in the host deployment.

## Reproducible checks

```bash
npm --prefix examples/hdoc/editor test
cargo test -p hcd-core
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
(cd examples/hdoc/xlsx-univer-viewer && npm ci)
(cd examples/hdoc/editor && npm run build)
```

The semantic checkpoint model preserves code blocks (including language and line breaks), underline, strike, inline code, hard breaks, blockquotes, nested lists, ordered-list starts, and horizontal rules. Those structural changes use semantic rebuild exports. The HTML remains the authoritative body; JSON tree metadata does not contain another stored text copy. Unknown editor nodes fail explicitly instead of silently disappearing from a snapshot.

Fixed-layout text drafts live outside viewport-mounted pages. They survive page unloading, locale changes, and remote revisions for the lifetime of the mounted workspace. Conflicting remote text is shown alongside the preserved draft; choose **Use remote text** or **Keep my draft** before saving. Export and the editor's Close action require saved drafts. Browser navigation warns about pending drafts. A browser crash/reload that proceeds past that warning does not recover unsaved drafts from disk; offline recovery is a later collaboration milestone.

In the browser, insert, delete, and reorder paragraphs, save, view an older revision, restore it, and confirm the editor reconnects. Open two write sessions with different `--user-id` values to verify live sync and presence. Repeat with a read token to verify editing is disabled. Use a 100-page DOCX to check end-to-end input, scrolling, and memory; use a large PDF to check window loading and rotated pages.

For rich-text acceptance, select paragraph text, apply an `https://` link from the toolbar, undo and redo it, and save. Export HTML and confirm the link and text survive. Right-click the same selection, choose **Copy selection** (or **复制选中内容** in Simplified Chinese), and verify the clipboard contains the complete selected text. The link dialog accepts `http://`, `https://`, and `mailto:` URLs, matching server validation.

Markdown documents with quotes, fenced code, tables, or other unsupported structure keep those regions as blocks whose structure cannot be inserted, deleted, or restyled as paragraphs. Text inside those blocks remains editable and is saved as a source text patch. Ordinary headings, paragraphs, and lists remain fully editable in the same document.

## Compact workbench and long documents

Word, PPTX, and PDF share compact navigation, ribbon actions, pane styling, and status bars. Save and Export are in the ribbon, not the title bar. Fixed-layout properties follow the selected object; full Word exposes text properties and a dedicated image inspector. Text object browsing is separate from the one selected text field. Original fixed-layout font information is informational; it does not offer unsupported font editing.

Semantic documents with at least four HCD chunks open in section mode. This mode fetches only the selected chunk and keeps a bounded cache of visited chunks. The section list does not fetch document bodies. Text changes preserve original formatting and use node hashes and revision checks; drafts survive section switches. **View → Full formatting tools** loads the complete collaborative Word model for structural and rich-text edits. **View → Edit in sections** returns after saving. Full formatting mode still loads the complete document; it is not a paged Yjs model.

The sidecar supports presence-only rooms named `fixed:<documentId>:0`. These rooms authenticate through the document API and reject document updates; they only relay awareness. Saved text/image changes travel through the revision APIs and the native API WebSocket. People can see each other's selections, while same-node text conflicts require an explicit choice. This is save-based cooperation for fixed/section modes, not character-by-character CRDT merging. Word full mode continues to use its existing Yjs document room.

Local acceptance covers two PPT users, cross-slide drafts and conflicts, ribbon saving/export guards, mouse/keyboard pane resizing, a 640px read-only embed, PDF text hit regions, PPT image geometry, and a 2,000-paragraph/125-chunk document. Its initial body request was chunk 0; subsequent body requests followed selected sections, without a full editor projection. See `docs/hcd-optimization-progress.zh.md` at the repository root for current limitations, especially inline image streams, complex clipping, fonts and collaboration reliability. New PDF imports map cropped, rotated text/image hitboxes into the editor viewport. Quarter turns, negative and over-360° rotations, image background recovery and transparent replacement have pixel-based local regression coverage.


Legacy PDF bundles expose **View → Update PDF layout**. The operation appends a `layoutUpgrade` revision and preserves canonical text, image resources, annotations, source maps and earlier revisions. Save text and apply picture positions first. Read-only tokens cannot submit the operation. The API uses `GET/POST /v1/documents/{id}/pdf/layout`; POST accepts `{ expectedRevision }`. A changed head rejects the upgrade rather than overwriting another save.

The equivalent CLI is `officecli hdoc upgrade-pdf-layout BUNDLE --source IMMUTABLE_PDF --expected-revision N --json`. The source hash must match. Historical revisions retain their original objects and remain exportable. This requires the updated reader that understands presentation-only layout revisions; it does not change the semantic content or turn the revision into a structural edit.


### Revision connections and reconnects

Forward WebSocket upgrades for `/v1/documents/{id}/events/ws` to the Rust API (the Vite `/v1` proxy already does this). This endpoint works without the optional presence sidecar. Over HTTPS it uses WSS. The first frame is `{"type":"auth","token":"<short-lived-token>","afterRevision":4,"nodeIds":["n_..."]}`; credentials never appear in the URL. Read and write document tokens may subscribe, and the server closes expired sessions. A later `{"type":"track","nodeIds":["n_..."]}` updates the set of pending text drafts without sending their contents.

The hub carries only revision wakeups. Notifications are reconstructed from immutable history and one captured manifest, with a two-second head check covering local CLI edits and dropped notifications. Remote mode uses the PostgreSQL committed head and verifies its root before sending, so an unpublished local candidate is not announced. This is still the existing single-instance remote model; it does not add multi-instance cache hydration.

Reconnects carry the last delivered revision. Up to 256 missed revisions are coalesced into current node text; merged events have no single patch ID. Larger gaps, structural changes, layout upgrades, or oversized text return `reset: true`; consumers reload indexes while retaining drafts. Frames include `nodeHashes` for tracked nodes even when text is omitted, and `null` identifies a removed object. Text payloads are bounded to 1 MiB, tracking to 10,000 IDs. The fixed editor checks drafts even for equal-revision snapshots, blocks unresolved/stale saves, and allows copying/discarding a removed object's local text. Drafts remain in memory only; closing or reloading the page is not offline persistence.

`GET /v1/documents/{id}/events` remains available for SSE clients. Its `id` is the document revision; `Last-Event-ID` or `?afterRevision=N` requests history-based catchup, including after broadcast lag. New browser editors use WebSockets to avoid same-origin SSE connection exhaustion across tabs.


### Font fallback foundation

The source-free PDF repaint path uses the static bundled Noto Sans SC and monochrome Noto Emoji faces. It selects complete grapheme clusters and shapes them with Rustybuzz. Missing glyphs, multiple lines, unsupported paragraph direction, excessive work, or text that does not fit its rectangle leave the complete canonical text in the explicit overlay path; that page cannot use the bitmap-only export shortcut. The properties panel flags approximate overlays. Semantic export may repaginate; the multiline regression checks both lines in the actual exported PDF.

Known repaint dependencies are stored in `data-hcd-raster-font-ids` as `sha256:<font-file-hash>#<face-index>` and reported by `PDF_RASTER_FALLBACK_FONTS`. Repainting an existing bitmap conservatively retains its known dependencies. Native source rendering leaves the field empty, and this metadata is not a full document font inventory. Forced PDF font embedding reuses only a matching source font identity with sufficient character coverage; custom files retain their actual PostScript name.

Font/size editing, browser/export font resolution, complete font packaging, native PDF complex-script/emoji support and font management remain separate work. See [the font and internationalization design](../../../docs/design/hcd-fonts-i18n.zh.md).

Embedded subsets assign distinct CIDs to Unicode scalars even when they share one glyph, using an explicit CIDToGIDMap. Ligature ToUnicode sequences are not inverted into independent letters. Simple font codes remain one byte, supported composite codes two bytes; out-of-range values fail rather than truncate. These rules preserve text roundtrips without claiming native complex-script shaping is complete.

### Authored typography and schema compatibility

The semantic model carries optional `Inline.typography` (`family`, `sizePt`, `latin`, `eastAsia`, `bidi`). These are authored font requests, not resolved font-file identities. The Word inspector reads the selected font/size, including mixed selections; font-size editing supports 1–1638 pt in half-point increments. Font-family selection is still pending. Font metadata survives the Tiptap/Yjs codec and structural HCD checkpoints, including code text. The bounded core CSS resolver rejects unsupported font expressions rather than erasing them.

New semantic rooms use `documentId:epoch:typography2:save4`. Update the sidecar and browser together, then reload old semantic pages. Fixed-layout room names are unchanged. `/checkpoints` requests send `typographyVersion: 2`; documents with authored typography reject missing versions with HTTP 426, and unknown versions are rejected. Empty-font documents retain compatibility with older API snapshots. The collaboration state endpoint remains binary Yjs. On load, unversioned Yjs text is enriched only when it matches canonical text; the migration adds marks to existing CRDT items and keeps identities. Ambiguous pending text is retained and migration fails without overwriting the stored state; a user-facing recovery flow is still pending.

Source-backed DOCX export retains font styles for text-only saves. Semantic DOCX uses typed native runs for sizes and Latin / EastAsia / BiDi font names, including mixed runs and table-cell ranges. This does not preserve every original style, physical layout, font file, or advanced typographic feature.

Font metadata protocol 2 enriches the earlier protocol-1 Yjs marks with script font slots while retaining pending size changes and CRDT item identities. New DOCX imports store language slots in bounded `-hcd-font-*` stylesheet metadata. Older API documents can recover this metadata from a SHA-256-verified companion original under `sources/`; the API caches at most 16 documents / 16 MiB of derived CSS. This lookup does not change the HCD revision or historical stylesheet. Semantic CLI export of an older bundle can use `--typography-source original.docx` to supply the verified metadata without replaying source content.

`GET /v1/documents/{id}/export-options?revision=N` reports `sourceAvailable`, `sourceEditsSupported` and stable reason codes. DOCX export switches to current-content reconstruction when the revision cannot preserve source layout. The final export checks the saved revision again. Source-backed export still performs source-hash/package validation.

The full editor stays locked until collaboration bootstrap succeeds. A disconnected/unsynced writer cannot submit a whole-document checkpoint. A manual save acknowledgement covering an older snapshot leaves newer edits pending and prevents that close/export attempt. This is not a completed unified coordinator for manual saves, sidecar autosaves and all external canonical edits; legacy ambiguous pending text still needs a recovery flow.

### Fixed/section joint image save regression

```sh
cargo build -p officecli
python3 scripts/hcd-fixed-image-transaction.py
```

The regression creates isolated DOCX, PPTX and PDF fixtures and a temporary loopback API. It requires `pypdf` for independent PDF validation. Each case checks failed-batch rollback, a single text/replacement/geometry revision, actual exported content and media, later replacement and immutable replay. Office output follows the active blip relationship and dimensions; PDF output checks selectable text, the active image XObject and its transform. DOCX/PPTX exports here are semantic reconstruction; this does not prove native source image rewrite or exact original Office layout. No production documents or services are modified.


### Fixed/section selective history

The fixed editor shares one session-local action stack across text, image replacements and geometry. Save preserves the stack; receipts, remote updates and recovery are not user actions. Undo reads the authenticated current object and stages a field-specific inverse; Save publishes it through the ordinary CAS/receipt path. Geometry inverses do not redundantly replace an unchanged resource. This normalization applies to newly created inverse drafts, not to captured pending requests whose immutable bodies must replay exactly. It preserves unrelated peer fields. Same-field divergence and deletion retain the action and leave content untouched; an explicit skip removes only the reviewed history action. Uploads and unresolved save attempts block history operations. Input arriving during an asynchronous lookup invalidates that lookup.

`Mod+Z`, `Mod+Shift+Z` and Windows `Ctrl+Y` share the ribbon behavior; composition and search input keep their own handling. Explicit draft discard/conflict resolution clears that target's older history. The bounded stack is in memory and does not survive refresh; pending inverse drafts and exact save attempts remain locally backed up. Saved undo currently needs a live object lookup.

Fixed backup state version 3 preserves authored image fields, field conflicts and `restoreSource`, and reads ordinary version 1/2 backups. `image.restoreSource` is an additional patch/3 and patch/5 operation for original source-only PDF placements: it removes the replacement override while retaining current geometry and the original source XObject. It cannot share a target with `image.replace`; non-PDF and unverifiable sources are rejected. Update the API with the editor. Old API rejection must leave the whole draft pending rather than omit the source restore.

```sh
cargo build -p officecli
python3 scripts/hcd-fixed-history.py
```

The wrapper requires installed editor dependencies and pypdf, uses temporary local fixtures/API and independent Office media/geometry and native PDF content/XObject/CTM checks. Full Word's Yjs text/image unified history, active ACL revocation and cross-session history remain separate work.


### Ordinary image field collaboration

Fixed/section image drafts now merge committed peer changes per X/Y/width/height/resource. Only diverging authored fields become conflicts. Choosing remote values replaces those conflicting fields, retaining independent local edits; choosing local values preserves unrelated peer fields. The fixed text editor remains object-level, not character-level CRDT collaboration.

Upload-only targets participate in authoritative refreshes. Completed uploads use the latest geometry; intervening resource edits and deletions remain explicit conflicts. Snapshot/receipt acknowledgement retains newer input, later peer fields and explicit reversions, including a peer revert after an own commit that was not observed before its receipt. Captured unknown requests are immutable. Metadata caches are bounded and exclude preview bytes; active targets remain protected.

The existing `python3 scripts/hcd-fixed-history.py` wrapper now additionally drives `hcd-fixed-field-merge.mts` through two real authenticated identities and verifies r10/r12 exports independently. DOCX checks content/resource/dimensions; PPTX and native PDF also check positions. DOCX floating X/Y fidelity remains unsupported. Conflict choices currently clear the target's older session history; safe undo of a choice remains part of the unified-history work.
