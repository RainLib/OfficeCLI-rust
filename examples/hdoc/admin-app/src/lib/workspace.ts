import { useSyncExternalStore } from "react";
import { ApiError, request } from "./api";
import type {
  DocumentAccess,
  ExportCapabilities,
  RevisionRecord,
} from "./types";

const KEY = "hcdAdminDocumentTokens";
const change = new Set<() => void>();
let credentials: Record<string, string> = (() => {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([id, token]) =>
          /^[\w-]{1,128}$/.test(id) &&
          typeof token === "string" &&
          token.length <= 16384,
      ),
    );
  } catch {
    return {};
  }
})();

export const documentTokens = {
  get: (id: string) => credentials[id] || "",
  set(id: string, token: string) {
    credentials = { ...credentials, [id]: token.trim() };
    if (!token.trim()) delete credentials[id];
    try {
      sessionStorage.setItem(KEY, JSON.stringify(credentials));
    } catch {
      /* Memory only. */
    }
    change.forEach((listener) => listener());
  },
  clear() {
    credentials = {};
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* Memory only. */
    }
    change.forEach((listener) => listener());
  },
};

export function useDocumentToken(id: string) {
  return useSyncExternalStore(
    (listener) => {
      change.add(listener);
      return () => {
        change.delete(listener);
      };
    },
    () => documentTokens.get(id),
  );
}

export async function documentJson<T>(
  id: string,
  path: string,
  init?: RequestInit,
  token = documentTokens.get(id),
): Promise<T> {
  if (!token) throw new ApiError("请先连接此文档的只读或写入令牌。", 401);
  const response = await request(
    `/v1/documents/${encodeURIComponent(id)}${path}`,
    init,
    token,
  );
  return response.json() as Promise<T>;
}

export const documentApi = {
  auth: (id: string, token?: string) =>
    documentJson<DocumentAccess>(id, "/auth", undefined, token),
  revisions: (id: string, before?: number) =>
    documentJson<{
      headRevision: number;
      revisions: RevisionRecord[];
      nextBefore: number | null;
    }>(
      id,
      `/revisions?limit=30${before === undefined ? "" : `&before=${before}`}`,
    ),
  capabilities: (id: string, revision: number) =>
    documentJson<ExportCapabilities>(
      id,
      `/export-capabilities?revision=${revision}`,
    ),
  restore: (
    id: string,
    revision: number,
    expectedRevision: number,
    epoch: number,
  ) =>
    documentJson<{ revision: number }>(id, `/restore/${revision}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HCD-Collaboration-Epoch": String(epoch),
      },
      body: JSON.stringify({ expectedRevision }),
    }),
  download: (id: string, format: string, revision: number, source: boolean) =>
    documentJson<{ url: string; filename: string; revision: number }>(
      id,
      `/downloads/${encodeURIComponent(format)}?revision=${revision}&source=${source}`,
      { method: "POST" },
    ),
  cancelRun: (id: string, runId: string) =>
    documentJson<{ message: string }>(
      id,
      `/agent-runs/${encodeURIComponent(runId)}`,
      { method: "DELETE" },
    ),
};

const SETTINGS_KEY = "hcdAdminEditorSettings";
export function editorSettings(): { url: string } {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (value && typeof value.url === "string") return { url: value.url };
  } catch {
    /* Use the local reference editor. */
  }
  return {
    url: import.meta.env.VITE_HCD_EDITOR_URL || "http://127.0.0.1:8767/",
  };
}
export function saveEditorSettings(url: string) {
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("编辑器地址需要不含身份信息的 HTTP 或 HTTPS 地址。");
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ url: parsed.href }));
}

/** Credentials travel through an origin-bound handshake, never in a URL. */
export async function openEditor(id?: string): Promise<void> {
  const url = new URL(editorSettings().url);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("请先在服务设置中配置编辑器地址。");
  const token = id ? documentTokens.get(id) : "";
  if (id && !token) throw new Error("请先连接文档令牌，再打开编辑器。");
  const nonce = crypto.randomUUID();
  if (id) url.hash = `admin-open=${nonce}`;
  const child = window.open(url.href, "_blank");
  if (!child) throw new Error("浏览器阻止了打开编辑器，请允许弹出窗口。");
  if (!id) {
    child.opener = null;
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (error) reject(error);
      else resolve();
    };
    const receive = (event: MessageEvent) => {
      if (
        event.source !== child ||
        event.origin !== url.origin ||
        event.data?.nonce !== nonce
      )
        return;
      if (event.data.type === "hcd-editor-ready")
        child.postMessage(
          { type: "hcd-admin-open", nonce, documentId: id, token },
          url.origin,
        );
      if (event.data.type === "hcd-editor-opened") finish();
      if (event.data.type === "hcd-editor-error")
        finish(new Error("编辑器未能打开文档，请检查连接与令牌。"));
    };
    const timer = window.setTimeout(
      () =>
        finish(
          new Error("编辑器连接超时，请检查服务设置中的地址和编辑器版本。"),
        ),
      15000,
    );
    window.addEventListener("message", receive);
  });
}

export function formatTime(value?: number) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(value)
    : "—";
}

export const activeStates = new Set(["running", "queued", "cancelling"]);
export function stateLabel(state: string) {
  return (
    (
      {
        COMPLETE: "已就绪",
        IMPORTING: "导入中",
        queued: "排队中",
        running: "正在处理",
        completed: "已完成",
        failed: "处理失败",
        interrupted: "已中断",
        cancelling: "正在停止",
        cancelled: "已停止",
        conflict: "需要重新读取",
        stopped: "已停止",
        pending: "等待处理",
        leased: "执行中",
        verified: "已核验",
        done: "已完成",
      } as Record<string, string>
    )[state] || state
  );
}
