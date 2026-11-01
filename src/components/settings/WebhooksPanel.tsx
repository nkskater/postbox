"use client";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WEBHOOK_EVENTS } from "@/core/webhook-events";
import { formatDateTime } from "@/lib/format";
import { SecretBox } from "./key-ui";

interface Hook {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  pending?: number;
}
interface Delivery {
  id: string;
  eventId: string;
  eventType: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  replayOf: string | null;
  createdAt: number;
}

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const STATUS_STYLE: Record<Delivery["status"], string> = {
  delivered: "text-emerald-600 dark:text-emerald-400",
  pending: "text-amber-600 dark:text-amber-400",
  failed: "text-destructive",
};

function Deliveries({ hook }: { hook: Hook }) {
  const [items, setItems] = useState<Delivery[] | null>(null);
  const load = useCallback(() => {
    call<Delivery[]>(`/api/webhooks/${hook.id}/deliveries?limit=25`).then(setItems, (e: Error) =>
      toast.error(e.message),
    );
  }, [hook.id]);
  useEffect(load, [load]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Recent deliveries</h4>
        <Button type="button" variant="ghost" size="sm" onClick={load}>
          Refresh
        </Button>
      </div>
      {items?.length === 0 && <p className="text-xs text-muted-foreground">Nothing has been sent yet.</p>}
      <ul className="space-y-1">
        {items?.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border p-2 text-xs">
            <code>{d.eventType}</code>
            <span className={STATUS_STYLE[d.status]}>{d.status}</span>
            <span className="text-muted-foreground">
              {d.attempts} {d.attempts === 1 ? "attempt" : "attempts"}
              {d.lastStatus ? ` · HTTP ${d.lastStatus}` : ""}
              {d.status === "pending" && d.nextAttemptAt ? ` · next ${formatDateTime(d.nextAttemptAt)}` : ""}
              {d.replayOf ? " · replay" : ""}
            </span>
            {d.lastError && d.status !== "delivered" && (
              <span className="min-w-0 truncate text-muted-foreground" title={d.lastError}>
                {d.lastError}
              </span>
            )}
            <span className="ml-auto text-muted-foreground">{formatDateTime(d.createdAt)}</span>
            {d.status !== "pending" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  call(`/api/webhooks/${hook.id}/replay`, "POST", { deliveryId: d.id }).then(
                    () => {
                      toast.success("Queued again");
                      load();
                    },
                    (e: Error) => toast.error(e.message),
                  )
                }
              >
                Replay
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Owners configure outbound webhooks for a workspace, send tests, and inspect or replay deliveries. */
export function WebhooksPanel({ workspaceId }: { workspaceId: string }) {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["run.failed"]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    call<Hook[]>(`/api/webhooks?workspaceId=${encodeURIComponent(workspaceId)}`).then(setHooks, (e: Error) =>
      toast.error(e.message),
    );
  }, [workspaceId]);
  useEffect(load, [load]);

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await action();
      if (done) toast.success(done);
      load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const created = await call<Hook & { secret: string }>("/api/webhooks", "POST", {
        workspaceId,
        name,
        url,
        events,
      });
      setSecret({ name: created.name, value: created.secret });
      setName("");
      setUrl("");
    });
  };

  return (
    <section className="space-y-3" aria-labelledby={`webhooks-${workspaceId}`}>
      <h3 id={`webhooks-${workspaceId}`} className="text-lg font-semibold">
        Webhooks
      </h3>
      <p className="text-xs text-muted-foreground">
        Postbox sends a signed JSON POST to these addresses when a subscribed event happens. Nothing is sent
        until you add one. Addresses are checked against this server&apos;s outbound host policy.
      </p>
      {secret && (
        <SecretBox
          what="signing secret"
          secret={secret.value}
          note={`Use it to verify the Postbox-Signature header of deliveries to “${secret.name}”.`}
        />
      )}
      <form onSubmit={add} className="space-y-2 rounded border p-3">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Webhook name"
            placeholder="Name"
            className="max-w-48"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            aria-label="Webhook URL"
            placeholder="https://example.com/hooks/postbox"
            className="min-w-64 flex-1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend className="sr-only">Events</legend>
          {WEBHOOK_EVENTS.map((event) => (
            <label key={event.type} className="flex items-center gap-1.5" title={event.description}>
              <input
                type="checkbox"
                checked={events.includes(event.type)}
                onChange={(e) =>
                  setEvents((list) =>
                    e.target.checked ? [...list, event.type] : list.filter((t) => t !== event.type),
                  )
                }
              />
              <code>{event.type}</code>
            </label>
          ))}
        </fieldset>
        <Button disabled={busy || !name.trim() || !url.trim() || !events.length}>Add webhook</Button>
      </form>
      {hooks.map((hook) => (
        <div key={hook.id} className="space-y-2 rounded border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{hook.name}</span>
            {!hook.enabled && <span className="text-xs text-muted-foreground">(paused)</span>}
            {!!hook.pending && <span className="text-xs text-amber-600">{hook.pending} waiting</span>}
            <span className="ml-auto flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => call(`/api/webhooks/${hook.id}/test`, "POST"),
                    "Test event queued. Check recent deliveries.",
                  )
                }
              >
                Send test
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() => call(`/api/webhooks/${hook.id}`, "PATCH", { enabled: !hook.enabled }))
                }
              >
                {hook.enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Rotate the signing secret for "${hook.name}"? Update your receiver next.`,
                    )
                  )
                    return;
                  void run(async () => {
                    const rotated = await call<{ secret: string }>(`/api/webhooks/${hook.id}/rotate`, "POST");
                    setSecret({ name: hook.name, value: rotated.secret });
                  });
                }}
              >
                Rotate secret
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setOpen(open === hook.id ? null : hook.id)}
              >
                {open === hook.id ? "Hide log" : "Deliveries"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Delete "${hook.name}" and its delivery log?`)) return;
                  void run(() => call(`/api/webhooks/${hook.id}`, "DELETE"), "Webhook deleted");
                }}
              >
                Delete
              </Button>
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground" title={hook.url}>
            {hook.url} · {hook.events.join(", ")}
          </div>
          {open === hook.id && <Deliveries hook={hook} />}
        </div>
      ))}
    </section>
  );
}
