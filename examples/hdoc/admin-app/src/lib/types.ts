// Shapes mirror the camelCase JSON that `hdoc serve` returns for the catalog.

export type FontStyle = "normal" | "italic" | "oblique";
export type FontStretch = "normal" | "condensed" | "expanded";
export type FontFormat = "woff2" | "otf" | "ttf";
export type FontScript =
  | "latin"
  | "eastAsia"
  | "bidi"
  | "hans"
  | "hant"
  | "arab";

export interface FontLicense {
  name: string;
  webPreview: boolean;
  ooxmlEmbed: boolean;
  pdfEmbed: boolean;
  redistribution: boolean;
  expiresAtEpochMs?: number;
}

export interface FontFace {
  family: string;
  subfamily: string;
  weight: number;
  style: FontStyle;
  stretch: FontStretch;
  scripts: FontScript[];
  format: FontFormat;
  sha256: string;
  byteLength: number;
}

export interface FontRevision {
  schemaVersion: string;
  fontId: string;
  fontRevisionId: string;
  family: string;
  faces: FontFace[];
  license: FontLicense;
}

export interface CatalogFont {
  fontId: string;
  family: string;
  revisions: FontRevision[];
}

export interface FontRef {
  fontId: string;
  fontRevisionId: string;
}

export interface ThemeFontSlots {
  latin?: FontRef;
  eastAsia?: FontRef;
  bidi?: FontRef;
}

export interface ThemeRevision {
  schemaVersion: string;
  themeRevisionId: string;
  name: string;
  major: ThemeFontSlots;
  minor: ThemeFontSlots;
  fallbackFamilies: string[];
}

export interface ThemeDocumentRef {
  documentId: string;
  headPinned: boolean;
  pinnedRevisions: number[];
}

export interface DocumentSummary {
  documentId: string;
  profile: string;
  format: string;
  revision: number;
  state: string;
  themeRevisionId?: string;
}

export interface ResolvedFace {
  slot: string;
  fontId: string;
  fontRevisionId: string;
  family: string;
  subfamily: string;
  weight: number;
  style: FontStyle;
  stretch: FontStretch;
  scripts: FontScript[];
  format: FontFormat;
  sha256: string;
  byteLength: number;
  href: string;
  webPreview: boolean;
  ooxmlEmbed: boolean;
  pdfEmbed: boolean;
}

export interface ResolvedTheme {
  themeRevisionId: string;
  name: string;
  css: string;
  faces: ResolvedFace[];
  warnings?: string[];
}

export interface FontDeleteReport {
  fontId: string;
  removedRevisions: string[];
  removedBlobs: string[];
}

/**
 * One appended catalog operation. `detail` is omitted by the server when it is
 * empty, and an older line may carry an action this build has no name for, so
 * both fields are read as text rather than as a closed union.
 */
export interface AuditEntry {
  at: number;
  action: string;
  target: string;
  actor: string;
  detail?: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Lines that could not be read as records, so a short list is not the whole trail. */
  unreadable: number;
  /**
   * Lines the window contained and this page did not return. Different from
   * `unreadable`: those exist and were merely not read.
   */
  truncated?: boolean;
  /** The limit the server actually applied. */
  limit: number;
  /**
   * The window the server applied, or null for an open end. Compared against
   * what was asked: an older build ignores both parameters and answers with
   * the newest lines, which must not be shown as if it were the requested
   * week.
   */
  from?: string | null;
  to?: string | null;
}

/**
 * Which export to ask about. `docx` and `pptx` share the OOXML embedding flag,
 * `pdf` has its own, and `xlsx` registers names without ever carrying bytes.
 */
export type ExportKind = "docx" | "pptx" | "pdf" | "xlsx";

/**
 * One face of a pinned theme, as the export would treat it. `reason` is the
 * sentence the export report writes, so the console cannot invent its own
 * explanation; it is absent exactly when the bytes go into the file.
 */
export interface FontPlanEntry {
  slots: string[];
  family: string;
  subfamily: string;
  weight: number;
  style: FontStyle;
  format: FontFormat;
  sha256: string;
  byteLength: number;
  embeds: boolean;
  reason?: string;
}

export interface FontPlan {
  documentId: string;
  /** The revision the answer is about, resolved by the server. */
  revision: number;
  /** Null when that revision carries no pinned theme. */
  themeRevisionId: string | null;
  kind: ExportKind;
  entries: FontPlanEntry[];
}

/** A face picked off disk, before its bytes are stored as a blob. */
export interface PendingFace {
  name: string;
  format: FontFormat;
  bytes: Uint8Array;
  subfamily: string;
  weight: number;
  style: FontStyle;
  stretch: FontStretch;
  scripts: FontScript[];
}
