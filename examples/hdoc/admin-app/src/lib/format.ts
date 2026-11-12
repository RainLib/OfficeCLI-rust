import type { FontFace, FontFormat, FontLicense, FontScript } from "./types";

export const GROUP_NAMES: Record<"major" | "minor", string> = {
  major: "标题",
  minor: "正文",
};

export const SLOT_KEYS = ["latin", "eastAsia", "bidi"] as const;

export const SLOT_NAMES: Record<(typeof SLOT_KEYS)[number], string> = {
  latin: "西文",
  eastAsia: "东亚",
  bidi: "双向",
};

export const SCRIPT_OPTIONS: FontScript[] = [
  "latin",
  "eastAsia",
  "bidi",
  "hans",
  "hant",
  "arab",
];

/** Byte sizes stay on one table line; the exact value belongs in the tooltip. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function formatExactBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} 字节`;
}

export function shortId(value: string, keep = 12): string {
  return value.length > keep ? `${value.slice(0, keep)}…` : value;
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("zh-CN");
}

export function licenseExpired(license: FontLicense): boolean {
  if (license.expiresAtEpochMs === undefined) return false;
  return Date.now() > license.expiresAtEpochMs;
}

export function faceLabel(face: FontFace): string {
  const scripts = face.scripts.join("/");
  return `${face.subfamily} ${face.weight} ${face.style}${face.stretch === "normal" ? "" : ` ${face.stretch}`} · ${scripts}`;
}

export function guessFormat(name: string): FontFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".woff2")) return "woff2";
  if (lower.endsWith(".otf")) return "otf";
  if (lower.endsWith(".ttf")) return "ttf";
  return null;
}

export function subfamilyOf(name: string): string {
  const base = name.replace(/\.[^.]*$/, "").replace(/^.*[-_]/, "");
  return base || "Regular";
}

/** Catalog ids are content-addressed, so a prefix is enough to eyeball one. */
export function idTitle(value: string): string {
  return value;
}
