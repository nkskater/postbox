"use client";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import { SecretBox } from "./key-ui";

type Verification =
  | { type: "none" }
  | { type: "token"; header: string }
  | { type: "hmac"; header: string; encoding: "hex" | "base64"; prefix: string }
  | { type: "timestamped"; header: string };

interface Listener {
  id: string;
  name: string;
  status: "active" | "paused" | "revoked";
  tokenHint: string;
  verification: Verification;
  response: { status: number; contentType: string; body: string };
  forwardUrl: string | null;
  ratePerMinute: number;
  receivedCount: number;
  lastReceivedAt: number | null;
}
interface HookEvent {
  id: string;
  receivedAt: number;
  method: string;
  path: string;
  query: string;
  headers: [string, string][];
  bodyBytes: number;
  signature: "none" | "valid" | "invalid" | "missing";
  responseStatus: number;
  forwardStatus: number | null;
  forwardError: string | null;
  replays: number;
}
interface EventDetail extends HookEvent {
  body: string;
  bodyEncoding: "utf8" | "base64";
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

const SIGNATURE_STYLE: Record<HookEvent["signature"], string> = {
  none: "text-muted-foreground",
  valid: "text-emerald-600 dark:text-emerald-400",
  invalid: "text-destructive",
  missing: "text-destructive",
};
const PRESETS: Record<string, { label: string; verification: Verification }> = {
  none: { label: "No verification", verification: { type: "none" } },
  github: {
    label: "GitHub (X-Hub-Signature-256)",
    verification: { type: "hmac", header: "X-Hub-Signature-256", encoding: "hex", prefix: "sha256=" },
  },
  stripe: {
    label: "Timestamped (Stripe-Signature)",
    verification: { type: "timestamped", header: "Stripe-Signature" },
  },
  token: { label: "Shared token header", verification: { type: "token", header: "X-Webhook-Token" } },
};

/** Request bodies are rendered as plain text by React, so a hostile payload stays inert. */
function Body({ detail }: { detail: EventDetail }) {
  let text = detail.body;
  if (detail.bodyEncoding === "utf8") {
    try {
      text = JSON.stringify(JSON.parse(detail.body), null, 2);
    } catch {
      /* not JSON: show as received */
    }
  }
  return (
    <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">
      {detail.bodyEncoding === "base64" ? `(binary, base64)\n${text}` : text || "(empty)"}
    </pre>
  );
}

function Events({ listener }: { listener: Listener }) {
  const [items, setItems] = useState<HookEvent[] | null>(null);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const load = useCallback(() => {
    call<HookEvent[]>(`/api/hook-listeners/${listener.id}/events?limit=25`).then(setItems, (e: Error) =>
      toast.error(e.message),
    );
  }, [listener.id]);
  useEffect(load, [load]);
  const target = listener.forwardUrl;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Received requests</h4>
        <span className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={load}>
            Refresh
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!window.confirm("Delete all stored requests for this listener?")) return;
              call(`/api/hook-listeners/${listener.id}/events`, "DELETE").then(
                () => {
                  setDetail(null);
                  load();
                },
                (e: Error) => toast.error(e.message),
              );
            }}
          >
            Clear
          </Button>
        </span>
      </div>
      {items?.length === 0 && <p className="text-xs text-muted-foreground">Nothing has been received yet.</p>}
      <ul className="space-y-1">
        {items?.map((event) => (
          <li key={event.id} className="space-y-2 rounded border p-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <code>{event.method}</code>
              <span
                className="min-w-0 truncate"
                title={`${event.path}${event.query ? `?${event.query}` : ""}`}
              >
                {event.path || "/"}
                {event.query ? `?${event.query}` : ""}
              </span>
              <span className={SIGNATURE_STYLE[event.signature]}>signature: {event.signature}</span>
              <span className="text-muted-foreground">
                {event.bodyBytes} B · replied {event.responseStatus}
                {event.forwardStatus ? ` · forwarded ${event.forwardStatus}` : ""}
                {event.replays ? ` · replayed ${event.replays}×` : ""}
              </span>
              {event.forwardError && (
                <span className="text-destructive" title={event.forwardError}>
                  {event.forwardError.slice(0, 80)}
                </span>
              )}
              <span className="ml-auto text-muted-foreground">{formatDateTime(event.receivedAt)}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  detail?.id === event.id
                    ? setDetail(null)
                    : call<EventDetail>(`/api/hook-listeners/${listener.id}/events?event=${event.id}`).then(
                        setDetail,
                        (e: Error) => toast.error(e.message),
                      )
                }
              >
                {detail?.id === event.id ? "Hide" : "Inspect"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!target}
                title={target ? `Send to ${target}` : "Set a forward URL to replay"}
                onClick={() => {
                  if (!window.confirm(`Send this request to ${target}?`)) return;
                  call<{ status: number | null; error: string | null }>(
                    `/api/hook-listeners/${listener.id}/replay`,
                    "POST",
                    { eventId: event.id },
                  ).then(
                    (r) => {
                      if (r.error) toast.error(r.error);
                      else toast.success(`Replayed: HTTP ${r.status}`);
                      load();
                    },
                    (e: Error) => toast.error(e.message),
                  );
                }}
              >
                Replay
              </Button>
            </div>
            {detail?.id === event.id && (
              <div className="space-y-2">
                <div className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[auto_1fr]">
                  {detail.headers.map(([name, value], index) => (
                    <div key={`${name}-${index}`} className="contents">
                      <code className="text-muted-foreground">{name}</code>
                      <span className="break-all">{value}</span>
                    </div>
                  ))}
                </div>
                <Body detail={detail} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Owners create public listener URLs for providers to call, then inspect, forward or replay what arrives. */
export function HookListenersPanel({ workspaceId }: { workspaceId: string }) {
  const [listeners, setListeners] = useState<Listener[]>([]);
  const [created, setCreated] = useState<{ name: string; url: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("none");
  const [header, setHeader] = useState("");
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState("200");
  const [responseBody, setResponseBody] = useState('{"ok":true}');
  const [forwardUrl, setForwardUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    call<Listener[]>(`/api/hook-listeners?workspaceId=${encodeURIComponent(workspaceId)}`).then(
      setListeners,
      (e: Error) => toast.error(e.message),
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
  const show = (listenerName: string, path: string) =>
    setCreated({ name: listenerName, url: `${window.location.origin}${path}` });

  const verification = (): Verification => {
    const base = PRESETS[preset].verification;
    return base.type === "none" || !header.trim() ? base : { ...base, header: header.trim() };
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await call<Listener & { path: string }>("/api/hook-listeners", "POST", {
        workspaceId,
        name,
        verification: verification(),
        ...(preset === "none" ? {} : { secret }),
        response: { status: Number(status), contentType: "application/json", body: responseBody },
        forwardUrl: forwardUrl.trim() || null,
      });
      show(result.name, result.path);
      setName("");
      setSecret("");
      setForwardUrl("");
    });
  };

  return (
    <section className="space-y-3" aria-labelledby={`hooks-${workspaceId}`}>
      <h3 id={`hooks-${workspaceId}`} className="text-lg font-semibold">
        Incoming webhooks
      </h3>
      <p className="text-xs text-muted-foreground">
        Each listener has a secret URL that a provider can call. Postbox stores the last 200 requests
        (credentials hidden), answers with the response you choose, and can verify signatures. Requests are
        forwarded or replayed only to addresses this server&apos;s outbound host policy allows, and replays
        happen only when you click Replay.
      </p>
      {created && (
        <SecretBox
          what="listener URL"
          secret={created.url}
          note={`Give this address to the provider that should call “${created.name}”. Anyone with it can send requests to the listener.`}
        />
      )}
      <form onSubmit={add} className="space-y-2 rounded border p-3">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Listener name"
            placeholder="Name"
            className="max-w-48"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            aria-label="Verification"
            className="rounded-md border bg-background px-2 text-sm"
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value);
              setHeader("");
            }}
          >
            {Object.entries(PRESETS).map(([key, entry]) => (
              <option key={key} value={key}>
                {entry.label}
              </option>
            ))}
          </select>
          {preset !== "none" && (
            <>
              <Input
                aria-label="Signature header"
                placeholder={(PRESETS[preset].verification as { header: string }).header}
                className="max-w-56"
                value={header}
                onChange={(e) => setHeader(e.target.value)}
              />
              <Input
                aria-label="Verification secret"
                type="password"
                autoComplete="off"
                placeholder="Secret"
                className="max-w-56"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Response status"
            inputMode="numeric"
            className="w-20"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          />
          <Input
            aria-label="Response body"
            className="min-w-48 flex-1"
            value={responseBody}
            onChange={(e) => setResponseBody(e.target.value)}
          />
          <Input
            aria-label="Forward URL"
            placeholder="Forward to (optional) https://…"
            className="min-w-64 flex-1"
            value={forwardUrl}
            onChange={(e) => setForwardUrl(e.target.value)}
          />
        </div>
        <Button disabled={busy || !name.trim() || (preset !== "none" && !secret)}>Add listener</Button>
      </form>
      {listeners.map((listener) => (
        <div key={listener.id} className="space-y-2 rounded border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{listener.name}</span>
            <span
              className={
                listener.status === "active"
                  ? "text-xs text-emerald-600 dark:text-emerald-400"
                  : "text-xs text-muted-foreground"
              }
            >
              {listener.status}
            </span>
            <span className="ml-auto flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setOpen(open === listener.id ? null : listener.id)}
              >
                {open === listener.id ? "Hide requests" : "Requests"}
              </Button>
              {listener.status !== "revoked" && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        call(`/api/hook-listeners/${listener.id}`, "PATCH", {
                          status: listener.status === "active" ? "paused" : "active",
                        }),
                      )
                    }
                  >
                    {listener.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Give "${listener.name}" a new URL? The old one stops working.`))
                        return;
                      void run(async () => {
                        const rotated = await call<{ path: string }>(
                          `/api/hook-listeners/${listener.id}/rotate`,
                          "POST",
                        );
                        show(listener.name, rotated.path);
                      });
                    }}
                  >
                    New URL
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Revoke "${listener.name}"? This cannot be undone.`)) return;
                      void run(
                        () => call(`/api/hook-listeners/${listener.id}`, "PATCH", { status: "revoked" }),
                        "Listener revoked",
                      );
                    }}
                  >
                    Revoke
                  </Button>
                </>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Delete "${listener.name}" and its stored requests?`)) return;
                  void run(() => call(`/api/hook-listeners/${listener.id}`, "DELETE"), "Listener deleted");
                }}
              >
                Delete
              </Button>
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            …{listener.tokenHint} · {listener.receivedCount} received
            {listener.lastReceivedAt ? ` · last ${formatDateTime(listener.lastReceivedAt)}` : ""} ·
            verification: {listener.verification.type}
            {listener.forwardUrl ? ` · forwards to ${listener.forwardUrl}` : ""}
          </div>
          {open === listener.id && <Events listener={listener} />}
        </div>
      ))}
    </section>
  );
}
