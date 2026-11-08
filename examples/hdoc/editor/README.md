# HCD reference editor and core service

Layout-aware regional Word `/2` now exposes reviewed page setup from the normal Layout ribbon. Exact requests survive tab refresh; unknown outcomes retain their identity, and process cache loss can be checked against signed native receipts. Unprepared cancellation is durably sealed. See [page transactions and acceptance boundaries](../../../docs/design/hcd-word-page-transactions.zh.md). The regional flags remain opt-in; page-field undo, normal story structure operations and automatic legacy migration remain open.

This example runs a self-hosted Tiptap/Yjs editor against the `hcd/2` core API. DOCX, HTML, Markdown, and TXT use the semantic editor. PDF and PPTX use the fixed-layout, window-loaded viewer. XLSX uses the Univer adapter. A write token can edit mapped workbook cells and mapped PDF or PPTX text runs; the reference editor journals its `hcd-patch/3` `/edits` transactions and resolves immutable receipts before retrying. The standalone workbook adapter retains its `hcd-patch/1` event contract. Saves are stamped with the signed-in user. Other open windows receive saved revisions through `/v1/documents/{id}/events/ws`, an authenticated native API WebSocket that does not occupy an HTTP/1.1 request slot. Formula cells stay locked. PDF text with an available verified source is rebuilt and rerendered through the same path used by native export, retaining source color, page rotation and background. Without the source, text uses an explicitly approximate raster/overlay fallback. Imported Word tracked changes can be accepted or rejected from the revision panel, and a reply can be appended to an imported comment region. Those decisions rewrite HCD and reject source-backed export. HCD revisions are immutable. Text changes inside unchanged runs, including text inside read-only tables, headers, footers, footnotes, endnotes, and other opaque blocks, create source-anchored text patches. Color and highlight changes create `hcd-patch/2` `node.style` operations. Structural changes and cleared colors create `hcd-patch/4` checkpoints. Checkpoints record the signed-in user, or every collaborator who typed since the previous save when the sidecar writes the snapshot. Mapped images can be replaced from the Insert tab or the fixed-layout viewer. Fixed-layout/section replacements stage a resource into workspace-owned drafts and commit with pending text and geometry in one `/edits` transaction; the image inspector Save button saves the full pending set. Uploads block save/close/export, and receipts validate both actual resource identity and geometry before clearing any draft. These modes journal scoped per-window snapshots and exact pending attempts; unknown outcomes query an immutable receipt before the same request may be resent. The editor does not write browser HTML into a bundle. Source-backed export rejects presentation styles and Office image replacements before writing. PDF image edits rebuild the selected source placement and rerender the affected page before publishing the revision; native PDF export replays the same edits.

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

Each update is bounded to 8 MiB and a journal to 64 MiB / 100000 records. Compaction merges every tab's stored updates in one transaction. Storage errors preserve existing records and offer retry or explicit operation without local backup. Backups conservatively remain on disk; safe retention cleanup is pending. `.hcd-draft` is a recovery artifact containing CRDT and image references, not a self-contained Office file or offline resource archive. Authentication/server access is still needed to reopen the application. Fixed-layout and section modes use the separate snapshot journal described below. Mapped workbook-cell edits now use the same fixed snapshot journal, explicit recovery and immutable edit receipts; see [workbook save and recovery](../../../docs/design/hcd-workbook-save-recovery.zh.md). Formula/structural editing and unfinished in-cell buffer crash recovery remain open.

The local regression closed/reopened a real browser page, restored pending text/image/geometry over a newer collaborator revision, saved and reread actual DOCX media and dimensions. Renderer/OS crash, storage eviction and production operation are unverified. See [evidence](../../../docs/assets/hcd-workbench-2026-10-23/word-local-draft-browser-evidence.json).

### Fixed-layout and section recovery

`FixedSaveController` persists an exact captured request before its first HTTP submission. Network failure or invalid response retains that identity and pins the captured drafts. Retry first calls `POST /edits/receipt` with the same patch. The server verifies the full canonical payload against immutable history and the authenticated author, returning `missing` or `committed`; display-name changes use the original recorded attribution. Receipt lookup is read-only and can be performed by the same author's read token. Only an authenticated writer may resend the original request. A confirmed request clears only its captured values; later input and later remote conflicts remain.

The fixed journal stores complete text/image snapshots and pending requests in IndexedDB. Its scope includes authenticated user, API/collaboration endpoints, document and immutable source hash. Fixed edits do not join semantic Yjs epochs, so ordinary section saves advancing a semantic epoch do not strand subsequent input. Every mounted window owns a different branch. Recovery forks a new branch; retained copies remain downloadable and are not automatically restored again. Dirty targets, including offscreen text, are refreshed from authenticated APIs. Source hashes accompany downloaded `hcd-fixed-recovery/1` `.hcd-draft` files; tokens, preview URLs and credentials do not.

A full snapshot is limited to 8 MiB; at most 64 nonempty branches and 64 MiB of loaded copies are accepted. Empty acknowledged state removes only its owner's branch. There is no automatic cleanup of other windows or retained copies. A failed complete snapshot preserves the previous durable copy; a later complete successful snapshot may restore local backup health. A new request is not submitted when its configured journal cannot record it. Storage failures offer a backup retry or explicit continuation without device backup, both at startup and during editing. The warning and draft download remain visible; memory-only mode does not promise recovery after the page closes. Server-confirmed saves remain valid if persisting the local acknowledgement fails; the old disk attempt resolves to the same immutable receipt on reopen.

Cold startup still requires server authentication and the current source identity. Uploaded resources remain in the authenticated server resource store; the journal contains hashes, not all image payloads. An upload interrupted before staging completes must be selected again. Real local browser verification covered response loss after commit, later input, full-page close/reopen, receipt resolution without a new revision, retained unsubmitted image drafts, backup download and actual PPTX export. Renderer/OS crash, storage eviction, production deployment and equivalent workbook recovery remain unverified. See [browser evidence](../../../docs/assets/hcd-workbench-2026-10-23/fixed-recovery-browser-evidence.json).

## Extensibility and editor AI design

The embedding API now accepts `commandExtensions` for Word and the fixed-layout/section editor. Word's Home/Insert ribbon, context menu, selection bubble and searchable palette consume the same per-instance registry. PPT/PDF/Word sections route Save, Export, Undo/Redo, the palette and host literal-text commands through format adapters. Property panels, view/revision controls and export parameter forms still use their existing specialized paths. XLSX has not been migrated.

Use stable configuration identities (for example `useMemo`) and explicit command IDs. This example inserts plain text through the checked built-in adapter; it does not insert HTML or a custom schema:

```tsx
import type { CommandExtensions } from '@officecli/hcd-reference-editor/react'
const commandExtensions: CommandExtensions = {
  commands: [{
    id: 'business.approval',
    label: { 'zh-CN': '插入审批标记', 'en-US': 'Insert approval token' },
    icon: '✓', group: 'extensions', order: 10,
    profiles: ['flow', 'fixed'],
    surfaces: ['ribbon', 'context', 'bubble', 'palette', 'slash'],
    shortcuts: ['Mod+Alt+J'],
    canExecute: context => context.selection.kind === 'text'
      && !!context.actions['text.insert']?.enabled,
    execute: ({ commands }) => commands.run('text.insert', { text: '待审批' }),
  }],
  menuOverrides: { palette: { order: ['business.approval', 'file.save'] } },
  keymap: { 'editor.palette': ['Mod+Shift+P'] },
  onReady: service => {
    // Optional dynamic registration: retain and call its returned unregister.
    // A subscription cleanup can also be returned here.
    return service.subscribe(() => { /* refresh a host-owned command surface */ })
  },
  onError: error => { /* show/log a host-appropriate message */ },
}
// <EmbeddedHcdEditor {...documentSession} commandExtensions={commandExtensions} />
```

`onReady` exposes `register`, `subscribe`, `list`, `execute`, `context` and `capabilities`. Registration is atomic; IDs, dependencies and platform/profile shortcut collisions are checked. Unregistering a dependency disables its consumers. Host configuration arrays are copied; changing them outside React does not bypass validation. Hidden menu items remain executable when authorized; visibility is not permission. Predicates receive a frozen, bounded context, never an editor/DOM/Y.Doc handle. This is a trusted same-process host API, not a sandbox for untrusted JavaScript plugins.

Write access is the default. `access: 'read'` is for nonmutating host actions; nested `commands.run` still checks the target's current authority. Async commands should honor `signal` and call `commands.run` after awaiting work. A changed document/selection or revoked permission rejects that nested edit. Current semantic anchors conservatively invalidate on newer semantic content, including unrelated peer edits. `text.insert` accepts `{text: string}` (1–1,000,000 characters), literal newlines and text only; fixed mode edits the current text object's inspector range. Text commands stop history capture on both sides, joining existing save/collaboration/export paths. File commands rely on their save/receipt controller state, so a missing page preview cannot itself prevent an allowed immutable-receipt retry.

`Mod` follows the platform. Composition/229/AltGraph events are ignored; editor shortcuts leave search, URL and property fields alone. `shortcutScope: 'workspace'` also applies in form fields (built-in Save and palette use this). Invalid host configuration reports `onError`, displays a warning and falls back to built-ins. Unmount cancels registry work and host subscriptions. The semantic connection and undo manager are effect-owned; React StrictMode render/effect replay cannot leave a destroyed connection or shared undo manager behind.

`capabilities()` reports version `hcd-commands/1`; structural Word reports `mentions: person`, and reports `customNodes: atomic-v1` when host atom definitions are loaded in structural Word; non-person candidate sources and AI remain reserved. The full semantic Word editor now renders a `/` insertion menu from this registry; block handles and multi-block interaction are connected for the structural Word adapter. Fixed-layout text inspectors and XLSX do not render the flow slash menu. Host inline/block atoms use `nodeExtensions`; arbitrary Tiptap schema extensions, custom candidate-source registration, reminder sending and AI providers are not accepted by these props. Built-in people lookup uses the authenticated native API. Unknown business nodes survive inside validated `hcd.extension/1` or `hcd.extension/2` envelopes, with protected atoms or rich children; unknown envelope models and arbitrary unmodeled content remain rejected. The [E1 preservation contract](../../../docs/design/hcd-extension-nodes.zh.md), [design analysis](../../../docs/design/hcd-editor-extensions-and-ai.zh.md) and [delivery plan](../../../docs/design/hcd-editor-delivery-plan.zh.md) specify the implemented boundaries and subsequent work. Management UI remains out of scope.

Validation: `npm test`, `npm run build` in this directory. From the repository root, run `python3 scripts/hcd-command-workbench.py` after building `target/debug/officecli`. It starts isolated local API/Hocuspocus/Vite services and prints the web port. Open `.hcd-commands-docx-writer.html`, `.hcd-commands-pptx-writer.html`, `.hcd-commands-pdf-writer.html` (and the `reader` variants) at that loopback port. Check the shared approval command, palette English search, selection/context surfaces, Mod+Alt+J, undo/redo, delayed command then caret movement, and direct read-only execution. Save and download each native format. `officecli view <downloaded-file> text` must contain the literal `<b>审批标记</b>` inserted by this fixture, with no `延迟内容`. The fixture's file names/revisions depend on the steps taken. Stop with Ctrl+C; private pages are removed and services stop. Evidence from the real browser and three independently read downloaded files is in [commands-file-evidence.json](../../../docs/assets/hcd-workbench-2026-10-23/commands-file-evidence.json). This is local fixture evidence, not production, all-format fidelity or full IME/device acceptance.


### Host atom SDK (`hcd-nodes/1`)

```tsx
import type {NodeExtensions} from '@officecli/hcd-reference-editor/react'
const nodeExtensions: NodeExtensions = {
  nodes: [{
    type: 'example.task', version: 1, display: 'inline' as const,
    label: { 'en-US': 'Task badge', 'zh-CN': '任务标记' },
    defaultData: { title: 'Review', done: false },
    validate: data => typeof data.title === 'string' && typeof data.done === 'boolean',
    fallback: data => `${data.done ? '☑' : '☐'} ${data.title}`,
    properties: [
      { key: 'title', label: 'Title', kind: 'text' as const, required: true, maxLength: 120 },
      { key: 'done', label: 'Completed', kind: 'boolean' as const, required: true },
    ],
  }],
  onReady: nodes => { /* nodes.register([...]) returns an unregister cleanup */ },
  onError: error => { /* report a configuration/view error */ },
}
// <EmbeddedHcdEditor {...documentSession} nodeExtensions={nodeExtensions} />
```

