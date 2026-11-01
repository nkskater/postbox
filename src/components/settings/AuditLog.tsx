"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import type { AuditChange } from "@/core/audit";

interface AuditEvent {
  id: string;
  at: number;
  actorName: string;
  actorKind: string;
  via: string | null;
  workspaceId: string | null;
  action: string;
  entityKind: string;
  entityName: string | null;
  entityId: string | null;
  revision: number;
  result: string;
  changes: AuditChange[];
}

const ACTION_GROUPS = [
  ["", "All actions"],
  ["request", "Requests"],
  ["folder", "Collections and folders"],
  ["environment", "Environments"],
  ["workspace", "Workspaces"],
  ["member", "Members and roles"],
  ["user", "Users"],
  ["service_account", "Service accounts"],
  ["key", "API keys"],
  ["settings", "Settings"],
  ["backup", "Backups and restore"],
  ["auth", "Sign-ins"],
  ["mcp", "MCP tool calls"],
] as const;

const show = (v: unknown) =>
  v === null || v === undefined ? "none" : typeof v === "string" ? v : JSON.stringify(v);

function Changes({ changes }: { changes: AuditChange[] }) {
  if (!changes.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {changes.map((c) => (
        <li key={c.field}>
          <code>{c.field}</code>{" "}
          {c.redacted ? (
            "changed (value not recorded)"
          ) : (
            <>
              {"before" in c && <span>{show(c.before)}</span>}
              {"before" in c && "after" in c && " → "}
              {"after" in c && <span className="text-foreground">{show(c.after)}</span>}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The audit log: filterable, paged, and exportable. Without `workspaceId` it covers every workspace (administrators). */
export function AuditLog({ workspaceId }: { workspaceId?: string }) {
  const base = workspaceId ? `/api/workspaces/${encodeURIComponent(workspaceId)}/audit` : "/api/admin/audit";
  const [q, setQ] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [result, setResult] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const params = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({
        q,
        actor,
        action,
        result,
        from: from ? String(new Date(`${from}T00:00:00`).getTime()) : "",
        to: to ? String(new Date(`${to}T23:59:59.999`).getTime()) : "",
        ...extra,
      }))
        if (v) p.set(k, v);
      return p.toString();
    },
    [q, actor, action, result, from, to],
  );

  const load = useCallback(
    (cursor?: string) => {
      const mine = ++generation.current;
      setLoading(true);
      setError("");
      void fetch(`${base}?${params({ limit: "50", ...(cursor ? { cursor } : {}) })}`)
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
          if (mine !== generation.current) return;
          setEvents((prev) => (cursor ? [...prev, ...data.events] : data.events));
          setNext(data.next);
        })
        .catch((err) => mine === generation.current && setError((err as Error).message))
        .finally(() => mine === generation.current && setLoading(false));
    },
    [base, params],
  );

  useEffect(() => {
    const timer = setTimeout(() => load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <section className="space-y-3">
      <header>
        <h3 className="text-lg font-semibold">{workspaceId ? "Activity" : "Audit log"}</h3>
        <p className="text-sm text-muted-foreground">
          Who changed what and when. Secret values are never recorded; changed secrets are listed by field
          name.
        </p>
      </header>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          Search
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, person or action" />
        </label>
        <label className="grid gap-1 text-sm">
          Person
          <Input value={actor} onChange={(e) => setActor(e.target.value)} className="w-32" />
        </label>
        <label className="grid gap-1 text-sm">
          Action
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {ACTION_GROUPS.map(([v, l]) => (
              <option key={l} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Result
          <select
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">All</option>
            <option value="ok">Succeeded</option>
            <option value="denied">Refused</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          From
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          To
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <Button asChild variant="outline" size="sm">
          <a href={`${base}?${params({ export: "csv" })}`} download>
            <Download className="size-4" /> CSV
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={`${base}?${params({ export: "json" })}`} download>
            <Download className="size-4" /> JSON
          </a>
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <ul className="divide-y rounded-md border text-sm" aria-label="Audit events">
        {events.map((e) => (
          <li key={e.id} className="px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <time className="text-xs text-muted-foreground">{formatDateTime(e.at)}</time>
              <span className="font-medium">{e.actorName}</span>
              <code className="text-xs">{e.action}</code>
              {e.entityName && <span>{e.entityName}</span>}
              {e.revision > 1 && <span className="text-xs text-muted-foreground">revision {e.revision}</span>}
              {e.result === "denied" && (
                <span className="rounded bg-destructive/15 px-1.5 text-xs text-destructive">refused</span>
              )}
            </div>
            <Changes changes={e.changes} />
          </li>
        ))}
        {!events.length && !loading && (
          <li className="px-3 py-4 text-muted-foreground">No events match these filters.</li>
        )}
      </ul>
      {next && (
        <Button variant="outline" size="sm" disabled={loading} onClick={() => load(next)}>
          Load more
        </Button>
      )}
    </section>
  );
}
