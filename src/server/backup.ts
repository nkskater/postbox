import { createHash, randomBytes } from "node:crypto";
import { sanitizeExample } from "@/core/examples";
import { credentialRedactionValues, sensitiveFieldValues } from "@/core/retention";
import { redactStoredValue } from "@/core/variables/resolver";
import type { MockRoute } from "@/core/mocks/model";
/**
 * Full backup and restore of workspace data, plus database maintenance.
 *
 * A backup holds workspaces, collections, requests, environments, variables, datasets,
 * schedules, workspace memberships, instance settings, the outbound proxy and TLS profiles as one
 * JSON document. It does not
 * hold accounts, sessions, API tokens, run results, history or cookies. Secret values are
 * stored in the database in plain text, so a backup that includes them must be handled like
 * a credentials file; `includeSecrets: false` produces a best-effort scrubbed copy.
 *
 * These functions take the database as an argument so they can be tested against a fresh one.
 */
import fs from "node:fs";
import { inArray, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type Database from "better-sqlite3";
import { z } from "zod";
import { OutboundNetwork } from "@/core/http/outbound";
import { withoutAuthCredentials } from "@/core/retention";
import { sanitizeSettings } from "@/lib/settings/registry";
import { schema, type DB } from "./db";

export const BACKUP_FORMAT = 1;

const TABLES = {
  documentationPublications: schema.documentationPublications,
  catalogEntries: schema.catalogEntries,
  catalogVersions: schema.catalogVersions,
  workspaces: schema.workspaces,
  grpcDefinitions: schema.grpcDefinitions,
  folders: schema.folders,
  environments: schema.environments,
  variables: schema.variables,
  requests: schema.requests,
  datasets: schema.datasets,
  datasetVersions: schema.datasetVersions,
  schedules: schema.schedules,
  mockServers: schema.mockServers,
  scriptPackages: schema.scriptPackages,
  scriptPackageVersions: schema.scriptPackageVersions,
  workspaceMembers: schema.workspaceMembers,
  appSettings: schema.appSettings,
  outboundProxy: schema.outboundProxy,
  tlsProfiles: schema.tlsProfiles,
  vaultSecrets: schema.vaultSecrets,
} as const;
type TableName = keyof typeof TABLES;
/** Insert order: parents before children. */
const ORDER: TableName[] = [
  "workspaces",
  "grpcDefinitions",
  "folders",
  "environments",
  "variables",
  "requests",
  "documentationPublications",
  "catalogEntries",
  "catalogVersions",
  "datasets",
  "datasetVersions",
  "schedules",
  "mockServers",
  "scriptPackages",
  "scriptPackageVersions",
  "workspaceMembers",
  "appSettings",
  "outboundProxy",
  "tlsProfiles",
  "vaultSecrets",
];

export interface Backup {
  postboxBackup: typeof BACKUP_FORMAT;
  exportedAt: string;
  secretsIncluded: boolean;
  tables: Record<TableName, Record<string, unknown>[]>;
}

const envelope = z.object({
  postboxBackup: z.literal(BACKUP_FORMAT),
  exportedAt: z.string().optional(),
  secretsIncluded: z.boolean().optional(),
  tables: z.object(
    Object.fromEntries(
      ORDER.map((t) => [t, z.array(z.record(z.string(), z.unknown())).default([])]),
    ) as Record<TableName, z.ZodDefault<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>,
  ),
});

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

const SENSITIVE_NAME = /authorization|cookie|token|password|secret|api[-_]?key|credential/i;
type Row = { key?: unknown; value?: unknown; [k: string]: unknown };
const maskHeaders = (rows: unknown) =>
  Array.isArray(rows)
    ? rows.map((row: Row) =>
        typeof row?.key === "string" && SENSITIVE_NAME.test(row.key) ? { ...row, value: "" } : row,
      )
    : rows;

export function createBackup(db: DB, opts: { includeSecrets: boolean }): Backup {
  const tables = {} as Backup["tables"];
  for (const name of ORDER) {
    tables[name] = db.select().from(TABLES[name]).all() as Record<string, unknown>[];
  }
  if (!opts.includeSecrets) {
    const mockSecrets = credentialRedactionValues([
      ...tables.variables.filter((v) => v.type === "secret").map((v) => String(v.value ?? "")),
      ...sensitiveFieldValues(tables.requests),
      ...sensitiveFieldValues(tables.folders),
    ]);
    tables.mockServers = tables.mockServers.map((mock) => ({
      ...redactStoredValue(mock, mockSecrets),
      id: mock.id,
      workspaceId: mock.workspaceId,
      folderId: mock.folderId,
      keyHash: randomBytes(32).toString("hex"),
      enabled: false,
      public: false,
      routes: (mock.routes as MockRoute[]).map((route) => ({
        ...redactStoredValue(route, mockSecrets),
        id: route.id,
        requestId: route.requestId,
        response: sanitizeExample(route.response, mockSecrets),
      })),
    }));
    tables.catalogVersions = tables.catalogVersions.map((version) => ({
      ...version,
      snapshot: redactStoredValue(version.snapshot, mockSecrets),
    }));
    tables.catalogEntries = tables.catalogEntries.map((entry) => ({
      ...entry,
      title: redactStoredValue(entry.title, mockSecrets),
      description: redactStoredValue(entry.description, mockSecrets),
      tags: redactStoredValue(entry.tags, mockSecrets),
      owners: redactStoredValue(entry.owners, mockSecrets),
    }));
    tables.documentationPublications = tables.documentationPublications.map((publication) => ({
      ...publication,
      snapshot: redactStoredValue(publication.snapshot, mockSecrets),
    }));
    tables.scriptPackageVersions = tables.scriptPackageVersions.map((version) => {
      const source = redactStoredValue(String(version.source), mockSecrets);
      return {
        ...version,
        source,
        hash: createHash("sha256").update(source).digest("hex"),
        approved: false,
        approvedBy: null,
      };
    });
    tables.variables = tables.variables.map((v) => (v.type === "secret" ? { ...v, value: "" } : v));
    const scrub = (r: Record<string, unknown>) => ({
      ...r,
      auth: r.auth ? withoutAuthCredentials(r.auth as never) : r.auth,
      headers: maskHeaders(r.headers),
    });
    tables.folders = tables.folders.map(scrub);
    tables.requests = tables.requests.map(scrub);
    tables.datasetVersions = tables.datasetVersions.map((v) => {
      const secret = new Set((v.secretColumns as string[]) ?? []);
      if (!secret.size) return v;
      const data = v.table as { columns: string[]; rows: Record<string, string>[] };
      return {
        ...v,
        missingSecrets: true,
        table: {
          columns: data.columns,
          rows: data.rows.map((row) =>
            Object.fromEntries(Object.entries(row).map(([k, val]) => [k, secret.has(k) ? "" : val])),
          ),
        },
      };
    });
    // Proxy password, private keys and their passphrases are credentials.
    tables.outboundProxy = tables.outboundProxy.map((p) => ({ ...p, password: "" }));
    tables.tlsProfiles = tables.tlsProfiles.map((p) => ({ ...p, keyPem: "", passphrase: "" }));
    // The vault's values are encrypted, but a backup without secrets carries none of them at all.
    tables.vaultSecrets = tables.vaultSecrets.map((v) => ({ ...v, ciphertext: "", keyId: "" }));
    tables.appSettings = tables.appSettings.map((s) =>
      s.key === "execution.defaultHeaders" ? { ...s, value: maskHeaders(s.value) } : s,
    );
  }
  return {
    postboxBackup: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    secretsIncluded: opts.includeSecrets,
    tables,
  };
}

/** A restored proxy must still parse, or every outbound request would fail. */
function validProxyRow(row: Record<string, unknown>): boolean {
  try {
    new OutboundNetwork({ proxy: { url: String(row.url ?? ""), bypass: (row.bypass as string[]) ?? [] } });
    return true;
  } catch {
    return false;
  }
}

export type RestoreSummary = Record<TableName, number> & { skippedSettings: string[] };

/** Insert in chunks so wide rows stay under SQLite's bound-parameter limit. */
function insertAll(db: DB, name: TableName, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 25) {
    db.insert(TABLES[name])
      .values(rows.slice(i, i + 25) as never)
      .run();
  }
}

