"use client";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WEBHOOK_EVENTS } from "@/core/webhook-events";
import {
  FORMAT_LABELS,
  URL_IS_CREDENTIAL,
  WEBHOOK_FORMATS,
  type WebhookFormat,
} from "@/core/webhook-adapters";
import { formatDateTime } from "@/lib/format";
import { SecretBox } from "./key-ui";

interface Hook {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  format: WebhookFormat;
  signingKeyRef: string | null;
  routingKeyRef: string | null;
  headers: { name: string; hasValue: boolean }[];
  pauseAfterFailures: number;
  failureStreak: number;
  pausedAt: number | null;
  pauseReason: string | null;
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
  const [format, setFormat] = useState<WebhookFormat>("postbox");
  const [secretRef, setSecretRef] = useState("");
  const [routingKeyRef, setRoutingKeyRef] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [pauseAfter, setPauseAfter] = useState("0");
  const [busy, setBusy] = useState(false);
  const credentialUrl = URL_IS_CREDENTIAL.includes(format);

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
      // One header per line, "Name: value"; a value may be {{vault:name}}.
      const headers = headerText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const i = line.indexOf(":");
          if (i < 1) throw new Error(`Write headers as "Name: value" (got "${line}")`);
          return { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
        });
      const created = await call<Hook & { secret: string | null }>("/api/webhooks", "POST", {
        workspaceId,
        name,
        url,
        events,
        format,
        ...(secretRef.trim() ? { signingKeyRef: secretRef.trim() } : {}),
        ...(routingKeyRef.trim() ? { routingKeyRef: routingKeyRef.trim() } : {}),
        ...(headers.length ? { headers } : {}),
        pauseAfterFailures: Number(pauseAfter) || 0,
      });
      if (created.secret) setSecret({ name: created.name, value: created.secret });
      setName("");
      setUrl("");
      setSecretRef("");
      setRoutingKeyRef("");
      setHeaderText("");
    });
  };

  return (
    <section className="space-y-3" aria-labelledby={`webhooks-${workspaceId}`}>
      <h3 id={`webhooks-${workspaceId}`} className="text-lg font-semibold">
        Webhooks
      </h3>
      <p className="text-xs text-muted-foreground">
        Postbox sends a signed JSON POST (or a Slack, Discord, Teams or PagerDuty message) when a subscribed
        event happens. Nothing is sent until you add one. Addresses are checked against this server&apos;s
        outbound host policy. Keep tokens, signing keys and header values in the secrets vault and refer to
        them as <code>{"{{vault:name}}"}</code>.
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
          <select
            aria-label="Webhook format"
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={format}
            onChange={(e) => setFormat(e.target.value as WebhookFormat)}
          >
            {WEBHOOK_FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
          <Input
            aria-label="Webhook URL"
            placeholder={
              credentialUrl
                ? "{{vault:slack-webhook-url}} (the address is a credential)"
                : format === "pagerduty"
                  ? "https://events.pagerduty.com/v2/enqueue (default)"
                  : "https://example.com/hooks/postbox"
            }
            className="min-w-64 flex-1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {format === "pagerduty" ? (
            <Input
              aria-label="PagerDuty routing key secret"
              placeholder="Vault secret holding the routing key"
              className="max-w-72"
              value={routingKeyRef}
              onChange={(e) => setRoutingKeyRef(e.target.value)}
            />
          ) : (
            <Input
              aria-label="Signing secret from the vault"
              placeholder="Sign with a vault secret (optional)"
              className="max-w-72"
              value={secretRef}
              onChange={(e) => setSecretRef(e.target.value)}
            />
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Pause after
            <Input
              aria-label="Pause after failures"
              className="h-8 w-16"
              value={pauseAfter}
              onChange={(e) => setPauseAfter(e.target.value)}
            />
            failures in a row (0 never)
          </label>
        </div>
        <textarea
          aria-label="Custom headers"
          rows={2}
          className="w-full rounded-md border bg-transparent p-2 font-mono text-xs"
          placeholder={"Custom headers, one per line:\nAuthorization: Bearer {{vault:api-token}}"}
          value={headerText}
          onChange={(e) => setHeaderText(e.target.value)}
        />
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
            <span className="rounded border px-1 text-xs text-muted-foreground">
              {FORMAT_LABELS[hook.format]}
            </span>
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
              {!hook.signingKeyRef && (
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
                      const rotated = await call<{ secret: string }>(
                        `/api/webhooks/${hook.id}/rotate`,
                        "POST",
                      );
                      setSecret({ name: hook.name, value: rotated.secret });
                    });
                  }}
                >
                  Rotate secret
                </Button>
              )}
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
          {hook.pausedAt && hook.pauseReason && (
            <p className="text-xs text-destructive" role="status">
              {hook.pauseReason} Resume it once the receiver is fixed.
            </p>
          )}
          {(hook.signingKeyRef || hook.routingKeyRef || hook.headers.length > 0) && (
            <div className="text-xs text-muted-foreground">
              {hook.signingKeyRef && (
                <>
                  Signs with vault secret <code>{hook.signingKeyRef}</code>.{" "}
                </>
              )}
              {hook.routingKeyRef && (
                <>
                  Routing key: <code>{hook.routingKeyRef}</code>.{" "}
                </>
              )}
              {hook.headers.length > 0 && <>Custom headers: {hook.headers.map((h) => h.name).join(", ")}.</>}
            </div>
          )}
          {open === hook.id && <Deliveries hook={hook} />}
        </div>
      ))}
    </section>
  );
}
