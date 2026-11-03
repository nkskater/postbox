"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { graphOverview, searchGraph, traverseGraph } from "@/server/graph";

type Overview = ReturnType<typeof graphOverview>;
type Hit = ReturnType<typeof searchGraph>["nodes"][number];
type Traversal = ReturnType<typeof traverseGraph>;
const KINDS = [
  "collection",
  "folder",
  "request",
  "service",
  "specification",
  "operation",
  "environment",
  "mock",
  "monitor",
  "catalog",
  "webhook",
  "captureSession",
];
const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

export function GraphPanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  return workspaceId ? (
    <Explorer key={workspaceId} workspaceId={workspaceId} />
  ) : (
    <p className="p-4">Select a workspace.</p>
  );
}

function Explorer({ workspaceId }: { workspaceId: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [selected, setSelected] = useState("");
  const [direction, setDirection] = useState<"dependents" | "dependencies">("dependents");
  const [depth, setDepth] = useState(3);
  const [result, setResult] = useState<Traversal | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);
  useEffect(() => {
    let live = true;
    api.graph
      .overview(workspaceId)
      .then((o) => live && (setOverview(o), setError("")))
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, tick]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.graph
        .search(workspaceId, query, kind || undefined)
        .then((r) => !controller.signal.aborted && setHits(r.nodes))
        .catch((e) => !controller.signal.aborted && setError(message(e)));
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspaceId, query, kind, overview]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    api.graph
      .traverse({ workspaceId, node: selected, direction, depth })
      .then((r) => live && (setResult(r), setError("")))
      .catch((e) => live && (setResult(null), setError(message(e))));
    return () => {
      live = false;
    };
  }, [workspaceId, selected, direction, depth, overview]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">Dependencies</h2>
        {overview && (
          <span className="text-xs text-muted-foreground">
            {overview.nodes} nodes · {overview.edges} relationships
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => act(() => api.graph.refresh(workspaceId))}
        >
          Refresh index
        </Button>
      </div>
      <p className="max-w-3xl text-xs text-muted-foreground">
        Relationships read “A depends on B”. Choose a node to see what it relies on, or what would be affected
        if it changed. Each relationship shows whether it was written down, inferred, or observed in recorded
        traffic.
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <section aria-label="Find a node" className="space-y-2">
          <div className="flex gap-2">
            <Input
              aria-label="Search the graph"
              placeholder="Search services, requests, specs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Node kind"
              className="rounded-md border bg-background px-2 text-xs"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">All</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <ul className="max-h-96 space-y-1 overflow-auto">
            {hits.map((n) => (
              <li key={n.id}>
                <button
                  className={`w-full rounded px-2 py-1 text-left text-xs hover:bg-accent ${selected === n.id ? "bg-accent" : ""}`}
                  onClick={() => setSelected(n.id)}
                >
                  <span className="mr-2 rounded bg-muted px-1 text-[10px] uppercase">{n.kind}</span>
                  {n.label}
                </button>
              </li>
            ))}
            {!hits.length && <li className="text-xs text-muted-foreground">Nothing matches.</li>}
          </ul>
        </section>
        <section aria-label="Relationships" className="space-y-2">
          {!selected && (
            <p className="text-xs text-muted-foreground">Select a node to explore its relationships.</p>
          )}
          {selected && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <strong className="break-all">{result?.root.label ?? selected}</strong>
                <label className="flex items-center gap-1">
                  Show
                  <select
                    className="rounded-md border bg-background px-1 py-0.5"
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as typeof direction)}
                  >
                    <option value="dependents">what depends on it (impact)</option>
                    <option value="dependencies">what it depends on</option>
                  </select>
                </label>
                <label className="flex items-center gap-1">
                  Depth
                  <select
                    className="rounded-md border bg-background px-1 py-0.5"
                    value={depth}
                    onChange={(e) => setDepth(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5, 6, 8].map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
              </div>
              {result && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {Object.entries(result.summary)
                      .map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`)
                      .join(" · ") || "Nothing reached."}
                    {result.truncated && " (more not shown)"}
                  </p>
                  <ul className="space-y-1">
                    {result.nodes.map(({ node, depth: d, via }) => {
                      return (
                        <li
                          key={node.id}
                          className="flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-xs"
                        >
                          <span className="text-muted-foreground">{"·".repeat(d)}</span>
                          <button className="underline" onClick={() => setSelected(node.id)}>
                            {node.label}
                          </button>
                          <span className="rounded bg-muted px-1 text-[10px] uppercase">{node.kind}</span>
                          {via && (
                            <span className="text-muted-foreground">
                              {via.type} · {via.origin} · from {via.sourceId.split(":")[0]}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </>
          )}
        </section>
      </div>
      <section aria-label="Sources" className="space-y-2">
        <h3 className="text-sm font-medium">Sources</h3>
        <ul className="space-y-1">
          {overview?.sources.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-xs">
              <span className="rounded bg-muted px-1 text-[10px] uppercase">{s.kind}</span>
              <span>{s.label}</span>
              <span
                className={s.state === "fresh" ? "text-muted-foreground" : "text-amber-600"}
                title={s.error ?? undefined}
              >
                {s.telemetry && !s.connected ? "not connected" : s.state}
              </span>
              {s.error && <span className="text-destructive">{s.error}</span>}
              {s.telemetry && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => act(() => api.graph.connect(workspaceId, s.id, !s.connected))}
                >
                  {s.connected ? "Disconnect" : "Connect"}
                </Button>
              )}
            </li>
          ))}
          {!overview?.sources.length && (
            <li className="text-xs text-muted-foreground">Nothing indexed yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
