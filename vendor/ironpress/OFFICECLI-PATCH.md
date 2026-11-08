# OfficeCLI print layout patch

Base: crates.io `ironpress` 1.6.0, upstream commit
`e7727b74838027337eb9532517d9e05df35e8a6a`, MIT, unchanged assets and license notices.
The package is retained locally so the fix works offline and does not depend on
editing a developer's Cargo registry cache.

Patch: `layout/text/emergency_wrap.rs` and one call in `wrap_text_runs`.
When CSS enables emergency wrapping, measure each complete source word across
styled runs with the existing layout arithmetic. Only groups wider than a fresh
line gain extra run-boundary opportunities, and only at grapheme boundaries.
Keep `nowrap`, atomic boxes, preserved whitespace and fitting groups unchanged.
The reproduced defect printed 80 alternating styled middle dots on one line,
outside the PDF page; setting `overflow-wrap:anywhere` alone did not fix it.

Validation includes local module tests, OfficeCLI's real PDF text/geometry test
and the 80-paragraph/6400-run exported-file regression. The original package
excludes its Chromium parity corpus. Only 19 authentic compile-time fixtures
were retrieved from the pinned upstream commit (hashes in OFFICECLI-TEST-SOURCES.json);
the ParitySans license is retained. This patch does not claim a full upstream
Chromium parity run. See `tests/parity/REPORT.md` for the scoped report.

Additional patch: `layout/engine.rs` list-item block children. The first loose
paragraph and nested lists already used their parent list's content edge, but
subsequent paragraphs and block containers were flattened at the outer page
edge with the wrong available width. Carry the content-box width and the
accumulated list/padding offset to their emitted principal boxes. Absolute and
fixed boxes keep their containing-block placement.

OfficeCLI's actual PDF geometry regression reproduced first-wrap x=76 versus
continuation x=40 before the patch. It now checks equal parent/continuation/tail
edges, nested indentation, a retained block container, long wrapped content,
and an unshifted fixed box. The HTML-list native CLI fixture independently
checks PDF word bounds and a visually reviewed one-page raster. See the scoped
report and repository `docs/assets/hcd-lists-2026-10-24/list-paragraphs-evidence.json`.
This is a scoped fix; full upstream Chromium parity remains unrun.
