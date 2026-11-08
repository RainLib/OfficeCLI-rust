# OfficeCLI scoped emergency-wrap regression

This retained change is checked against CSS Text 3 §5.4 and §5.5:
https://www.w3.org/TR/2026/CRD-css-text-3-20260814/#overflow-wrap-property

Requirements: permit emergency wrapping of an otherwise unbreakable overlong
sequence, preserve its text and styles, keep grapheme clusters together, and
retain `nowrap` and fitting source-word boundaries. No hyphen or invisible
separator is inserted.

The regression is 80 adjacent alternating-style middle dots: before the patch,
PDF glyph positions extend beyond the page even with overflow-wrap:anywhere.
OfficeCLI also checks a complete 80-paragraph/6400-run PDF through its native
read-only HTTP export endpoint. See the repository evidence files under
`docs/assets/hcd-mentions-2026-10-24/`.

Status: scoped regression passed. Three patch-module tests, two actual PDF geometry tests, 435 main native tests and 388 frontend tests passed. Native HTTP export preserved all 6400 styled characters; its 10 PDF pages were rendered and visually inspected. The browser-downloaded file was independently read back. Machine results are in report.json.
Nineteen original compile-time fixtures (including the authentic ParitySans font) were retrieved from the pinned upstream commit; hashes are in OFFICECLI-TEST-SOURCES.json and the font license is retained. The crates.io package excludes the full upstream Chromium parity corpus, pinned
launcher, references and refs.lock. No replacement oracle has been generated;
this report makes no full browser parity claim and no raster has been altered
to conceal a mismatch.

## List-item block children (2026-10-24)

The actual OfficeCLI HTML-list fixture reproduced continuation and tail
paragraphs at the page edge while the first paragraph and nested lists were
indented. The independent regression requires all normal blocks of a list item
to use that item's content edge/width; fixed and absolute placement must retain
its containing-block coordinates. Before the patch, the first wrapped line was
at x=76 and the next paragraph at x=40. After the patch the geometry regression
passes for parent/nested continuations, a nested block container, long text and
a fixed child. Native CLI output also places the parent's first/continuation/
break/tail words at x≈70, its child words at x≈100 and its leaf at x≈130.

294 related native tests, the application build/all-targets clippy and a direct
ironpress lib clippy pass. The actual one-page CLI PDF was rendered with Poppler
and inspected. [Repository evidence](../../../../docs/assets/hcd-lists-2026-10-24/list-paragraphs-evidence.json)
retains the pre-fix file boundary, geometry and the reviewed raster. No new
oracle was generated and this does not expand the full Chromium parity claim.
