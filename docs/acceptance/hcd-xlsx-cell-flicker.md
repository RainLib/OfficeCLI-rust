# XLSX cell save without a grid flash

The reference editor keeps the Univer canvas and its visible cells in place
while a local HCD cell patch is saved. It reloads the changed HCD chunk's node
metadata without writing the already edited value back into Univer. Repeated
`SheetValueChanged` events for a cell waiting for acknowledgement are ignored.

## Reproduce and verify

Set `HCD_TOKEN_SECRET` to the same secret of at least 32 bytes in both terminals.
Run the service command in its own terminal, then start the editor.

```bash
mkdir -p /tmp/hcd-cell-flicker
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-cell-flicker/accept-xlsx.hcd --document-id accept-xlsx
# In a separate terminal, with the same secret used by the editor:
HCD_TOKEN_SECRET="$HCD_TOKEN_SECRET" target/debug/officecli hdoc serve \
  --root /tmp/hcd-cell-flicker --bind 127.0.0.1:8842
cd examples/hdoc/editor
npm run build
HCD_DEMO_ROOT=/tmp/hcd-cell-flicker \
  HCD_TOKEN_SECRET="$HCD_TOKEN_SECRET" \
  HCD_API_TARGET=http://127.0.0.1:8842 \
  npm run dev -- --host 127.0.0.1 --port 8844
```

Open the `accept-xlsx` sample imported from
`assets/showcase/budget-tracker.xlsx`. On the `Overview` sheet, edit numeric
cell B8 from `800000` to `800001`, then edit it back. Edit text cell A8 from
`Engineering` to `Engineering test`, then edit it back. Each save must advance
the HCD revision exactly once. The selected cell, surrounding table, and chart
must stay visible while saving. Repeating the edit must not fail with a stale
node hash. Finally run:

```bash
cd ../../..
target/debug/officecli hdoc validate /tmp/hcd-cell-flicker/accept-xlsx.hcd --json
```

Browser validation on 2026-09-26: B8 edits saved as r19 and r20; A8 edits
saved as r21 and r22. The canvas remained visible after each save and the
original cell values were restored at r22.