Each valid definition automatically registers `node.insert.<type>` in the command surfaces, including `/`, the palette, ribbon and block insertion menus. Those wrappers call the shared `node.insert` command; hosts can also call it with `{type, data?}`. Structural Word accepts inline and block atoms. Property controls support text, number and boolean fields; applying them calls `node.update` with `{instanceId, expected, data}`. `expected` is the full previous envelope, and only the selected known atom can change. Host callbacks can read the selected envelope from the frozen `context.selection.extension` and its ID from `context.selection.nodeId`, then invoke the same update command; nested business data is frozen too. Stale forms preserve their input and require reload. `node.delete` uses the same identity/precondition checks; `node.properties` opens the right inspector. Commands use the existing history, Yjs and canonical save path. They do not expose the Tiptap editor, DOM or Y.Doc to host command callbacks.

`mountView(element, {node, locale, readOnly})` optionally paints a trusted host DOM view and returns cleanup; it is called again on payload/locale/access/registration changes, with cleanup before replacement. The frozen payload cannot be used to mutate the document. Render errors fall back to persisted text and report `onError`. Use `textContent` for untrusted business text. Views and callbacks are not stored in `.hcd` or Office files. Definitions are trusted same-process code, not sandboxed downloaded plugins.

Registration is atomic and limited to 64 definitions, 32 properties per definition; generated command IDs constrain host type names to 116 characters. Definitions/configuration are copied. `validate` and `fallback` are synchronous, side-effect-free business functions; fallback must be deterministic and locale-independent. Locale changes affect labels/views, not persisted text. A definition recognizes exactly its declared type/version/display and recomputed fallback. Missing, unregistered, invalid or newer business schemas use the protected E1 reader. Read access remains authoritative even with a codec loaded. Native services validate the inert common envelope; a host business validator does not grant server authority or validate external business operations.

`NodeExtensionService.capabilities()` reports `migrations: 'explicit-v1'`, `resources: 'archive-v1'`, `exportAdapters: 'portable-v1'` and `containers: 'blocks-v1'`. Inline atoms, archived resources and collaborative rich block containers use persisted per-format snapshots for server/offline exports; custom marks and long-lived history compaction remain pending. See the [resource and rich-content contract](../../../docs/design/hcd-node-resources-and-rich-content.zh.md). Field conflicts now use retained intents; see the contract below. The concrete bundled example is in [fixtures/nodeSdk.ts](fixtures/nodeSdk.ts). Run `python3 scripts/hcd-mention-preview.py --extension-nodes --node-sdk --pages-prefix .hcd-sdk-docx` from the repo root for isolated writer/peer/reader pages; the reader deliberately omits host codecs. The [E1/E2 contract](../../../docs/design/hcd-extension-nodes.zh.md) tracks verification and remaining work.

Known inline atoms now participate in checked paragraph duplication, movement and paragraph/heading/list/quote conversion. Duplication assigns a new occurrence ID while retaining portable metadata/resources; movement and style conversion preserve the old ID. Code blocks reject these atoms. Current codec lookup is repeated at commit, so unload and unknown enclosing containers remain protected. Known whole business blocks and rich containers now also support checked copy/move/delete, including fresh nested node/reference identities for copies and retained IDs for moves/undo. Unknown descendants remain barriers; incompatible structural conversions, arbitrary marks and editable inline containers remain separate work. See the [block-operation contract and actual export evidence](../../../docs/design/hcd-inline-node-block-operations.zh.md).

The [whole-container contract](../../../docs/design/hcd-business-block-operations.zh.md) covers real nested copy, offline move/delete/undo, resource/reference preservation and actual offline files. Structural view projection now verifies the fitted result equals the authoritative tree, with a closed replacement fallback for open-slice fitter mismatches. It never rewrites shared carriers. Menus count sibling targets and Shift selection stays in one parent scope. Creation/copy undo after peer edits and full deletion arbitration still need their own recovery review.

### Explicit business schema migrations

Definitions may add `migrations: [{fromVersion: 1, validate: data => typeof data.title === 'string', migrate: ({title, ...data}) => ({...data, caption: title})}]` when the current definition is version 2 and validates `caption`. Each step advances one version. Callbacks receive deeply frozen JSON and must be synchronous, deterministic and free of side effects. The registry validates every bounded common envelope and the final business schema/fallback; a missing path, invalid result or changed identity never updates the node.

`NodeExtensionService.previewMigration(node)` returns frozen `{before, after, versions}` without editing. The inspector shows a preview and optional data changes; explicit apply calls `node.migrate` with `{instanceId, expected: before, after}`. This uses one ordinary history/collaboration/save transaction and rechecks the exact original, selection, access and registration. Loading or rendering never auto-migrates. An invalidated preview must be reloaded; cancel leaves the document intact. Missing codecs keep their original protected payload and readable fallback.

Cross-version conflicts retain complete envelopes rather than merging old and new field names. `node.resolve` selects an existing candidate by its intent ID; choosing an old candidate permits a later explicit migration with that candidate's data. See the [migration contract, deployment boundary and evidence](../../../docs/design/hcd-node-migrations.zh.md), and [fixtures/nodeMigrations.ts](fixtures/nodeMigrations.ts). Run `python3 scripts/hcd-mention-preview.py --extension-nodes --node-migrations --runtime-dir target/hcd-preview-runtime --pages-prefix .hcd-node-migrate` for an owned isolated sample. The migration command currently targets structural flow atoms; fixed PPT/PDF objects, arbitrary custom marks and complex business layouts need separate work.

### Retained property edits and wire compatibility

Concurrent top-level data fields merge; different values for the same field remain candidates. The coordinator blocks a canonical checkpoint until conflicts are explicitly resolved and a compatible host has materialized readable fallback text for the exact intent set. It executes no arbitrary host validator. Nested objects are atomic fields. Own undo removes only the local intent, and undoing a resolution restores the conflict.

`context.selection.nodeEdits` is a frozen `{ids, conflicts, ready}` snapshot. A host action may call `node.resolve` with `{instanceId, ids, choices}`; `choices` maps each disputed field to a candidate intent ID. Changed intent sets reject stale choices. The built-in inspector uses the same path. `NodeExtensionService.capabilities()` reports `collaboration: 'fields-v2'`. Ordinary `node.update` is disabled while the selected node is disputed. Schema transitions use the reserved `\0envelope` conflict key and complete candidate selection; they cannot mix fields across schema versions.

Compatible flow connections acknowledge `hcdNodeEdits=5` in their WebSocket URL. Negotiation and save state require `nodeEditVersion: 5`; v5 adds deleted-subtree review receipts, while v4 reference retarget intents remain readable. Native persistence uses `X-HCD-Node-Edits-Version: 5` and retains a monotonically increasing durable model requirement across epoch changes. Once v5 is required, missing/v1/v2/v3/v4/unknown shared reads, writes and checkpoints return 426. Upgrade the editor, sidecar and native service together and refresh older writable windows. The structural protocol remains `hcd-semantic-blocks/3`, coordinator version remains 4, canonical reference payload remains `hcd.mention/1` and portable envelope remains 2; these are separate declarations. Canonical file reads/exports stay separate from the shared draft model. Clients using this embedded package handle these declarations automatically. See the [deletion review contract and actual compatibility fences](../../../docs/design/hcd-deletion-conflict-review.zh.md).

### Person retargeting and reference conflicts

`reference.keepSaved({mentionId, ids, revision})` offers a separate recovery choice for the saved value shown in the conflict panel. It fetches that immutable reference snapshot between two authenticated head checks, rechecks current authority/codec/lifetime/candidate identities after each await, then records one undoable resolution. It never accepts a caller-supplied target as evidence of canonical content, nor substitutes the old conflict root. Native checkpoint CAS and permissions remain authoritative. A deleted canonical occurrence has no value choice in this action. See [saved-value recovery and actual disabled-person/export evidence](../../../docs/design/hcd-reference-saved-recovery.zh.md).

The document references panel offers an authenticated, searchable person picker. `reference.retarget` accepts `{expected, candidate}` and rechecks the exact occurrence/old value, editability and enclosing container codecs. Person target and display snapshot change atomically with the original `mentionId`; reserved reference kinds remain protected. Concurrent retargets retain complete candidates instead of duplicating the inline atom. The panel resolves through `reference.resolve({mentionId, ids, candidateId})`, rejecting stale candidate sets. Undoing a resolution reopens the conflict; unrelated peer text remains. Both client save/export decisions and the coordinator check live business draft metadata, because a conflict placeholder can have the same body digest as a previously saved document. Current canonical reads, events, saved names and offline exports are verified separately. See the [contract, reproduction and evidence](../../../docs/design/hcd-reference-retarget-conflicts.zh.md). Reminder delivery and the management platform remain deferred.

Retained records are currently bounded (128 per node, 2048 per document, plus JSON/native/transport budgets). Limit rejection preserves the old node and ordinary text editing; automatic history compaction, deletion-versus-update arbitration and production capacity remain pending. [Detailed behavior, evidence and remaining work](../../../docs/design/hcd-node-property-conflicts.zh.md).

### Slash insertion and conversion boundaries

In a legal paragraph/heading text position, `/` at the start or after whitespace opens grouped commands; Chinese/English labels and aliases filter the list. URLs, marked code/link text, code blocks, nonempty selections, protected content and read-only sessions do not trigger it. Arrow keys/Enter choose, Escape preserves all typed text, and Tab dismisses without taking over normal navigation. The popup keeps editor focus, clips to the canvas/viewport and follows scroll/zoom. The editor exposes a localized multiline textbox name and active-option relationship. Composition/229/AltGraph checks have automated coverage; native OS/device IME acceptance remains separate.

For this menu, `commands.run` stages **one** supported content transaction. The outer host callback must finish without throwing or returning `false` before it commits. A late permission/selection/content change or unloading an intermediate command rejects the staged write. Ordinary UI metadata updates do not invalidate identical content, selection and stored marks. Staging multiple writes is rejected without partial insertion. Host code must not treat a staged result as already-visible document content; combine future richer insertions through versioned content adapters, not raw editor mutation. Built-in slash leaves are `text.insert`, paragraph, level-2 heading, bullet/ordered list, quote, code block and divider. Unsupported leaves preserve the trigger. One successful commit is one undo boundary; undo restores the trigger and its original block type.

These seven default block kinds use existing canonical codecs. Export behavior is format-dependent:

| Content | DOCX semantic rebuild | Markdown | PDF |
|---|---|---|---|
| Paragraph / heading | Paragraph / named heading style | Paragraph / heading syntax | Static readable text and layout |
| Bullet / ordered list | Native numbering definitions, depth, starts/restarts and unnumbered continuation paragraphs | Nested list syntax and explicit line breaks; list tree reimport verified | Static nested list presentation |
| Quote | Declared `Quote` paragraph style; nested depth flattened | `>` on every line; nested depth flattened | Static readable text |
| Code | Monospaced paragraph text | Fenced code; longer fences when content contains backticks | Static code presentation |
| Divider | Line characters | `---` | Static line presentation |
| Host literal text | Readable literal text | Escaped Markdown/HTML punctuation | Readable literal text |

The native conversion path now retains `<blockquote><p>…</p></blockquote>` paragraphs, declares the DOCX Quote style and validates its use. Markdown escaping prevents literal `<b>…</b>` from turning into HTML, and code fences cannot close on embedded backticks. Markdown reimport preserves the literal text and quote preview; code/quote initially remain protected source blocks rather than a claim of arbitrary editable roundtrip nodes. No custom node codec, person directory/reference service, AI provider or reminder delivery is introduced here.

Reproduce with `python3 scripts/hcd-command-workbench.py --slash`. Open `.hcd-slash-docx-writer.html` at the printed port. Test `/标题`, one undo/redo, `/approval`, `/失败` (fixture callback stages then throws), Escape, code/list/quote/divider/paragraph insertion, Save and DOCX/MD/PDF downloads. Check Word styles and list markers in the DOCX ZIP, `>`/escaped literal text/code fences in MD and `officecli view <pdf> text`; [file evidence](../../../docs/assets/hcd-workbench-2026-10-23/slash-file-evidence.json) records actual r9 downloads. The same fixture's PPT writer/reader pages verify StrictMode presence: both show two users, closing one returns to one. Block `+`/handles, drag/batch operations, full nesting/type conversion, `@`, custom nodes and AI continue in the subsequent phases.

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
- Conflict recovery can download a `.hcd-draft` CRDT backup, inspect the latest saved text, and preserve a local HTTP recovery copy before explicitly opening the latest room. This path also works when the stale WebSocket/sidecar is unavailable. **Revisions → Draft recovery copies** lists the latest 50 server copies. `GET/POST /collaboration/recovery` and `GET /collaboration/recovery/{id}` use the document's read/write authorization; old-epoch recovery cannot alter the current room or canonical body. The backup references document assets rather than packaging them, and selective merge/import is not implemented. Browser-disk journals now review same-epoch copies before connecting and retain older copies for download. Cross-protocol semantic restoration and upload handoff remain pending; recovery requires a completed local or server write.
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