/**
 * Replace all workspace data with a backup, atomically. Run results, history and cookies of
 * the replaced workspaces are removed with them. References to accounts that do not exist in
 * this database (creators, memberships) are dropped rather than failing the restore.
 */
export function restoreBackup(db: DB, sqlite: Database.Database, input: unknown): RestoreSummary {
  const parsed = envelope.safeParse(input);
  if (!parsed.success)
    throw new BackupError("This is not a Postbox backup file, or it comes from an unsupported version");
  const tables = parsed.data.tables as Backup["tables"];

  const users = new Set(
    db
      .select({ id: schema.users.id })
      .from(schema.users)
      .all()
      .map((u) => u.id),
  );
  const known = (id: unknown) => typeof id === "string" && users.has(id);
  const withCreator = (rows: Record<string, unknown>[]) =>
    rows.map((r) => ("createdBy" in r && !known(r.createdBy) ? { ...r, createdBy: null } : r));

  const { valid, errors } = sanitizeSettings(
    Object.fromEntries(tables.appSettings.map((s) => [String(s.key), s.value])),
  );
  const savedAt = new Map(tables.appSettings.map((s) => [String(s.key), s.updatedAt]));
  const settings = Object.entries(valid)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => {
      const at = savedAt.get(key);
      return { key, value, updatedAt: typeof at === "number" ? at : Date.now() };
    });

  const rows: Record<TableName, Record<string, unknown>[]> = {
    ...tables,
    catalogEntries: tables.catalogEntries.map((entry) => ({ ...entry, enabled: false })),
    documentationPublications: tables.documentationPublications.map((row) => ({ ...row, enabled: false })),
    grpcDefinitions: withCreator(tables.grpcDefinitions),
    datasets: withCreator(tables.datasets),
    datasetVersions: withCreator(tables.datasetVersions),
    schedules: withCreator(tables.schedules),
    scriptPackageVersions: withCreator(tables.scriptPackageVersions).map((version) => ({
      ...version,
      approved: false,
      approvedBy: null,
    })),
    workspaceMembers: tables.workspaceMembers.filter((m) => known(m.userId)),
    appSettings: settings,
    // A personal secret whose owner is not an account here could never be used or removed by anyone.
    vaultSecrets: withCreator(tables.vaultSecrets).filter(
      (v) => !v.ownerId || v.ownerId === "open" || v.ownerId === "env" || known(v.ownerId),
    ),
    outboundProxy: tables.outboundProxy.filter((p) => validProxyRow(p)),
    // A client certificate without its key (scrubbed backup) cannot be used; keep the CA part only.
    tlsProfiles: tables.tlsProfiles
      .map((p) => (p.certPem && !p.keyPem ? { ...p, certPem: "", passphrase: "" } : p))
      .filter((p) => p.caPem || p.certPem),
  };

  try {
    sqlite.transaction(() => {
      // Cross-table references (schedules -> datasets) are only consistent once everything is in.
      sqlite.pragma("defer_foreign_keys = ON");
      db.delete(schema.workspaces).run(); // cascades to everything workspace-scoped
      db.delete(schema.appSettings).run();
      db.delete(schema.outboundProxy).run();
      db.delete(schema.tlsProfiles).run();
      db.delete(schema.vaultSecrets).run();
      for (const name of ORDER) insertAll(db, name, rows[name]);
    })();
  } catch (err) {
    throw new BackupError(
      `The backup could not be restored (nothing was changed): ${(err as Error).message}`,
    );
  }
  return {
    ...(Object.fromEntries(ORDER.map((name) => [name, rows[name].length])) as Record<TableName, number>),
    skippedSettings: errors,
  };
}

