import { and, eq, inArray, or } from "drizzle-orm";
import YAML from "yaml";
import { analyzeSpecification } from "@/core/specifications/analyze";
import { extractSources, hostOf, type SnapshotVariable, type WorkspaceSnapshot } from "@/core/graph/extract";
import {
  GRAPH_LIMITS,
  TELEMETRY_SOURCES,
  graphPathSchema,
  graphSearchSchema,
  graphTraverseSchema,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type SourceFacts,
  type SourceKind,
  type SourceState,
} from "@/core/graph/model";
import { buildView, searchNodes, shortestPath, traverse, type GraphView } from "@/core/graph/query";
import { currentCaller } from "./access-context";
import { authorize } from "./authorize";
import { getDb, getSqlite, schema } from "./db";
import { HttpError } from "./errors";

const { graphSources: sources, graphNodes: nodes, graphEdges: edges } = schema;

/** How often a query may trigger a re-check of a workspace's sources. */
const RECHECK_MS = 60_000;

const variable = (v: {
  key: string;
  value: string;
  type: string;
  enabled: boolean | number;
}): SnapshotVariable => ({
  key: v.key,
  value: v.value,
  secret: v.type === "secret",
  enabled: !!v.enabled,
});

function specificationDetails(
  spec: { id: string; format: string; revision: number },
  version: { entrypoint: string; files: { path: string; content: string }[] } | undefined,
): { servers: string[]; operations: string[]; error?: string } {
  if (!version) return { servers: [], operations: [], error: "No stored version" };
  const analysis = analyzeSpecification({
    format: spec.format as never,
    entrypoint: version.entrypoint,
    files: version.files,
  });
  if (!analysis.valid && !analysis.symbols.length)
    return {
      servers: [],
      operations: [],
      error: analysis.diagnostics[0]?.message ?? "Specification cannot be read",
    };
  const operations = analysis.symbols.filter((s) => s.kind === "operation").map((s) => s.name);
  let servers: string[] = [];
  if (spec.format === "openapi") {
    try {
      const text = version.files.find((f) => f.path === version.entrypoint)?.content ?? "";
      const root = YAML.parse(text) as { servers?: { url?: unknown }[]; host?: unknown } | null;
      servers = (root?.servers ?? []).map((s) => (typeof s?.url === "string" ? s.url : "")).filter(Boolean);
      if (!servers.length && typeof root?.host === "string") servers = ["//" + root.host];
    } catch {
      /* The analysis already reports unparseable files. */
    }
  }
  return { servers, operations: [...new Set(operations)] };
}

/** What the graph already knew about a specification, used while its current version cannot be read. */
function lastKnownSpecification(id: string): { servers: string[]; operations: string[] } {
  const db = getSqlite();
  const operations = (
    db
      .prepare("SELECT label FROM graph_nodes WHERE source_id = ? AND kind = 'operation' ORDER BY id")
      .all(`specification:${id}`) as {
      label: string;
    }[]
  ).map((r) => r.label);
  const servers = (
    db
      .prepare(
        "SELECT to_id AS id, props FROM graph_edges WHERE source_id = ? AND type = 'servedBy' ORDER BY to_id",
      )
      .all(`specification:${id}`) as { id: string; props: string }[]
  ).map((r) => {
    const prefix = (JSON.parse(r.props) as { path?: string }).path ?? "";
    return "//" + r.id.slice("service:".length) + prefix;
  });
  return { servers, operations };
}

type SpecProblem = { id: string; message: string };