The online-members control opens the right **Live collaboration** panel in Word, PPTX and PDF. Fixed-layout members show their page, vertical scroll progress and selected text/image; content snippets are resolved from the currently loaded canonical page, with an object-type fallback elsewhere. **Locate** brings the selected object into view once. **Follow** tracks the member's page and normalized horizontal/vertical scroll without selecting their object or editing the document. Local pointer/touch/wheel/keyboard input stops following; disconnects, departed targets and follow cycles also stop it. Read-only members may follow without gaining write access. Unindexed destinations remain unavailable until the page index loads; older peers without a viewport show a pending position. Multiple windows retain a connection-specific follow target.

For isolated two-page PPT/PDF checks, run `python3 scripts/hcd-command-workbench.py --follow` from the repository root (build `officecli` first), then open the printed web port with `.hcd-follow-pptx-writer.html` and `.hcd-follow-pptx-peer.html` (or the corresponding `pdf` pages). Start Follow, navigate the peer to page 2, zoom both PDF windows to 100% and scroll. Confirm proportional scrolling at different canvas heights, local input cancellation, named object borders, cycle prevention and read-only follow. Follow/selection awareness must not create a canonical revision. These checks use disposable identities and bundles; no production credentials are printed.


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


### Live document access policy (local single-process adapter)

`GET/POST /v1/documents/{id}/access` requires a separate document-scoped `manage` token with a stable subject. A manage token cannot read or edit content; read/write tokens cannot manage membership. Issue this token only to the trusted host policy controller, never to the editor. This is a host API, not an administration UI.

The POST body is `{"expectedGeneration":0,"readers":null,"writers":["alice"]}`. Both membership fields must be explicit: null retains token-based access, an empty list denies every user in that role. Effective write access also requires read membership. IDs are bounded, unique stable subjects. A stale generation returns 409. Restrictive transitions preserve recovery data and advance the collaboration epoch before acknowledging the new policy; grants do not revive old rooms. Existing in-flight HTTP mutations finish before the transition can acknowledge. The local policy file uses compare-and-swap and durable replacement; remote storage mode returns 501 until a shared atomic policy/epoch adapter is supplied.

Sidecar packets revalidate the caller before applying updates; idle connections are also checked every two seconds, with bounded HTTP timeouts. Old epochs cannot publish canonical checkpoints or the current room state. Read revocation closes revision streams. Clients latch write loss, stop collaboration retries and keep device drafts; a fresh authenticated opening is required after a grant. Pending fixed-layout saves can query an immutable receipt while still permitted to read, but cannot replay missing writes. Downloaded recovery files are drafts, not exported Office documents or self-contained asset packages. A revoked editor may close once its device backup flush succeeds.

Run `python3 scripts/hcd-access-revocation.py` after building `target/debug/officecli`. It starts isolated native API and Hocuspocus processes, validates authority and queued updates, writes credential-free evidence, then stops both services. This is local runtime evidence, not distributed or production acceptance.


### Full Word chronological undo/redo

The current window now combines local CRDT body actions with image geometry, replacement and candidate choices. Toolbar, editor commands, context actions and keyboard shortcuts share the same timeline. Body undo retains peer text; image inverses read the authenticated current image, preserve unrelated peer fields and publish through normal protocol 4 saving. Same-field changes retain the history entry for review or explicit skipping. No raw undo manager covers the shared image maps. Source identity repairs after undo/remote synchronization are excluded from user history without excluding ordinary typed input.

History is session-local and does not survive refresh. Local CRDT/draft recovery is separate. Image inverses require network access; fixed/section candidate-choice history remains pending. Run `python3 scripts/hcd-semantic-history.py` for two actual Hocuspocus peers plus nine independently checked DOCX exports; the browser replacement and keyboard evidence is recorded in the Chinese progress document.


### Fixed/section conflict-decision history

Text and image conflict choices now join the same session timeline. Undoing an uncommitted decision restores the unresolved local/remote draft; Save remains blocked. Once an exact request receipt confirms an active keep-local decision, undo creates a field-specific inverse through normal saving. Disjoint current fields are preserved. Superseded decisions cannot borrow a newer commit, and a late receipt cannot acknowledge later input.

Consecutive undo/redo across a later saved edit and interleaved targets retains validated inverse state rather than requiring a Save after each step. Redo checks the authority observed by the previous transition; newer overlapping peer values retain a conflict or reject the stale decision. Explicit discard still clears that target history. Recovery state remains version 3 and contains drafts, not the window's undo stack or decision replay metadata.

Run `python3 scripts/hcd-fixed-choice-history.py` for real native DOCX/PPTX/PDF transactions and nine independently checked files. DOCX position is not claimed as floating-layout support. Separate real-browser PPT evidence covers saved choices, restored conflicts, rejected stale redo, downloaded PPTX and the recovery file. Management UI and reminder delivery are not part of this work.


### Word block controls (first supported scope)

Full semantic Word now exposes a compact block `+` and draggable handle. The same command registry supplies conversion, duplicate, delete, up/down and destination moves; `Mod+/` opens the current block menu. Text selections across root blocks operate as one group. Shift-clicking handles extends a previously anchored range. Before/after insertion uses the registered slash actions and never replaces the reference block. A menu search box provides arrow/Enter/Escape navigation and non-drag destination selection.

Every operation prepares one checked document transaction against root boundaries and a content fingerprint. Permission, selection, source document and registered command ancestry are checked again before commit. Escape, outside close, source changes and teardown cancel staged async work. Source/format metadata-only UI changes do not create content actions. A local block clone receives fresh temporary block IDs, drops source identities and preserves visible typography; movement preserves IDs. Enter splitting also receives a new ID, including mid-paragraph splits. Remote synchronization does not independently allocate random repair IDs. Canonical save receipts replace temporary IDs through the existing path.

Duplication, deletion and movement retain nested structure. Conversion supports ordinary text blocks, flat one-paragraph list items and quotes containing text blocks. Converting a group to a quote/code block merges identities by retaining its first owner; conversion back does not resurrect removed identities. A divider conversion requires one empty block. Protected objects and crossing them are rejected. These are top-level root operations; arbitrary nested rearrangement, table/section boundary edits and drag autoscroll remain pending. Simultaneous peer structural moves/typing on the same block have not been verified; preserving logical IDs alone is not a claim that the Yjs physical node survives a move. Word block commands do not apply directly to PPT/PDF object canvases.

Reproduce with `python3 scripts/hcd-command-workbench.py --slash` after the native build. It supplies isolated writer/peer/reader pages for DOCX/PPTX/PDF. For Word: enter several paragraphs, select two, open `Mod+/`, duplicate and undo once; convert a block to a heading; use `+` to add a rule; move by destination or handle drag and undo. Open the peer page, edit while a menu is open and check that stale actions close. Run `/延迟`, Enter then Escape; the trigger must remain and `延迟内容` must not appear. Save, reload and export actual DOCX/MD/PDF. Browser/file evidence is linked from the Chinese progress document. This is local verification, not deployed or production concurrency acceptance. Mentions/custom-node/AI capabilities remain explicitly reserved.


### Structural collaboration migration in progress

The active `default`-fragment binding loses input when one replica moves a root while another offline replica edits that root. Earlier sequential browser/export checks do not cover this case. **The default App now negotiates the structural room and uses the permanent-carrier binding. The legacy comparison remains reproducible; complex structures and cross-epoch offline recovery still need acceptance.**

The opt-in v3 replacement in `semanticBlockStore.ts` separates permanent graph/text nodes from parent/order references, visibility and canonical owner tokens. Quotes and flat lists can wrap/unwrap existing paragraphs without recreating text. Source receipts target captured owners and text carriers, retire absorbed native IDs, and preserve edits arriving during a save. Unknown schema data/cycles fail projection without deleting raw CRDT bytes. Existing legacy/default or prototype-v1/v2 data refuses local initialization; this is not a distributed migration lease.

`SemanticStructureIdentity`, the PM binding, relative selections and `SemanticStructureCollaboration` are explicit opt-in modules. The Awareness caret plugin publishes focused relative selections, decorates ranges/carets and filters invalid positions without changing document state. These paths have headless tests, not DOM/IME or live-browser visual acceptance. The new `semanticTextFlow.ts` uses the original carriers as its only body storage: joins connect flows, splits add private boundaries, and selections follow physical carrier positions. Paragraph joins, Enter splits, multi-paragraph code conversion, cross-paragraph replacement and open-slice paste have concurrent-input tests. Boundaries never enter the projected document. Late text after an empty paragraph became a non-text node is preserved as a projection conflict; its recovery UI remains pending. Complex nested/mixed transitions still require further coverage. Unknown-node read-only fallback and the public node SDK are also pending.

Run `npm test` and `npm run build` in this directory (333 tests and both builds passed). From the repository root, `scripts/hcd-structural-concurrency.mts` generates the installed-binding comparison; `python3 scripts/hcd-structural-save.py` tests real native saves and independently reads eighteen actual DOCX/Markdown/PDF exports. It covers moves/offline input, undo/redo, quote wrapping, unwrapping during an in-flight save, concurrent late text, canonical receipts, code joins/undo, paragraph join/split and persisted-state restart. A separate eight-seed, three-replica split/join schedule checks that every inserted character survives exactly once after shuffled/duplicated updates. It uses headless PM views and in-process Yjs replicas, without Hocuspocus migration or production claims.

Before default activation: complete remaining nested/mixed ownership and conflict recovery, real DOM/IME/caret checks, default-page protocol selection, old-device recovery/upload handoff and joint image/text history, then real dual-session reconnect/save/export verification. See the [detailed structural repair design](../../../docs/design/hcd-semantic-structure.zh.md). Server-backed mentions, the custom-node SDK and AI remain in the delivery scope; management UI and reminder delivery remain deferred.


### Native collaboration protocol publication

The native API now persists `collaborationProtocol` alongside the epoch and advertises it in `/auth`. Structural epochs require `X-HCD-Collaboration-Protocol: hcd-semantic-blocks/3`; old epochs and missing/wrong protocols cannot persist state or submit canonical checkpoints. The service `/project` write is also fenced after migration. `POST /collaboration/migrate` is restricted to the trusted save service and compares the captured epoch, state hash and canonical revision before publishing a converted state. Its durable migration ID supports exact retries without overwriting later input; old bytes are archived and unpublished files cannot be adopted by a later reset. See the [full contract](../../../docs/design/hcd-collaboration-protocol.zh.md).

118 native unit tests, the native build, strict Clippy and formatting checks passed. The structural-save probe now begins with a clean persisted legacy Yjs projection, migrates through real HTTP, verifies exact recovery bytes and protocol rejection on state/checkpoint/project, then checks late retries, restart and eighteen actual exports. PostgreSQL code compiles but has no live-database acceptance in this phase. The sidecar now exposes explicit protocol negotiation and handles packet draining, bound dirty bodies/image alternatives and durable unknown-outcome retries. The default App calls negotiation after device-draft review and a no-edit handoff. Old writable windows must attest readiness; unreviewed private work blocks migration. Cross-epoch semantic recovery and physical IME acceptance remain required.


### Sidecar migration driver and default UI handoff

POST `/v1/documents/{id}/collaboration/negotiate` on the sidecar HTTP port with the caller's document Bearer token. The request contains no document payload; the sidecar validates access and uses the trusted core service to migrate its frozen room. It returns the active epoch/protocol. A packet barrier spans async auth through message application, rejects new work while draining, and pauses autosave. Pending bodies and image alternatives are converted from the actual CRDT, not replaced with the canonical projection. A signed contributor ledger binds pending content to authenticated authors across restart. Unknown/unbound content is archived and rejected for automatic publication.

