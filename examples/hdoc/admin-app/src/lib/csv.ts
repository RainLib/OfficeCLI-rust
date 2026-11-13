import { auditActionName } from "./format";
import type { AuditEntry } from "./types";

/**
 * Text exported for a spreadsheet.
 *
 * The rows here are the rows on screen, not a second read from the server: an
 * export that quietly disagreed with the table would be worse than no export.
 */

/**
 * Values a spreadsheet would evaluate instead of display. Font ids, families and
 * document names are typed by people, so a cell can start with `=`.
 */
const FORMULA_LEADING = /^[=+\-@\t]/;

/** Quote what CSV cannot carry bare, and mark what a spreadsheet would run. */
export function csvCell(value: string): string {
  const text = FORMULA_LEADING.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(values: string[]): string {
  return values.map(csvCell).join(",");
}

/**
 * Epoch milliseconds as the day-bounded UTC stamp the log itself rotates on.
 * Local time would make a forwarded file ambiguous about which day a line fell
 * in, and the window picker is measured in UTC days.
 */
export function utcStamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19)}Z`;
}

export const AUDIT_CSV_HEADER = ["时间UTC", "动作", "动作名", "对象", "操作者", "详情"];

export function auditCsvRow(entry: AuditEntry): string {
  return csvRow([
    utcStamp(entry.at),
    entry.action,
    // The raw id stays in `动作`: a line from a newer build has no name here,
    // and the export must not drop it or invent one.
    auditActionName(entry.action),
    entry.target,
    entry.actor,
    entry.detail ?? "",
  ]);
}

export function auditCsv(entries: AuditEntry[]): string {
  const lines = [csvRow(AUDIT_CSV_HEADER), ...entries.map(auditCsvRow)];
  // Excel and WPS read a plain UTF-8 CSV as the local code page and garble
  // Chinese operator names; the BOM says otherwise.
  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * Name the file after the window it was read from, so a saved export says what
 * it covers. `n<count>` is the row count, not a page number: the count is part
 * of what an auditor checks when two exports are supposed to be the same.
 */
export function auditCsvName(from: string, to: string, count: number): string {
  const span = [from.trim(), to.trim()].filter(Boolean).join("_");
  return `hcd-audit-${span || "recent"}-n${count}.csv`;
}

/** Hand the built text to the browser as a download. */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // The click is not a fetch: revoke on a timer so the file still has a body.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