export interface DatabaseInfo {
  path: string;
  sizeBytes: number;
  walBytes: number;
  /** Space inside the file that VACUUM can give back. */
  reclaimableBytes: number;
  counts: Record<"workspaces" | "requests" | "history" | "cookies" | "runs" | "datasets", number>;
}

export function databaseInfo(db: DB, sqlite: Database.Database, file: string): DatabaseInfo {
  const size = (path: string) => {
    try {
      return fs.statSync(path).size;
    } catch {
      return 0;
    }
  };
  const count = (table: SQLiteTable) =>
    (
      db
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .get() as { n: number }
    ).n;
  const pageSize = sqlite.pragma("page_size", { simple: true }) as number;
  const free = sqlite.pragma("freelist_count", { simple: true }) as number;
  return {
    path: file,
    sizeBytes: size(file),
    walBytes: size(`${file}-wal`),
    reclaimableBytes: free * pageSize,
    counts: {
      workspaces: count(schema.workspaces),
      requests: count(schema.requests),
      history: count(schema.history),
      cookies: count(schema.cookies),
      runs: count(schema.runs),
      datasets: count(schema.datasets),
    },
  };
}

/** Rewrite the database file without free pages. Returns the file sizes before and after. */
export function compactDatabase(sqlite: Database.Database, file: string): { before: number; after: number } {
  const total = () => {
    const size = (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    return size(file) + size(`${file}-wal`);
  };
  const before = total();
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  sqlite.exec("VACUUM");
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  return { before, after: total() };
}

export type ClearTarget = "history" | "cookies" | "runs";

/** Delete history, cookies or run results, for one workspace or all of them. */
export function clearData(db: DB, target: ClearTarget, workspaceIds?: string[]): number {
  const table = { history: schema.history, cookies: schema.cookies, runs: schema.runs }[target];
  const scoped = workspaceIds ? inArray(table.workspaceId, workspaceIds) : undefined;
  return db.delete(table).where(scoped).run().changes;
}
