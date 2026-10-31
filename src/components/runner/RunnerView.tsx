"use client";
/**
 * Collection runner tab: choose requests, options and iteration data, run with
 * live progress, inspect per-request results and export reports.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ChevronDown, ChevronRight, Database, FileUp, Loader2, Play, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import type { DataTable, DatasetRef } from "@/core/types";
import type { RunEvent, RunResult } from "@/core/runner/runner";
import { filterRows } from "@/core/runner/data";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TestResultsList } from "@/components/response/ResponseViewer";
import { formatBytes, formatMs, methodColor, relativeTime, statusColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getSetting } from "@/lib/settings/runtime";
import { useSetting } from "@/stores/settings";
import { readNdjson } from "@/lib/ndjson";
import { DatasetPicker } from "./DatasetPicker";
import { DataGrid } from "./DataGrid";
import { Schedules } from "./Schedules";
import { RunComparison } from "./RunComparison";
import { RunResultDetails } from "./RunResultDetails";

interface RunState {
  runId: string | null;
  running: boolean;
  total: number;
  iterations: number;
  results: RunResult[];
  current?: string;
  done?: Extract<RunEvent, { type: "done" }>["summary"];
  error?: string;
}

interface PastRun {
  id: string;
  name: string;
  status: string;
  startedAt: number;
  totalRequests: number;
  passedTests: number;
  failedTests: number;
  durationMs: number;
}

const emptyRun: RunState = { runId: null, running: false, total: 0, iterations: 0, results: [] };

export function RunnerView({ folderId }: { folderId: string }) {
  const {
    folders,
    requests,
    environments,
    environmentId: activeEnv,
    workspaceId,
    log,
    refreshVariables,
  } = useApp(
    useShallow((s) => ({
      folders: s.folders,
      requests: s.requests,
      environments: s.environments,
      environmentId: s.environmentId,
      workspaceId: s.workspaceId,
      log: s.log,
      refreshVariables: s.refreshVariables,
    })),
  );
  const folder = folders.find((f) => f.id === folderId);

  // Requests below this folder in tree order.
  const ordered = useMemo(() => {
    const out: { id: string; name: string; method: string; path: string }[] = [];
    const walk = (fid: string, path: string[]) => {
      const kids = [
        ...folders.filter((f) => f.parentId === fid).map((f) => ({ kind: "f" as const, sort: f.sort, f })),
        ...requests.filter((r) => r.folderId === fid).map((r) => ({ kind: "r" as const, sort: r.sort, r })),
      ].sort((a, b) => a.sort - b.sort);
      for (const k of kids) {
        if (k.kind === "r")
          out.push({ id: k.r.id, name: k.r.name, method: k.r.method, path: path.join(" / ") });
        else walk(k.f.id, [...path, k.f.name]);
      }
    };
    walk(folderId, []);
    return out;
  }, [folders, requests, folderId]);

  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [envId, setEnvId] = useState<string | null>(activeEnv);
  const [iterationsInput, setIterations] = useState(1);
  /** While true, the iteration count follows the number of (filtered) data rows. */
  const [autoIterations, setAutoIterations] = useState(true);
  // Initial option values come from Settings → Collection runner.
  const [delayMs, setDelayMs] = useState(() => getSetting<number>("runner.delayMs") ?? 0);
  const [stopOnFailure, setStopOnFailure] = useState(
    () => getSetting<boolean>("runner.stopOnFailure") ?? false,
  );
  const [persistVariables, setPersistVariables] = useState(
    () => getSetting<boolean>("runner.persistVariables") ?? true,
  );
  const [verifySsl, setVerifySsl] = useState(() => getSetting<boolean>("runner.verifySsl") ?? true);
  const preferredReport = useSetting<string>("runner.reportFormat");
  const [data, setData] = useState<DataTable | null>(null);
  const [dataset, setDataset] = useState<DatasetRef | null>(null);
  const [dataName, setDataName] = useState("");
  const [filter, setFilter] = useState("");
  const [run, setRun] = useState<RunState>(emptyRun);
  const [view, setView] = useState<"all" | "passed" | "failed">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [past, setPast] = useState<PastRun[]>([]);
  const streamController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      streamController.current?.abort();
      streamController.current = null;
    },
    [],
  );

  const filtered = useMemo(() => (data ? filterRows(data, filter) : null), [data, filter]);
  const iterations = autoIterations && filtered ? Math.max(1, filtered.rows.length) : iterationsInput;

  const loadPast = useCallback(() => {
    if (workspaceId)
      fetch(`/api/runs?workspaceId=${workspaceId}&folderId=${folderId}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows) => setPast(Array.isArray(rows) ? rows : []))
        .catch(() => undefined);
  }, [workspaceId, folderId]);
  useEffect(loadPast, [loadPast]);

  const onFile = async (file: File) => {
    try {
      const { readDataFile, formatIssue } = await import("@/core/runner/data");
      const buf = new Uint8Array(await file.arrayBuffer());
      const { table, warnings } = readDataFile(file.name, buf);
      if (!table.columns.length) throw new Error("No columns found");
      setDataset(null);
      setData(table);
      setDataName(file.name);
      setFilter("");
      setAutoIterations(true);
      toast.success(`Loaded ${table.rows.length} rows × ${table.columns.length} columns`);
      if (warnings.length)
        toast.warning(`${warnings.length} row(s) were short and padded with empty cells`, {
          description: warnings.slice(0, 3).map(formatIssue).join("\n"),
        });
    } catch (err) {
      toast.error(`Could not read data file: ${(err as Error).message}`);
    }
  };

  const start = async () => {
    if (!workspaceId) return;
    const selected = ordered.filter((r) => !excluded.has(r.id)).map((r) => r.id);
    if (!selected.length) return toast.error("Select at least one request");
    streamController.current?.abort();
    const controller = new AbortController();
    streamController.current = controller;
    setRun({ ...emptyRun, running: true });
    setExpanded(new Set());
    try {
      const res = await fetch("/api/runs", {
        signal: controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          folderId,
          environmentId: envId,
          options: {
            iterations: dataset && autoIterations ? 0 : iterations,
            delayMs,
            stopOnFailure,
            persistVariables,
            verifySsl,
          },
          data: dataset ? null : filtered,
          dataset,
          selectedRequestIds: selected.length === ordered.length ? null : selected,
        }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      let terminal = false;
      for await (const event of readNdjson(res.body)) {
        if (streamController.current !== controller) return;
        const e = event as
          | ((RunEvent | { type: "queued"; position: number }) & { runId: string })
          | { type: "error"; error: string };
        if (e.type === "done" || e.type === "error") terminal = true;
        setRun((s) => {
          switch (e.type) {
            case "queued":
              return { ...s, runId: e.runId, current: `Queued #${e.position}, waiting for a free run slot` };
            case "start":
              return { ...s, runId: e.runId, total: e.total, iterations: e.iterations, current: undefined };
            case "request":
              return { ...s, current: `${e.name} (iteration ${e.iteration + 1})` };
            case "result":
              return { ...s, results: [...s.results, e.result] };
            case "done":
              return { ...s, done: e.summary, running: false, current: undefined };
            case "error":
              return { ...s, error: e.error, running: false };
            default:
              return s;
          }
        });
        if (e.type === "log") log(e.entries);
      }
      if (!terminal)
        throw new Error("Run progress disconnected. Open the run from history to check its status.");
    } catch (err) {
      if (streamController.current !== controller || controller.signal.aborted) return;
      toast.error((err as Error).message);
      setRun((s) => ({ ...s, error: (err as Error).message }));
    } finally {
      if (streamController.current === controller) {
        streamController.current = null;
        setRun((s) => ({ ...s, running: false }));
        void refreshVariables();
        loadPast();
      }
    }
  };

  const stop = async () => {
    if (run.runId) await fetch(`/api/runs/${run.runId}/cancel`, { method: "POST" });
  };

  const openPast = async (id: string) => {
    const r = await fetch(`/api/runs/${id}`).then((x) => x.json());
    setRun({
      runId: r.id,
      running: false,
      total: r.totalRequests,
      iterations: r.iterations,
      results: r.results,
      done: r,
    });
    setExpanded(new Set());
  };

  const shown = run.results.filter((r) => view === "all" || (view === "passed" ? r.passed : !r.passed));
  const passedCount = run.results.filter((r) => r.passed).length;
  const failedCount = run.results.length - passedCount;
  const progress = run.total ? Math.min(100, (run.results.length / run.total) * 100) : 0;

  return (
    <Group orientation="horizontal" className="h-full">
      <Panel defaultSize="42" minSize="25">
        <div className="flex h-full flex-col gap-4 overflow-auto p-4 text-xs">
          <div>
            <h2 className="text-lg font-medium">Run {folder?.name}</h2>
            <p className="text-muted-foreground">Requests run sequentially in the order shown.</p>
          </div>

          <section className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">
                Requests ({ordered.length - excluded.size}/{ordered.length})
              </Label>
              <div className="flex gap-2">
                <button className="text-primary hover:underline" onClick={() => setExcluded(new Set())}>
                  All
                </button>
                <button
                  className="text-primary hover:underline"
                  onClick={() => setExcluded(new Set(ordered.map((r) => r.id)))}
                >
                  None
                </button>
              </div>
            </div>
            <div className="max-h-56 overflow-auto rounded-md border p-1">
              {ordered.length === 0 && (
                <p className="p-3 text-center text-muted-foreground">No requests in this folder.</p>
              )}
              {ordered.map((r) => (
                <label
                  key={r.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-accent"
                >
                  <Checkbox
                    checked={!excluded.has(r.id)}
                    onCheckedChange={(c) =>
                      setExcluded((s) => {
                        const n = new Set(s);
                        if (c) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      })
                    }
                  />
                  <span className={cn("w-12 font-mono text-[10px] font-bold", methodColor(r.method))}>
                    {r.method}
                  </span>
                  <span className="truncate">{r.name}</span>
                  {r.path && (
                    <span className="ml-auto truncate text-[10px] text-muted-foreground">{r.path}</span>
                  )}
                </label>
              ))}
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Environment</Label>
              <Select value={envId ?? "__none"} onValueChange={(v) => setEnvId(v === "__none" ? null : v)}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none" className="text-xs">
                    No environment
                  </SelectItem>
                  {environments.map((e) => (
                    <SelectItem key={e.id} value={e.id} className="text-xs">
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Iterations</Label>
              <Input
                type="number"
                min={1}
                className="h-8 text-xs"
                value={iterations}
                onChange={(e) => {
                  setAutoIterations(false);
                  setIterations(Math.max(1, Number(e.target.value) || 1));
                }}
              />
              {dataset && (
                <label className="flex items-center gap-1 text-[11px]">
                  <input
                    type="checkbox"
                    checked={autoIterations}
                    onChange={(e) => setAutoIterations(e.target.checked)}
                  />
                  One iteration per saved dataset row at run start
                </label>
              )}
              {!dataset && filtered && iterations !== filtered.rows.length && (
                <button
                  className="text-[11px] text-primary hover:underline"
                  onClick={() => setAutoIterations(true)}
                >
                  Use {filtered.rows.length} (one per data row)
                </button>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Delay between requests (ms)</Label>
              <Input
                type="number"
                min={0}
                className="h-8 text-xs"
                value={delayMs}
                onChange={(e) => setDelayMs(Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
            <label className="flex items-center gap-2">
              <Switch checked={stopOnFailure} onCheckedChange={setStopOnFailure} /> Stop run on first failure
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={persistVariables} onCheckedChange={setPersistVariables} /> Persist variable
              changes
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={verifySsl} onCheckedChange={setVerifySsl} /> Verify SSL certificates
            </label>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1 text-xs">
                <Database className="size-3.5" /> Iteration data{" "}
                {dataName && <span className="text-muted-foreground">· {dataName}</span>}
              </Label>
              <label className="flex cursor-pointer items-center gap-1 text-primary hover:underline">
                <FileUp className="size-3.5" /> {data ? "Replace file" : "Select CSV, JSON or XLSX"}
                <input
                  type="file"
                  accept=".csv,.tsv,.txt,.json,.xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {workspaceId && (
              <DatasetPicker
                key={workspaceId}
                workspaceId={workspaceId}
                value={dataset}
                onChange={(value) => {
                  setDataset(value);
                  setAutoIterations(true);
                }}
              />
            )}
            {!dataset &&
              (data ? (
                <DataGrid
                  table={data}
                  onChange={(t) => {
                    setData(t);
                    if (!t) setDataName("");
                  }}
                  filter={filter}
                  onFilterChange={setFilter}
                />
              ) : (
                <p className="rounded-md border border-dashed p-3 text-muted-foreground">
                  Each row becomes one iteration. Column headers map to variables, e.g. a column{" "}
                  <code>asn_id</code> is available as <code className="text-success">{"{{asn_id}}"}</code> and{" "}
                  <code>pm.iterationData.get(&quot;asn_id&quot;)</code>.
                </p>
              ))}
          </section>

          {workspaceId && (
            <Schedules
              key={`${workspaceId}:${folderId}`}
              workspaceId={workspaceId}
              folderId={folderId}
              environments={environments}
              environmentId={envId}
              onOpenRun={(id) => void openPast(id)}
              onRunStarted={loadPast}
              canOpenRun={!run.running}
            />
          )}

          <div className="sticky bottom-0 flex gap-2 bg-background pt-2">
            {run.running ? (
              <Button variant="destructive" className="flex-1" onClick={stop}>
                <Square className="size-4" /> Stop
              </Button>
            ) : (
              <Button className="flex-1" onClick={start} disabled={!ordered.length}>
                <Play className="size-4" /> Run {folder?.name}
              </Button>
            )}
          </div>
        </div>
      </Panel>
      <Separator className="w-px bg-border hover:bg-primary data-[separator=active]:bg-primary" />
      <Panel minSize="30">
        <div className="flex h-full flex-col text-xs">
          <div className="space-y-2 border-b p-3">
            <div className="flex items-center gap-3">
              <span className="font-medium">Results</span>
              {run.running && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> {run.current}
                </span>
              )}
              {run.done && (
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                    run.done.status === "passed"
                      ? "bg-success/15 text-success"
                      : "bg-destructive/15 text-destructive",
                  )}
                >
                  {run.done.status}
                </span>
              )}
              {run.runId && !run.running && (
                <div className="ml-auto flex gap-1">
                  {(["json", "junit", "html"] as const)
                    .slice()
                    .sort((a, b) => Number(b === preferredReport) - Number(a === preferredReport))
                    .map((f) => (
                      <Button
                        key={f}
                        variant="outline"
                        size="sm"
                        className="h-6 text-[11px]"
                        onClick={() => window.open(`/api/runs/${run.runId}/export?format=${f}`, "_blank")}
                      >
                        Export {f === "junit" ? "JUnit" : f.toUpperCase()}
                      </Button>
                    ))}
                </div>
              )}
            </div>
            {run.done?.dataset && (
              <p className="text-muted-foreground">
                Dataset: {run.done.dataset.name ?? run.done.dataset.id} · version {run.done.dataset.version}
              </p>
            )}
            {(run.running || run.results.length > 0) && (
              <>
                <div className="h-1.5 overflow-hidden rounded bg-muted">
                  <div
                    className={cn("h-full transition-all", failedCount ? "bg-destructive" : "bg-success")}
                    style={{ width: `${run.done ? 100 : progress}%` }}
                  />
                </div>
                <div className="flex gap-4 text-muted-foreground">
                  <span>Iterations: {run.iterations}</span>
                  <span>
                    Requests: {run.results.length}
                    {run.running && run.total ? ` / ${run.total}` : ""}
                  </span>
                  {run.done && (
                    <>
                      <span className="text-success">Tests passed: {run.done.passedTests}</span>
                      <span className="text-destructive">Tests failed: {run.done.failedTests}</span>
                      <span>Duration: {formatMs(run.done.durationMs)}</span>
                    </>
                  )}
                </div>
                <div className="flex gap-1">
                  {(["all", "passed", "failed"] as const).map((v) => (
                    <Button
                      key={v}
                      variant={view === v ? "secondary" : "ghost"}
                      size="sm"
                      className="h-6 text-[11px] capitalize"
                      onClick={() => setView(v)}
                    >
                      {v} ({v === "all" ? run.results.length : v === "passed" ? passedCount : failedCount})
                    </Button>
                  ))}
                </div>
              </>
            )}
            {run.error && <div className="text-destructive">{run.error}</div>}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {workspaceId && (
              <RunComparison
                key={`${workspaceId}:${folderId}`}
                runs={past}
                workspaceId={workspaceId}
                folderId={folderId}
              />
            )}
            {run.results.length === 0 && !run.running && (
              <div className="p-4">
                <p className="mb-3 text-muted-foreground">Run the collection to see results here.</p>
                {past.length > 0 && (
                  <>
                    <div className="mb-1 font-medium">Previous runs</div>
                    {past.map((p) => (
                      <div
                        key={p.id}
                        className="group flex items-center gap-3 rounded px-2 py-1 hover:bg-accent"
                      >
                        <button
                          className="flex flex-1 items-center gap-3 text-left"
                          onClick={() => openPast(p.id)}
                        >
                          <span
                            className={cn(
                              "w-14 text-[10px] font-semibold uppercase",
                              p.status === "passed"
                                ? "text-success"
                                : p.status === "running"
                                  ? "text-warning"
                                  : "text-destructive",
                            )}
                          >
                            {p.status}
                          </span>
                          <span>{relativeTime(p.startedAt)}</span>
                          <span className="text-muted-foreground">{p.totalRequests} requests</span>
                          <span className="text-success">{p.passedTests} passed</span>
                          <span className="text-destructive">{p.failedTests} failed</span>
                          <span className="ml-auto text-muted-foreground">{formatMs(p.durationMs)}</span>
                        </button>
                        <button
                          className="opacity-0 group-hover:opacity-100"
                          title="Delete run"
                          onClick={async () => {
                            await fetch(`/api/runs/${p.id}`, { method: "DELETE" });
                            loadPast();
                          }}
                        >
                          <Trash2 className="size-3.5 text-muted-foreground" />
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
            {shown.map((r) => {
              const open = expanded.has(r.sequence);
              const failedTests = r.tests.filter((t) => !t.passed).length;
              return (
                <div key={r.sequence} className="border-b">
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/50"
                    onClick={() =>
                      setExpanded((s) => {
                        const n = new Set(s);
                        if (n.has(r.sequence)) n.delete(r.sequence);
                        else n.add(r.sequence);
                        return n;
                      })
                    }
                  >
                    {open ? (
                      <ChevronDown className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0" />
                    )}
                    <span
                      className={cn(
                        "w-10 shrink-0 text-[10px] font-semibold uppercase",
                        r.skipped ? "text-muted-foreground" : r.passed ? "text-success" : "text-destructive",
                      )}
                    >
                      {r.skipped ? "skip" : r.passed ? "pass" : "fail"}
                    </span>
                    {run.iterations > 1 && (
                      <span className="w-8 shrink-0 text-muted-foreground">#{r.iteration + 1}</span>
                    )}
                    <span
                      className={cn("w-12 shrink-0 font-mono text-[10px] font-bold", methodColor(r.method))}
                    >
                      {r.method}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {r.name} <span className="text-muted-foreground">{r.url}</span>
                    </span>
                    {r.tests.length > 0 && (
                      <span className={failedTests ? "text-destructive" : "text-success"}>
                        {r.tests.length - failedTests}/{r.tests.length}
                      </span>
                    )}
                    <span className={cn("w-10 text-right", statusColor(r.status))}>{r.status ?? "ERR"}</span>
                    <span className="w-16 text-right text-muted-foreground">{formatMs(r.timeMs)}</span>
                    <span className="w-16 text-right text-muted-foreground">{formatBytes(r.size)}</span>
                  </button>
                  {open && (
                    <div className="space-y-2 bg-muted/20 px-9 py-2">
                      {r.error && <div className="text-destructive">{r.error}</div>}
                      {r.scriptErrors.map((e, i) => (
                        <div key={i} className="text-destructive">
                          {e.source}: {e.message}
                        </div>
                      ))}
                      <TestResultsList tests={r.tests} />
                      <RunResultDetails key={`${r.iteration}:${r.sequence}`} result={r} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Panel>
    </Group>
  );
}
