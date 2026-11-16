import * as React from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronsUpDown,
  Files,
  KeyRound,
  LayoutDashboard,
  Menu,
  Monitor,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
  RefreshCw,
  ScrollText,
  Settings2,
  Sparkles,
  Sun,
  Type,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { TokenDialog } from "@/components/TokenDialog";
import { useCatalog } from "@/state/CatalogProvider";
import { tokenStore } from "@/lib/api";
import { openEditor } from "@/lib/workspace";
import { useToast } from "@/components/Toast";
import { GlobalSearch } from "@/components/GlobalSearch";
import { cn } from "@/lib/utils";

export const NAV = [
  {
    title: "工作空间",
    items: [
      { route: "overview", label: "概览", icon: LayoutDashboard },
      { route: "documents", label: "文档管理", icon: Files },
      { route: "jobs", label: "导入与导出", icon: Activity },
      { route: "agents", label: "AI 任务", icon: Sparkles },
    ],
  },
  {
    title: "品牌资源",
    items: [
      { route: "fonts", label: "字体目录", icon: Type },
      { route: "themes", label: "主题与预览", icon: Palette },
    ],
  },
  {
    title: "服务管理",
    items: [
      { route: "tokens", label: "访问与令牌", icon: KeyRound },
      { route: "audit", label: "操作记录", icon: ScrollText },
      { route: "settings", label: "服务设置", icon: Settings2 },
    ],
  },
];

