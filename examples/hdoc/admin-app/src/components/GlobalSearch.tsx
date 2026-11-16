import * as React from "react";
import { Files, Palette, Search, Type } from "lucide-react";
import { useCatalog } from "@/state/CatalogProvider";

export function GlobalSearch({
  inputRef,
  onNavigate,
}: {
  inputRef: React.Ref<HTMLInputElement>;
  onNavigate: (route: string) => void;
}) {
  const { documents, fonts, themes } = useCatalog();
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const needle = query.trim().toLowerCase();
  const matches = [
    ...(documents || [])
      .filter((doc) =>
        `${doc.title || ""} ${doc.documentId}`.toLowerCase().includes(needle),
      )
      .slice(0, 3)
      .map((doc) => ({
        label: doc.title || doc.documentId,
        kind: "文档",
        icon: Files,
        route: `documents/${encodeURIComponent(doc.documentId)}`,
      })),
    ...fonts
      .filter((font) =>
        `${font.family} ${font.fontId}`.toLowerCase().includes(needle),
      )
      .slice(0, 2)
      .map((font) => ({
        label: font.family,
        kind: "字体",
        icon: Type,
        route: `fonts?search=${encodeURIComponent(font.fontId)}`,
      })),
    ...themes
      .filter((theme) =>
        `${theme.name} ${theme.themeRevisionId}`.toLowerCase().includes(needle),
      )
      .slice(0, 2)
      .map((theme) => ({
        label: theme.name,
        kind: "主题",
        icon: Palette,
        route: `themes?search=${encodeURIComponent(theme.themeRevisionId)}`,
      })),
  ];
  return (
    <form
      className="relative ml-auto flex h-9 min-w-0 max-w-[300px] flex-1 items-center gap-2 rounded-xl bg-card px-3 sm:w-[270px] sm:flex-none"
      onSubmit={(event) => {
        event.preventDefault();
        setOpen(false);
        onNavigate(
          matches[0]?.route || `documents?search=${encodeURIComponent(query)}`,
        );
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        aria-label="全局搜索"
        aria-controls="workspace-search-results"
        aria-expanded={open && !!needle}
        placeholder="搜索文档、字体、主题…"
        className="w-full min-w-0 bg-transparent text-[11px] outline-none"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
      />
      <kbd className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">
        ⌘ K
      </kbd>
      {open && needle && (
        <div
          id="workspace-search-results"
          className="absolute right-0 top-11 z-40 w-[min(360px,calc(100vw-32px))] space-y-1 rounded-2xl border bg-popover p-2 shadow-lg"
        >
          {matches.length ? (
            matches.map((item) => (
              <a
                key={item.route}
                href={`#/${item.route}`}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-xl p-3 text-xs hover:bg-accent focus:bg-accent"
              >
                <item.icon className="size-4 shrink-0 text-accent-foreground" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span className="text-[10px] text-muted-foreground">
                  {item.kind}
                </span>
              </a>
            ))
          ) : (
            <p className="p-4 text-xs text-muted-foreground">
              没有找到匹配的文档、字体或主题。
            </p>
          )}
        </div>
      )}
    </form>
  );
}
