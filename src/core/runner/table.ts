/**
 * Data-grid helpers for iteration data. Kept apart from the file readers in ./data so the browser
 * can edit tables without loading the spreadsheet reader.
 */
import Papa from "papaparse";
import type { DataTable } from "../types";

/** One problem found while reading iteration data. Rows are 1-based and count the header row. */
export interface DataIssue {
  row?: number;
  column?: string;
  message: string;
}

/** Iteration data that would be lost or misread if imported as-is. */
export class DataValidationError extends Error {
  constructor(readonly issues: DataIssue[]) {
    const shown = issues.slice(0, 5).map(formatIssue);
    if (issues.length > shown.length) shown.push(`…and ${issues.length - shown.length} more`);
    super(`Invalid iteration data: ${shown.join("; ")}`);
    this.name = "DataValidationError";
  }
}

export function formatIssue(issue: DataIssue): string {
  const where = [issue.row && `row ${issue.row}`, issue.column && `column "${issue.column}"`].filter(Boolean);
  return where.length ? `${where.join(", ")}: ${issue.message}` : issue.message;
}

export function trimWhitespace(t: DataTable): DataTable {
  const columns = t.columns.map((c) => c.trim());
  const issues: DataIssue[] = [];
  columns.forEach((c, i) => {
    if (c === "") issues.push({ column: t.columns[i], message: "header would be empty after trimming" });
    else if (columns.indexOf(c) !== i)
      issues.push({
        column: c,
        message: `headers "${t.columns[columns.indexOf(c)]}" and "${t.columns[i]}" would collide`,
      });
  });
  if (issues.length) throw new DataValidationError(issues);
  return {
    columns,
    rows: t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [columns[i], (r[c] ?? "").trim()]))),
  };
}

export function dedupeRows(t: DataTable): DataTable {
  const seen = new Set<string>();
  return {
    columns: t.columns,
    rows: t.rows.filter((r) => {
      const key = JSON.stringify(t.columns.map((c) => r[c] ?? ""));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

export function deleteColumn(t: DataTable, column: string): DataTable {
  return {
    columns: t.columns.filter((c) => c !== column),
    rows: t.rows.map((r) => {
      const { [column]: _drop, ...rest } = r;
      return rest;
    }),
  };
}

export function renameColumn(t: DataTable, from: string, to: string): DataTable {
  if (!to || from === to || t.columns.includes(to)) return t;
  return {
    columns: t.columns.map((c) => (c === from ? to : c)),
    rows: t.rows.map((r) => {
      const { [from]: v, ...rest } = r;
      return { ...rest, [to]: v ?? "" };
    }),
  };
}

/** Remove rows whose every cell is empty. */
export function dropEmptyRows(t: DataTable): DataTable {
  return {
    columns: t.columns,
    rows: t.rows.filter((r) => t.columns.some((c) => (r[c] ?? "").trim() !== "")),
  };
}

/**
 * Filter rows. The query is either free text (matches any cell, case-insensitive)
 * or `column=value`, `column!=value`, `column~=substring`, `column=` (empty).
 */
export function filterRows(t: DataTable, query: string): DataTable {
  const q = query.trim();
  if (!q) return t;
  const m = /^([^=!~]+?)\s*(!=|~=|=)\s*(.*)$/.exec(q);
  if (m && t.columns.includes(m[1].trim())) {
    const col = m[1].trim();
    const val = m[3].trim();
    const pred =
      m[2] === "="
        ? (v: string) => v === val
        : m[2] === "!="
          ? (v: string) => v !== val
          : (v: string) => v.toLowerCase().includes(val.toLowerCase());
    return { columns: t.columns, rows: t.rows.filter((r) => pred(r[col] ?? "")) };
  }
  const lower = q.toLowerCase();
  return {
    columns: t.columns,
    rows: t.rows.filter((r) => t.columns.some((c) => (r[c] ?? "").toLowerCase().includes(lower))),
  };
}

export function toCsv(t: DataTable): string {
  return Papa.unparse({ fields: t.columns, data: t.rows.map((r) => t.columns.map((c) => r[c] ?? "")) });
}
