/**
 * Turn a plain snapshot of one workspace into graph facts, one source at a time. Nothing here touches the database or
 * the network, so the same snapshot always produces the same graph.
 */
import { createHash } from "node:crypto";
import {
  GRAPH_LIMITS,
  nodeId,
  sourceId,
  type EdgeOrigin,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type SourceFacts,
  type SourceKind,
} from "./model";

export interface SnapshotVariable {
  key: string;
  value: string;
  secret: boolean;
  enabled: boolean;
}
export interface WorkspaceSnapshot {
  workspaceId: string;
  folders: { id: string; parentId: string | null; name: string }[];
  requests: { id: string; folderId: string; name: string; method: string; url: string }[];
  environments: { id: string; name: string; variables: SnapshotVariable[] }[];
  globals: SnapshotVariable[];
  /** Variables scoped to a collection, keyed by the collection's folder id. */
  collectionVariables: Record<string, SnapshotVariable[]>;
  specifications: {
    id: string;
    name: string;
    format: string;
    revision: number;
    servers: string[];
    /** "GET /pets/{id}" */
    operations: string[];
  }[];
  links: { folderId: string; specificationId: string; version: number }[];
  mocks: { id: string; name: string; folderId: string; enabled: boolean }[];
  monitors: { id: string; name: string; folderId: string; enabled: boolean; state: string }[];
  catalog: { id: string; title: string; folderId: string; enabled: boolean; visibility: string }[];
  webhooks: { id: string; name: string; url: string; enabled: boolean }[];
  captures: {
    id: string;
    name: string;
    state: string;
    hosts: { host: string; requests: number; lastAt: number }[];
  }[];
}

const clip = (s: string) => s.slice(0, GRAPH_LIMITS.label);
const VARIABLE = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)$/;

/**
 * The host (and non-default port) a URL points at, lower-cased. Credentials, paths and queries are dropped, so a
 * graph never stores anything that could be a secret.
 */
