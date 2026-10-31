/** Versioned workspace iteration data. Rows remain server-side when used by runs or schedules. */
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DatasetRef, DatasetSummary } from "@/core/types";
import {
  datasetCreateSchema,
  datasetRevisionSchema,
  datasetPatchSchema,
  datasetRefSchema,
  suggestedSecretColumns,
  validateDataset,
  maskDataset,
  parseDatasetImport,
  type DatasetPackage,
} from "@/core/runner/datasets";
import { credentialRedactionValues } from "@/core/retention";
import { getDb, schema } from "./db";
import { actorId, authorize, workspaceRole } from "./authorize";
import { currentCaller } from "./access-context";
import { newId } from "./defaults";
import { HttpError, notFound } from "./errors";
import * as repo from "./repo";
const { datasets, datasetVersions, schedules, runs } = schema;
const row = (id: string) => {
  const dataset = getDb().select().from(datasets).where(eq(datasets.id, id)).get();
  if (!dataset) throw notFound("Dataset");
  return dataset;
};
function content(input: z.infer<typeof datasetCreateSchema> | z.infer<typeof datasetRevisionSchema>) {
  const secretColumns = input.secretColumns ?? suggestedSecretColumns(input.table.columns);
  try {
    return {
      table: validateDataset(input.table, secretColumns),
      secretColumns,
      missingSecrets: input.missingSecrets ?? false,
    };
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid dataset");
  }
}
export function requireDatasetRef(workspaceId: string, raw: DatasetRef, { runnable = false } = {}) {
  const reference = datasetRefSchema.parse(raw),
    dataset = row(reference.id);
  if (dataset.workspaceId !== workspaceId) throw notFound("Dataset");
  const version = reference.version ?? dataset.latestVersion;
  const revision = getDb()
    .select({
      version: datasetVersions.version,
      rows: datasetVersions.rowCount,
      columns: datasetVersions.columns,
      secretColumns: datasetVersions.secretColumns,
      missingSecrets: datasetVersions.missingSecrets,
      createdAt: datasetVersions.createdAt,
      createdBy: datasetVersions.createdBy,
    })
    .from(datasetVersions)
    .where(and(eq(datasetVersions.datasetId, dataset.id), eq(datasetVersions.version, version)))
    .get();
  if (!revision) throw notFound("Dataset version");
  if (runnable && (!revision.rows || !revision.columns.length))
    throw new HttpError(400, "Dataset has no iteration rows or columns");
  if (runnable && revision.missingSecrets)
    throw new HttpError(
      400,
      "Dataset secret values were omitted. Save a new version with supplied or intentionally blank values before running.",
    );
  return {
    ...revision,
    id: dataset.id,
    workspaceId,
    name: dataset.name,
    description: dataset.description,
    latestVersion: dataset.latestVersion,
    updatedAt: dataset.updatedAt,
    canEdit: workspaceRole(currentCaller(), workspaceId) !== "viewer",
  };
}
export function listDatasets(workspaceId: string): DatasetSummary[] {
  repo.requireWorkspace(workspaceId);
  const rows = getDb()
    .select()
    .from(datasets)
    .where(eq(datasets.workspaceId, workspaceId))
    .orderBy(desc(datasets.updatedAt))
    .all();
  return rows.map((dataset) => {
    const revision = requireDatasetRef(workspaceId, { id: dataset.id });
    return { ...revision, createdAt: dataset.createdAt };
  });
}
export function getDataset(
  id: string,
  options: { version?: number; includeSecrets?: boolean; previewRows?: number } = {},
) {
  const dataset = row(id);
  if (options.includeSecrets) authorize(currentCaller(), dataset.workspaceId, "write");
  const metadata = requireDatasetRef(dataset.workspaceId, { id, version: options.version });
  const revision = getDb()
    .select()
    .from(datasetVersions)
    .where(and(eq(datasetVersions.datasetId, id), eq(datasetVersions.version, metadata.version)))
    .get()!;
  const table = options.previewRows
    ? { columns: revision.table.columns, rows: revision.table.rows.slice(0, options.previewRows) }
    : revision.table;
  return {
    ...metadata,
    createdAt: dataset.createdAt,
    versionCreatedAt: revision.createdAt,
    versionCreatedBy: revision.createdBy,
    table: options.includeSecrets ? table : maskDataset(table, revision.secretColumns),
    valuesOmitted: !options.includeSecrets && revision.secretColumns.length > 0,
  };
}
export function listDatasetVersions(id: string) {
  row(id);
  return getDb()
    .select({
      version: datasetVersions.version,
      rows: datasetVersions.rowCount,
      columns: datasetVersions.columns,
      secretColumns: datasetVersions.secretColumns,
      missingSecrets: datasetVersions.missingSecrets,
      createdAt: datasetVersions.createdAt,
      createdBy: datasetVersions.createdBy,
    })
    .from(datasetVersions)
    .where(eq(datasetVersions.datasetId, id))
    .orderBy(desc(datasetVersions.version))
    .all();
}
export function createDataset(workspaceId: string, raw: z.input<typeof datasetCreateSchema>) {
  repo.requireWorkspace(workspaceId);
  const input = datasetCreateSchema.parse(raw),
    data = content(input),
    id = newId(),
    now = Date.now();
  getDb().transaction((tx) => {
    tx.insert(datasets)
      .values({
        id,
        workspaceId,
        name: input.name,
        description: input.description ?? "",
        latestVersion: 1,
        createdBy: actorId(),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(datasetVersions)
      .values({
        datasetId: id,
        version: 1,
        ...data,
        rowCount: data.table.rows.length,
        columns: data.table.columns,
        createdBy: actorId(),
        createdAt: now,
      })
      .run();
  });
  return getDataset(id);
}
export function createDatasetVersion(id: string, raw: z.input<typeof datasetRevisionSchema>) {
  const input = datasetRevisionSchema.parse(raw),
    data = content(input);
  getDb().transaction((tx) => {
    const dataset = row(id);
    if (input.expectedVersion !== dataset.latestVersion)
      throw new HttpError(409, "Dataset changed. Reload before saving a new version.");
    const version = dataset.latestVersion + 1;
    tx.insert(datasetVersions)
      .values({
        datasetId: id,
        version,
        ...data,
        rowCount: data.table.rows.length,
        columns: data.table.columns,
        createdBy: actorId(),
        createdAt: Date.now(),
      })
      .run();
    tx.update(datasets)
      .set({
        latestVersion: version,
        name: input.name ?? dataset.name,
        description: input.description ?? dataset.description,
        updatedAt: Date.now(),
      })
      .where(eq(datasets.id, id))
      .run();
  });
  return getDataset(id);
}
export function updateDataset(id: string, raw: z.input<typeof datasetPatchSchema>) {
  row(id);
  const patch = datasetPatchSchema.parse(raw);
  getDb()
    .update(datasets)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(datasets.id, id))
    .run();
  return getDataset(id);
}
export function datasetReferences(id: string) {
  row(id);
  const scheduled = getDb()
    .select({ id: schedules.id, name: schedules.name, enabled: schedules.enabled })
    .from(schedules)
    .where(eq(schedules.datasetId, id))
    .all();
  const handles = (globalThis as typeof globalThis & { __postboxActiveRuns?: Map<string, unknown> })
    .__postboxActiveRuns;
  const active = getDb()
    .select({ id: runs.id, name: runs.name, status: runs.status })
    .from(runs)
    .where(and(eq(runs.datasetId, id), inArray(runs.status, ["queued", "running"])))
    .all()
    .filter((run) => handles?.has(run.id));
  return { schedules: scheduled, runs: active };
}
export function deleteDataset(id: string) {
  return getDb().transaction((tx) => {
    const refs = datasetReferences(id);
    if (refs.schedules.length || refs.runs.length)
      throw new HttpError(
        409,
        "Dataset is referenced by schedules or active runs. Detach schedule references and finish/cancel runs before deleting it.",
      );
    tx.delete(datasets).where(eq(datasets.id, id)).run();
    return { ok: true };
  });
}
export function resolveDataset(workspaceId: string, reference: DatasetRef) {
  const metadata = requireDatasetRef(workspaceId, reference, { runnable: true });
  const revision = getDb()
    .select()
    .from(datasetVersions)
    .where(and(eq(datasetVersions.datasetId, reference.id), eq(datasetVersions.version, metadata.version)))
    .get()!;
  const values = [
    ...new Set(
      revision.table.rows.flatMap((record) =>
        revision.secretColumns.map((column) => record[column]).filter(Boolean),
      ),
    ),
  ];
  return { ...metadata, table: revision.table, secrets: credentialRedactionValues(values) };
}
export function exportDataset(
  id: string,
  options: { version?: number; includeSecrets?: boolean } = {},
): DatasetPackage {
  const document = getDataset(id, { version: options.version, includeSecrets: options.includeSecrets }),
    secret = new Set(document.secretColumns);
  return {
    format: "postbox.dataset",
    formatVersion: 1,
    name: document.name,
    description: document.description,
    sourceVersion: document.version,
    secretColumns: document.secretColumns,
    missingSecrets: document.missingSecrets || document.valuesOmitted,
    table: document.valuesOmitted
      ? {
          columns: document.table.columns,
          rows: document.table.rows.map((row) =>
            Object.fromEntries(
              document.table.columns.map((column) => [column, secret.has(column) ? "" : row[column]]),
            ),
          ),
        }
      : document.table,
  };
}
export const datasetImportSchema = z.object({
  content: z.string(),
  format: z.enum(["csv", "json", "package"]),
  name: z.string().optional(),
  secretColumns: z.array(z.string()).optional(),
});
export function importDataset(workspaceId: string, raw: z.input<typeof datasetImportSchema>) {
  const input = datasetImportSchema.parse(raw);
  try {
    const parsed = parseDatasetImport(input);
    return { ...createDataset(workspaceId, parsed), warnings: parsed.warnings };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid dataset import");
  }
}
