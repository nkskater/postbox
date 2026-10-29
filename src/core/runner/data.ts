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

export function parseCsv(text: string): DataTable {
  const result = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const columns = (result.meta.fields ?? []).filter((c) => c !== "");
  return { columns, rows: result.data.map((r) => Object.fromEntries(columns.map((c) => [c, cell(r[c])]))) };
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

/** Detect the format from the file name and parse. */
export function parseDataFile(name: string, content: ArrayBuffer | Uint8Array | string): DataTable {
  const lower = name.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    if (typeof content === "string") throw new Error("XLSX data must be binary");
    return parseXlsx(content);
  }
  const text = typeof content === "string" ? content : new TextDecoder().decode(content);
  if (lower.endsWith(".json")) return parseJsonData(text);
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) return parseCsv(text);
  const t = text.trimStart();
  return t.startsWith("[") ? parseJsonData(text) : parseCsv(text);
}

// ------------------------------------------------------------------ grid operations (pure)

export function trimWhitespace(t: DataTable): DataTable {
  const columns = t.columns.map((c) => c.trim());
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