export function hostOf(url: string): string | null {
  const m = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#\s]+)/i.exec(url);
  const authority = m ? m[1] : /^\s*([a-z0-9.-]+(?::\d+)?)(?:[/?#]|\s*$)/i.exec(url)?.[1];
  if (!authority) return null;
  const host = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
  if (!host || host.includes("{{") || !/^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d{1,5})?$/.test(host)) return null;
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  const defaults: Record<string, string> = { http: ":80", https: ":443", ws: ":80", wss: ":443" };
  return scheme && host.endsWith(defaults[scheme] ?? "\0") ? host.slice(0, -defaults[scheme].length) : host;
}

function pathOf(url: string): string {
  const afterHost = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#\s]*([^?#\s]*)/i.exec(url);
  if (afterHost) return afterHost[1] || "/";
  const rest = url.replace(/^\s*\{\{[^{}]+\}\}/, "").split(/[?#]/)[0]!;
  return rest.startsWith("/") ? rest : "/" + rest;
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
function templateRegex(template: string): RegExp {
  const body = trimSlash(template)
    .split("/")
    .map((seg) =>
      seg
        .split(/(\{[^{}]*\}|\{\{[^{}]*\}\}|:[A-Za-z_]\w*)/)
        .map((part, i) => (i % 2 ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join(""),
    )
    .join("/");
  return new RegExp(`^${body || "/"}$`, "i");
}

class Facts {
  nodes = new Map<string, GraphNode>();
  edges = new Map<string, GraphEdge>();
  constructor(
    readonly id: string,
    private readonly workspaceId: string,
  ) {}
  node(kind: NodeKind, ref: string, label: string, props: GraphNode["props"] = {}, shared = false): string {
    const id = nodeId(kind, ref);
    if (!this.nodes.has(id))
      this.nodes.set(id, {
        id,
        kind,
        workspaceId: shared ? null : this.workspaceId,
        label: clip(label),
        props,
      });
    return id;
  }
  edge(from: string, type: EdgeType, to: string, origin: EdgeOrigin, props: GraphEdge["props"] = {}) {
    if (from === to) return;
    const key = `${from}|${type}|${to}`;
    const have = this.edges.get(key);
    if (have) {
      // The same relationship found through another route keeps the first provenance and notes the extra route.
      if (
        props.via &&
        have.props.via &&
        have.props.via !== props.via &&
        !String(have.props.via).includes(String(props.via))
      )
        have.props = { ...have.props, via: `${have.props.via}, ${props.via}`.slice(0, 200) };
      return;
    }
    this.edges.set(key, { from, to, type, origin, workspaceId: this.workspaceId, sourceId: this.id, props });
  }
}

function finish(
  facts: Facts,
  kind: SourceKind,
  ref: string,
  workspaceId: string,
  label: string,
): SourceFacts {
  const nodes = [...facts.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...facts.edges.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to),
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([nodes, edges]))
    .digest("hex");
  return { id: facts.id, kind, ref, workspaceId, label: clip(label), fingerprint, nodes, edges };
}

/** Variable name -> every non-secret value it can take, with where that value came from. */
interface Candidate {
  value: string;
  via: string;
  environmentId?: string;
}
function candidatesFor(snapshot: WorkspaceSnapshot, collectionId: string): (name: string) => Candidate[] {
  const out = new Map<string, Candidate[]>();
  const add = (list: SnapshotVariable[], via: string, environmentId?: string) => {
    for (const v of list) {
      if (!v.enabled || v.secret) continue;
      const have = out.get(v.key) ?? [];
      have.push({ value: v.value, via, environmentId });
      out.set(v.key, have);
    }
  };
  add(snapshot.globals, "globals");
  add(snapshot.collectionVariables[collectionId] ?? [], "collection variables");
  for (const env of snapshot.environments) add(env.variables, `environment ${env.name}`, env.id);
  return (name) => out.get(name) ?? [];
}

/** Every concrete URL a template can expand to, plus the environments that supplied part of it. */
function expand(
  template: string,
  lookup: (name: string) => Candidate[],
): { url: string; vias: string[]; environments: string[] }[] {
  const results: { url: string; vias: string[]; environments: string[] }[] = [];
  const walk = (text: string, vias: string[], environments: string[], depth: number) => {
    if (results.length >= 8) return;
    const m = new RegExp(VARIABLE.source).exec(text);
    if (!m || depth > 3) {
      results.push({ url: text, vias, environments });
      return;
    }
    const options = lookup(m[1]!);
    if (!options.length) {
      // Leave an unknown variable in place; the result stays a template and yields no host.
      const marker = `\u0000${m[1]}\u0000`;
      walk(
        text.slice(0, m.index) + marker + text.slice(m.index + m[0].length),
        vias,
        environments,
        depth + 1,
      );
      return;
    }
    for (const o of options)
      walk(
        text.slice(0, m.index) + o.value + text.slice(m.index + m[0].length),
        [...vias, o.via],
        o.environmentId ? [...environments, o.environmentId] : environments,
        depth + 1,
      );
  };
  walk(template, [], [], 0);
  return results.map((r) => ({ ...r, url: r.url.replace(/\u0000([^\u0000]*)\u0000/g, "{{$1}}") }));
}

function folderNodeId(snapshot: WorkspaceSnapshot, folderId: string): string | null {
  const f = snapshot.folders.find((x) => x.id === folderId);
  return f ? nodeId(f.parentId ? "folder" : "collection", f.id) : null;
}

function rootOf(snapshot: WorkspaceSnapshot, folderId: string): string {
  const byId = new Map(snapshot.folders.map((f) => [f.id, f]));
  let cur = byId.get(folderId);
  for (let i = 0; cur?.parentId && i < 100; i++) cur = byId.get(cur.parentId);
  return cur?.id ?? folderId;
}

function collectionFacts(snapshot: WorkspaceSnapshot, root: string): SourceFacts | null {
  const rootFolder = snapshot.folders.find((f) => f.id === root && !f.parentId);
  if (!rootFolder) return null;
  const ws = snapshot.workspaceId;
  const facts = new Facts(sourceId("collection", root), ws);
  const inside = snapshot.folders.filter((f) => rootOf(snapshot, f.id) === root);
  const lookup = candidatesFor(snapshot, root);
  const operations = snapshot.specifications.flatMap((spec) =>
    spec.operations
      .map((op) => {
        const [method, ...rest] = op.split(" ");
        return METHOD.test(method ?? "")
          ? { spec, name: op, method: method!, regex: templateRegex(rest.join(" ")) }
          : null;
      })
      .filter((o): o is NonNullable<typeof o> => !!o),
  );
  for (const f of inside) {
    const id = facts.node(f.parentId ? "folder" : "collection", f.id, f.name);
    if (f.parentId) {
      const parent = folderNodeId(snapshot, f.parentId);
      if (parent) facts.edge(parent, "contains", id, "declared");
    }
  }
  const insideIds = new Set(inside.map((f) => f.id));
  for (const r of snapshot.requests.filter((x) => insideIds.has(x.folderId))) {
    const id = facts.node("request", r.id, `${r.method} ${r.name}`, { method: r.method });
    const parent = folderNodeId(snapshot, r.folderId);
    if (parent) facts.edge(parent, "contains", id, "declared");
    for (const variant of expand(r.url, lookup)) {
      const host = hostOf(variant.url);
      if (host) {
        const service = facts.node("service", host, host, {}, true);
        facts.edge(id, "calls", service, "derived", { via: variant.vias.join(", ") || "url" });
      }
      for (const environmentId of new Set(variant.environments))
        facts.edge(id, "usesEnvironment", nodeId("environment", environmentId), "derived");
      const path = trimSlash(pathOf(variant.url).split("?")[0]!);
      for (const op of operations) {
        if (op.method !== r.method.toUpperCase()) continue;
        const prefixes = op.spec.servers.map((s) => trimSlash(pathOf(s))).filter((p) => p !== "/");
        const options = [
          path,
          ...prefixes.filter((p) => path.startsWith(p + "/")).map((p) => path.slice(p.length)),
        ];
        if (!options.some((p) => op.regex.test(p || "/"))) continue;
        // Only count a match when the request really goes to a host the specification declares, if it declares any.
        const hosts = op.spec.servers.map(hostOf).filter(Boolean);
        if (host && hosts.length && !hosts.includes(host)) continue;
        facts.edge(id, "implements", nodeId("operation", `${op.spec.id}:${op.name}`), "derived", {
          via: "method and path",
        });
      }
    }
  }
  for (const link of snapshot.links) {
    if (!insideIds.has(link.folderId)) continue;
    const from = folderNodeId(snapshot, link.folderId);
    if (from)
      facts.edge(from, "syncedFrom", nodeId("specification", link.specificationId), "declared", {
        version: link.version,
      });
  }
  return finish(facts, "collection", root, ws, rootFolder.name);
}

function specificationFacts(
  snapshot: WorkspaceSnapshot,
  spec: WorkspaceSnapshot["specifications"][number],
): SourceFacts {
  const facts = new Facts(sourceId("specification", spec.id), snapshot.workspaceId);
  const id = facts.node("specification", spec.id, spec.name, {
    format: spec.format,
    revision: spec.revision,
  });
  for (const name of spec.operations) {
    const op = facts.node("operation", `${spec.id}:${name}`, name, { specification: spec.name });
    facts.edge(op, "definedIn", id, "declared");
  }
  for (const server of spec.servers) {
    const host = hostOf(server);
    // The path prefix is kept so a request can still be matched to an operation without re-reading the specification.
    const prefix = trimSlash(pathOf(server));
    if (host)
      facts.edge(
        id,
        "servedBy",
        facts.node("service", host, host, {}, true),
        "declared",
        prefix === "/" ? {} : { path: prefix.slice(0, 200) },
      );
  }
  return finish(facts, "specification", spec.id, snapshot.workspaceId, spec.name);
}

function targetFacts(
  snapshot: WorkspaceSnapshot,
  kind: "mock" | "monitor" | "catalog",
  row: { id: string; folderId: string; enabled: boolean },
  label: string,
  type: EdgeType,
  props: GraphNode["props"],
): SourceFacts {
  const facts = new Facts(sourceId(kind, row.id), snapshot.workspaceId);
  const id = facts.node(kind, row.id, label, { ...props, enabled: row.enabled });
  const target = folderNodeId(snapshot, row.folderId);
  if (target) facts.edge(id, type, target, "declared");
  return finish(facts, kind, row.id, snapshot.workspaceId, label);
}

function webhookFacts(snapshot: WorkspaceSnapshot, hook: WorkspaceSnapshot["webhooks"][number]): SourceFacts {
  const facts = new Facts(sourceId("webhook", hook.id), snapshot.workspaceId);
  const id = facts.node("webhook", hook.id, hook.name, { enabled: hook.enabled });
  const host = hostOf(hook.url);
  if (host) facts.edge(id, "calls", facts.node("service", host, host, {}, true), "declared");
  return finish(facts, "webhook", hook.id, snapshot.workspaceId, hook.name);
}

function captureFacts(
  snapshot: WorkspaceSnapshot,
  session: WorkspaceSnapshot["captures"][number],
): SourceFacts {
  const facts = new Facts(sourceId("captureSession", session.id), snapshot.workspaceId);
  const id = facts.node("captureSession", session.id, session.name, { state: session.state });
  for (const h of session.hosts.slice(0, 200)) {
    const host = hostOf("//" + h.host);
    if (host)
      facts.edge(id, "observed", facts.node("service", host, host, {}, true), "telemetry", {
        requests: h.requests,
        lastAt: h.lastAt,
      });
  }
  return finish(facts, "captureSession", session.id, snapshot.workspaceId, session.name);
}

function environmentFacts(
  snapshot: WorkspaceSnapshot,
  env: WorkspaceSnapshot["environments"][number],
): SourceFacts {
  const facts = new Facts(sourceId("environment", env.id), snapshot.workspaceId);
  facts.node("environment", env.id, env.name);
  return finish(facts, "environment", env.id, snapshot.workspaceId, env.name);
}

/**
 * All sources for a workspace. Telemetry sources are included here and filtered by the caller, because whether one is
 * connected is a decision that lives outside the data.
 */
export function extractSources(snapshot: WorkspaceSnapshot): SourceFacts[] {
  const sources: SourceFacts[] = [];
  for (const f of snapshot.folders.filter((x) => !x.parentId)) {
    const s = collectionFacts(snapshot, f.id);
    if (s) sources.push(s);
  }
  for (const spec of snapshot.specifications) sources.push(specificationFacts(snapshot, spec));
  for (const m of snapshot.mocks) sources.push(targetFacts(snapshot, "mock", m, m.name, "mocks", {}));
  for (const m of snapshot.monitors)
    sources.push(targetFacts(snapshot, "monitor", m, m.name, "monitors", { state: m.state }));
  for (const c of snapshot.catalog)
    sources.push(targetFacts(snapshot, "catalog", c, c.title, "publishes", { visibility: c.visibility }));
  for (const h of snapshot.webhooks) sources.push(webhookFacts(snapshot, h));
  for (const c of snapshot.captures) sources.push(captureFacts(snapshot, c));
  for (const e of snapshot.environments) sources.push(environmentFacts(snapshot, e));
  return sources;
}
