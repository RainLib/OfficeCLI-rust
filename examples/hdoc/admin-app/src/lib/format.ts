import type {
  ExportKind,
  FontFace,
  FontFormat,
  FontLicense,
  FontScript,
} from "./types";

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

/** The four export targets the font plan answers for. */
export const EXPORT_KINDS: ExportKind[] = ["docx", "pptx", "pdf", "xlsx"];

export const EXPORT_KIND_NAMES: Record<ExportKind, string> = {
  docx: "Word (.docx)",
  pptx: "PowerPoint (.pptx)",
  pdf: "PDF",
  xlsx: "Excel (.xlsx)",
};

/**
 * The slot suffix the theme records use: `eastAsia` in the theme itself,
 * `east-asia` in the name a resolved face carries.
 */
const SLOT_SUFFIX_NAMES: Record<string, string> = {
  latin: "西文",
  "east-asia": "东亚",
  bidi: "双向",
};

/**
 * `major-east-asia` becomes 标题 · 东亚. A slot this build has no name for is
 * shown as itself rather than guessed away, because the plan is read straight
 * from the catalog and a newer theme may carry a slot nobody has named yet.
 */
export function slotName(slot: string): string {
  const cut = slot.indexOf("-");
  if (cut < 0) return slot;
  const group = slot.slice(0, cut);
  const suffix = slot.slice(cut + 1);
  const groupName = group === "major" || group === "minor" ? GROUP_NAMES[group] : null;
  const suffixName = SLOT_SUFFIX_NAMES[suffix];
  if (!groupName || !suffixName) return slot;
  return `${groupName} · ${suffixName}`;
}

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

/** Log rows are read in order, so the seconds have to show. */
export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Names for the actions this build writes. A log line may carry an action from a
 * newer build, so an unknown id is shown as itself rather than guessed away.
 */
export const AUDIT_ACTION_NAMES: Record<string, string> = {
  "font.bytes.put": "存入字库",
  "font.revision.put": "登记字体修订",
  "font.revision.delete": "删除字体修订",
  "font.delete": "删除字体",
  "theme.put": "保存主题",
  "theme.retire": "退役主题",
  "theme.unretire": "取消退役",
  "theme.delete": "删除主题",
  "document.theme.pin": "钉上主题",
  "document.theme.unpin": "取消钉版",
};

export function auditActionName(action: string): string {
  return AUDIT_ACTION_NAMES[action] ?? action;
}

export type AuditGroup = "font" | "theme" | "document";

export const AUDIT_GROUP_NAMES: Record<AuditGroup, string> = {
  font: "字体",
  theme: "主题",
  document: "文档钉版",
};

/** Which half of the catalog a line belongs to, for the filter. */
export function auditGroup(action: string): AuditGroup | null {
  if (action.startsWith("font.")) return "font";
  if (action.startsWith("theme.")) return "theme";
  if (action.startsWith("document.")) return "document";
  return null;
}

/** Removing something reads louder than adding it, so the row tone follows that. */
export function auditTone(action: string): "destructive" | "warning" | "secondary" {
  if (action.endsWith(".delete")) return "destructive";
  if (action === "theme.retire") return "warning";
  return "secondary";
}

export function licenseExpired(license: FontLicense): boolean {
  if (license.expiresAtEpochMs === undefined) return false;
  return Date.now() > license.expiresAtEpochMs;
}

/**
 * Whole days left on a license, counting any part of a day as one day, or null
 * when the license has no end date. A license due tomorrow is `1`, never `0` —
 * a date already past is not "0 days left", it is expired.
 */
export function licenseDaysLeft(license: FontLicense): number | null {
  if (license.expiresAtEpochMs === undefined) return null;
  const left = license.expiresAtEpochMs - Date.now();
  return Math.max(0, Math.ceil(left / 86_400_000));
}

/**
 * The window the exporter itself warns on, mirroring `LICENSE_WARN_WINDOW_DAYS`
 * in `hcd-core`. The 体检 answer carries the server's copy of this number, so a
 * page that shows the exporter's sentence never restates it; this constant is
 * only what the catalog-wide filters and the overview default to.
 */
export const LICENSE_WARN_WINDOW_DAYS = 30;

/** Windows offered for the expiring-soon count; the default is the exporter's. */
export const LICENSE_WINDOWS = [7, LICENSE_WARN_WINDOW_DAYS, 90];

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

/**
 * The UTC calendar day `offsetDays` back, as the audit window names it.
 *
 * Measured in UTC because that is how the log is split: `audit/2026-11-13.jsonl`
 * holds the lines the server wrote between 00:00 and 23:59 UTC, so a picker
 * keyed to the local calendar would silently ask for a window offset by the
 * timezone. `input[type=date]` carries a bare day with no zone at all, which is
 * exactly what the route expects.
 */
export function utcDay(offsetDays = 0): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}
