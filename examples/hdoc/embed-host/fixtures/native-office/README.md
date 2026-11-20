# Native Office regression fixtures

These are original, synthetic sources used by both the browser workbench and
independent native-file validators. `sources.json` pins their exact bytes. The
runner checks the hashes before testing and verifies that each original remains
unchanged afterwards. No user documents or external model service are involved.

- `pivot-source.xlsx`: two worksheets, formulas, frozen panes, an existing chart
  and conditional rule, occupied destinations, and mixed numeric/text values.
- `native-conditions-source.xlsx`: a native cell-value rule, a separate color
  scale, an existing chart and frozen panes. Unsupported rules must survive edits.
- `workshop-scan.pdf`: three pages with bitmap Chinese/English text, a mixed page
  with a real PDF header, and a rotated cropped page.
- The three PNGs: one textured original and two transparent cards with overlap,
  so layer order, opacity and reversal can be checked pixel for pixel.

The browser helpers perform actual pointer/keyboard edits, downloads and fresh
uploads. Native validators then use openpyxl, pypdf, Pillow and Poppler rather than
the editor's own preview to inspect the exported files. The PDF validator also
replays measured OCR through the CLI, compares pixels, checks page subsets and
tests restore/reapply. The image validator unpacks the portable layer archive,
checks every asset hash, edits the recovered layer graph and restores the original.

Install test-only Python dependencies in a virtual environment using
`requirements.txt`. Poppler (`pdftotext`, `pdftoppm`) must be on PATH. The installed
Workspace product itself does not need Python or these test dependencies.

```sh
python -m pip install -r examples/hdoc/embed-host/fixtures/native-office/requirements.txt
npm run test:workbench-native --prefix apps/workspace
```

`OFFICECLI_NATIVE_PYTHON` selects the virtual environment's Python executable;
`HCD_BROWSER_PATH` selects a local Chromium/Chrome installation. Set
`OFFICECLI_NATIVE_CASE=pivots|conditions|ocr|layers` for a focused run. Set
`OFFICECLI_NATIVE_ARTIFACTS` to a new output folder to keep screenshots and reports.
The OCR case blocks external browser HTTP requests; models and WASM come from the
built workspace assets. Network isolation of the entire installed release is a
separate deployment check.

`make_workbooks.py`, `make_pdf.py` and `make_images.py` retain the generation instructions. The image/PDF scripts
require the repository's bundled Noto Sans SC font and the pinned test packages.
Regeneration may change file metadata; review changes and update `sources.json`
intentionally rather than weakening the hash check.