export function snapshotWorkspace(
  workspaceId: string,
  telemetry: Set<string>,
): { snapshot: WorkspaceSnapshot; problems: SpecProblem[] } {
  const db = getSqlite();
  const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
  const folders = all<{ id: string; parentId: string | null; name: string }>(
    "SELECT id, parent_id AS parentId, name FROM folders WHERE workspace_id = ? ORDER BY id",
    workspaceId,
  );
  const requests = all<{ id: string; folderId: string; name: string; method: string; url: string }>(
    "SELECT id, folder_id AS folderId, name, method, url FROM requests WHERE workspace_id = ? ORDER BY id",
    workspaceId,
  );
  const vars = all<{
    scope: string;
    ownerId: string | null;
    key: string;
    value: string;
    type: string;
    enabled: number;
  }>(
    "SELECT scope, owner_id AS ownerId, key, value, type, enabled FROM variables WHERE workspace_id = ? ORDER BY sort, id",
    workspaceId,
  );
  const environments = all<{ id: string; name: string }>(
    "SELECT id, name FROM environments WHERE workspace_id = ? ORDER BY sort, created_at, id",
    workspaceId,
  ).map((e) => ({
    ...e,
    variables: vars.filter((v) => v.scope === "environment" && v.ownerId === e.id).map(variable),
  }));
  const collectionVariables: Record<string, SnapshotVariable[]> = {};
  for (const v of vars.filter((x) => x.scope === "collection" && x.ownerId))
    (collectionVariables[v.ownerId!] ??= []).push(variable(v));
  const problems: SpecProblem[] = [];
  const specifications = getDb()
    .select()
    .from(schema.specifications)
    .where(eq(schema.specifications.workspaceId, workspaceId))
    .all()
    .map((spec) => {
      const version = getDb()
        .select()
        .from(schema.specificationVersions)
        .where(
          and(
            eq(schema.specificationVersions.specificationId, spec.id),
            eq(schema.specificationVersions.version, spec.revision),
          ),
        )
        .get();
      let details = specificationDetails(spec, version);
      if (details.error) {
        problems.push({ id: spec.id, message: details.error });
        details = { ...details, ...lastKnownSpecification(spec.id) };
      }
      return { id: spec.id, name: spec.name, format: spec.format, revision: spec.revision, ...details };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const captures = all<{ id: string; name: string; status: string }>(
    "SELECT id, name, status FROM capture_sessions WHERE workspace_id = ? ORDER BY id",
    workspaceId,
  ).map((session) => {
    const hosts = new Map<string, { host: string; requests: number; lastAt: number }>();
    if (telemetry.has(`captureSession:${session.id}`))
      for (const row of all<{ url: string; startedAt: number }>(
        "SELECT url, started_at AS startedAt FROM capture_entries WHERE session_id = ? ORDER BY started_at DESC LIMIT 5000",
        session.id,
      )) {
        const host = hostOf(row.url);
        if (!host) continue;
        const have = hosts.get(host);
        if (have) have.requests++;
        else hosts.set(host, { host, requests: 1, lastAt: row.startedAt });
      }
    return { id: session.id, name: session.name, state: session.status, hosts: [...hosts.values()] };
  });
  return {
    problems,
    snapshot: {
      workspaceId,
      folders,
      requests,
      environments,
      globals: vars.filter((v) => v.scope === "global").map(variable),
      collectionVariables,
      specifications,
      links: all<{ folderId: string; specificationId: string; version: number }>(
        "SELECT folder_id AS folderId, specification_id AS specificationId, spec_version AS version FROM specification_links WHERE workspace_id = ? ORDER BY folder_id",
        workspaceId,
      ),
      mocks: all<{ id: string; name: string; folderId: string; enabled: number }>(
        "SELECT id, name, folder_id AS folderId, enabled FROM mock_servers WHERE workspace_id = ? ORDER BY id",
        workspaceId,
      ).map((m) => ({ ...m, enabled: !!m.enabled })),
      monitors: all<{ id: string; name: string; folderId: string; enabled: number; state: string }>(
        `SELECT m.id AS id, s.name AS name, s.folder_id AS folderId, s.enabled AS enabled, m.state AS state
         FROM monitors m JOIN schedules s ON s.id = m.schedule_id WHERE m.workspace_id = ? ORDER BY m.id`,
        workspaceId,
      ).map((m) => ({ ...m, enabled: !!m.enabled })),
      catalog: all<{ id: string; title: string; folderId: string; enabled: number; visibility: string }>(
        "SELECT id, title, folder_id AS folderId, enabled, visibility FROM catalog_entries WHERE workspace_id = ? ORDER BY id",
        workspaceId,
      ).map((c) => ({ ...c, enabled: !!c.enabled })),
      webhooks: all<{ id: string; name: string; url: string; enabled: number }>(
        "SELECT id, name, url, enabled FROM webhooks WHERE workspace_id = ? ORDER BY id",
        workspaceId,
      ).map((h) => ({ ...h, enabled: !!h.enabled })),
      captures,
    },
  };
}

export interface RefreshResult {
  workspaceId: string;
  sources: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  errors: number;
  nodes: number;
  edges: number;
}

/**
 * Bring the stored graph in line with the workspace. Only sources whose facts changed are rewritten; sources whose
 * thing was deleted are removed; telemetry that is not connected contributes nothing.
 */
export function indexWorkspace(workspaceId: string, now = Date.now()): RefreshResult {
  const db = getDb();
  const existing = new Map(
    db
      .select()
      .from(sources)
      .where(eq(sources.workspaceId, workspaceId))
      .all()
      .map((s) => [s.id, s]),
  );
  const connected = new Set([...existing.values()].filter((s) => s.connected).map((s) => s.id));
  const { snapshot, problems } = snapshotWorkspace(workspaceId, connected);
  const problem = new Map(problems.map((p) => [`specification:${p.id}`, p.message]));
  const facts = extractSources(snapshot);
  const total = facts.reduce(
    (n, f) => ({ nodes: n.nodes + f.nodes.length, edges: n.edges + f.edges.length }),
    { nodes: 0, edges: 0 },
  );
  if (total.nodes > GRAPH_LIMITS.nodesPerWorkspace || total.edges > GRAPH_LIMITS.edgesPerWorkspace)
    throw new HttpError(413, "This workspace is too large to index as a dependency graph");
  const result: RefreshResult = {
    workspaceId,
    sources: facts.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    errors: 0,
    nodes: total.nodes,
    edges: total.edges,
  };
  db.transaction((tx) => {
    const live = new Set<string>();
    for (const f of facts) {
      live.add(f.id);
      const row = existing.get(f.id);
      const telemetry = TELEMETRY_SOURCES.includes(f.kind);
      const isConnected = telemetry ? !!row?.connected : true;
      const error = problem.get(f.id) ?? null;
      const base = {
        workspaceId,
        kind: f.kind,
        ref: f.ref,
        label: f.label,
        connected: isConnected,
        checkedAt: now,
      };
      if (telemetry && !isConnected) {
        // Known but not connected: no facts, and anything left from an earlier connection is gone.
        if (row?.fingerprint) {
          tx.delete(nodes).where(eq(nodes.sourceId, f.id)).run();
          tx.delete(edges).where(eq(edges.sourceId, f.id)).run();
        }
        const values = { ...base, fingerprint: "", state: "revoked" as const, error: null };
        if (row) tx.update(sources).set(values).where(eq(sources.id, f.id)).run();
        else
          tx.insert(sources)
            .values({ id: f.id, ...values, indexedAt: now })
            .run();
        result.unchanged++;
        continue;
      }
      if (error) {
        // Keep the last good facts so the graph does not lose a specification because it was saved half-edited.
        result.errors++;
        if (row)
          tx.update(sources)
            .set({ ...base, state: "error", error })
            .where(eq(sources.id, f.id))
            .run();
        else
          tx.insert(sources)
            .values({ id: f.id, ...base, fingerprint: "", state: "error", error, indexedAt: now })
            .run();
        continue;
      }
      if (row && row.fingerprint === f.fingerprint && row.state === "fresh") {
        tx.update(sources).set({ checkedAt: now }).where(eq(sources.id, f.id)).run();
        result.unchanged++;
        continue;
      }
      writeFacts(tx, f, base, now, !!row);
      if (row) result.updated++;
      else result.added++;
    }
    for (const [id] of existing)
      if (!live.has(id)) {
        tx.delete(sources).where(eq(sources.id, id)).run();
        result.removed++;
      }
  });
  return result;
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
function writeFacts(
  tx: Tx,
  f: SourceFacts,
  base: {
    workspaceId: string;
    kind: string;
    ref: string;
    label: string;
    connected: boolean;
    checkedAt: number;
  },
  now: number,
  exists: boolean,
) {
  const values = {
    ...base,
    fingerprint: f.fingerprint,
    state: "fresh" as const,
    error: null,
    indexedAt: now,
  };
  if (exists) {
    tx.update(sources).set(values).where(eq(sources.id, f.id)).run();
    tx.delete(nodes).where(eq(nodes.sourceId, f.id)).run();
    tx.delete(edges).where(eq(edges.sourceId, f.id)).run();
  } else
    tx.insert(sources)
      .values({ id: f.id, ...values })
      .run();
  for (let i = 0; i < f.nodes.length; i += 200)
    tx.insert(nodes)
      .values(f.nodes.slice(i, i + 200).map((n) => ({ sourceId: f.id, ...n })))
      .run();
  for (let i = 0; i < f.edges.length; i += 200)
    tx.insert(edges)
      .values(
        f.edges.slice(i, i + 200).map((e) => ({
          sourceId: f.id,
          workspaceId: e.workspaceId,
          from: e.from,
          to: e.to,
          type: e.type,
          origin: e.origin,
          props: e.props,
        })),
      )
      .run();
}

/** Re-check a workspace when it was never indexed or was last checked a while ago. */
function ensureIndexed(workspaceId: string) {
  const latest = getSqlite()
    .prepare("SELECT MAX(checked_at) AS at FROM graph_sources WHERE workspace_id = ?")
    .get(workspaceId) as { at: number | null };
  if (latest.at === null || Date.now() - latest.at > RECHECK_MS) indexWorkspace(workspaceId);
}

export function refreshGraph(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "write");
  return indexWorkspace(workspaceId);
}

export function sourceState(row: typeof sources.$inferSelect, now = Date.now()): SourceState {
  if (row.state === "fresh" && now - row.checkedAt > GRAPH_LIMITS.staleAfterHours * 3_600_000) return "stale";
  return row.state;
}

export function listSources(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  ensureIndexed(workspaceId);
  const now = Date.now();
  return getDb()
    .select()
    .from(sources)
    .where(eq(sources.workspaceId, workspaceId))
    .all()
    .map((s) => ({
      id: s.id,
      kind: s.kind as SourceKind,
      ref: s.ref,
      label: s.label,
      state: sourceState(s, now),
      error: s.error,
      telemetry: TELEMETRY_SOURCES.includes(s.kind as SourceKind),
      connected: s.connected,
      indexedAt: s.indexedAt,
      checkedAt: s.checkedAt,
    }))
    .sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    );
}

/** Connect or disconnect a telemetry source. Disconnecting deletes everything it contributed. */
export function setSourceConnected(workspaceId: string, id: string, connected: boolean) {
  authorize(currentCaller(), workspaceId, "manage");
  ensureIndexed(workspaceId);
  const row = getDb()
    .select()
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.workspaceId, workspaceId)))
    .get();
  if (!row) throw new HttpError(404, "Source not found");
  if (!TELEMETRY_SOURCES.includes(row.kind as SourceKind))
    throw new HttpError(400, "Only telemetry sources can be connected or disconnected");
  getDb().update(sources).set({ connected }).where(eq(sources.id, id)).run();
  indexWorkspace(workspaceId);
  return listSources(workspaceId).find((s) => s.id === id)!;
}