function initialDark() {
  try {
    return localStorage.getItem("hcdAdminTheme") === "dark";
  } catch {
    return false;
  }
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
  const { refresh, busy, error, unauthorized, session, service } = useCatalog();
  const toast = useToast();
  const [dark, setDark] = React.useState(initialDark);
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobile, setMobile] = React.useState(false);
  const search = React.useRef<HTMLInputElement>(null);
  const path = route.split("?")[0].split("/")[0];
  const selectedRoute =
    path === "upload" ? "fonts" : path === "preview" ? "themes" : path;
  const active = NAV.flatMap((group) => group.items).find(
    (item) => item.route === selectedRoute,
  );
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("hcdAdminTheme", dark ? "dark" : "light");
    } catch {
      /* Optional storage. */
    }
  }, [dark]);
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const navigate = (next: string) => {
    setMobile(false);
    onNavigate(next);
  };
  const navigation = (
    <>
      <div className="flex h-[38px] items-center gap-2.5 px-0.5">
        <PanelsTopLeft className="size-6 text-accent-foreground" />
        <strong className="text-[19px] font-semibold">OfficeCLI</strong>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto hidden lg:flex"
          aria-label="收起导航"
          onClick={() => setCollapsed(true)}
        >
          <PanelLeftClose className="size-4" />
        </Button>
      </div>
      <div className="flex h-12 shrink-0 items-center gap-2.5 rounded-[13px] bg-secondary px-3 text-xs">
        <Monitor className="size-4 text-muted-foreground" />
        <span>本机工作空间</span>
        <ChevronsUpDown className="ml-auto size-3.5 text-muted-foreground" />
      </div>
      <nav
        aria-label="后台导航"
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto py-1"
      >
        {NAV.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <p className="mb-1 text-[10px] text-muted-foreground">
              {group.title}
            </p>
            {group.items.map((item) => (
              <a
                key={item.route}
                href={`#/${item.route}`}
                onClick={() => setMobile(false)}
                aria-current={selectedRoute === item.route ? "page" : undefined}
                className={cn(
                  "flex h-[42px] shrink-0 items-center gap-3 rounded-[11px] px-2.5 text-xs transition-colors hover:bg-accent",
                  selectedRoute === item.route
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-foreground",
                )}
              >
                <item.icon className="size-[18px]" />
                {item.label}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="space-y-2 rounded-[14px] bg-muted p-3">
        <p className="flex items-center gap-1.5 text-[11px]">
          {service && !unauthorized ? (
            <CheckCircle2 className="size-3.5 text-success" />
          ) : (
            <AlertTriangle className="size-3.5 text-warning" />
          )}
          {service && !unauthorized ? "本机服务正常" : "等待连接服务"}
        </p>
        <p
          className="truncate text-[10px] text-muted-foreground"
          title={location.origin}
        >
          {location.host}
        </p>
      </div>
      <button
        type="button"
        onClick={() => navigate("tokens")}
        className="flex h-10 shrink-0 items-center gap-2.5 text-left"
      >
        <span className="flex size-8 items-center justify-center rounded-[10px] bg-accent text-xs font-medium text-accent-foreground">
          {(session?.displayName || session?.userId || "O")
            .slice(0, 1)
            .toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 text-xs">
          <span className="block truncate">
            {session?.displayName || session?.userId || "管理会话"}
          </span>
          <small className="text-[10px] text-muted-foreground">
            {session ? "本机管理员" : "连接管理令牌"}
          </small>
        </span>
        <MoreHorizontal className="size-4 text-muted-foreground" />
      </button>
    </>
  );
  return (
    <div className="flex h-dvh gap-[14px] overflow-hidden bg-background p-3 lg:p-4">
      {!collapsed && (
        <aside className="hidden h-full w-56 shrink-0 flex-col gap-5 rounded-[28px] bg-card p-[18px] lg:flex">
          {navigation}
        </aside>
      )}
      <Dialog open={mobile} onOpenChange={setMobile}>
        <DialogContent className="inset-y-3 left-3 top-3 flex h-[calc(100dvh-24px)] max-h-none w-[min(300px,calc(100vw-24px))] translate-x-0 translate-y-0 flex-col gap-5 rounded-[24px] border-0 p-[18px]">
          <DialogTitle className="sr-only">工作空间导航</DialogTitle>
          <DialogDescription className="sr-only">
            选择后台管理页面
          </DialogDescription>
          {navigation}
        </DialogContent>
      </Dialog>
      <div className="flex min-w-0 flex-1 flex-col gap-[14px] pb-[70px] lg:pb-0">
        <header className="flex h-11 shrink-0 items-center gap-3 px-1 lg:h-14 lg:px-3">
          <Button
            variant="ghost"
            size="icon"
            className={cn(!collapsed && "lg:hidden")}
            aria-label={collapsed ? "展开导航" : "打开导航"}
            onClick={() => {
              if (matchMedia("(min-width: 1024px)").matches)
                setCollapsed(false);
              else setMobile(true);
            }}
          >
            {collapsed ? <PanelLeftOpen /> : <Menu />}
          </Button>
          <span className="hidden truncate text-xs text-muted-foreground sm:block">
            管理后台 <span className="px-2">/</span>{" "}
            {active?.label || "工作空间"}
          </span>
          <strong className="text-base sm:hidden">OfficeCLI</strong>
          <GlobalSearch inputRef={search} onNavigate={navigate} />
          <Button
            variant="ghost"
            className="hidden sm:inline-flex"
            onClick={() => void openEditor().catch(toast.err)}
          >
            <ArrowUpRight />
            返回工作台
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={dark ? "切换浅色" : "切换深色"}
            onClick={() => setDark((value) => !value)}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
        </header>
        <main
          id="admin-main"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain rounded-[24px] bg-card p-5 lg:rounded-[28px] lg:p-8"
        >
          {(!tokenStore.get() || unauthorized) && (
            <div
              role="status"
              className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl bg-accent p-4 text-xs"
            >
              <KeyRound className="size-5 text-accent-foreground" />
              <span className="min-w-0 flex-1">
                {unauthorized
                  ? "管理会话已过期或无权访问，请更换管理令牌。"
                  : "连接管理令牌，查看本机文档与资源。"}
              </span>
              <TokenDialog onSaved={() => void refresh()} />
            </div>
          )}
          {error && !unauthorized && (
            <div
              role="alert"
              className="mb-6 flex items-start gap-3 rounded-2xl bg-destructive/10 p-4 text-xs text-destructive"
            >
              <AlertTriangle className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void refresh()}
              >
                <RefreshCw />
                重试
              </Button>
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
        </main>
      </div>
      <nav
        aria-label="手机底部导航"
        className="fixed inset-x-3 bottom-3 z-30 flex h-[58px] items-center gap-1 rounded-[20px] bg-card p-1 shadow-sm lg:hidden"
      >
        {[
          { route: "overview", label: "概览", icon: LayoutDashboard },
          { route: "documents", label: "文档", icon: Files },
          { route: "jobs", label: "任务", icon: Activity },
        ].map((item) => (
          <a
            key={item.route}
            href={`#/${item.route}`}
            aria-current={selectedRoute === item.route ? "page" : undefined}
            className={cn(
              "flex h-full flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[10px]",
              selectedRoute === item.route
                ? "text-accent-foreground"
                : "text-muted-foreground",
            )}
          >
            <item.icon className="size-[18px]" />
            {item.label}
          </a>
        ))}
        <button
          type="button"
          aria-label="更多导航"
          className="flex h-full flex-1 flex-col items-center justify-center gap-1 text-[10px] text-muted-foreground"
          onClick={() => setMobile(true)}
        >
          <MoreHorizontal className="size-[18px]" />
          更多
        </button>
      </nav>
    </div>
  );
}