`HCD_SIDECAR_STATE_DIR` selects private migration storage (default `~/.officecli/hcd-sidecar`). The journal persists exact IDs and source/target bytes before the core call; uncertain results keep the old room frozen and reuse that job after restart. It is a single-process sidecar journal, not a distributed lease. New rooms use `id:epoch:structure3:save4`; old rooms retain `id:epoch:typography2:save4`. Incremental shadow guards reject mixed default/structural body payloads before application.

`python3 scripts/hcd-sidecar-migration.py` checks actual native HTTP and Hocuspocus peers, held packet auth, concurrent negotiation, a lost migration reply and sidecar restart, dirty body/image conflict preservation, split/offline typing, and an already-committed canonical save with a lost response. Seven exported files are independently read back, including committed own typing/undo/redo. `python3 scripts/hcd-semantic-history.py` separately rechecks nine legacy DOCX history exports. All 344 frontend/service tests and both builds passed. These probes use headless PM views, without browser, IME or remote database acceptance. See the [protocol contract and remaining gates](../../../docs/design/hcd-collaboration-protocol.zh.md). Node SDK, @people and AI remain in scope; administration and reminder delivery remain deferred.


### Collaboration activity and view locations

The default Word page renders remote names, selection ranges and an active-block highlight. `content-visibility` stays enabled for other blocks but not the block containing a remote caret, so its absolute name label is not cropped. `hcdStructureViewport` Awareness carries a bounded relative anchor and scroll fraction, batched at 150 ms. The position rail never scrolls the local document until the user explicitly follows a member; wheel/touch/pointer/typing/navigation stops following. Invalid or skipped layout falls back to progress; follow cycles are rejected. Presence never enters Yjs document content, revisions or exports. PPT/PDF viewport/object adapters remain pending.

Run `python3 scripts/hcd-command-workbench.py --activity` for two named, 60-paragraph browser fixtures (Alice/Bob). Actual default browser and two downloaded DOCX readbacks are recorded in `docs/assets/hcd-workbench-2026-10-23/default-structure-browser-evidence.json`. The full sidecar probe also verifies source metadata repair survives an own redo after earlier commits without adding another undo action. Historical main-document viewing, diff and safer restore confirmation are currently being implemented; the old sidebar preview is not acceptance of those new flows.

The header online button now opens a right-side Live collaboration panel. Locate/follow/stop controls and locally resolved active-block excerpts live there; the document rail only shows passive member markers. The real 60-paragraph activity fixture stayed at canonical r1 throughout these presence-only interactions. The complete test count is 344.


#### Revision review and coordinated local restore

The default semantic Word editor now opens historical source content in the main document area, pins diff endpoints, and exports the selected immutable revision. Restoring uses an in-app confirmation and the sidecar's `/collaboration/restore/N`, never the old direct restore path for structural rooms. Every writable window must finish its local handoff; pending uploads/unknown clients or a newer snapshot prevent publication. A durable sidecar request and native pending intent reconcile a lost response or crash without repeating the head/epoch transition. Keep the sidecar state directory across restarts.

Validation: `python3 scripts/hcd-revision-restore.py` starts isolated native/sidecar services, exercises real socket peers and a lost native success reply, restarts the sidecar, then reads back seven DOCX/PDF exports. `python3 scripts/hcd-command-workbench.py --restore` starts separate browser fixtures; open the printed loopback origin with `.hcd-restore-docx-{writer,peer}.html`. Browser proof covers cancel, r0→r3 and r2→r4 restoration, both clients editing r4, Bob's new saved r5, and downloaded DOCX readback. See the revision-restore evidence files under `docs/assets/hcd-workbench-2026-10-23/`.

This transaction is for a single local native API and sidecar. Remote storage does not advertise `coordinatedRestore`; a shared restore transaction/lease adapter and PPT/PDF version-panel parity remain pending. Body normalization no longer creates a view-only trailing paragraph after protected source content: the visible append button uses `block.appendParagraph`. Its `allowProtectedSelection` declaration only permits an action outside the selection; read-only/history/action checks still apply.


#### Default people mentions and durable authors (D1/D2 local implementation)

The native server offers `/mention-options`, `/references/resolve` and immutable `/references?revision=N`. A bounded, server-owned `people/{documentId}.json` file is the first `PeopleDirectory` adapter; no directory editor/admin UI or online-presence directory is created. Search and resolution honor document/person visibility, signed scoped cursors and active status. New targets require current authority; an existing saved reference does not depend on the directory remaining online.

The built-in `hcdMention` atom decodes `hcd.mention/1`, preserves target and occurrence identity, provides readable leaf text, and assigns a new occurrence on copy/paste. Native snapshots require `referenceVersion:1`; all reference transitions additionally require coordinator-bound `referenceAuthors`, included in the exact attempt signature. A synchronous server Yjs listener records the authenticated author of each addition/retarget/removal before another transaction can change the projection. The signed ledger binds the exact observation, document, epoch, lineage and canonical base; absence/tampering cannot borrow another contributor. Immutable revisions retain per-occurrence authors for relationship events. Structural Word now supplies the default @ menu and reports `mentions: person`; fixed-layout and sheet adapters keep it reserved. Existing reference-bearing documents can be read and saved without dropping identities. Do not derive authors from node attributes or a list of online peers.

Run `python3 scripts/hcd-people-references.py` after building the binary. It tests native HTTP authorization/homonyms/history, actual two-writer structural saves and per-occurrence authors, denied-target isolation, committed deletion/own undo, a save with the people directory removed, three real exports and an offline copy of the native HCD directory. The test ZIP is a fixture transport, not a `pack` CLI implementation. Details and remaining acceptance are in `docs/design/hcd-people-and-references.zh.md`; no reminders are delivered.

The Notion-style people popup supports an empty/default query, async name search, scoped pagination, homonym details, keyboard choice, Escape, focus/selection revalidation and recoverable lookup failure. `reference.person` opens it via ribbon/context/palette; `reference.person.insert` rechecks the live trigger before a single atom transaction. Existing references keep snapshot labels offline. Current export UI states explicitly that readable names are retained while online relationships/reminders are not exported. Code/link conversion guards protect reference atoms.

For browser verification run `python3 scripts/hcd-mention-preview.py`, open its two printed localhost URLs and follow the r2–r5 sequence in `docs/assets/hcd-mentions-2026-10-24/mention-browser-evidence.json`; `python3 scripts/hcd-mention-preview-verify.py <temporary-root>/private.json` reads back those immutable versions, three exported files and an offline native bundle. The source preview uses Vite; this is not a deployed host/user-center/physical-IME/multi-instance acceptance. Reference profile/status UI, same-occurrence retarget conflicts, old-epoch offline recovery and E/F node/AI contracts remain pending. No management UI or reminder delivery was added.

### Export runtime limits

The native API permits at most two simultaneous subprocess exports. It returns
429 when both slots are occupied and 504 when a child exceeds its deadline;
timed-out children are killed/reaped and all their scratch files are cleaned.
`HCD_HTTP_EXPORT_TIMEOUT_SECONDS` defaults to 300 and accepts 1..3600 at server
startup. Subprocess diagnostics are drained with a 64 KiB retention cap.

The export UI offers **Stop waiting** and a 310-second client deadline. Neither
interrupts a save already started by `beforeExport`. An aborted client never
creates a late download or a false success message. This is not a server-side
cancellation receipt: the bounded server export may continue. A fresh explicit
export is a new request; no automatic export retries are made.

The development profile optimizes font parsing/shaping and ironpress while
leaving application code debuggable. `vendor/ironpress/OFFICECLI-PATCH.md`
describes the pinned emergency-wrap correction used for styled long text.


### Private AI suggestions

Pass `aiExtensions={{provider:createHttpAiProvider({url:'/api/editor-ai'})}}` to `EmbeddedHcdEditor`. Import the transport or framework-independent controller from `@officecli/hcd-reference-editor/ai`. The URL is a host-owned service, not a built-in Rust route; authenticate/authorize document access and own model credentials/quota/cancellation there. No model dependency or credential is bundled. `actions` optionally replaces the default rewrite/continue catalog; each id/label/mode/instruction maps automatically to `ai.action.<id>` in shared menus. `ai.open/request/accept/cancel/dismiss/locate` remain the common command layer.

Word supports plain text within one paragraph/heading, or within one available editable inline body after explicit inline-model negotiation, excluding protected atoms and code/link ranges. Streaming previews stay private in memory; only explicit acceptance enters the existing own undo, collaboration and canonical save path. Acceptance rechecks native authority, epoch/protocol, CRDT-relative target and source text/format. Unrelated peer edits map; changes to the original target invalidate the suggestion. Cancel/timeout/replacement ignores late chunks even for an uncooperative provider. Explicit suggestions have no default Tab/space binding. Optional automatic completion is implemented and default-off; nested-list and bubble-menu feedback loops are fixed, with device/remaining interaction acceptance still incomplete. Current AI capability is `private-text-v1`; PPT/PDF remain reserved pending format-specific adapters.

The host stream is `application/x-ndjson`: `{version:'hcd-ai/1',requestId,seq,type:'delta',text}` records followed by `done`, or a safe `error` code. Requests contain only allowlisted action/document/source/bounded-context data, with no HCD bearer token or CRDT position. The transport rejects redirects/cross-origin defaults, invalid UTF-8 and oversized streams; model-generation retries are explicit. `onAccepted` is an optional host callback, not a durable native AI provenance receipt.

Full contract and boundaries: [AI design](../../../docs/design/hcd-editor-ai.zh.md). `python3 scripts/hcd-mention-preview.py --ai --pages-prefix .hcd-ai-docx` from the repository root starts a disposable synthetic NDJSON fixture with writer/peer/reader pages; it never calls an external model. Supplementary instruction `慢速` makes cancellation observable. Real provider/deployment acceptance, native AI provenance and structured AI tools remain outstanding.

### Optional automatic completion (initial implementation)

Use `aiExtensions.autocomplete` to set `enabled` (default false), `delayMs` (900), `cooldownMs` (1500), `minPrefix` (8), `maxOutput` (256), and an optional instruction; set false to disable the capability. Local text input schedules private PM ghost text through the same provider/controller and strict caret adapter. Menus, host key bindings, list/table navigation and IME take priority over Tab acceptance. `ai.autocomplete.toggle/accept/dismiss` are common commands; `/ai` also exports the framework-independent scheduler/policy/key helpers. No completion is shared or exported until accepted.

`--autocomplete` on the synthetic preview enables this fixture. The nested-list identity loop and the unstable bubble-menu predicate have been fixed. A fresh isolated browser fixture passed continued nested input, Tab/Shift-Tab, peer editing during the ghost, accept/undo/redo, slash-menu priority, writable cache reopen and three-format text readback. Native DOCX nested numbering is now exported through real numbering definitions, with Markdown hierarchy/hard-break support; common DOCX heading/list and new HTML hierarchy imports are preserved, while advanced DOCX types, multi-paragraph DOCX reimport and resource/layout fidelity still have known gaps (see [list export contract](../../../docs/design/hcd-list-export.zh.md)); device/OS-focus/offscreen cases remain outstanding. See [E05 evidence and remaining acceptance](../../../docs/design/hcd-ai-autocomplete.zh.md); do not treat `ghost-text-v1` as production readiness.


### Native list export

Semantic DOCX export now emits `numbering.xml` and native `numPr/numId/ilvl` for nested lists, preserving starts/restarts and unnumbered continuation paragraphs. Markdown retains hierarchy and explicit line breaks; the existing CSS/PDF path receives transient containers for canonical standalone list items. Original HCD bytes remain unchanged. Own Word preview counters resume across nested numbering instances. [Validation and known import gaps](../../../docs/design/hcd-list-export.zh.md) cover actual DOCX reimport/reexport tree equality and source-backed edits. Common headings 1–6 and decimal/bullet hierarchy are preserved; advanced numbering/deep headings remain explicit read-only blocks. DOCX reimport restores explicitly declared unnumbered continuation ownership from newly exported files; unmarked third-party paragraphs are not grouped by guessing their indentation. Normal hard breaks survive fresh paragraph/heading imports.

Imported mixed lists also pass the source-identity/protocol handoff: bullet containers no longer receive an unsupported start attribute, and inferred nested item flags match the existing neutral snapshot representation. A fresh two-person CUA fixture saved r2, own undo r3 and redo r4 without structural rewrites; source-backed DOCX files retained other package parts and non-text document structure/run properties, and reopened as the saved trees. Old paragraph-only HCD history has not been semantically migrated. See the linked list contract for reproduction and remaining boundaries.

