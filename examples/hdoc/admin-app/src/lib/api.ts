import type {
  AuditPage,
  CatalogFont,
  DocumentSummary,
  FontDeleteReport,
  FontFace,
  FontLicense,
  FontRevision,
  ResolvedTheme,
  ThemeDocumentRef,
  ThemeFontSlots,
  ThemeRevision,
} from "./types";

const TOKEN_KEY = "hcdAdminToken";

let token: string = (() => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
})();

const listeners = new Set<() => void>();

export const tokenStore = {
  get(): string {
    return token;
  },
  set(value: string) {
    token = value.trim();
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* private mode: keep the token for this page load only */
    }
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Every catalog call carries the pasted admin bearer token, same-origin. */
export async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${tokenStore.get()}`);
  const response = await fetch(path, { ...init, headers });
  if (response.ok) return response;

  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(
      body.error ?? "需要管理令牌：用 `officecli hdoc issue-token --document-id '*' --scope admin` 签发后粘贴。",
      response.status,
    );
  }
  throw new ApiError(body.error ?? `请求失败（${response.status}）`, response.status);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  return (await response.json()) as T;
}

function postJson<T>(path: string, payload: unknown): Promise<T> {
  return json<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function putJson<T>(path: string, payload: unknown): Promise<T> {
  return json<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const encode = encodeURIComponent;

export const api = {
  fonts: () => json<CatalogFont[]>("/v1/catalog/fonts"),
  themes: () => json<ThemeRevision[]>("/v1/catalog/themes"),
  retiredThemes: () => json<string[]>("/v1/catalog/themes/retired"),
  documents: () => json<DocumentSummary[]>("/v1/documents"),

  /**
   * The catalog operation log, newest first. The server applies its own ceiling,
   * so a large `limit` asks for the tail of the trail rather than all of it.
   */
  audit: (limit = 100) => json<AuditPage>(`/v1/catalog/audit?limit=${limit}`),

  /** Store one font binary; the catalog answers with its sha256. */
  putBlob: (
    fontId: string,
    format: string,
    bytes: Uint8Array,
  ): Promise<{ sha256: string; byteLength?: number }> =>
    json(`/v1/catalog/fonts/${encode(fontId)}/blobs?format=${format}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as BodyInit,
    }),

  createRevision: (
    fontId: string,
    payload: { family: string; faces: FontFace[]; license: FontLicense },
  ): Promise<FontRevision> =>
    postJson<FontRevision>(`/v1/catalog/fonts/${encode(fontId)}/revisions`, payload),

  deleteFont: (fontId: string) =>
    json<FontDeleteReport>(`/v1/catalog/fonts/${encode(fontId)}`, { method: "DELETE" }),

  deleteRevision: (fontId: string, fontRevisionId: string) =>
    json<FontDeleteReport>(
      `/v1/catalog/fonts/${encode(fontId)}/revisions/${encode(fontRevisionId)}`,
      { method: "DELETE" },
    ),

  createTheme: (payload: {
    name: string;
    major: ThemeFontSlots;
    minor: ThemeFontSlots;
    fallbackFamilies: string[];
  }) => postJson<ThemeRevision>("/v1/catalog/themes", payload),

  retireTheme: (themeRevisionId: string) =>
    request(`/v1/catalog/themes/${encode(themeRevisionId)}/retire`, { method: "POST" }),

  unretireTheme: (themeRevisionId: string) =>
    request(`/v1/catalog/themes/${encode(themeRevisionId)}/retire`, { method: "DELETE" }),

  themeDocuments: (themeRevisionId: string) =>
    json<ThemeDocumentRef[]>(`/v1/catalog/themes/${encode(themeRevisionId)}/documents`),

  deleteTheme: (themeRevisionId: string) =>
    request(`/v1/catalog/themes/${encode(themeRevisionId)}`, { method: "DELETE" }),

  resolveTheme: (themeRevisionId: string) =>
    json<ResolvedTheme>(`/v1/themes/${encode(themeRevisionId)}`),

  /**
   * Pin a catalog theme onto a document, or clear the pin by passing null. Both
   * write a content revision of the document: the managed stylesheet region
   * changes, the text does not. `themeRevisionId` must appear in the body, so the
   * clear is an explicit null and never an empty object.
   */
  pinDocumentTheme: (documentId: string, themeRevisionId: string | null) =>
    putJson<{ revision: number; themeRevisionId: string }>(
      `/v1/documents/${encode(documentId)}/theme`,
      { themeRevisionId },
    ),

  /** A web-preview face, fetched with the same token and turned into a blob URL. */
  faceObjectUrl: async (href: string): Promise<string> => {
    const response = await request(href);
    return URL.createObjectURL(await response.blob());
  },
};
