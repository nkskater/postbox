import { telemetryConfig } from "@/core/telemetry/model";
import { scorecardConfig } from "@/core/scorecards/model";
import { governanceConfig, governanceOverrides, governanceExclusion } from "@/core/governance/model";
import { specificationSource } from "@/core/specifications/model";
import { analyzeSpecification } from "@/core/specifications/analyze";
import { createHash, randomBytes } from "node:crypto";
import { sanitizeExample } from "@/core/examples";
import { credentialRedactionValues, sensitiveFieldValues, redactSensitiveFields } from "@/core/retention";
import { redactStoredValue } from "@/core/variables/resolver";
import type { MockRoute } from "@/core/mocks/model";
/**
 * Full backup and restore of workspace data, plus database maintenance.
 *
 * A backup holds every workspace's configuration (collections, requests, environments, variables,
 * datasets, schedules, memberships, webhooks, listeners, comments, forks, releases, runners, ...),
 * instance settings, the outbound proxy and TLS profiles as one JSON document. Records of what
 * happened (runs, history, cookies, deliveries, captured traffic, reports) and anything tied to
 * accounts are left out; `EXCLUDED_TABLES` lists them with the reason. Secret values are
 * stored in the database in plain text, so a backup that includes them must be handled like
 * a credentials file; `includeSecrets: false` produces a best-effort scrubbed copy.
 *
 * These functions take the database as an argument so they can be tested against a fresh one.
 */
import fs from "node:fs";
import { getTableName, inArray, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type Database from "better-sqlite3";
import { z } from "zod";
import { monitorRulesSchema } from "@/core/monitoring/model";
import { OutboundNetwork } from "@/core/http/outbound";
import { withoutAuthCredentials } from "@/core/retention";
import { sanitizeSettings } from "@/lib/settings/registry";
import { SECRET_PREFIX } from "@/core/webhooks";
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
  monitors: schema.monitors,
  telemetrySources: schema.telemetrySources,
  specifications: schema.specifications,
  specificationVersions: schema.specificationVersions,
  specificationLinks: schema.specificationLinks,
  governanceRuleSets: schema.governanceRuleSets,
  governanceRuleVersions: schema.governanceRuleVersions,
  governanceBindings: schema.governanceBindings,
  qualityScorecards: schema.qualityScorecards,
  qualityScorecardVersions: schema.qualityScorecardVersions,
  qualityBindings: schema.qualityBindings,
  mockServers: schema.mockServers,
  scriptPackages: schema.scriptPackages,
  scriptPackageVersions: schema.scriptPackageVersions,
  workspaceMembers: schema.workspaceMembers,
  appSettings: schema.appSettings,
  outboundProxy: schema.outboundProxy,
  tlsProfiles: schema.tlsProfiles,
  vaultSecrets: schema.vaultSecrets,
  brokerApis: schema.brokerApis,
  webhooks: schema.webhooks,
  hookListeners: schema.hookListeners,
  mcpCalls: schema.mcpCalls,
  runners: schema.runners,
  comments: schema.comments,
  dependencyReleases: schema.dependencyReleases,
  dependencyInstalls: schema.dependencyInstalls,
  collectionForks: schema.collectionForks,
  mergeRequests: schema.mergeRequests,
  mergeRequestReviews: schema.mergeRequestReviews,
  gatewayRoutes: schema.gatewayRoutes,
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
  "monitors",
  "telemetrySources",
  "specifications",
  "specificationVersions",
  "specificationLinks",
  "governanceRuleSets",
  "governanceRuleVersions",
  "governanceBindings",
  "qualityScorecards",
  "qualityScorecardVersions",
  "qualityBindings",
  "mockServers",
  "scriptPackages",
  "scriptPackageVersions",
  "workspaceMembers",
  "appSettings",
  "outboundProxy",
  "tlsProfiles",
  "vaultSecrets",
  "brokerApis",
  "webhooks",
  "hookListeners",
  "mcpCalls",
  "runners",
  "comments",
  "dependencyReleases",
  "dependencyInstalls",
  "collectionForks",
  "mergeRequests",
  "mergeRequestReviews",
  "gatewayRoutes",
];

