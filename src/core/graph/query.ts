/**
 * Queries over an already access-filtered graph. The view a caller passes in is the only thing they can reach, so
 * nothing here needs to know about users, workspaces or roles.
 */
import {
  GRAPH_LIMITS,
  type EdgeOrigin,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
} from "./model";

export interface GraphView {
  nodes: Map<string, GraphNode>;
  forward: Map<string, GraphEdge[]>;
  backward: Map<string, GraphEdge[]>;
  edges: GraphEdge[];
}

/** Build a view, dropping edges whose ends are not both present (their source was removed or hidden). */
export function buildView(nodes: Iterable<GraphNode>, edges: Iterable<GraphEdge>): GraphView {
  const byId = new Map<string, GraphNode>();
  for (const n of nodes) {
    const have = byId.get(n.id);
    // A shared node (a service) can be reported by several sources; keep one and prefer the one with a workspace.
    if (!have || (!have.workspaceId && n.workspaceId)) byId.set(n.id, n);
  }
  const kept: GraphEdge[] = [];
  const forward = new Map<string, GraphEdge[]>();
  const backward = new Map<string, GraphEdge[]>();
  const push = (m: Map<string, GraphEdge[]>, k: string, e: GraphEdge) => {
    const list = m.get(k);
    if (list) list.push(e);
    else m.set(k, [e]);
  };
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    kept.push(e);
    push(forward, e.from, e);
    push(backward, e.to, e);
  }
  return { nodes: byId, forward, backward, edges: kept };
}

export interface SearchHit {
  node: GraphNode;
  score: number;
}
export function searchNodes(
  view: GraphView,
  query: string,
  kind: NodeKind | undefined,
  limit: number = 50,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  for (const node of view.nodes.values()) {
    if (kind && node.kind !== kind) continue;
    const label = node.label.toLowerCase();
    let score = 0;
    if (!q) score = 1;
    else if (node.id.toLowerCase() === q || label === q) score = 100;
    else if (label.startsWith(q)) score = 60;
    else if (label.includes(q)) score = 40;
    else if (node.id.toLowerCase().includes(q)) score = 20;
    if (score) hits.push({ node, score });
  }
  return hits
    .sort(
      (a, b) =>
        b.score - a.score || a.node.label.localeCompare(b.node.label) || a.node.id.localeCompare(b.node.id),
    )
    .slice(0, Math.min(limit, GRAPH_LIMITS.resultNodes));
}

export interface TraverseOptions {
  direction: "dependencies" | "dependents" | "both";
  depth: number;
  types?: readonly EdgeType[];
  origins?: readonly EdgeOrigin[];
  limit: number;
}
export interface TraversalNode {
  node: GraphNode;
  /** Hops from the start node. */
  depth: number;
  /** The relationship that first reached it. */
  via: GraphEdge;
}
export interface Traversal {
  root: GraphNode;
  nodes: TraversalNode[];
  edges: GraphEdge[];
  /** Count of reached nodes per kind, excluding the root: the shape of the blast radius at a glance. */
  summary: Partial<Record<NodeKind, number>>;
  truncated: boolean;
}

const allowed = (e: GraphEdge, o: TraverseOptions) =>
  (!o.types?.length || o.types.includes(e.type)) && (!o.origins?.length || o.origins.includes(e.origin));

export function traverse(view: GraphView, start: string, options: TraverseOptions): Traversal | null {
  const root = view.nodes.get(start);
  if (!root) return null;
  const limit = Math.min(options.limit, GRAPH_LIMITS.resultNodes);
  const depthOf = new Map<string, number>([[start, 0]]);
  const reachedBy = new Map<string, GraphEdge>();
  const edges = new Map<string, GraphEdge>();
  let truncated = false;
  let frontier = [start];
  for (let depth = 1; depth <= Math.min(options.depth, GRAPH_LIMITS.depth) && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const steps: { edge: GraphEdge; to: string }[] = [];
      if (options.direction !== "dependents")
        for (const edge of view.forward.get(id) ?? []) steps.push({ edge, to: edge.to });
      if (options.direction !== "dependencies")
        for (const edge of view.backward.get(id) ?? []) steps.push({ edge, to: edge.from });
      for (const { edge, to } of steps) {
        if (!allowed(edge, options)) continue;
        if (!depthOf.has(to)) {
          if (depthOf.size > limit || edges.size >= GRAPH_LIMITS.resultEdges) {
            truncated = true;
            continue;
          }
          depthOf.set(to, depth);
          reachedBy.set(to, edge);
          next.push(to);
        }
        edges.set(`${edge.sourceId}|${edge.from}|${edge.type}|${edge.to}`, edge);
      }
    }
    frontier = next.sort();
  }
  const nodes = [...depthOf]
    .filter(([id]) => id !== start)
    .map(([id, depth]) => ({ node: view.nodes.get(id)!, depth, via: reachedBy.get(id)! }))
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        a.node.kind.localeCompare(b.node.kind) ||
        a.node.label.localeCompare(b.node.label),
    );
  const summary: Traversal["summary"] = {};
  for (const { node } of nodes) summary[node.kind] = (summary[node.kind] ?? 0) + 1;
  return {
    root,
    nodes,
    edges: [...edges.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to),
    ),
    summary,
    truncated,
  };
}

export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the path runs against the dependency direction (`from` is something `to` depends on). */
  reversed: boolean;
}
/** The shortest chain between two nodes, following dependencies first and dependents if there is no such chain. */
export function shortestPath(view: GraphView, from: string, to: string, maxDepth: number): GraphPath | null {
  if (!view.nodes.has(from) || !view.nodes.has(to)) return null;
  const search = (reversed: boolean): GraphPath | null => {
    const prev = new Map<string, GraphEdge | null>([[from, null]]);
    let frontier = [from];
    for (
      let depth = 0;
      depth < Math.min(maxDepth, GRAPH_LIMITS.depth) && frontier.length && !prev.has(to);
      depth++
    ) {
      const next: string[] = [];
      for (const id of frontier)
        for (const edge of (reversed ? view.backward : view.forward).get(id) ?? []) {
          const target = reversed ? edge.from : edge.to;
          if (prev.has(target)) continue;
          prev.set(target, edge);
          next.push(target);
        }
      frontier = next.sort();
    }
    if (!prev.has(to)) return null;
    const edges: GraphEdge[] = [];
    const nodes: GraphNode[] = [];
    for (let cur = to; ;) {
      nodes.unshift(view.nodes.get(cur)!);
      const edge = prev.get(cur);
      if (!edge) break;
      edges.unshift(edge);
      cur = reversed ? edge.to : edge.from;
    }
    return { nodes, edges, reversed };
  };
  return search(false) ?? search(true);
}