New HTML imports retain parent items with multiple paragraphs, mixed child lists, restarts, hard breaks, supported inline marks and original source byte anchors. Each root subtree is bounded and emitted separately; the source file itself is still read wholly within the existing 64 MiB limit. Compound table containers remain read-only. Explicit `data-hcd-html-tree` declarations prevent new parsing rules from silently reinterpreting old signed snapshots. Real two-person HTML r2/own-undo r3/redo r4 saves preserved peer text and source IDs; source-backed HTML changed only intended text bytes and reopened as the saved trees. Writable r4 reload and the right-side Online collaboration panel with names, activity and Follow passed. Use `--source-html` on the synthetic preview and `scripts/hcd-html-list-verify.py --browser-root ...` for the named fixture. Source-free semantic HTML export remains unsupported (`render-html` is an inspection route); PDF continuation indentation now uses the parent content edge/width; images/resources/CSS and complete cross-format fidelity remain outstanding.


Fresh DOCX paragraphs/headings declare `data-hcd-word-tree="1"` so normal `w:br`/`w:cr` breaks survive semantic projection, source-backed text editing and reimport without changing old unmarked HCD snapshots. The shared CSS/PDF renderer now carries each list item's content edge/width to subsequent block children, while fixed/absolute children retain their placement. The regression covers mixed nested continuations, a block container and long wrapping. 294 native tests plus build/clippy passed; actual file geometry and a full-page raster were checked. Newly exported DOCX files now carry bounded, ignorable ownership attributes so the common multi-paragraph list tree roundtrips; unmarked third-party ownership remains ambiguous. See the list contract; this batch does not certify page/column-break fidelity or repeat browser/physical Office acceptance.


DOCX list ownership uses the optional typed `RichParagraph.list_ownership` alongside ordinary `numPr` numbering. The `urn:officecli:semantic-lists:1` `list` attribute carries only version/item/depth/start-or-continuation, with local `mc:Ignorable` and `mc:PreserveAttributes`; no second text copy. Import resolves namespace URIs and validates native depth, unique start IDs and the currently open owner. Stale/invalid declarations produce `WORD_LIST_OWNERSHIP_IGNORED` and retain readable paragraphs. Actual HTML→HCD→DOCX→HCD trees/starts/breaks/text now match; complete formatting marks are not included in that comparison. A fresh two-person DOCX fixture passed continuation edits, r2/own-undo r3/redo r4 source-backed readback and writable reload/follow. Peer local-backup bootstrap failed and required the explicit continue entry; this remains a recovery investigation, not a successful local-backup acceptance. See the linked list contract and ownership evidence. External applications may strip optional metadata; physical Office/WPS save/reopen is still unverified.


### Device draft bootstrap and server errors

Startup now classifies disk operations separately from server state, access and protocol failures. A stale state read probes current authority once and refreshes the session only if epoch/protocol changed; it does not loop or offer a no-backup bypass for server failures. Cancelled generations cannot launch a provider or replace newer state. Loaded device candidates remain reviewable/downloadable if collaboration state is unavailable, with restore disabled until verified. Recovery previews retain hard breaks as plain text.

450 frontend tests and TypeScript/standalone/embed builds passed. Fresh two-person browser startup needed no backup bypass. In a controlled pause of an owned sidecar (native API remained online), the native snapshot lacked a marker present in the IndexedDB review; restore and subsequent peer editing reached r4. Actual source-backed DOCX changed only three intended text spans, retained source IDs/other parts/breaks and reopened as the saved tree. Earlier browser exceptions were discarded, so their exact cause is not retrospectively proven. Full offline startup, process/OS crash recovery and physical-browser storage denial/quota/blocking remain outside this acceptance. See [bootstrap contract and evidence](../../../docs/design/hcd-local-draft-bootstrap.zh.md).


### Saved-revision business export preflight

`GET /v1/documents/{id}/export-capabilities?revision=N` returns authenticated, non-cached `hcd-export-capabilities/1` declarations with `scope: business-nodes`. Current inline atoms, block atoms and references are counted with bounded readable samples. Office/PDF/Markdown/TXT conversion flattens them and omits business data; HTTP HTML retains embedded envelopes and explicitly discloses that data remains accessible. The native HCD snapshot retains payloads. This does not introduce a bundle download endpoint or promise whole-document conversion/layout support.

The toolbar checks the actual saved revision before requesting a file. New counts or changed support/retention update the notice and stop that attempt for review. Ordinary text/version changes do not cause repeated review. Unsupported source mode and failed saves prevent download; stopping download waiting leaves an in-progress save with its regular coordinator. Details use a keyboard-accessible native top-layer popover so the compact ribbon cannot clip them. The report is a generic envelope inventory: portable per-business adapters, resource archives and rich block containers are now implemented; custom marks and complex layout adapters remain pending, as described in the [contract and evidence](../../../docs/design/hcd-export-capabilities.zh.md).


### Native offline archives

The export format menu now includes **HCD offline archive** (`.hcdz`). It runs the normal save gate and downloads exactly that saved revision, its ancestors, business envelopes, rich subtrees and committed asset indexes/bytes. Historical review exports exclude newer revisions. Runtime collaboration state, ACLs, credentials, receipts and uncommitted staging are excluded; the original source file in the separate server `sources/` directory is not bundled. The selected version's complete history travels with the archive.

Use `officecli hdoc pack document.hcd --output saved.hcdz --revision N`, then `officecli hdoc unpack saved.hcdz --output new/document.hcd`. The package has a bounded `hcd-archive/1` inventory; unpack verifies all objects, historical roots and the current native model before publishing a new directory. Existing targets cannot be overwritten. This is a portable file transport; opening local archives directly in the browser and full offline startup remain pending. See the [contract, limits and verification](../../../docs/design/hcd-offline-archive.zh.md). Per-format business `exportAdapters` still cover the seven ordinary file formats; native archives preserve the canonical payload without a host adapter.


### Fixed-layout navigation beyond loaded indexes

PPT/PDF Online collaboration can now resolve a peer page outside the locally loaded prefix. A shared index loader fetches only the necessary metadata prefix; target bodies remain lazy. Continuations across an index boundary are completed before canvas/thumbnail loading. Own actions cancel the pending location without a later jump, and optional awareness revisions prevent cross-version locations. Cross-page activity reads only an authenticated canonical node; private unsaved fixed-layout drafts are never added to awareness. The follow status stays in the existing canvas bar, and fixed thumbnail slots avoid pointer-target shifts during loading. See the [contract and 130-page local evidence](../../../docs/design/hcd-fixed-lazy-collaboration.zh.md).


### Workspace view and revision commands (2026-10-25)

Word and fixed Word/PPT/PDF share panel, collaboration, navigation and zoom commands. Word also exposes revision viewing, normal save, local copies, return-to-current and restore-review commands. Hosts can compose these through `commandExtensions` and rebind shortcuts. Explicit panel visibility is idempotent; viewing never grants write access. `revision.restore.review` only opens the existing confirmation flow. See the [command/input contracts and local file evidence](../../../docs/design/hcd-workspace-commands.zh.md). XLSX, remaining property writes and child-local comparison controls are still open; source-free offline PDF export now retains existing canonical text as a searchable invisible layer over page images; see the [offline PDF contract and file evidence](../../../docs/design/hcd-pdf-searchable-offline.zh.md).


### PDF input and subset-font save (2026-10-25)

The bounded native decoder now preserves ASCII85 data digits, including `>`, before Flate decoding. Saving new covered Chinese/emoji glyphs resolves indirect/inherited font maps and adds page-local fallback resources while keeping original fonts and other pages. Unsupported glyphs fail without advancing the document version. Real CLI/HTTP, replay, inverse-patch and export evidence is in the [PDF input/font save report](../../../docs/design/hcd-pdf-input-and-font-save.zh.md).

Candidate text geometry and mixed-font runs are now committed with canonical text and page rasters under the same revision. Root/node hash checks reject stale plans. New readers validate the derived run partitions; legacy/source-free edits without a fresh candidate clear stale metadata and mark approximate layout. Hit targets, named collaboration highlights, font properties and source-free invisible text use the committed bounds. Actual Poppler word bounds and rotated replacements, plus read-only browser properties/cross-page follow, are verified locally. Incomplete font metrics, complex text matrices/shaping and unsaved rotated drafts still need broader coverage. See the [saved PDF layout contract](../../../docs/design/hcd-pdf-saved-text-layout.zh.md).


### Resource request lifetime and inline selection (2026-10-25)

`archiveResource({file, name, key, signal?})` now propagates cancellation to authenticated HTTP, enforces a 45-second request lifetime and rejects results from disposed/replaced sessions. Resource progress does not rebuild the unified command registry. The properties panel offers cancellation, retains unapplied form values after failures and clears the global pending warning when the gate releases. Native-accepted bytes remain staging until an expected-node resource command attaches them.

Structural selection bookmarks now retain occurrence IDs for inline business atoms and mentions, so peer typing preserves the selected node and properties view; deleted/ambiguous identities fall back safely. Local real-network browser evidence covers delayed native success followed by cancel, HTTP failure, actual timeout, close/export guards, peer rich-text input, retry and r9/r10 save/download. Historical DOCX and source-free HCD archive DOCX/PDF/Markdown readback passed. See the [contract, reproduction and remaining scope](../../../docs/design/hcd-resource-request-lifecycle.zh.md). This does not claim production, hot-reload migration or arbitrary custom-mark support.


### Structural undo review (2026-10-25)

Structural history previews its inverse on an isolated Yjs replica, including local redone links. Undoing creation/copying or redoing deletion cannot silently hide already received peer text, formatting, block types, business properties, references or new children. The review bar offers cancel or keep-content-and-skip; exact timeline/stack identity and permissions are rechecked. Source/canonical receipts are excluded, and ordinary typing does not clone the full document on every key.

546 frontend tests and both builds pass; actual authenticated sockets, browser review/cancel/retry/skip, peer reopen, browser DOCX and source-free HCD/DOCX/PPTX/PDF/MD readback are covered locally. This is local-window history protection, not distributed deletion arbitration or durable cross-device history. See the [contract, evidence and remaining work](../../../docs/design/hcd-structural-undo-review.zh.md). Management and reminder delivery remain deferred.


### History after codec unload (2026-10-25)

The semantic Word connection supplies `prepareExtensionHistoryGuard` to its undo manager. Every inverse queries the current node registry, including plain child typing and property history. Missing/incompatible codecs preserve the full occurrence/subtree and history; the matching codec can be loaded and the same action retried. Unrelated text remains undoable. Low-level stores may supply their own optional projection guard; raw Yjs is not a host codec/permission boundary. The public registration API is exercised by an owned `--node-history` preview control, which is not product UI.

558 frontend tests and both builds pass. Browser unload/reload/undo/redo and source-free exports are verified locally. One subsequent explicit peer-save probe returned native400 before a later retry saved r10; this remains an open reproduction and is not counted as clean-save acceptance. See the [contract and explicit evidence limits](../../../docs/design/hcd-extension-history-guard.zh.md). Management, reminders, arbitrary custom marks and editable inline containers remain outside this completed batch; the full delivery goal continues.


### Source repair through an unloaded container (2026-10-25)

Unknown rich containers no longer reject core source-identity mark repairs needed by unrelated typing. Only internal `hcdSource` mark differences are permitted in a core repair; business attrs, text, visible marks and the entire subtree remain protected. History uses the same comparison. The peer probe now runs the real PM append-plugin path rather than naked Fragment edits.

562 tests, TypeScript and both builds pass. Independent negative controls retain native400 and persisted rejected drafts; a fresh complete input flow and browser saves r10–r14 succeed on their first checkpoints. Actual browser download and source-free HCD/DOCX/PPTX/PDF/MD retain content, resource bytes and identities. Original failed probe evidence is unchanged. See the [source-repair contract and evidence boundaries](../../../docs/design/hcd-source-identity-repair.zh.md). Full deletion arbitration, arbitrary custom marks/editable inline containers and broader delivery acceptance remain open; management and reminder delivery remain deferred.


### Hidden block deletion review (2026-10-25)

Explicit block/container deletion records the exact reviewed public subtree. Later offline text, formatting, business/property/reference intents or child blocks reopen review before a new canonical checkpoint. The side panel compares deletion-time and latest content, offers restore-latest or a second confirmation to keep deleted, and invalidates changed confirmations. Keep-deleted does not re-hide a concurrent restoration. Unknown codecs/ancestors prevent destructive confirmation; restoration preserves read-only content. Read-only/history/ready gates and unified commands apply.

