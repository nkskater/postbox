"use client";
import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { USAGE_METRICS, USAGE_METRIC_KEYS, type UsageMetric } from "@/core/usage";
import { formatBytes, formatDateTime, formatMs } from "@/lib/format";

interface Line {
  metric: UsageMetric;
  label: string;
  unit: string;
  used: number;
  softLimit: number | null;
  hardLimit: number | null;
  period: "day" | "month" | null;
}
interface WorkspaceRow {
  workspaceId: string;
  workspaceName: string;
  deleted: boolean;
  lines: Line[];
}
interface Alert {
  id: string;
  at: number;
  metric: UsageMetric;
  kind: "soft" | "hard";
  workspaceId: string;
  used: number;
  limitValue: number;
}
interface Limit {
  id: string;
  workspaceId: string | null;
  userId: string | null;
  metric: UsageMetric;
  period: string;
  softLimit: number | null;
  hardLimit: number | null;
}
interface Named {
  id: string;
  name: string;
}

const show = (metric: UsageMetric, value: number) =>
  metric === "storage_bytes"
    ? formatBytes(value)
    : metric === "run_ms"
      ? formatMs(value)
      : value.toLocaleString();

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** One workspace's usage lines, with bars against hard (or soft) limits. */
export function UsageLines({ lines }: { lines: Line[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {lines.map((l) => {
        const cap = l.hardLimit ?? l.softLimit;
        const pct = cap ? Math.min(100, (l.used / Math.max(cap, 1)) * 100) : 0;
        const over = l.softLimit !== null && l.used > l.softLimit;
        return (
          <li key={l.metric}>
            <div className="flex flex-wrap justify-between gap-2">
              <span title={USAGE_METRICS[l.metric].description}>{l.label}</span>
              <span className={over ? "text-destructive" : "text-muted-foreground"}>
                {show(l.metric, l.used)}
                {l.hardLimit !== null && ` of ${show(l.metric, l.hardLimit)}`}
                {l.hardLimit === null && l.softLimit !== null && ` (alert at ${show(l.metric, l.softLimit)})`}
                {l.period && ` per ${l.period}`}
              </span>
            </div>
            {cap !== null && (
              <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-muted">
                <div
                  className={`h-full ${over ? "bg-destructive" : "bg-primary"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const dayInput = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Usage and quotas for one workspace (owners) or every workspace (administrators). */
export function UsagePanel({ workspaceId }: { workspaceId?: string }) {
  const base = workspaceId ? `/api/workspaces/${encodeURIComponent(workspaceId)}/usage` : "/api/admin/usage";
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<WorkspaceRow[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [error, setError] = useState("");
  const query = useCallback(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", String(new Date(`${from}T00:00:00Z`).getTime()));
    if (to) p.set("to", String(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000));
    return p.toString();
  }, [from, to]);

  useEffect(() => {
    let live = true;
    void get<{ from: number; to: number; workspaces?: WorkspaceRow[]; lines?: Line[]; alerts: Alert[] }>(
      `${base}?${query()}`,
    )
      .then((d) => {
        if (!live) return;
        setRange({ from: d.from, to: d.to });
        setRows(
          d.workspaces ?? [
            { workspaceId: workspaceId!, workspaceName: "This workspace", deleted: false, lines: d.lines! },
          ],
        );
        setAlerts(d.alerts);
        setError("");
      })
      .catch((err) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [base, query, workspaceId]);

  const exportHref = (format: "csv" | "json") => `${base}?${query()}${query() ? "&" : ""}export=${format}`;
  return (
    <section className="space-y-3">
      <header>
        <h3 className="text-lg font-semibold">{workspaceId ? "Usage" : "Usage & quotas"}</h3>
        <p className="text-sm text-muted-foreground">
          {range ? `${formatDateTime(range.from)} to ${formatDateTime(range.to - 1)}. ` : ""}
          Calls, runs and run time are counted over the period; storage is what is kept now.
        </p>
      </header>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          From
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder={range ? dayInput(range.from) : ""}
          />
        </label>
        <label className="grid gap-1 text-sm">
          To
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <Button asChild variant="outline" size="sm">
          <a href={exportHref("csv")} download>
            <Download className="size-4" /> CSV
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={exportHref("json")} download>
            <Download className="size-4" /> JSON
          </a>
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="space-y-3">
        {rows.map((w) => (
          <article key={w.workspaceId} className="space-y-2 rounded border p-3">
            {!workspaceId && <h4 className="font-medium">{w.workspaceName}</h4>}
            <UsageLines lines={w.lines} />
          </article>
        ))}
      </div>
      {alerts.length > 0 && (
        <div>
          <h4 className="mb-1 text-sm font-medium">Alerts</h4>
          <ul className="divide-y rounded border text-sm" aria-label="Quota alerts">
            {alerts.map((a) => (
              <li key={a.id} className="px-3 py-1.5">
                <time className="text-xs text-muted-foreground">{formatDateTime(a.at)}</time>{" "}
                {a.kind === "hard" ? "Refused: " : "Over soft limit: "}
                {USAGE_METRICS[a.metric].label} reached {show(a.metric, a.used)} (limit{" "}
                {show(a.metric, a.limitValue)})
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Administrator quota editor and reconciliation. */
export function QuotaEditor() {
  const [limits, setLimits] = useState<Limit[]>([]);
  const [workspaces, setWorkspaces] = useState<Named[]>([]);
  const [accounts, setAccounts] = useState<Named[]>([]);
  const [scope, setScope] = useState("default");
  const [target, setTarget] = useState("");
  const [metric, setMetric] = useState<UsageMetric>("requests");
  const [period, setPeriod] = useState("month");
  const [soft, setSoft] = useState("");
  const [hard, setHard] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([
      get<Limit[]>("/api/admin/usage/limits"),
      get<{ id: string; name: string }[]>("/api/workspaces"),
      get<{ id: string; username: string }[]>("/api/admin/users"),
    ])
      .then(([l, w, u]) => {
        if (!live) return;
        setLimits(l);
        setWorkspaces(w);
        setAccounts(u.map((x) => ({ id: x.id, name: x.username })));
      })
      .catch((err) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [version]);

  const send = async (url: string, method: string, body?: unknown) => {
    setError("");
    setMessage("");
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? `Request failed (${res.status})`);
      return null;
    }
    setVersion((v) => v + 1);
    return data;
  };
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const nameOf = (l: Limit) =>
    l.userId
      ? `account ${accounts.find((a) => a.id === l.userId)?.name ?? l.userId}`
      : l.workspaceId
        ? `workspace ${workspaces.find((w) => w.id === l.workspaceId)?.name ?? l.workspaceId}`
        : "every workspace (default)";

  return (
    <section className="space-y-3">
      <header>
        <h3 className="text-lg font-semibold">Quotas</h3>
        <p className="text-sm text-muted-foreground">
          Nothing is limited until you set a limit. A soft limit raises an alert; a hard limit refuses new
          requests or runs with 429. A workspace limit replaces the default for that workspace; an account
          limit caps one person or service account across all workspaces.
        </p>
      </header>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <form
        className="flex flex-wrap items-end gap-2 rounded border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send("/api/admin/usage/limits", "PUT", {
            ...(scope === "workspace" ? { workspaceId: target } : {}),
            ...(scope === "account" ? { userId: target } : {}),
            metric,
            period,
            softLimit: num(soft),
            hardLimit: num(hard),
          }).then((r) => r && setMessage("Limit saved"));
        }}
      >
        <label className="grid gap-1 text-sm">
          Applies to
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setTarget("");
            }}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="default">Every workspace</option>
            <option value="workspace">One workspace</option>
            <option value="account">One account</option>
          </select>
        </label>
        {scope !== "default" && (
          <label className="grid gap-1 text-sm">
            {scope === "workspace" ? "Workspace" : "Account"}
            <select
              value={target}
              required
              onChange={(e) => setTarget(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">Choose…</option>
              {(scope === "workspace" ? workspaces : accounts).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="grid gap-1 text-sm">
          Metric
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as UsageMetric)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {USAGE_METRIC_KEYS.map((m) => (
              <option key={m} value={m}>
                {USAGE_METRICS[m].label} ({USAGE_METRICS[m].unit})
              </option>
            ))}
          </select>
        </label>
        {!USAGE_METRICS[metric].stock && (
          <label className="grid gap-1 text-sm">
            Per
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="day">Day</option>
              <option value="month">Month</option>
            </select>
          </label>
        )}
        <label className="grid w-32 gap-1 text-sm">
          Soft limit
          <Input
            type="number"
            min={0}
            value={soft}
            onChange={(e) => setSoft(e.target.value)}
            placeholder="None"
          />
        </label>
        <label className="grid w-32 gap-1 text-sm">
          Hard limit
          <Input
            type="number"
            min={0}
            value={hard}
            onChange={(e) => setHard(e.target.value)}
            placeholder="None"
          />
        </label>
        <Button type="submit" size="sm">
          Save limit
        </Button>
      </form>
      {limits.length > 0 && (
        <ul className="divide-y rounded border text-sm" aria-label="Quotas">
          {limits.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1">
                {USAGE_METRICS[l.metric]?.label ?? l.metric} for {nameOf(l)}:{" "}
                {l.softLimit !== null && `alert at ${l.softLimit}`}
                {l.softLimit !== null && l.hardLimit !== null && ", "}
                {l.hardLimit !== null && `refuse at ${l.hardLimit}`}
                {!USAGE_METRICS[l.metric]?.stock && ` per ${l.period}`}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void send(`/api/admin/usage/limits/${l.id}`, "DELETE")}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void send("/api/admin/usage/reconcile", "POST", { repair: false }).then(
              (r) =>
                r &&
                setMessage(
                  `Checked ${r.runsChecked} runs this month: ${r.missing} missing and ${r.mismatched} wrong ledger entries.`,
                ),
            )
          }
        >
          Check ledger against runs
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void send("/api/admin/usage/reconcile", "POST", { repair: true }).then(
              (r) => r && setMessage(`Repaired ${r.repaired} ledger entries.`),
            )
          }
        >
          Repair ledger
        </Button>
      </div>
    </section>
  );
}
