/** Dataset interchange and validation. Stored versions retain exact string cells and column order. */
import { z } from "zod";
import type { DataTable } from "../types";
import { DataValidationError, readCsv, parseJsonData, type DataIssue } from "./data";
export const DATASET_LIMITS = {
  rows: 100_000,
  columns: 200,
  cells: 1_000_000,
  bytes: 20 * 1024 * 1024,
  secretCells: 10_000,
} as const;
export const datasetRefSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
});
export const dataTableSchema = z.object({
  columns: z.array(z.string()).max(DATASET_LIMITS.columns),
  rows: z.array(z.record(z.string(), z.string())).max(DATASET_LIMITS.rows),
});
export const datasetContentSchema = z.object({
  table: dataTableSchema,
  secretColumns: z.array(z.string()).max(DATASET_LIMITS.columns).optional(),
  missingSecrets: z.boolean().optional(),
});
export const datasetCreateSchema = datasetContentSchema.extend({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(),
});
export const datasetRevisionSchema = datasetContentSchema.extend({
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).optional(),
});
export const datasetPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).optional(),
});
const sensitiveName =
  /authorization|cookie|token|password|passwd|secret|api[-_]?key|credential|^jwt$|^signature$/i;
export const suggestedSecretColumns = (columns: string[]) =>
  columns.filter((column) => sensitiveName.test(column));
export function validateDataset(
  table: DataTable,
  secretColumns: string[] = suggestedSecretColumns(table.columns),
): DataTable {
  const issues: DataIssue[] = [];
  if (
    table.columns.length > DATASET_LIMITS.columns ||
    table.rows.length > DATASET_LIMITS.rows ||
    table.columns.length * table.rows.length > DATASET_LIMITS.cells
  )
    throw new Error("Dataset exceeds the row, column or cell limit");
  for (const [i, column] of table.columns.entries()) {
    if (!column.trim() || column !== column.trim())
      issues.push({ column, message: "Column names must be non-empty and have no surrounding whitespace" });
    if (table.columns.indexOf(column) !== i) issues.push({ column, message: "Duplicate column name" });
  }
  if (
    new Set(secretColumns).size !== secretColumns.length ||
    secretColumns.some((column) => !table.columns.includes(column))
  )
    throw new Error("Secret columns must be distinct column names in the dataset");
  if (secretColumns.length * table.rows.length > DATASET_LIMITS.secretCells)
    throw new Error("Dataset exceeds 10,000 secret cells");
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const [index, row] of table.rows.entries()) {
    for (const [column, value] of Object.entries(row)) {
      if (!table.columns.includes(column))
        issues.push({ row: index + 2, column, message: "Value has no declared column" });
      if (typeof value !== "string")
        issues.push({ row: index + 2, column, message: "Cells must be strings" });
      bytes += encoder.encode(column).byteLength + encoder.encode(value).byteLength + 8;
    }
    if (bytes > DATASET_LIMITS.bytes) throw new Error("Dataset exceeds 20 MiB of content");
    if (issues.length >= 100) break;
  }
  if (issues.length) throw new DataValidationError(issues);
  const normalized = {
    columns: [...table.columns],
    rows: table.rows.map((row) =>
      Object.fromEntries(table.columns.map((column) => [column, row[column] ?? ""])),
    ),
  };
  if (encoder.encode(JSON.stringify(normalized)).byteLength > DATASET_LIMITS.bytes)
    throw new Error("Dataset exceeds 20 MiB of serialized content");
  return normalized;
}
export function maskDataset(table: DataTable, secretColumns: string[]): DataTable {
  const secret = new Set(secretColumns);
  return {
    columns: table.columns,
    rows: table.rows.map((row) =>
      Object.fromEntries(
        table.columns.map((column) => [column, secret.has(column) ? "[REDACTED]" : (row[column] ?? "")]),
      ),
    ),
  };
}
export interface DatasetPackage {
  format: "postbox.dataset";
  formatVersion: 1;
  name: string;
  description: string;
  table: DataTable;
  secretColumns: string[];
  missingSecrets: boolean;
  sourceVersion: number;
}
export const datasetPackageSchema = datasetCreateSchema.extend({
  format: z.literal("postbox.dataset"),
  formatVersion: z.literal(1),
  sourceVersion: z.number().int().positive().optional(),
  missingSecrets: z.boolean().default(false),
});
export function parseDatasetImport(input: {
  content: string;
  format: "csv" | "json" | "package";
  name?: string;
  secretColumns?: string[];
}) {
  if (new TextEncoder().encode(input.content).byteLength > DATASET_LIMITS.bytes)
    throw new Error("Dataset import exceeds 20 MiB");
  if (input.format === "package") {
    const parsed = datasetPackageSchema.parse(JSON.parse(input.content)),
      secretColumns = parsed.secretColumns ?? suggestedSecretColumns(parsed.table.columns);
    return {
      ...parsed,
      secretColumns,
      table: validateDataset(parsed.table, secretColumns),
      warnings: [] as DataIssue[],
    };
  }
  const parsed =
    input.format === "csv" ? readCsv(input.content) : { table: parseJsonData(input.content), warnings: [] };
  const secretColumns = input.secretColumns ?? suggestedSecretColumns(parsed.table.columns);
  return {
    name: input.name?.trim() || "Imported dataset",
    description: "",
    table: validateDataset(parsed.table, secretColumns),
    secretColumns,
    missingSecrets: false,
    warnings: parsed.warnings,
  };
}
