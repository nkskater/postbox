/**
 * The API dependency context graph.
 *
 * An edge `A -> B` always reads "A depends on B". A folder depends on the requests it contains, a request depends on
 * the service it calls, a monitor depends on the collection it runs. So the *dependencies* of a node are what you
 * reach by following edges forward and its *dependents* (the blast radius of a change) are what you reach by following
 * them backwards.
 *
 * Every node and edge belongs to one source (a collection, a specification, a mock, a monitor, ...). Re-indexing
 * replaces a source's contribution as a unit, so nothing is ever patched in place and a removed source takes all of its
 * facts with it.
 */
import { z } from "zod";

export const GRAPH_LIMITS = {
  nodesPerWorkspace: 50000,
  edgesPerWorkspace: 150000,
  resultNodes: 500,
  resultEdges: 2000,
  depth: 8,
  label: 300,
  staleAfterHours: 24 * 7,
} as const;

export const NODE_KINDS = [
  "collection",
  "folder",
  "request",
  "environment",
  "specification",
  "operation",
  "mock",
  "monitor",
  "catalog",
  "service",
  "captureSession",
  "webhook",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_TYPES = [
  /** Parent depends on a child it contains. */
  "contains",
  /** A request, webhook or specification talks to a service (a host). */
  "calls",
  /** A request reads variables defined by an environment. */
  "usesEnvironment",
  /** A request matches an operation declared by a specification. */
  "implements",
  /** An operation is defined by a specification. */
  "definedIn",
  /** A specification is served from a host. */
  "servedBy",
  /** A collection is kept in sync with a specification. */
  "syncedFrom",
  /** A mock server serves a collection. */
  "mocks",
  /** A monitor runs a collection. */
  "monitors",
  /** A catalog entry publishes a collection. */
  "publishes",
  /** Recorded traffic that reached a service. */
  "observed",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** `declared` came from something a person wrote down; `derived` was inferred; `telemetry` was observed on the wire. */
export type EdgeOrigin = "declared" | "derived" | "telemetry";

export const SOURCE_KINDS = [
  "collection",
  "environment",
  "specification",
  "mock",
  "monitor",
  "catalog",
  "webhook",
  "captureSession",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
/** Telemetry is only indexed once someone connects it and stops the moment they disconnect it. */
export const TELEMETRY_SOURCES: readonly SourceKind[] = ["captureSession"];
export type SourceState = "fresh" | "stale" | "error" | "revoked";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Null for nodes that belong to no workspace (a service shared by several). */
  workspaceId: string | null;
  label: string;
  props: Record<string, string | number | boolean | null>;
}
export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  origin: EdgeOrigin;
  /** The workspace whose data produced the edge; decides who may see it. */
  workspaceId: string;
  /** The source that produced it, for provenance. */
  sourceId: string;
  props: Record<string, string | number | boolean | null>;
}
export interface SourceFacts {
  /** `kind:ref`, stable across re-indexing. */
  id: string;
  kind: SourceKind;
  ref: string;
  workspaceId: string;
  label: string;
  /** Hash of everything the facts were derived from; equal fingerprints mean nothing needs re-indexing. */
  fingerprint: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const nodeId = (kind: NodeKind, ref: string) => `${kind}:${ref}`;
export const sourceId = (kind: SourceKind, ref: string) => `${kind}:${ref}`;
export const edgeKey = (e: Pick<GraphEdge, "from" | "to" | "type" | "sourceId">) =>
  `${e.sourceId}|${e.from}|${e.type}|${e.to}`;

const kinds = z.enum(NODE_KINDS);
const edgeTypes = z.enum(EDGE_TYPES);
const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : v,
    z.array(item),
  );

export const graphSearchSchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string().max(200).default(""),
  kind: kinds.optional(),
  limit: z.coerce.number().int().min(1).max(GRAPH_LIMITS.resultNodes).default(50),
});
export const graphTraverseSchema = z.object({
  workspaceId: z.string().min(1),
  node: z.string().min(1).max(600),
  /** dependencies: what it needs; dependents: what breaks if it changes; both: the neighbourhood. */
  direction: z.enum(["dependencies", "dependents", "both"]).default("dependencies"),
  depth: z.coerce.number().int().min(1).max(GRAPH_LIMITS.depth).default(3),
  types: csv(edgeTypes).optional(),
  origins: csv(z.enum(["declared", "derived", "telemetry"])).optional(),
  limit: z.coerce.number().int().min(1).max(GRAPH_LIMITS.resultNodes).default(200),
});
export const graphPathSchema = z.object({
  workspaceId: z.string().min(1),
  from: z.string().min(1).max(600),
  to: z.string().min(1).max(600),
  depth: z.coerce.number().int().min(1).max(GRAPH_LIMITS.depth).default(6),
});
export const graphConnectSchema = z.object({ connected: z.boolean() });
export type GraphTraverseInput = z.input<typeof graphTraverseSchema>;