573 frontend tests, 74 selected native tests, TypeScript, both builds, native build, Clippy/fmt and actual local browser/socket/file evidence pass. Four late edits, confirmation invalidation, persisted Yjs reload, wire4 rejection, reference actors and source-free HCD/DOCX/PPTX/PDF/MD are verified. This does not cover inline-occurrence deletion, post-undo-creation offline input, arbitrary complex deletion/move combinations, service restart, production, real Office or hot-update history migration. See the [contract, reproduction and evidence](../../../docs/design/hcd-deletion-conflict-review.zh.md). The full goal remains active; management and reminder delivery remain deferred.


### Offline input after undoing creation (2026-10-25)

Guarded creation/copy inverses now retain permanent child topology and use the existing deletion receipt inside the same inverse transaction. Late offline edits remain reviewable and can be restored in a new window without its original undo stack. Temporary Yjs delete filtering preserves append-only anchors and is restored in `finally`; ordinary typing does not clone the document. Restoration assigns an independent canonical owner when an undone wrapper previously shared the now-unwrapped paragraph's owner.

581 frontend tests and TypeScript/both builds pass; no Rust change or repeated native-unit claim. Real local sockets/browser, native persisted files at r8/r11/r12, immutable r6–r12, resource bytes/reference actors, browser DOCX and source-free HCD/DOCX/PPTX/PDF/MD are verified. The original writer kept copy/undo/redo throughout UI observation timeouts; no service restart was used as recovery. Wire5 and canonical/offline formats stay unchanged; older editor windows must update their own guarded history implementation. See the [implementation, reproduction and evidence boundaries](../../../docs/design/hcd-history-late-input-recovery.zh.md). Inline-occurrence deletion, previously broken topology, complex ownership concurrency, compaction and the full original goal remain open. Management and reminder delivery remain deferred.


### Anchored AI writing and visible block drops (2026-10-25)

AI writing now opens beside the caret/selection with a private prompt and suggestion, explicit accept/retry/discard, empty-line Space and a staged `/AI` entry. Slash rows include descriptions and skip disabled entries during keyboard navigation. Pointer-captured block dragging highlights the destination row, labels before/after insertion and distinguishes no-op/blocked drops; stale gestures cancel and edge scrolling recomputes geometry. Existing command, authority, collaborative history and export paths still own writes.

591 frontend tests, TypeScript and standalone/embed builds pass. Real two-window gestures, observed feedback DOM, no-op/undo, synthetic AI accept/undo/stale-selection and actual browser DOCX plus source-free HCD/DOCX/PPTX/PDF/MD checks pass. No wire or canonical-format change. Continuous edge scrolling/complex nesting still need device acceptance; this is not real-model/Office/production acceptance or completion of the full goal. See the [contract and evidence](../../../docs/design/hcd-notion-writing-and-drag.zh.md). Management and reminder delivery remain deferred.


### Projected list slots and permanent empty carriers (2026-10-26)

Save/source/owner/history traversal now uses projected children, while permanent empty list items stay available for older offline edits. This fixes restored bullet/ordered lists producing more canonical targets than visible snapshot rows. Restoration reserves independent owners for retained slots so a later child can become a separate saved item.

595 frontend tests, TypeScript and standalone/embed builds pass. Real sockets/native/browser r2–r5, persisted Yjs reload at r3/r4/r5, protected undo, no-codec read-only reopen, actual DOCX and source-free HCD/DOCX/PPTX/PDF/MD are verified; all four first checkpoints return200. Native binary/protocols stay unchanged. Existing malformed pending captures, arbitrary concurrent ownership transfer and remaining full-goal acceptance remain open; management and reminder delivery stay deferred. See [implementation and evidence](../../../docs/design/hcd-projected-list-recovery.zh.md).

### Concurrent canonical owners and retained placements (2026-10-26)

Concurrent quote/list conversions keep the permanent original carrier's canonical identity and derive distinct owners for surviving additions through a pure projection. Save targets, receipts and ordinary edits use those effective owners. Projection caching invalidates on every transaction, including delete-only updates, and bypasses active mutations. Guarded history recovers a foreign placement only from exact retained anchors, then captures the hidden post-inverse baseline without adding a separate history action. Ambiguous split/boundary recovery remains rejected.

Strict actual-file equality also exposed native rewrites dropping an unrelated root list's outer container. Native now preserves detached li ordering metadata and reconstructs the matching ol/ul and start. This batch changes Rust; wire5 and canonical/offline versions remain unchanged, and editor/sidecar/native should be updated together.

606 frontend tests, 78 hcd-core / 43 hcd-docx / 49 hcd-formats tests, TypeScript, both editor builds, native build, related all-targets Clippy and Rust fmt pass. Fresh local native/socket/browser r2–r8, signed persisted r5/r8, seven first checkpoints200, exact browser undo/redo projection equality, no-codec reader reopen, browser DOCX and source-free HCD/DOCX/PPTX/PDF/MD are verified. Harness and old-native negative controls remain separate. See [contract, reproduction and evidence boundaries](../../../docs/design/hcd-concurrent-canonical-owners.zh.md). This does not complete arbitrary compound ownership/deletion races, inline-occurrence deletion, editable inline containers/custom marks, compaction, real Office or production acceptance; the full goal continues. Management and reminder delivery remain deferred.

### Inline deletion review and wire6 (2026-10-26)

Removed mentions/business atoms retain their storage root, exact review baseline, permanent text point and adjacent occurrence identities. Late property/retarget intents reopen review before canonical save/current export. Keep-deleted confirms only that snapshot. Restore uses the owning coordinator's serialized `/collaboration/inline-restore` route with current write/epoch/model checks, persistence CAS and authenticated reference authors; concurrent requests for the same deletion generation insert once. Unavailable positions offer an explicit new final paragraph. Unknown codecs remain restorable read-only and cannot authorize destructive confirmation.

Guarded insertion inverses retain inline tombstones in the same undo transaction; already received peer properties remain protected. YText embed insertions are detected through delta, not only changes.added. A proven linear atom-removal path preserves unchanged separator/text carriers between deleted atoms. Fresh paragraph allocation normalizes extension/reference storage roots.

Frontend, sidecar and native now require wire6 for these shared drafts; structure3/coordinator4/envelope2/mention1 and canonical/offline formats stay unchanged. Update these components together. 621 frontend tests, 3 related native fence tests, TypeScript, both builds, native build, officecli all-targets Clippy and fmt pass. Real local sockets/browser r2–r7, persisted r3/r6/r7, six first checkpoints200, concurrent restores, denied old/read-only/epoch requests, no-codec reopen, browser DOCX and source-free HCD/DOCX/PPTX/PDF/MD are verified. Native structural Replace deliberately regenerates later text-source IDs: semantic/block/business identity equality is verified, not full canonical byte equality. Server restores currently require an online owner and do not enter the browser's personal undo stack. See [contract, reproduction, negative controls and remaining work](../../../docs/design/hcd-inline-deletion-review.zh.md). Inline-format deletion races, custom marks/editable inline containers, lost legacy occurrences, source fidelity, capacity and production/multi-instance remain open. Management and reminder delivery remain deferred.

### Structural source retention (2026-10-26)

The later source-ID regeneration boundary above is now repaired for owned inline identities. Signed optional leaf bindings capture permanent Yjs item ranges and a content SHA; receipt reconciliation marks exact surviving items, excludes late inserted characters/deleted atoms and works through joined-away carriers. Source maintenance does not add a user undo item. Legacy captures remain readable and only matching whole leaves can be rebound without item ranges.

Native structural batches may retain sources from roots explicitly replaced/deleted in that batch, including lawful paragraph joins and splits. Role checks, surviving-owner preference and final uniqueness reject forged IDs or borrowing from unchanged roots. Logical HCD IDs do not guarantee original OOXML anchors/pagination, nor exact IDs for every formatting split or retired block root.

628 frontend tests, 82 hcd-core / 159 officecli tests, TypeScript, both builds, native build, related all-targets Clippy and fmt pass. Two fresh native/socket fixtures each have six first checkpoints200. Actual browser restore/confirm-cancel/save/download/no-codec reopen, signed fresh persisted docs, exact canonical blocks r4=r6, stable sources through PM join/late peer typing/own undo-redo-undo, and all-revision source-free HCD plus DOCX/PPTX/PDF/MD are verified. The native-only failed fixture stays separate. No protocol bump; update editor/sidecar/native together. See [contract, reproduction and limitations](../../../docs/design/hcd-structural-source-retention.zh.md). Full goal remains active, including online-restore personal history, editable inline containers/custom marks, compound races, capacity and real Office/production acceptance. Management and reminder delivery remain deferred.


### Custom text marks and wire7 (2026-10-26)

`nodeExtensions.marks` and the public service's `registerMarks` / `createMark` expose immutable, inert `hcd.mark/1` formatting values. Registered toggles reuse ribbon/context/bubble/palette commands; explicit apply/toggle/remove share authority and selection checks. Cursor formatting only affects later typing. Different business types have independent Yjs format keys, deterministic type order, idempotent apply and an atomic eight-overlap limit. Unknown codecs protect existing text/format/data, including personal history; loading the codec resumes the same history item. Same-type concurrent formatting uses normal Yjs value convergence, without a new per-field mark candidate model.

Editor, sidecar and native must now use wire7 together. Canonical manifests declare `customMarks:1`; marked projection reads and structural/checkpoint writes require `X-HCD-Custom-Marks-Version:1`. Older wire6, unaware bodies that strip marks, unknown models and malformed updates fail closed. Older documents without marks remain readable. Node envelope2 / structure3 / coordinator4 / mention1 are unchanged.

638 frontend tests, 84 hcd-core / 160 officecli tests, TypeScript, both builds, native build, related Clippy and fmt pass. Real authenticated sockets/browser r2–r10, nine first checkpoints200, exact canonical own history 4=6 / 7=9 / 8=10, signed fresh persisted docs, dynamic unload protection and no-codec reopen are verified. Actual browser DOCX preserves bold/underline/color/highlight, and HTML embeds image bytes and mark values; source-free HCD all versions1–10 plus DOCX/PPTX/PDF/MD and inspection HTML are checked. Actual npm pack resolves public types in an isolated strict TypeScript consumer. See [contract, usage, reproduction and boundaries](../../../docs/design/hcd-custom-text-marks.zh.md).

This is format-v1, with a bounded style subset. Editable inline containers, mark property candidates/migrations, broader HTML/CSS and business-node/resource reimport, complex Office round trips, annotation anchors through splits, capacity and the full remaining goal continue. No service-restart, real Office/provider, multi-instance or production acceptance is claimed. Management and reminder delivery remain deferred.


Text-mark HTML import and clipboard normalization now preserve inert payloads, ordinary formatting and fresh source identity. Runtime fallback CSS is isolated from browser DOM reparsing; copy emits standalone static CSS. New paragraphs no longer inherit the previous source receipt. The follow-up verified 642 frontend / 53 hcd-formats tests, actual browser copy/paste/peer edits/own undo, five successful checkpoints, exact r3/r5 canonical state, browser HTML reimport, browser DOCX styles and source-free r1–r6 archives/exports. See [reproduction and explicit scope](../../../docs/design/hcd-mark-html-roundtrip.zh.md).


Native-only inline-content foundation: Rust now supports envelope3 and independent inline body subtrees, including nested/empty content, source identities, marks, mentions and archived resources. Model-aware HTTP/CLI and source-free files are verified; **the current browser SDK/sidecar does not advertise or edit this model yet**. Permanent child text carriers, PM/Yjs offset mapping, own history/deletion review and browser acceptance must land before exposing it. Native projection/write requests require `X-HCD-Inline-Containers-Version:1`. See [contract, evidence and integration order](../../../docs/design/hcd-inline-content-native.zh.md).


Internal inline-container kernel (2026-10-26): `SemanticInlineContainers` now retains one permanent child `Y.XmlText` per occurrence, stores only stable parent references and maps PM subtree positions to independent relative text positions. Sixteen new regressions cover concurrent input/formatting, parent movement, personal undo, late input after hiding or undoing creation, nested/empty bodies, source/mark preservation and fail-before-write boundaries. The active projection reader refuses native empty-text inline wrappers; wire7 shadow guards reject these not-yet-supported carriers. All 658 frontend tests, TypeScript and both builds pass. This kernel is not wired into the active composite text flow, structural/save binding, property candidates, deletion review or SDK/UI yet; no new socket/browser/checkpoint/export acceptance is claimed. See [contract and remaining integration](../../../docs/design/hcd-inline-carriers.zh.md). Management and reminder delivery remain deferred.