/** Workspaces the caller may read. */
function readableWorkspaces(): Set<string> {
  const caller = currentCaller();
  const ids = (getSqlite().prepare("SELECT id FROM workspaces").all() as { id: string }[]).map((w) => w.id);
  return new Set(
    ids.filter((id) => {
      try {
        authorize(caller, id, "read");
        return true;
      } catch {
        return false;
      }
    }),
  );
}

const toNode = (r: typeof nodes.$inferSelect): GraphNode => ({
  id: r.id,
  kind: r.kind as NodeKind,
  workspaceId: r.workspaceId,
  label: r.label,
  props: r.props,
});
const toEdge = (r: typeof edges.$inferSelect): GraphEdge => ({
  from: r.from,
  to: r.to,
  type: r.type as GraphEdge["type"],
  origin: r.origin as GraphEdge["origin"],
  workspaceId: r.workspaceId,
  sourceId: r.sourceId,
  props: r.props,
});

/**
 * The part of the graph the caller may see: the workspace itself, plus whatever other workspaces they can read attach
 * to the services it shares. Edges from workspaces they cannot read, and the nodes only those edges reached, are
 * simply absent. Sources that were revoked or never connected have no rows to leak.
 */
function chunks<T>(list: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function loadView(workspaceId: string): GraphView {
  authorize(currentCaller(), workspaceId, "read");
  ensureIndexed(workspaceId);
  const readable = readableWorkspaces();
  const db = getDb();
  const own = db.select().from(edges).where(eq(edges.workspaceId, workspaceId)).all();
  const shared = [...new Set(own.flatMap((e) => [e.from, e.to]).filter((id) => id.startsWith("service:")))];
  const visible = [...own];
  for (const batch of chunks(shared))
    for (const e of db
      .select()
      .from(edges)
      .where(or(inArray(edges.to, batch), inArray(edges.from, batch)))
      .all())
      if (e.workspaceId !== workspaceId && readable.has(e.workspaceId)) visible.push(e);
  const reached = [...new Set(visible.flatMap((e) => [e.from, e.to]))];
  const rows = db.select().from(nodes).where(eq(nodes.workspaceId, workspaceId)).all();
  for (const batch of chunks(reached))
    rows.push(...db.select().from(nodes).where(inArray(nodes.id, batch)).all());
  return buildView(
    rows.filter((n) => !n.workspaceId || readable.has(n.workspaceId)).map(toNode),
    visible.map(toEdge),
  );
}

export function searchGraph(input: unknown) {
  const q = graphSearchSchema.parse(input);
  const view = loadView(q.workspaceId);
  return { nodes: searchNodes(view, q.query, q.kind, q.limit).map((h) => h.node) };
}

export function traverseGraph(input: unknown) {
  const q = graphTraverseSchema.parse(input);
  const view = loadView(q.workspaceId);
  const result = traverse(view, q.node, {
    direction: q.direction,
    depth: q.depth,
    types: q.types,
    origins: q.origins,
    limit: q.limit,
  });
  if (!result) throw new HttpError(404, "Node not found");
  return result;
}

export function graphPath(input: unknown) {
  const q = graphPathSchema.parse(input);
  const view = loadView(q.workspaceId);
  if (!view.nodes.has(q.from) || !view.nodes.has(q.to)) throw new HttpError(404, "Node not found");
  return { path: shortestPath(view, q.from, q.to, q.depth) };
}

export function graphOverview(workspaceId: string) {
  const view = loadView(workspaceId);
  const kinds: Record<string, number> = {};
  for (const n of view.nodes.values()) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  const types: Record<string, number> = {};
  for (const e of view.edges) types[e.type] = (types[e.type] ?? 0) + 1;
  return {
    nodes: view.nodes.size,
    edges: view.edges.length,
    kinds,
    types,
    sources: listSources(workspaceId),
  };
}
