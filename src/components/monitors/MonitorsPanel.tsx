"use client";
import { useEffect, useState } from "react";
import { useApp, folderPath } from "@/stores/app";
import { api } from "@/lib/api";
import { monitorRulesSchema } from "@/core/monitoring/model";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { getMonitor, listMonitors } from "@/server/monitors";
type Document = ReturnType<typeof getMonitor>;
const blank = () => ({
  name: "API monitor",
  folderId: "",
  environmentId: "",
  cron: "*/5 * * * *",
  enabled: true,
  maxLatencyMs: "",
  minAvailability: "100",
  minAssertions: "",
  failAfter: "1",
  recoverAfter: "1",
  timeoutMs: "15000",
  maxDurationMs: "60000",
  emails: "",
});
const percent = (passed: number | null, total: number | null) =>
  total ? `${((100 * (passed ?? 0)) / total).toFixed(2)}%` : "No observations";
export function MonitorsPanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  return workspaceId ? (
    <MonitorDashboard key={workspaceId} workspaceId={workspaceId} />
  ) : (
    <p className="p-4">Select a workspace.</p>
  );
}
function MonitorDashboard({ workspaceId }: { workspaceId: string }) {
  const folders = useApp((s) => s.folders),
    environments = useApp((s) => s.environments);
  const [items, setItems] = useState<ReturnType<typeof listMonitors>>([]),
    [selected, setSelected] = useState(""),
    [doc, setDoc] = useState<Document | null>(null),
    [form, setForm] = useState(blank),
    [hours, setHours] = useState(168),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [sampleId, setSampleId] = useState(""),
    [runId, setRunId] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const [list, value] = await Promise.all([
          api.monitors.list(workspaceId, controller.signal),
          selected ? api.monitors.get(selected, hours, controller.signal) : Promise.resolve(null),
        ]);
        if (!controller.signal.aborted) {
          setItems(list);
          setDoc(value);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : "Could not load monitors");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [workspaceId, selected, hours]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    api.monitors
      .get(selected, 168, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setForm({
          name: value.name,
          folderId: value.folderId,
          environmentId: value.environmentId ?? "",
          cron: value.cron,
          enabled: value.enabled,
          maxLatencyMs: value.rules.maxLatencyMs === null ? "" : String(value.rules.maxLatencyMs),
          minAvailability: String(value.rules.minAvailability),
          minAssertions: value.rules.minAssertions === null ? "" : String(value.rules.minAssertions),
          failAfter: String(value.rules.failAfter),
          recoverAfter: String(value.rules.recoverAfter),
          timeoutMs: String(value.rules.timeoutMs),
          maxDurationMs: String(value.rules.maxDurationMs),
          emails: value.emails.join(", "),
        });
        setSampleId("");
        setRunId("");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [selected]);
  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Monitor operation failed");
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    guard(async () => {
      if (selected && doc?.id !== selected) throw new Error("Wait for the selected monitor to load");
      const rules = monitorRulesSchema.parse({
        maxLatencyMs: form.maxLatencyMs ? Number(form.maxLatencyMs) : null,
        minAvailability: Number(form.minAvailability),
        minAssertions: form.minAssertions ? Number(form.minAssertions) : null,
        failAfter: Number(form.failAfter),
        recoverAfter: Number(form.recoverAfter),
        timeoutMs: Number(form.timeoutMs),
        maxDurationMs: Number(form.maxDurationMs),
      });
      const input = {
        workspaceId,
        name: form.name,
        folderId: form.folderId,
        environmentId: form.environmentId || null,
        cron: form.cron,
        enabled: form.enabled,
        rules,
        emails: form.emails
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean),
      };
      const { workspaceId: _workspaceId, ...patch } = input;
      const value =
        selected && doc
          ? await api.monitors.update(selected, {
              ...patch,
              expectedRevision: doc.revision,
            })
          : await api.monitors.create(input);
      setDoc(await api.monitors.get(value.id, hours));
      setSelected(value.id);
      setItems(await api.monitors.list(workspaceId));
    });
  const fresh = () => {
    setSelected("");
    setDoc(null);
    setForm(blank());
    setError("");
    setRunId("");
    setSampleId("");
  };
  const field = (key: keyof ReturnType<typeof blank>, label: string, type = "text") => (
    <label className="block text-xs">
      {label}
      <Input
        type={type}
        aria-label={label}
        value={String(form[key])}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="mt-1"
      />
    </label>
  );
  const history = doc?.history ?? [],
    sample = history.find((s) => s.id === sampleId) ?? history[0],
    chart = [...history].reverse(),
    maximum = Math.max(1, ...chart.map((s) => s.metrics.p95Ms ?? 0)),
    points = chart
      .map((s, i) =>
        s.metrics.p95Ms === null
          ? ""
          : `${i === 0 || chart[i - 1].metrics.p95Ms === null ? "M" : "L"}${chart.length === 1 ? 350 : 20 + (i * 660) / (chart.length - 1)},${110 - (90 * s.metrics.p95Ms) / maximum}`,
      )
      .join(" ");
  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="font-semibold text-lg">API monitors</h1>
        <Button size="sm" variant="outline" onClick={fresh} disabled={busy}>
          New monitor
        </Button>
        <span className="text-xs text-muted-foreground">
          UTC schedules · observed checks · refreshes every 3 seconds
        </span>
      </div>
      <div className="grid gap-4 xl:grid-cols-[240px_1fr]">
        <aside className="space-y-2">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setDoc(null);
                setSelected(item.id);
                setError("");
              }}
              className={`block w-full rounded border p-3 text-left text-sm ${selected === item.id ? "bg-accent" : ""}`}
            >
              <strong className="[overflow-wrap:anywhere]">{item.name}</strong>
              <div className="text-xs mt-1">
                {item.enabled ? item.state : "paused"} · {item.cron}
              </div>
              <div className="text-xs text-muted-foreground">
                {item.lastRunAt ? new Date(item.lastRunAt).toLocaleString() : "No checks yet"}
              </div>
            </button>
          ))}
          {!items.length && (
            <p className="text-xs text-muted-foreground">Create a monitor for a collection or folder.</p>
          )}
        </aside>
        <main className="space-y-4 min-w-0">
          <section className="rounded border p-3 space-y-3">
            <h2 className="font-medium">{selected ? "Monitor configuration" : "Create monitor"}</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {field("name", "Monitor name")}
              <label className="text-xs">
                Collection or folder
                <select
                  aria-label="Monitor collection"
                  value={form.folderId}
                  onChange={(e) => setForm({ ...form, folderId: e.target.value })}
                  className="mt-1 block w-full rounded border bg-background p-2"
                >
                  <option value="">Choose a collection</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {folderPath(folders, f.id)
                        .map((p) => p.name)
                        .join(" / ")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                Environment
                <select
                  aria-label="Monitor environment"
                  value={form.environmentId}
                  onChange={(e) => setForm({ ...form, environmentId: e.target.value })}
                  className="mt-1 block w-full rounded border bg-background p-2"
                >
                  <option value="">No environment</option>
                  {environments.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              {field("cron", "Schedule (UTC cron)")}
              {field("maxLatencyMs", "Maximum p95 latency (ms; blank disables)", "number")}
              {field("minAvailability", "Minimum HTTP availability (%)", "number")}
              {field("minAssertions", "Minimum assertions passing (%; blank disables)", "number")}
              {field("failAfter", "Consecutive failures to open incident", "number")}
              {field("recoverAfter", "Consecutive passes to recover", "number")}
              {field("timeoutMs", "Request timeout (ms)", "number")}
              {field("maxDurationMs", "Whole check deadline (ms)", "number")}
              {field("emails", "Email recipients (comma separated)")}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                aria-label="Monitor enabled"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Enabled
            </label>
            <p className="text-xs text-muted-foreground">
              Monitor incident and recovery events go to configured workspace webhooks. Email requires the
              server SMTP relay. Blank assertion thresholds allow availability-only checks.
            </p>
            <div className="flex gap-2">
              <Button
                disabled={busy || !form.folderId || !!(selected && doc?.id !== selected)}
                onClick={() => void save()}
              >
                Save monitor
              </Button>
              <Button
                disabled={busy || !selected || doc?.id !== selected}
                variant="outline"
                onClick={() =>
                  void guard(async () => {
                    const run = await api.monitors.run(selected);
                    setRunId(run.runId);
                  })
                }
              >
                Run check now
              </Button>
              <Button
                disabled={busy || !selected || doc?.id !== selected}
                variant="destructive"
                onClick={() =>
                  void guard(async () => {
                    await api.monitors.delete(selected);
                    fresh();
                    setItems(await api.monitors.list(workspaceId));
                  })
                }
              >
                Delete monitor
              </Button>
            </div>
            {runId && (
              <p role="status" className="text-xs">
                Check queued or started: {runId}
              </p>
            )}
          </section>
          {error && (
            <p role="alert" className="text-destructive whitespace-pre-wrap">
              {error}
            </p>
          )}
          {doc && (
            <>
              <section className="rounded border p-3 space-y-3">
                <div className="flex flex-wrap items-center gap-4">
                  <h2 className="font-medium">
                    Monitor health: {doc.state}
                    {!doc.enabled ? " (paused)" : ""}
                  </h2>
                  <label className="text-xs">
                    History range
                    <select
                      aria-label="Monitor history range"
                      value={hours}
                      onChange={(e) => setHours(Number(e.target.value))}
                      className="rounded border bg-background p-1 ml-2"
                    >
                      <option value="24">24 hours</option>
                      <option value="168">7 days</option>
                      <option value="720">30 days</option>
                      <option value="2160">90 days</option>
                    </select>
                  </label>
                </div>
                <div className="grid gap-2 sm:grid-cols-4 text-xs">
                  <div className="rounded bg-muted p-3">
                    Checks passing
                    <strong className="block text-lg">
                      {percent(doc.aggregate.passed, doc.aggregate.checks)}
                    </strong>
                  </div>
                  <div className="rounded bg-muted p-3">
                    HTTP availability
                    <strong className="block text-lg">
                      {percent(doc.aggregate.available, doc.aggregate.requests)}
                    </strong>
                  </div>
                  <div className="rounded bg-muted p-3">
                    Assertions passing
                    <strong className="block text-lg">
                      {percent(doc.aggregate.passedTests, doc.aggregate.tests)}
                    </strong>
                  </div>
                  <div className="rounded bg-muted p-3">
                    Latest p95
                    <strong className="block text-lg">
                      {history[0]?.metrics.p95Ms === null || !history.length
                        ? "Unavailable"
                        : `${history[0].metrics.p95Ms} ms`}
                    </strong>
                  </div>
                </div>
                {!!chart.length && (
                  <svg
                    viewBox="0 0 700 135"
                    role="img"
                    aria-label="Monitor latency and check history"
                    className="w-full max-h-52"
                  >
                    <line x1="20" y1="110" x2="680" y2="110" stroke="currentColor" opacity=".3" />
                    <path d={points} fill="none" stroke="currentColor" strokeWidth="2" />
                    {chart.map((s, i) => (
                      <circle
                        key={s.id}
                        cx={chart.length === 1 ? 350 : 20 + (i * 660) / (chart.length - 1)}
                        cy={110 - (90 * (s.metrics.p95Ms ?? 0)) / maximum}
                        r="4"
                        fill={
                          s.outcome === "passed" ? "#22c55e" : s.outcome === "failed" ? "#ef4444" : "#888"
                        }
                        onClick={() => setSampleId(s.id)}
                      >
                        <title>
                          {new Date(s.at).toLocaleString()} · {s.outcome} · {s.metrics.p95Ms ?? "unavailable"}{" "}
                          ms
                        </title>
                      </circle>
                    ))}
                    <text x="20" y="130" fill="currentColor" fontSize="10">
                      {new Date(chart[0].at).toLocaleString()}
                    </text>
                    <text x="680" y="130" textAnchor="end" fill="currentColor" fontSize="10">
                      {new Date(chart.at(-1)!.at).toLocaleString()}
                    </text>
                  </svg>
                )}
                <p className="text-xs text-muted-foreground">
                  Each point shows p95 request latency for one check. Green passed, red failed, gray skipped.
                  Hollow baseline markers have no recorded latency.{" "}
                  {doc.hasMore
                    ? "Showing the latest 500 checks; summary cards include the full selected range."
                    : ""}
                </p>
                <div className="max-h-56 overflow-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Result</th>
                        <th>Availability</th>
                        <th>Assertions</th>
                        <th>p95</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((s) => (
                        <tr key={s.id} className="border-t cursor-pointer" onClick={() => setSampleId(s.id)}>
                          <td className="py-2">
                            <button className="underline" onClick={() => setSampleId(s.id)}>
                              {new Date(s.at).toLocaleString()}
                            </button>
                          </td>
                          <td>{s.outcome}</td>
                          <td>{s.metrics.availability.toFixed(2)}%</td>
                          <td>
                            {s.metrics.assertions === null
                              ? "No assertions"
                              : `${s.metrics.assertions.toFixed(2)}%`}
                          </td>
                          <td>{s.metrics.p95Ms ?? "Unavailable"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {sample && (
                  <div aria-label="Selected monitor check" className="rounded bg-muted p-2 text-xs">
                    {sample.runId}:{" "}
                    {sample.reasons.length ? sample.reasons.join("; ") : "All configured thresholds passed"}
                  </div>
                )}
              </section>
              <section className="rounded border p-3 space-y-2">
                <h2 className="font-medium">Incidents and recovery</h2>
                {doc.incidents.length ? (
                  doc.incidents.map((i) => (
                    <div key={i.id} className="border-t pt-2 text-xs">
                      <strong>{i.resolvedAt ? "Recovered" : "Open incident"}</strong> ·{" "}
                      {new Date(i.startedAt).toLocaleString()}
                      {i.resolvedAt ? ` → ${new Date(i.resolvedAt).toLocaleString()}` : ""}
                      <p>{i.reasons.join("; ")}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">No incidents.</p>
                )}
              </section>
              <section className="rounded border p-3 space-y-2">
                <h2 className="font-medium">Email notification deliveries</h2>
                <p className="text-xs text-muted-foreground">
                  SMTP {doc.smtpConfigured ? "configured" : "not configured"}. Webhook delivery logs are in
                  Settings → Integrations.
                </p>
                {doc.emailsStatus.map((e) => (
                  <div key={e.id} className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs">
                    <span>
                      {e.recipient} · {e.kind} · {e.status} · {e.attempts} attempt(s)
                    </span>
                    {e.lastError && <span>{e.lastError}</span>}
                    {e.status === "failed" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void guard(async () => {
                            await api.monitors.retry(doc.id, e.id);
                            setDoc(await api.monitors.get(doc.id, hours));
                          })
                        }
                      >
                        Retry email
                      </Button>
                    )}
                  </div>
                ))}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
