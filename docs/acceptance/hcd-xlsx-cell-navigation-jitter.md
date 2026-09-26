# XLSX cell navigation stays steady after saving

The HCD grid chunk ID is stable across revisions. Its HTML and source-map
hashes identify the content version. When a cell edit is saved or received from
another browser, the editor now compares those hashes and replaces only the
changed visible content. It keeps the old grid on screen until the replacement
is ready and preserves the active selection and unchanged merged ranges.

## Reproduce and verify

Use an isolated `accept-xlsx` demo document and the same `HCD_TOKEN_SECRET` for
the service and editor. The service and editor run in separate terminals.

```bash
mkdir -p /tmp/hcd-cell-navigation
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-cell-navigation/accept-xlsx.hcd --document-id accept-xlsx
HCD_TOKEN_SECRET="$HCD_TOKEN_SECRET" target/debug/officecli hdoc serve \
  --root /tmp/hcd-cell-navigation --bind 127.0.0.1:8842
```

```bash
cd examples/hdoc/editor
npm run build
HCD_DEMO_ROOT=/tmp/hcd-cell-navigation \
  HCD_TOKEN_SECRET="$HCD_TOKEN_SECRET" \
  HCD_API_TARGET=http://127.0.0.1:8842 \
  npm run dev -- --host 127.0.0.1 --port 8844
```

Open `http://127.0.0.1:8844/` in two browser tabs and select the sample. In
the first tab, edit Overview!B8, then press Enter to move to B9. The table,
merged title and chart should remain visible, and the revision should advance
once. In the second tab, edit Overview!C8. The first tab should show the new
value without a reload or a blank-grid frame. Its selection should stay in B9.
Validate the resulting bundle:

```bash
target/debug/officecli hdoc validate /tmp/hcd-cell-navigation/accept-xlsx.hcd --json
```

Browser validation on 2026-09-26 used a separate imported workbook. B8 saved
as r10 and moved to B9 without clearing the canvas. A second tab changed C8
at r11; the first tab displayed the new value, kept its B9 selection, and
retained the merged heading and chart. `hdoc validate` reported `valid: true`,
`revision: 11`, and no issues.