/**
 * Workspace data a backup deliberately leaves out, by SQL table name. A restore deletes these
 * along with the workspaces they belong to. Every table that is removed with a workspace must be
 * either backed up or listed here (checked by a test).
 */
export const EXCLUDED_TABLES: Record<string, string> = {
  runs: "run results",
  run_results: "run results",
  load_runs: "load test results",
  history: "request history",
  cookies: "cookies",
  mock_logs: "mock server request logs",
  webhook_deliveries: "webhook delivery log",
  webhook_attempts: "webhook delivery log",
  hook_events: "requests received by incoming hook listeners",
  monitor_samples: "monitor results",
  monitor_incidents: "monitor incidents",
  monitor_emails: "monitor e-mail log",
  runner_jobs: "queued and finished runner jobs",
  telemetry_observations: "received telemetry",
  capture_sessions: "captured traffic",
  capture_entries: "captured traffic",
  gateway_sessions: "gateway sessions",
  gateway_traces: "gateway traces",
  governance_reports: "governance reports (run the checks again)",
  quality_reports: "scorecard reports (run the scorecards again)",
  graph_sources: "the dependency graph index (rebuilt with Refresh)",
  graph_nodes: "the dependency graph index (rebuilt with Refresh)",
  graph_edges: "the dependency graph index (rebuilt with Refresh)",
  comment_notifications: "comment notifications of individual accounts",
  invites: "pending invitations (send them again)",
  broker_grants: "access granted to brokered APIs (approve it again)",
  scim_groups: "groups provisioned by the identity provider (provisioned again on its next sync)",
  sso_role_grants: "roles granted through single sign-on (granted again at the next sign-in)",
};

/** SQL names of the tables a backup holds. */
export const BACKED_UP_TABLES: string[] = ORDER.map((name) => getTableName(TABLES[name]));

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

const VAULT_REF = /^\s*\{\{\s*vault:[^}]+\}\}\s*$/;
/** A token hash no token can match, for listeners and runners restored without their credentials. */
const unusableHash = () => `restored-${randomBytes(16).toString("hex")}`;

const SENSITIVE_NAME = /authorization|cookie|token|password|secret|api[-_]?key|credential/i;
type Row = { key?: unknown; value?: unknown; [k: string]: unknown };
const maskHeaders = (rows: unknown) =>
  Array.isArray(rows)
    ? rows.map((row: Row) =>
        typeof row?.key === "string" && SENSITIVE_NAME.test(row.key) ? { ...row, value: "" } : row,
      )
    : rows;

function disableTelemetryBackup(row: Record<string, unknown>): Record<string, unknown> {
  const config = telemetryConfig.safeParse(row.config);
  if (!config.success) throw new BackupError("Invalid telemetry source configuration");
  return {
    ...row,
    config: { ...config.data, enabled: false },
    tokenHash: "",
    lastIntake: null,
    lastReceivedAt: null,
  };
}

