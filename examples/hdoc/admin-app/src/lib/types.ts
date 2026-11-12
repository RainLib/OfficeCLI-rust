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