Internal composite text-flow integration (2026-10-26): `SemanticTextFlow` accepts an explicit `SemanticInlineContainers` instance owned by the same document, schema, origin and parent Map. Container-aware read/write, paragraph boundary mapping, nested body bookmarks and personal text history now work across permanent split/joined carriers. A body at the beginning of a joined carrier keeps its actual physical parent. Leaf storage conversions preflight before mutation; permanent allocation inside a personal outer transaction is refused pending the structural preparation phase. Seventeen new regressions and all 675 frontend tests, TypeScript and both builds pass, including actual temporary Yjs/bookmark file reload after original Docs are destroyed. Default active stores still do not enable this model; source-range receipts, structural/save binding, property/deletion review and SDK/browser acceptance remain open. This is not native HCD/Office export, a production service restart, or full-goal acceptance. See [flow integration and remaining work](../../../docs/design/hcd-inline-flow.zh.md).


Internal recursive source bindings (2026-10-26): container-aware capture now records parent storage offsets and independent permanent body ranges in an explicit v2 tree. Flat captures retain their original fields. Per-layer source actions preserve late input and new-copy identities, rebind revived exact body content and never mark wrapper boundaries. The coordinator rejects v2 unless its actual structure instance enables the model. Native DTO typing and semantic normalization now recurse through inline bodies while frozen v1 semantics remain unchanged. Twelve new regressions, all 687 frontend tests, TypeScript and both builds pass. No new native/checkpoint/socket/browser/Office acceptance is claimed. Native DTO conversion, empty-body source/font defaults, signed receipt/save binding, property/deletion review and exact PM transaction hints remain open; whole-state repeated-prefix diff is not proven to preserve original user insertion positions. See [contract, evidence and test corrections](../../../docs/design/hcd-inline-source-bindings.zh.md). Management and reminder delivery stay deferred.


## 2026-10-26 文档异常页

统一打开、内容读取、草稿恢复和显示异常视图，提供 17 个稳定错误码、原因描述、问题详情与主动重试。已有草稿比较/固定布局画布保留原恢复和下载入口。详情见 [异常页设计与错误码](../../../docs/design/hcd-document-problems.zh.md)。696 项前端测试、TypeScript 与两种构建通过；本机故障代理验证 503 重试进入真实 DOCX，另核对 403/426/无效 JSON、多语言与显示异常恢复。管理平台仍不做。


## 2026-10-26 追加：行内容器原生转换与空正文默认值

内部 DTO/PM 编解码递归保留嵌套/空正文、mark、提及及带格式的换行；空正文的规范来源/字体默认值存入永久正文载体，回执不修改业务定义或个人历史。默认/活动模型仍拒绝，未开放 SDK/菜单。新增11项、82项专项与完整707项前端回归，TypeScript/双构建检查见报告。实际 source-free HCDZ r8 经前端转换/新 Y.Doc 文件回读、精确追加及 CLI 保存为r9，来源回执后完整规范含ID精确相等；新归档/资源和DOCX/PPTX/PDF/MD实际文件回读通过。见[契约、命令与验收边界](../../../docs/design/hcd-inline-projection.zh.md)。活动结构预分配/签名回执、全来源清理、属性/删除/历史/复制及配套协作仍继续；不是浏览器/生产验收，管理平台与实际提醒发送仍后置。


## 2026-10-26 追加：活动编辑器重复字符事务位置

普通同段单步替换从真实PM事务传递位置，不再由最终文字的公共前后缀猜测。UTF-16/保留字符预检先于共享修改和分配；原始item、光标、来源回执和迟到同伴输入保持关联。13项新增、57项专项与完整720项前端、TypeScript/双构建通过；真实wire7离线socket及native r2–r7、浏览器r9–r11、签名持久文件、严格规范相等、浏览器DOCX与无源HCD全部版本/四格式文件已验证。见[实现、复现和开放项](../../../docs/design/hcd-transaction-text-positions.zh.md)。首份浏览器QA中未归因的额外结构变更单独保留，未计作通过；多步/IME/行内容器位置、容量与原完整目标仍继续，管理平台与实际提醒后置。


## 2026-10-26 追加：多步文字事务与相同文字替换

活动结构绑定按各步骤的真实位置处理跨段纯文字替换，完整预检先于共享写入。最终文字相同的删除重插仍保留身份变化，并重新定位远端选区；容量拒绝保留原文/草稿，允许继续小操作。17项新增、74项专项、完整737项前端及TypeScript/双构建通过。真实双端连接/native r2–r8验证离线合并、程序化组合输入、双方自己的撤销重做、同文字身份变化持久化与下一次同伴输入落点；签名/规范摘要、无源HCD全版本及四格式实际文件通过。见[实现、复现与边界](../../../docs/design/hcd-multi-step-text-edits.zh.md)。真实操作系统IME、长文本性能、活动可编辑行内容器/SDK等继续，管理平台与提醒发送后置。


## 2026-10-26 追加：行内容器结构预分配与递归回执

内部SemanticBlockStore显式接入永久正文，整次多根预检/再次校验后分配空载体；新父段只种引用，正文修改留在个人事务，移动到新段同时改字的undo可正确恢复。全局实例冲突、模型声明/旧wire拒绝、正文外来字符历史检查、递归/空正文来源回执和隐藏正文失效来源清理接通。17项新增、71项专项、完整754项前端及TypeScript/双构建验证；实际无源r8副本经结构reconcile/精确undo-redo/CLI保存r9/完整来源回执和新Doc文件回读，HCDZ/资源及四格式文件通过。见[契约、复现与边界](../../../docs/design/hcd-inline-structure.zh.md)。尚非活动binding/签名room/SDK/UI；行内容器从保留根删除先明确拒绝，需专门审阅/恢复。精确正文事务、属性/复制/缺codec保护、配套协作和其余原目标继续；管理平台和实际提醒后置。
## Word 基础能力的原生准备（2026-10-26）

内部 `ImportOptions.flow_layout` 默认关闭；启用后分节/页眉页脚关系进入版本资产图，原生映射文字接口可联合保存已有正文/页眉/页脚，计算域结果只读，未知域指令不透明保留。新模型要求显式客户端声明，旧结构/签名快照路径先拒绝；源 DOCX 与离线 HCD 保留信息，无源区域导出仍待完成。尚未开放浏览器区域编辑、页码更新或正文自动目录。见[原生模型与验收边界](../../../docs/design/hcd-flow-layout.zh.md)。

后续区域结构核心提供显式 `hdoc import --word-regions` / `project-editor --word-regions` CLI 预览，模型 2/`hcd-patch/6` 支持已有 DOCX 区域中的富文本、映射图片及扩展资源联合保存；13 项新增、615 项原生/CLI 回归和真实文件验证通过。模型 2 的映射读写需声明版本 2；旧结构/签名快照仍拒绝，浏览器没有启用区域编辑。当前 HTML 等语义文档的区域建立/迁移、同房间协作和个人撤销、页眉页脚创建/链接、完整导出及自动目录继续。详见[区域协议、CLI 复现及边界](../../../docs/design/hcd-flow-regions.zh.md)。

Word 区域的后续原生能力：无源 DOCX 可以按保存版本重建正文节和独立页眉页脚，支持只读 HTTP 下载；`export-options.semanticFormats` 对区域文档返回 `docx`。旧内测模型缺投影身份时明确拒绝。域缓存暂静态化，浮动位置转为行内；浏览器区域 UI/签名协作、正文目录、页码重算和 PDF 区域导出仍未接通。详见 [区域 DOCX 导出](../../../docs/design/hcd-word-region-export.zh.md)。

Word 区域浏览器路径现支持模型 1/2 自动识别和映射分段编辑；正文、页眉、页脚共用保存/本机草稿/个人历史。在线协作可定位/跟随区域并显示节点姓名高亮；属性面板显示节设置、共享绑定和按节宽度预览。区域完整富文本 CRDT/块菜单、布局编辑、通用文档迁移、正文目录和页码重算仍未开放。见[实现、复现和浏览器证据](../../../docs/design/hcd-word-region-ui.zh.md)。

### Regional Word room core (opt-in, local verification)

`HCD_WORD_ROOMS=1` enables the sidecar handler for documents already explicitly
initialized with `hcd-word-regions/1`; it does not migrate existing documents.
Clients must use `documentId:epoch:wordregions1:save5` and acknowledge both
`hcdNodeEdits=7` and `hcdWordRegions=1`. The default remains disabled. Current
paper UI is not switched by this flag. Local ownership now requires a native
lease, the authenticated private recovery store and its full journal ancestry.
Acquire/renew/record/checkpoint must reach the same native instance. Remote
database/S3 and cross-host ownership are not configured. Coordinated legacy
migration remains an activation gate; browser binding, recovery and uploads
are described below.
See [regional room contract](../../../docs/design/hcd-word-room.zh.md).

Run `python3 scripts/hcd-word-room.py` from the repository root for an isolated
native/sidecar/WebSocket/DOCX/HCDZ verification; it only creates synthetic data.
Add `--owners` to verify two local native processes, sidecar contention, expiry
while the old process is suspended, draft handoff and copied-identity rejection.
See [ownership contract and limits](../../../docs/design/hcd-word-room-ownership.zh.md).


The newer layout-aware protocol `hcd-word-regions/2` has a separate explicit
opt-in: both `HCD_WORD_ROOMS=1` and `HCD_WORD_LAYOUT_ROOMS=1` are required. It uses
`documentId:epoch:wordregions2:save6` with `hcdNodeEdits=7`, `hcdWordRegions=2`
and `hcdWordLayout=1`. This enables the actual sidecar's loading, live checkpoint
messages, packet fences and protocol-bound uploads for already initialized `/2`
documents. It does not migrate `/1` identities. The ordinary embedded editor
now negotiates `/2` explicitly for stable, already initialized layout documents.
The sidecar settles an existing exact pending checkpoint before publishing a
reopened replica. Authenticated members can read a pinned active-room baseline
with `POST /v1/documents/{id}/collaboration/word-room-projection`, JSON
`{epoch, revision}` and headers `X-HCD-Node-Edits-Version: 7`,
`X-HCD-Word-Regions-Version: 2`, `X-HCD-Word-Layout-Version: 1`.
Native owner credentials remain private. Projection body/response bounds are
4 KiB/15 seconds and 16 MiB/30 seconds respectively.
Run `python3 scripts/hcd-word-room.py --layout` for synthetic actual-sidecar
verification including native TCP response loss, late input, restart, receipt
recovery without resubmission, image replacement and DOCX/HCDZ readback.
Browser protocol helpers, the save controller, image/large-recovery transport
and isolated `wordregions2-device1` journals now support explicit `/2`. New
layout device backups use `hcd-word-device/6` with the protocol declaration;
legacy `/5` output stays unchanged. Cross-model backups are inspection-only,
not recovery authorization. The ordinary embedded UI now binds the session,
signed recovery review and controller to the selected model. Recovery previews
use the active native owner or an exclusive stopped-room lease; a decision
requires write access and a stopped room. See the isolated real-Chrome fixture
`python3 scripts/hcd-word-layout-browser.py`, followed by
`node scripts/hcd-word-layout-ui-check.mjs FIXTURE OUTPUT` and
`python3 scripts/hcd-word-layout-ui-files.py FIXTURE OUTPUT` for body editing,
recovery confirmation, save, device backup inspection, refresh and DOCX/HCDZ
readback. This does not prove physical-device, Office/WPS or production use.
Normal page/story controls, active-room switching after those transactions,
legacy migration and broader image/resource UI acceptance remain open. See
[layout integration and limits](../../../docs/design/hcd-word-layout-edit-plan.zh.md).

Regional recovery review is available through the opt-in sidecar route
`POST /collaboration/word-recovery` and the internal `WordRecoveryGate` component.
Run `python3 scripts/hcd-word-room.py --recovery` for real API/Socket/file checks,
or `--preview` for an isolated, synthetic browser review. Review decisions retain
original authors, mention IDs, interrupted upload choices and the signed archive.
The downloaded draft copy is not a complete HCDZ. The component is internal to the regional editor and is not a separate public
SDK surface. RegionalWordEditor now embeds this review; legacy epoch migration
remains required. See [contract and remaining work](../../../docs/design/hcd-word-recovery-review.zh.md).

