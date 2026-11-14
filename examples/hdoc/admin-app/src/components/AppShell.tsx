import * as React from "react";
import {
  Database,
  FileText,
  LayoutDashboard,
  Moon,
  Palette,
  RefreshCw,
  ScrollText,
  Sun,
  Type,
  Upload,
  Eye,
  AlertTriangle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { TokenDialog } from "@/components/TokenDialog";
import { useCatalog } from "@/state/CatalogProvider";
import { tokenStore } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface NavItem {
  route: string;
  label: string;
  icon: React.ReactNode;
  hint: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * Groups follow authority, not screen space: the catalog is managed here
 * (目录管理), the documents that pin it are content (内容), and what the
 * changes actually left behind is read-only trail (留痕).
 */
export const NAV: NavGroup[] = [
  {
    title: "",
    items: [
      {
        route: "overview",
        label: "概览",
        hint: "目录规模与风险",
        icon: <LayoutDashboard />,
      },
    ],
  },
  {
    title: "目录管理",
    items: [
      { route: "fonts", label: "字体", hint: "修订与许可证", icon: <Type /> },
      { route: "themes", label: "主题", hint: "槽位、退役、引用", icon: <Palette /> },
    ],
  },
  {
    title: "录入与校验",
    items: [
      { route: "upload", label: "上传登记", hint: "字库 → 字体修订", icon: <Upload /> },
      { route: "preview", label: "主题预览", hint: "按许可证内联字面", icon: <Eye /> },
    ],
  },
  {
    title: "内容",
    items: [
      {
        route: "documents",
        label: "文档",
        hint: "本服务文档的钉版状态",
        icon: <FileText />,
      },
    ],
  },
  {
    title: "留痕",
    items: [
      {
        route: "audit",
        label: "操作记录",
        hint: "谁在什么时候改了什么",
        icon: <ScrollText />,
      },
    ],
  },
];

const THEME_KEY = "hcdAdminTheme";

function initialDark(): boolean {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored) return stored === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function AppShell({
  route,
  onNavigate,
  children,
}: {
  route: string;
  onNavigate: (route: string) => void;
  children: React.ReactNode;
}) {
  const { refresh, busy, error, unauthorized, fonts, themes } = useCatalog();
  const [dark, setDark] = React.useState(initialDark);
  const hasToken = Boolean(tokenStore.get());
  const active = NAV.flatMap((group) => group.items).find(
    (item) => item.route === route,
  );

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  }, [dark]);

  // Re-render the token badge as soon as the dialog saves a new one.
  const [, setTick] = React.useState(0);
  React.useEffect(
    () => tokenStore.subscribe(() => setTick((tick) => tick + 1)),
    [],
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-4">
        <div className="flex items-center gap-2 font-semibold">
          <Database className="size-4 text-muted-foreground" />
          <span className="text-sm">HCD 字体目录管理台</span>
        </div>
        <span className="tabular hidden text-xs text-muted-foreground sm:inline">
          {fonts.length} 个字体 · {themes.length} 个主题
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
              hasToken && !unauthorized
                ? "bg-success/10 text-success"
                : "bg-warning/10 text-warning",
            )}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {hasToken ? (unauthorized ? "令牌被拒绝" : "管理令牌就绪") : "未设置令牌"}
          </span>
          <TokenDialog onSaved={() => void refresh()} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={busy}
            title="重新拉取目录"
          >
            <RefreshCw className={cn(busy && "animate-spin")} />
            刷新
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="切换深浅色"
            onClick={() => setDark((value) => !value)}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-muted/30 px-2 py-3">
          {NAV.map((group, index) => (
            <div key={group.title || `root-${index}`} className="flex flex-col gap-1">
              {group.title ? (
                <p className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.title}
                </p>
              ) : null}
              {group.items.map((item) => {
                const selected = item.route === route;
                return (
                  <button
                    key={item.route}
                    type="button"
                    onClick={() => onNavigate(item.route)}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "group flex items-start gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors",
                      selected
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {/* The hint sits under the label: the rail is a fixed width,
                        so anything sharing the label's line truncates the label. */}
                    <span className="mt-0.5 shrink-0 [&>svg]:size-4">{item.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.label}</span>
                      <span
                        className={cn(
                          "mt-0.5 block truncate text-[11px]",
                          selected
                            ? "text-primary-foreground/70"
                            : "text-muted-foreground",
                        )}
                      >
                        {item.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {error ? (
            <div className="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-px size-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          ) : null}
          <div
            key={active?.route ?? route}
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4"
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
