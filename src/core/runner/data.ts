/**
 * Iteration data parsing (CSV, JSON, XLSX) and data-grid helpers.
 * Each row maps to variables by column header for one iteration.
 */
import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { DataTable } from "../types";

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

function fromRecords(records: Record<string, unknown>[]): DataTable {
  const columns: string[] = [];
  for (const r of records) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  return { columns, rows: records.map((r) => Object.fromEntries(columns.map((c) => [c, cell(r[c])]))) };
}

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

/** A parsed table plus non-lossy oddities the user should know about (e.g. padded short rows). */
export interface ParsedData {
  table: DataTable;
  warnings: DataIssue[];
}

const fields = (n: number) => `${n} field${n === 1 ? "" : "s"}`;
const isBlank = (v: string | undefined) => (v ?? "").trim() === "";

/**
 * Parse CSV/TSV (delimiter auto-detected). Anything that would silently drop or
 * overwrite a cell (malformed quotes, extra fields, duplicate or blank headers
 * over non-empty data) throws a DataValidationError instead.
 */
export function readCsv(text: string): ParsedData {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { skipEmptyLines: "greedy" });
  const errors: DataIssue[] = result.errors
    .filter((e) => e.type === "Quotes")
    .map((e) => ({ row: e.row === undefined ? undefined : e.row + 1, message: e.message }));
  const warnings: DataIssue[] = [];
  const [header = [], ...records] = result.data;
  const names = header.map((h) => h.trim());

  const keep: number[] = [];
  const seen = new Map<string, number>();
  names.forEach((name, i) => {
    if (name === "") {
      const row = records.findIndex((r) => !isBlank(r[i]));
      if (row >= 0) errors.push({ row: row + 2, message: `column ${i + 1} has values but no header` });
      return;
    }
    const first = seen.get(name);
    if (first !== undefined) {
      errors.push({ column: name, message: `duplicate header (columns ${first + 1} and ${i + 1})` });
      return;
    }
    seen.set(name, i);
    keep.push(i);
  });

  records.forEach((r, i) => {
    const row = i + 2;
    if (r.length > header.length && r.slice(header.length).some((v) => !isBlank(v))) {
      errors.push({
        row,
        message: `${fields(r.length)} but the header has ${header.length}; extra values would be lost`,
      });
    } else if (r.length < header.length) {
      warnings.push({
        row,
        message: `${fields(r.length)} but the header has ${header.length}; missing cells left empty`,
      });
    }
  });

  if (errors.length) throw new DataValidationError(errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0)));
  const columns = keep.map((i) => names[i]);
  return {
    table: { columns, rows: records.map((r) => Object.fromEntries(keep.map((i) => [names[i], r[i] ?? ""]))) },
    warnings,
  };
}

export function parseCsv(text: string): DataTable {
  return readCsv(text).table;
}

export function parseJsonData(text: string): DataTable {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("JSON iteration data must be an array of objects");
  return fromRecords(data.map((d) => (d && typeof d === "object" ? d : { value: d })));
}

export function parseXlsx(buf: ArrayBuffer | Uint8Array, sheet?: string): DataTable {
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[sheet ?? wb.SheetNames[0]];
  if (!ws) throw new Error("Workbook has no sheets");
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "", raw: false });
  return fromRecords(records);
}

/** Detect the format from the file name and parse, keeping CSV warnings. */
export function readDataFile(name: string, content: ArrayBuffer | Uint8Array | string): ParsedData {
  const lower = name.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    if (typeof content === "string") throw new Error("XLSX data must be binary");
    return { table: parseXlsx(content), warnings: [] };
  }
  const text = typeof content === "string" ? content : new TextDecoder().decode(content);
  if (lower.endsWith(".json")) return { table: parseJsonData(text), warnings: [] };
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) return readCsv(text);
  const t = text.trimStart();
  return t.startsWith("[") ? { table: parseJsonData(text), warnings: [] } : readCsv(text);
}

export function parseDataFile(name: string, content: ArrayBuffer | Uint8Array | string): DataTable {
  return readDataFile(name, content).table;
}

// ------------------------------------------------------------------ grid operations (pure)

/** Trim headers and cells. Throws (leaving the table untouched) if trimmed headers would collide or go blank. */
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
