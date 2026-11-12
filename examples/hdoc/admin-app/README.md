# HCD 字体目录管理台

Same-machine admin console for the HCD font catalogue, served by
`officecli hdoc serve` at `GET /admin`. React + TypeScript + Tailwind v4 with
shadcn/ui-style primitives vendored under `src/components/ui`.

## Layout

One view per page, chosen from the left rail — management and document content
are deliberately separate pages rather than sections of one scrolling page:

| Group | Views |
|---|---|
| （顶部） | 概览 — counts, licence and reference risks |
| 目录管理 | 字体（修订与许可证）· 主题（槽位、退役、引用文档） |
| 录入与校验 | 上传登记（字库 → blob → 字体修订）· 主题预览（按许可证内联字面） |
| 内容 | 文档（本服务文档目录里每个 bundle 的 head 修订与钉住的主题） |

Navigation is hash-based (`#/fonts`, `#/themes`, `#/upload`, `#/preview`,
`#/documents`), so the page stays one static file.

## Build

```bash
npm ci
npm run build   # tsc --noEmit && vite build → embed/index.html
```

`vite-plugin-singlefile` inlines JS and CSS into one `embed/index.html`, which
`crates/officecli/src/hdoc_server.rs` embeds with `include_str!`. The build
output is checked in because the single binary has to carry it — a fresh clone
compiles without Node. `embed/` is used instead of `dist/` because the
repository ignores every `dist/`.

Edit `src/`, rebuild, then `cargo build`; restart any running `hdoc serve` to
pick the new page up. Never edit `embed/index.html` directly.

## Auth

The console needs an admin token (`--scope admin`, `--document-id '*'`); paste
it into 管理令牌. It is kept in `sessionStorage` only.

```bash
officecli hdoc issue-token --document-id '*' --scope admin --ttl-seconds 3600
```

Pinning a theme onto a document is *not* an admin operation — the document
route requires that document's `write` token, so the 文档 view only shows the
current pin and the command sequence to change it.
