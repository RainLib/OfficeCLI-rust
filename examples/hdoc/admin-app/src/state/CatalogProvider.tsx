import * as React from "react";

import { api, ApiError } from "@/lib/api";
import type {
  CatalogFont,
  DocumentSummary,
  ThemeRevision,
} from "@/lib/types";

interface CatalogState {
  fonts: CatalogFont[];
  themes: ThemeRevision[];
  retired: string[];
  /** Null when this build of `hdoc serve` has no document list route. */
  documents: DocumentSummary[] | null;
  loaded: boolean;
  busy: boolean;
  error: string | null;
  /** Set when the token is missing or rejected, so views can point at one fix. */
  unauthorized: boolean;
  refresh: () => Promise<void>;
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
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [unauthorized, setUnauthorized] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    try {
      const [nextFonts, nextThemes, nextRetired] = await Promise.all([
        api.fonts(),
        api.themes(),
        api.retiredThemes(),
      ]);
      setFonts(nextFonts);
      setThemes(nextThemes);
      setRetired(nextRetired);
      setError(null);
      setUnauthorized(false);
      setLoaded(true);
      // The document list is a separate authority; a missing route must not
      // take the whole console down.
      try {
        setDocuments(await api.documents());
      } catch (cause) {
        if (cause instanceof ApiError && (cause.status === 404 || cause.status === 400)) {
          setDocuments(null);
        } else {
          throw cause;
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setUnauthorized(
        cause instanceof ApiError && (cause.status === 401 || cause.status === 403),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = React.useMemo<CatalogState>(
    () => ({
      fonts,
      themes,
      retired,
      documents,
      loaded,
      busy,
      error,
      unauthorized,
      refresh,
    }),
    [
      fonts,
      themes,
      retired,
      documents,
      loaded,
      busy,
      error,
      unauthorized,
      refresh,
    ],
  );

  return (
    <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>
  );
}

/** `<fontId>/<fontRevisionId>` options for the six theme slots. */
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