Regional browser binding now routes explicitly initialized `hcd-word-regions/1`
sessions to `RegionalWordEditor` through the actual embedded entry point. It
includes server recovery review, scoped body/header/footer rich views, shared
commands and mentions, own history, device-only authored recovery, image sizing
and the collaboration panel. Use `python3 scripts/hcd-word-room.py --rich-ui`
for a synthetic preview, and `scripts/hcd-word-browser-preview.py FIXTURE` to
resume that owned fixture at the same origin for device-recovery QA. Existing
mapped sessions are not migrated. Pagination/virtualization, upload recovery UI,
regional custom-node/AI editing and legacy migration remain open. See
[implementation and evidence](../../../docs/design/hcd-word-browser-regional.zh.md).

Regional image replacement is now wired to the durable server upload ledger.
The browser journals selection metadata before reserving it, then sends bytes
through the member-authenticated sidecar transport. Pending uploads block save,
export and close; recovery checks existing bytes or requires the same original
file. Cancellation records prevent late replay, and the resumed replacement can
be undone in its own window before or after a checkpoint. See
[upload UI, API and browser/file evidence](../../../docs/design/hcd-word-upload-browser.zh.md).
`hcd-word-upload-proxy.mjs` is a separate owned-fixture transport gate, not a
production editor flag. Cross-epoch migration and remote ownership remain open.


### Regional Word AI (2026-10-27)

Explicit `hcd-word-regions/1` workspaces now honor the existing `aiExtensions` host contract in body, header and footer editors. The shared private controller/composer, command actions, slash/empty-line entry and opt-in ghost completion pin suggestions to the originating editor and current section/story scope. Acceptance rechecks native authority and a CRDT-relative target, then uses normal own history, collaboration and checkpoint. Switching stories, peer changes to the target, read-only state or disconnect prevents stale acceptance. Pending suggestions are private and do not enter exports.

`python3 scripts/hcd-word-room.py --ai-fixture` starts an isolated loopback NDJSON provider and real embedded writer/peer/reader pages; it does not call an external model. 900 frontend checks, TypeScript and both builds pass; actual browser r9 DOCX and HCDZ r0–r9 history were read back. Regional export remains DOCX/HCDZ only; PDF/MD/HTML explicitly reject unsupported regional output. See [implementation, evidence and remaining boundaries](../../../docs/design/hcd-word-ai-regional.zh.md). Old-room migration, regional extension/AI expansion, precise pagination, live-provider acceptance and the original full goal remain open. Administration and reminder delivery remain deferred.


### Regional Word node extensions (2026-10-27)

Explicit regional workspaces now honor the existing `nodeExtensions` host contract for inline atoms, block atoms and `contentModel: 'blocks'` containers. Commands share ribbon/context/slash/block/palette entry points. Regional property/resource/conflict panels use the existing field intents, protected fallback views and own history. Resource preparation blocks local saved/close/export, including a resource choice started during an in-flight save; unknown codecs preserve complete payloads and read-only children while ordinary text remains editable.

A real saved-block receipt mismatch exposed omitted false fallback flags; new nodes now match native defaults, and old signed preparations accept only that narrow equivalence before advancing to the canonical baseline. Actual restart confirmed the original r3 without creating another revision. 905 tests and both builds pass; two actual Socket members and browser choice review verified field merge/own undo/conflict retention, and real browser DOCX/HCDZ r0–r10 plus resource bytes were read back.

Start an isolated host with `python3 scripts/hcd-word-room.py --nodes-fixture`. The bundled definitions in `src/examples/regionalNodes.ts` are registered only by that explicit example host. See [contract, reproduction and remaining boundaries](../../../docs/design/hcd-word-nodes-regional.zh.md). Pending node file-choice recovery across restart, old-room migration, future inline containers, precise pagination, regional PDF/HTML/MD and the original goal remain open. Management and notification delivery remain deferred.

Regional node file choices now persist bounded original bytes and target envelopes in the member-scoped device journal before upload. Reopen offers locate/resume/explicit attach/cancel; ordinary editor commands still own attachment, and unfinished choices block save/export/close. See [contract and actual browser/file evidence](../../../docs/design/hcd-word-node-resource-recovery.zh.md). Other semantic entry points and cross-device pending-file recovery remain separate work.

The ordinary structural editor now reuses the regional node-file state machine with a member/document/epoch file journal independent of text recovery copies. Pending original bytes survive fresh text copies; attachment still uses normal commands and requires the current target. Save receipts, close/window/restore handoff and exports check all unfinished jobs, and device backup downloads include file bytes. See [ordinary-editor evidence and limits](../../../docs/design/hcd-semantic-node-resource-recovery.zh.md). At that checkpoint, browser HTML was verified separately from the unsupported CLI path; the subsequent shared exporter below closes that CLI gap.

Source-free HTML now uses a shared CLI/authenticated HTTP exporter, including portable node presentations, inert metadata and verified embedded image bytes. Full native histories and opaque attachments still require HCDZ; regional HTML remains explicitly unsupported. See [standalone HTML implementation and offline browser evidence](../../../docs/design/hcd-standalone-html-export.zh.md).

### Regional Word standalone HTML

Flow layout version 2 exposes HTML alongside DOCX and HCDZ. CLI and authenticated HTTP share the same saved-revision exporter; paper/story bindings and node payloads remain in the derived file. Unrendered node resources are embedded as downloadable attachments. Browser block pagination is approximate; fields retain cached values and HCDZ remains the full native archive. See [implementation and acceptance](../../../docs/design/hcd-word-html-export.zh.md).

### Internal editable inline-body binding

The opt-in internal inline-container store now consumes exact PM text-step batches, separately addressing parent and child permanent carriers. Default room/schema capabilities remain unchanged. The isolated two-view fixture and native file bridge are described in [the binding acceptance report](../../../docs/design/hcd-inline-binding.zh.md); they do not enable public SDK insertion or signed collaboration rooms.

### Internal inline-body coordinated saving

An explicitly body-aware store can opt into `SemanticSaveCoordinator` with `inlineContainers: 1`. Signed baselines/captures retain that scope, nested mention authors are traversed, and native capability headers remain required. This does not enable existing rooms or advertise public SDK support. See [HTTP recovery and offline evidence](../../../docs/design/hcd-inline-save.zh.md).

### Internal inline-container property candidates

The body-aware structural store now keeps causal field candidates independently of permanent definitions and body characters. Conflicts and unmaterialized merges block coordinated saves; personal undo retains peer body input. Existing rooms reject the separate internal property maps. See [implementation, native response-loss recovery and export evidence](../../../docs/design/hcd-inline-properties.zh.md). Public SDK/room activation and inline-wrapper deletion review remain open.

### Internal editable inline deletion review

Container tombstones now retain identity, anchors and review snapshots while projecting live independent bodies. Late body/property edits reopen review; the owning coordinator serializes restoration. Recursive source retirement includes hidden bodies absent from save capture. Existing wire7 rooms reject container tombstones and public SDK registration remains closed. See [actual response-loss recovery and offline/export evidence](../../../docs/design/hcd-inline-deletion.zh.md); canonical HCDZ currently excludes pending Yjs review state.

### Internal portable semantic recovery transport

`semanticRecoveryArchive.ts` can carry canonical HCDZ, pending Yjs state, retained/candidate node resources and original bytes for unfinished node-file choices in a bounded, verified file. Opening requires a canonical verifier and returns an isolated candidate; it grants no room or write authority. The `structure3` editor now provides export, isolated comparison and explicit import as one personal history action, with current permission/staleness checks and private pending-file retention. Other models and epoch migration remain open. See [kernel acceptance](../../../docs/design/hcd-semantic-recovery-archive.zh.md) and [editor UI, collaboration and actual files](../../../docs/design/hcd-semantic-recovery-ui.zh.md).


### Opt-in editable inline host SDK

The local package exposes `@officecli/hcd-reference-editor/inline-containers`: a bounded `InlineContainerRegistry`, the real-body `SemanticInlineContainerNode`, and `prepareInlineContainerHistoryGuard`. Hosts can register codecs/properties/export adapters and preserve unavailable bodies read-only. Registration does not upgrade `EmbeddedHcdEditor.nodeExtensions` or an existing wire7 room; `requiresNegotiatedModel` is explicit. The opt-in model supports recursive copy/cut/paste with fresh body/source/mention identities, structured MIME and verified HTML; malformed or lossy clipboard input is rejected. Explicit paste-as-text follows the ordinary text path. Cross-document resource transfer still requires the host resource service. See [host API, actual package consumer and file acceptance](../../../docs/design/hcd-inline-host.zh.md). This entry has been packed and consumed locally; it is not an npm publication or active-room rollout. Clipboard acceptance and native/offline files are documented [here](../../../docs/design/hcd-inline-clipboard.zh.md).


### Inline-body interactions in the main editor

For documents already declared with extension model 3, `EmbeddedHcdEditor` negotiates the inline1 session before creating its room or device journal, then uses the body-aware schema, snapshots, properties and resource clients. Register host codecs through `inlineContainerExtensions`; adding codecs does not migrate an existing ordinary room. Main-page repeated saves and actual native files are documented [here](../../../docs/design/hcd-inline-main-editor.zh.md).

Within available inline bodies, `/` and person mentions use the live codec guard; every enclosing codec must be available. Block conversions and block extensions remain unavailable inside an inline wrapper, while literal inline insertion and nested inline nodes retain the real body. AI targets use the wrapper identity and permanent relative body anchors, with acceptance through normal personal history and saving. The production-service probe `python3 scripts/hcd-inline-room-files.py --inline-interactions` verifies server candidates, committed reference locations/events, accepted literal text, restart and four-format/HCDZ files. It does not call an external model or replace browser menu/IME/placement acceptance. See [interaction implementation and remaining gates](../../../docs/design/hcd-inline-editing.zh.md). Management UI and reminder delivery remain deferred.


### Whole-block commands containing editable inline bodies

Block controls now read both live ordinary-node and inline-container registries from the editor policy plugins. Known paragraphs and rich blocks can duplicate nested inline bodies with fresh wrapper/mention/source identities while retaining the same archived resources. Move and paragraph/heading/list/quote conversion preserve existing permanent body carriers. Unknown descendants and codec unload still block operations, including staged commits and crossed drag neighbors; code/rule conversions cannot erase business content. `python3 scripts/hcd-inline-room-files.py --block-operations` checks real copy/move/conversion/delete/peer-edit/own-undo checkpoints, restart, four-format exports and exact offline shared resource bytes. Actual browser drag/menu acceptance remains pending. See [implementation and evidence](../../../docs/design/hcd-inline-block-operations.zh.md).

Inline-container documents now use the coordinated version restore path without downgrading their collaboration model. The private durable restore intent pins `fromProtocol`; old intents without it remain structure3. Local inline restore requires model acknowledgements, drains peers before committing, reconciles an unknown result using the same request, and rotates the epoch before admitting a fresh room. See [implementation and actual browser/native/offline evidence](../../../docs/design/hcd-inline-revision-restore.zh.md). Remote shared transactions and the remaining editor delivery requirements remain open.

Main-editor inline-container Notion interactions now have real two-user browser and immutable-file acceptance through r24: nested slash insertion, server-backed mentions, personal undo/redo, block copying, drag feedback and selection formatting. Block dragging participates in contextual-menu exclusion; the selection toolbar stays hidden during the gesture. The end-of-document button appears on its own hover/focus rather than whenever the paper is hovered. Markdown semantic export now retains basic inline formatting, including within words, links and table cells; bold/emphasis use safe CommonMark inline HTML, which the corresponding importer accepts without attributes. See [acceptance scope and open work](../../../docs/design/hcd-inline-notion-ui.zh.md).

### Current capability matrix and workbook recovery (2026-10-27)

The [current matrix](../../../docs/design/hcd-current-capabilities.zh.md) separates format entry points and completed layers from remaining work. Workbook mapped cells now use owner-managed persistent drafts, immutable request recovery, conflict choices and guarded personal history. Save/export live in the operation area. Verified canonical node resources can be reused during recovery without a redundant archive POST; unpublished resources still stage normally. See [contract, actual browser/file evidence and remaining limits](../../../docs/design/hcd-workbook-save-recovery.zh.md). This does not enable formulas, structural workbook editing, all-format offline startup, management or reminders.
