/**
 * Iteration data parsing (CSV, JSON, XLSX) and data-grid helpers.
 * Each row maps to variables by column header for one iteration.
 */
import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { DataTable } from "../types";
import { DataValidationError, type DataIssue } from "./table";

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

export {
  DataValidationError,
  formatIssue,
  type DataIssue,
  dedupeRows,
  deleteColumn,
  dropEmptyRows,
  filterRows,
  renameColumn,
  toCsv,
  trimWhitespace,
} from "./table";