export function createBackup(db: DB, opts: { includeSecrets: boolean }): Backup {
  const tables = {} as Backup["tables"];
  for (const name of ORDER) {
    tables[name] = db.select().from(TABLES[name]).all() as Record<string, unknown>[];
  }
  tables.telemetrySources = tables.telemetrySources.map(disableTelemetryBackup);
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
    tables.specificationLinks = tables.specificationLinks.map((row) => {
      const baseline = redactStoredValue(
        redactSensitiveFields(row.baseline as import("./specification-sync").SyncBaseline),
        mockSecrets,
      );
      return {
        ...row,
        baseline: {
          ...baseline,
          root: { ...baseline.root, auth: withoutAuthCredentials(baseline.root.auth) },
          remoteRoot: { ...baseline.remoteRoot, auth: withoutAuthCredentials(baseline.remoteRoot.auth) },
          requests: Object.fromEntries(
            Object.entries(baseline.requests).map(([key, item]) => [
              key,
              {
                ...item,
                collection: {
                  ...item.collection,
                  auth: withoutAuthCredentials(item.collection.auth),
                  headers: maskHeaders(item.collection.headers),
                },
                remote: {
                  ...item.remote,
                  auth: withoutAuthCredentials(item.remote.auth),
                  headers: maskHeaders(item.remote.headers),
                },
              },
            ]),
          ),
          variables: baseline.variables.map((v) => (v.type === "secret" ? { ...v, value: "" } : v)),
          remoteVariables: baseline.remoteVariables.map((v) =>
            v.type === "secret" ? { ...v, value: "" } : v,
          ),
        },
      };
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
    // Signing keys, shared secrets and token hashes are credentials. A restored webhook gets a new
    // signing key and stays off; a listener or runner needs a new token before it works again.
    tables.webhooks = tables.webhooks.map((w) => ({
      ...w,
      secret: "",
      enabled: false,
      headers: JSON.stringify(
        (JSON.parse(String(w.headers ?? "[]")) as { name: string; value: string }[]).map((h) => ({
          ...h,
          value: VAULT_REF.test(h.value) ? h.value : "",
        })),
      ),
    }));
    tables.hookListeners = tables.hookListeners.map((l) => ({
      ...l,
      tokenHash: unusableHash(),
      tokenHint: "",
      secret: "",
      status: l.status === "revoked" ? "revoked" : "paused",
    }));
    tables.runners = tables.runners.map((r) => ({
      ...r,
      tokenHash: unusableHash(),
      revokedAt: r.revokedAt ?? Date.now(),
    }));
    tables.mcpCalls = tables.mcpCalls.map((c) => {
      const config = redactStoredValue(c.config, mockSecrets) as { connection?: { headers?: unknown } };
      return {
        ...c,
        config: {
          ...config,
          connection: { ...config.connection, headers: maskHeaders(config.connection?.headers) },
        },
      };
    });
    tables.dependencyReleases = tables.dependencyReleases.map((r) => ({
      ...r,
      snapshot: redactStoredValue(r.snapshot, mockSecrets),
    }));
    tables.dependencyInstalls = tables.dependencyInstalls.map((r) => ({
      ...r,
      baseSnapshot: redactStoredValue(r.baseSnapshot, mockSecrets),
    }));
    tables.collectionForks = tables.collectionForks.map((r) => ({
      ...r,
      baseSnapshot: redactStoredValue(r.baseSnapshot, mockSecrets),
      baseFiles: redactStoredValue(r.baseFiles, mockSecrets),
    }));
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
  tables.telemetrySources = tables.telemetrySources.map(disableTelemetryBackup);

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
    schedules: withCreator(tables.schedules).map((row) =>
      tables.monitors.some((m) => m.scheduleId === row.id)
        ? { ...row, enabled: false, lastRunId: null, lastRunAt: null }
        : row,
    ),
    qualityScorecardVersions: tables.qualityScorecardVersions.map((row) => {
      const parsed = scorecardConfig.safeParse(row.config);
      if (!parsed.success) throw new BackupError("Invalid scorecard configuration");
      return { ...row, config: parsed.data };
    }),
    qualityBindings: tables.qualityBindings.map((row) => {
      const card = tables.qualityScorecards.find((c) => c.id === row.scorecardId),
        entry = tables.catalogEntries.find((e) => e.id === row.entryId),
        env = row.environmentId ? tables.environments.find((e) => e.id === row.environmentId) : null,
        spec = row.specificationId ? tables.specifications.find((s) => s.id === row.specificationId) : null,
        monitor = row.monitorId ? tables.monitors.find((m) => m.id === row.monitorId) : null,
        schedule = monitor ? tables.schedules.find((s) => s.id === monitor.scheduleId) : null;
      if (
        !card ||
        !entry ||
        card.workspaceId !== row.workspaceId ||
        entry.workspaceId !== row.workspaceId ||
        (env && env.workspaceId !== row.workspaceId) ||
        (row.specificationId && (!spec || spec.workspaceId !== row.workspaceId)) ||
        (row.monitorId &&
          (!monitor ||
            monitor.workspaceId !== row.workspaceId ||
            !schedule ||
            schedule.folderId !== entry.folderId ||
            (schedule.environmentId ?? "") !== row.environmentId))
      )
        throw new BackupError("Invalid scorecard assignment");
      return row;
    }),
    governanceRuleVersions: tables.governanceRuleVersions.map((row) => {
      const parsed = governanceConfig.safeParse(row.config);
      if (!parsed.success) throw new BackupError("Invalid governance policy in backup");
      return { ...row, config: parsed.data };
    }),
    governanceBindings: tables.governanceBindings.map((row) => {
      const spec = tables.specifications.find((s) => s.id === row.specificationId),
        set = tables.governanceRuleSets.find((s) => s.id === row.ruleSetId),
        version = tables.governanceRuleVersions.find(
          (v) => v.ruleSetId === row.ruleSetId && v.version === (row.ruleVersion ?? set?.revision),
        );
      if (
        !spec ||
        !set ||
        spec.workspaceId !== row.workspaceId ||
        set.workspaceId !== row.workspaceId ||
        !version
      )
        throw new BackupError("Invalid governance binding in backup");
      try {
        governanceOverrides.parse(row.overrides ?? {});
        z.array(governanceExclusion).parse(row.exclusions ?? []);
      } catch {
        throw new BackupError("Invalid governance overrides in backup");
      }
      return row;
    }),
    specificationVersions: tables.specificationVersions.map((row) => {
      const parent = tables.specifications.find((s) => s.id === row.specificationId);
      const parsed = specificationSource.safeParse({
        format: parent?.format,
        entrypoint: row.entrypoint,
        files: row.files,
      });
      if (
        !parsed.success ||
        analyzeSpecification(parsed.data).diagnostics.some((d) => d.code === "limit" || d.code === "file")
      )
        throw new BackupError("Invalid specification bundle in backup");
      return { ...row, entrypoint: parsed.data.entrypoint, files: parsed.data.files };
    }),
    monitors: tables.monitors.map((row) => {
      const policy = monitorRulesSchema.safeParse(row.rules),
        emails = z.array(z.email().max(254)).max(10).safeParse(row.emails);
      if (!policy.success || !emails.success)
        throw new BackupError("Invalid monitor configuration in backup");
      return {
        ...row,
        rules: policy.data,
        emails: emails.data,
        state: "unknown",
        failures: 0,
        successes: 0,
        openIncidentId: null,
      };
    }),
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
    // Brokered APIs come back; the access granted to consumers does not, so it has to be approved again.
    brokerApis: withCreator(tables.brokerApis),
    outboundProxy: tables.outboundProxy.filter((p) => validProxyRow(p)),
    // A client certificate without its key (scrubbed backup) cannot be used; keep the CA part only.
    tlsProfiles: tables.tlsProfiles
      .map((p) => (p.certPem && !p.keyPem ? { ...p, certPem: "", passphrase: "" } : p))
      .filter((p) => p.caPem || p.certPem),
    // A webhook restored without its signing key gets a new one (shown by "Rotate secret") and stays off.
    webhooks: withCreator(tables.webhooks).map((w) =>
      !w.secret && !w.secretRef
        ? { ...w, secret: SECRET_PREFIX + randomBytes(32).toString("base64url"), enabled: false }
        : w,
    ),
    hookListeners: withCreator(tables.hookListeners),
    runners: withCreator(tables.runners).map((r) => ({ ...r, lastSeenAt: null })),
    comments: tables.comments.map((c) => (known(c.authorId) ? c : { ...c, authorId: null })),
    dependencyReleases: withCreator(tables.dependencyReleases),
    collectionForks: withCreator(tables.collectionForks),
    mergeRequests: withCreator(tables.mergeRequests),
    // Usage counters restart; the limits themselves are part of the route's policy.
    gatewayRoutes: tables.gatewayRoutes.map((r) => ({
      ...r,
      minuteWindow: 0,
      minuteUsed: 0,
      dayWindow: 0,
      dayUsed: 0,
    })),
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
