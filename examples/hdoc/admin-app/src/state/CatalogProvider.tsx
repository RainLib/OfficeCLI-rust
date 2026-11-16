import * as React from "react";
import { api, ApiError, tokenStore } from "@/lib/api";
import type {
  AdminSession,
  AgentRun,
  CatalogFont,
  DocumentSummary,
  ServiceInfo,
  ThemeRevision,
  WorkspaceJob,
} from "@/lib/types";

interface CatalogState {
  fonts: CatalogFont[];
  themes: ThemeRevision[];
  retired: string[];
  documents: DocumentSummary[] | null;
  jobs: WorkspaceJob[];
  runs: AgentRun[];
  session: AdminSession | null;
  service: ServiceInfo | null;
  taskWarning: string | null;
  loaded: boolean;
  busy: boolean;
  error: string | null;
  unauthorized: boolean;
  refresh: () => Promise<void>;
  refreshTasks: () => Promise<void>;
}
const CatalogContext = React.createContext<CatalogState | null>(null);
export function useCatalog(): CatalogState {
  const context = React.useContext(CatalogContext);
  if (!context) throw new Error("useCatalog 必须在 CatalogProvider 内使用");
  return context;
}

export function CatalogProvider({ children }: { children: React.ReactNode }) {
  const [fonts, setFonts] = React.useState<CatalogFont[]>([]);
  const [themes, setThemes] = React.useState<ThemeRevision[]>([]);
  const [retired, setRetired] = React.useState<string[]>([]);
  const [documents, setDocuments] = React.useState<DocumentSummary[] | null>(
    null,
  );
  const [jobs, setJobs] = React.useState<WorkspaceJob[]>([]);
  const [runs, setRuns] = React.useState<AgentRun[]>([]);
  const [session, setSession] = React.useState<AdminSession | null>(null);
  const [service, setService] = React.useState<ServiceInfo | null>(null);
  const [taskWarning, setTaskWarning] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [unauthorized, setUnauthorized] = React.useState(false);
  const generation = React.useRef(0);
  const taskGeneration = React.useRef(0);
  const mounted = React.useRef(true);
  const clear = React.useCallback(() => {
    setFonts([]);
    setThemes([]);
    setRetired([]);
    setDocuments(null);
    setJobs([]);
    setRuns([]);
    setSession(null);
    setService(null);
    setLoaded(false);
    setTaskWarning(null);
  }, []);

  const refreshTasks = React.useCallback(async () => {
    if (!tokenStore.get()) return;
    const credential = tokenStore.get(),
      sequence = ++taskGeneration.current;
    const results = await Promise.allSettled([api.jobs(), api.agentRuns()]);
    if (
      !mounted.current ||
      credential !== tokenStore.get() ||
      sequence !== taskGeneration.current
    )
      return;
    if (
      results.some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ApiError &&
          [401, 403].includes(result.reason.status),
      )
    ) {
      clear();
      setUnauthorized(true);
      return;
    }
    const warnings: string[] = [];
    const [nextJobs, nextRuns] = results;
    if (nextJobs.status === "fulfilled") {
      setJobs(nextJobs.value.jobs);
      if (nextJobs.value.unreadable)
        warnings.push(`${nextJobs.value.unreadable} 条任务记录无法读取`);
      if (nextJobs.value.truncated)
        warnings.push("仅显示最近 500 项导入导出任务");
    } else {
      setJobs([]);
      warnings.push(`任务读取失败：${String(nextJobs.reason)}`);
    }
    if (nextRuns.status === "fulfilled") {
      setRuns(nextRuns.value.runs);
      if (nextRuns.value.truncated) warnings.push("仅显示最近 200 项 AI 任务");
    } else {
      setRuns([]);
      warnings.push(`AI 任务读取失败：${String(nextRuns.reason)}`);
    }
    setTaskWarning(warnings.join("；") || null);
  }, [clear]);

  const refresh = React.useCallback(async () => {
    const sequence = ++generation.current,
      credential = tokenStore.get();
    if (!credential) {
      setFonts([]);
      setThemes([]);
      setRetired([]);
      setDocuments(null);
      setJobs([]);
      setRuns([]);
      setSession(null);
      setService(null);
      setLoaded(false);
      setBusy(false);
      setError(null);
      setUnauthorized(false);
      setTaskWarning(null);
      return;
    }
    setBusy(true);
    const results = await Promise.allSettled([
      api.fonts(),
      api.themes(),
      api.retiredThemes(),
      api.workspace(),
      api.session(),
      api.service(),
    ]);
    if (
      !mounted.current ||
      sequence !== generation.current ||
      credential !== tokenStore.get()
    )
      return;
    const [f, t, r, d, a, s] = results;
    const failures = results.filter((result) => result.status === "rejected");
    const denied = failures.find(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof ApiError &&
        [401, 403].includes(result.reason.status),
    );
    if (denied) {
      setFonts([]);
      setThemes([]);
      setRetired([]);
      setDocuments(null);
      setJobs([]);
      setRuns([]);
      setSession(null);
      setService(null);
      setUnauthorized(true);
      setLoaded(false);
    } else {
      if (f.status === "fulfilled") setFonts(f.value);
      if (t.status === "fulfilled") setThemes(t.value);
      if (r.status === "fulfilled") setRetired(r.value);
      if (d.status === "fulfilled") setDocuments(d.value.documents);
      if (a.status === "fulfilled") setSession(a.value);
      if (s.status === "fulfilled") setService(s.value);
      setUnauthorized(false);
      setLoaded(true);
    }
    setError(
      failures.length
        ? failures.map((result) => String(result.reason)).join("；")
        : null,
    );
    setBusy(false);
    if (!denied) await refreshTasks();
  }, [refreshTasks]);

  React.useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = tokenStore.subscribe(() => {
      generation.current++;
      taskGeneration.current++;
      clear();
      void refresh();
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshTasks();
    }, 5000);
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [refresh, refreshTasks, clear]);
  return (
    <CatalogContext.Provider
      value={{
        fonts,
        themes,
        retired,
        documents,
        jobs,
        runs,
        session,
        service,
        taskWarning,
        loaded,
        busy,
        error,
        unauthorized,
        refresh,
        refreshTasks,
      }}
    >
      {children}
    </CatalogContext.Provider>
  );
}

export function slotOptions(fonts: CatalogFont[]) {
  return fonts.flatMap((font) =>
    font.revisions
      .filter((revision) => revision.faces.length > 0)
      .map((revision) => ({
        value: `${font.fontId}/${revision.fontRevisionId}`,
        label: `${font.fontId} · ${revision.family}（${revision.fontRevisionId.slice(0, 8)}…）`,
      })),
  );
}
