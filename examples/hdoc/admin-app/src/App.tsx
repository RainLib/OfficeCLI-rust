import { useEffect, useState } from "react";
import { BusinessWorkspace } from "@/views/BusinessWorkspace";
import { AppShell } from "@/components/AppShell";
import { ToastProvider } from "@/components/Toast";
import { useRoute } from "@/lib/router";
import { CatalogProvider, useCatalog } from "@/state/CatalogProvider";
import { AuditView } from "@/views/AuditView";
import { DocumentsView } from "@/views/DocumentsView";
import { FontLibraryView, ThemeLibraryView } from "@/views/LibraryViews";
import { DocumentDetailView } from "@/views/DocumentDetailView";
import { JobsView } from "@/views/JobsView";
import { AgentRunsView } from "@/views/AgentRunsView";
import { AccessView } from "@/views/AccessView";
import { SettingsView } from "@/views/SettingsView";
import { EmptyState } from "@/components/Page";
import { OverviewView } from "@/views/OverviewView";
import { PreviewView } from "@/views/PreviewView";
import { UploadView } from "@/views/UploadView";

function Routes({
  route,
  onNavigate,
}: {
  route: string;
  onNavigate: (route: string) => void;
}) {
  const { session, busy } = useCatalog();
  const [path, search = ""] = route.split("?");
  const query = new URLSearchParams(search);
  if (!session && path !== "tokens")
    return (
      <EmptyState
        title={busy ? "正在连接工作空间…" : "连接管理会话以继续"}
        description="使用上方的管理令牌入口连接当前服务。"
      />
    );
  if (path.startsWith("documents/")) {
    const id = path.slice("documents/".length);
    if (!/^[\w-]{1,128}$/.test(id)) return <EmptyState title="文档 ID 无效" />;
    const revision = query.has("revision")
      ? Number(query.get("revision"))
      : undefined;
    return (
      <DocumentDetailView
        key={id}
        documentId={id}
        initialRevision={
          revision !== undefined &&
          Number.isSafeInteger(revision) &&
          revision >= 0
            ? revision
            : undefined
        }
        onNavigate={onNavigate}
      />
    );
  }
  switch (path) {
    case "fonts":
      return (
        <FontLibraryView
          search={query.get("search") || ""}
          onNavigate={onNavigate}
        />
      );
    case "themes":
      return (
        <ThemeLibraryView
          search={query.get("search") || ""}
          onNavigate={onNavigate}
        />
      );
    case "upload":
      return <UploadView onNavigate={onNavigate} />;
    case "preview":
      return <PreviewView initialTheme={query.get("theme") || ""} />;
    case "documents":
      return (
        <DocumentsView
          key={search}
          search={query.get("search") || ""}
          initialTheme={query.get("theme") || ""}
          onNavigate={onNavigate}
        />
      );
    case "jobs":
      return <JobsView query={query} onNavigate={onNavigate} />;
    case "agents":
      return (
        <AgentRunsView
          key={search}
          initialFilter={query.get("state") || "all"}
          onNavigate={onNavigate}
        />
      );
    case "tokens":
      return <AccessView />;
    case "settings":
      return <SettingsView />;
    case "audit":
      return <AuditView />;
    case "overview":
      return <OverviewView onNavigate={onNavigate} />;
    default:
      return (
        <EmptyState
          title="没有找到这个页面"
          action={{ label: "返回概览", onClick: () => onNavigate("overview") }}
        />
      );
  }
}

function LegacyApp() {
  const [route, navigate] = useRoute();

  return (
    <ToastProvider>
      <CatalogProvider>
        <AppShell route={route} onNavigate={navigate}>
          <Routes route={route} onNavigate={navigate} />
        </AppShell>
      </CatalogProvider>
    </ToastProvider>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState<{ name: string } | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/workspace/api/status", { signal: controller.signal }).then(async response => {
      if (!response.ok) return null;
      const value = await response.json();
      return value.product === "officecli-workspace" ? value : null;
    }).then(value => { if (!controller.signal.aborted) setWorkspace(value); }).catch(() => { if (!controller.signal.aborted) setWorkspace(null); });
    return () => controller.abort();
  }, []);
  if (workspace === undefined) return <div className="grid h-dvh place-items-center bg-background text-xs text-muted-foreground">正在连接服务…</div>;
  return workspace ? <BusinessWorkspace name={workspace.name} /> : <LegacyApp />;
}
