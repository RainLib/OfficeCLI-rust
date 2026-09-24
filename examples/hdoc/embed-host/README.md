# Embedded HCD editor host example

This separate React app installs the editor as a local package and mounts `EmbeddedHcdEditor` inside a bounded host panel. The host imports `@officecli/hcd-reference-editor/style.css`; the API is proxied under the same origin at `/v1`.

From the repository root, start the Rust API and collaboration sidecar as described in `examples/hdoc/editor/README.md`, then run:

```bash
(cd examples/hdoc/xlsx-univer-viewer && npm ci)
(cd examples/hdoc/editor && npm ci && npm run build)
(cd examples/hdoc/embed-host && npm ci && npm run build && npm run dev)
```

Open `http://127.0.0.1:8771/`, enter a document ID and a short-lived read or write token from `hdoc issue-token`, and verify that the editor fits the host panel. Editing, revision history, exports, and collaboration remain available inside the panel. A read token must stay read-only.
