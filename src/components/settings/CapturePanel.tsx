"use client";
/** Traffic capture: record requests through a relay URL, review them, and turn some into requests. */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import { useApp } from "@/stores/app";
import { SecretBox } from "./key-ui";

interface Session {
  id: string;
  name: string;
  status: "recording" | "paused" | "stopped";
  tokenHint: string;
  allowHttps: boolean;
  httpsConsentAt: number | null;
  captureCookies: boolean;
  hosts: string[];
  entryCount: number;
  lastCapturedAt: number | null;
}
interface Entry {
  id: string;
  startedAt: number;
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  requestBytes: number;
  responseBytes: number;
  error: string | null;
  redactions: number;
  importedAt: number | null;
}
interface Body {
  text: string;
  encoding: "utf8" | "omitted" | "empty";
  bytes: number;
  truncated: boolean;
}
interface EntryDetail extends Entry {
  requestHeaders: [string, string][];
  requestBody: Body;
  responseHeaders: [string, string][];
  responseBody: Body;
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

const hostList = (text: string) =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/** Captured text is shown as plain text by React, so a hostile payload stays inert. */
function BodyView({ title, body }: { title: string; body: Body }) {
  return (
    <div>
      <div className="font-medium">
        {title} <span className="font-normal text-muted-foreground">({body.bytes} bytes)</span>
      </div>
      {body.encoding === "utf8" ? (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap break-all">
          {body.text}
          {body.truncated ? "\n… cut" : ""}
        </pre>
      ) : (
        <p className="text-muted-foreground">
          {body.encoding === "omitted" ? "Binary content is not stored." : "No body."}
        </p>
      )}
    </div>
  );
}

function Review({ session, onChanged }: { session: Session; onChanged: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<EntryDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const base = `/api/capture/sessions/${session.id}`;

  const load = useCallback(() => {
    call<Entry[]>(`${base}/entries?limit=500`)
      .then((rows) => {
        setEntries(rows);
        setPicked((current) => new Set([...current].filter((id) => rows.some((r) => r.id === id))));
      })
      .catch((e) => toast.error((e as Error).message));
  }, [base]);
  useEffect(() => {
    load();
  }, [load, session.entryCount]);

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast.success(done);
      load();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const selected = [...picked];

  return (
    <div className="space-y-2 rounded-md border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPicked(new Set(entries.filter((e) => !e.error).map((e) => e.id)))}
        >
          Select all
        </Button>
        <Button size="sm" variant="outline" onClick={() => setPicked(new Set())}>
          Clear
        </Button>
        <Input
          className="h-7 w-44"
          aria-label="Folder name"
          placeholder="Folder name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          size="sm"
          disabled={busy || selected.length === 0}
          onClick={() =>
            void run(
              () =>
                call(`${base}/requests`, "POST", {
                  entryIds: selected,
                  ...(name.trim() ? { name: name.trim() } : {}),
                }).then(() => setPicked(new Set())),
              "Requests created",
            )
          }
        >
          Create {selected.length || ""} request{selected.length === 1 ? "" : "s"}
        </Button>
        <a
          className="underline"
          href={`${base}/export${selected.length ? `?entries=${selected.join(",")}` : ""}`}
          download="postbox-capture.har"
        >
          Download HAR
        </a>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || selected.length === 0}
          onClick={() =>
            void run(
              () =>
                call(`${base}/entries`, "DELETE", { entryIds: selected }).then(() => setPicked(new Set())),
              "Entries deleted",
            )
          }
        >
          Delete selected
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y rounded border">
          {entries.map((e) => (
            <li key={e.id} className="space-y-1 p-2">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`Select ${e.method} ${e.url}`}
                  checked={picked.has(e.id)}
                  disabled={!!e.error}
                  onChange={() => toggle(e.id)}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() =>
                    open?.id === e.id
                      ? setOpen(null)
                      : void call<EntryDetail>(`${base}/entries?entry=${e.id}`)
                          .then(setOpen)
                          .catch((err) => toast.error((err as Error).message))
                  }
                >
                  <span className="font-mono font-medium">{e.method}</span> <span>{e.url}</span>
                </button>
                <span className={e.error ? "text-destructive" : "text-muted-foreground"}>
                  {e.error ? "failed" : e.status}
                </span>
                {e.redactions > 0 && (
                  <span className="rounded border px-1" title="Credentials were removed before storing">
                    {e.redactions} redacted
                  </span>
                )}
                {e.importedAt && <span className="rounded border px-1">imported</span>}
              </div>
              {open?.id === e.id && (
                <div className="space-y-2 pl-6">
                  <div className="text-muted-foreground">
                    {formatDateTime(e.startedAt)}
                    {e.durationMs !== null ? ` · ${e.durationMs} ms` : ""}
                    {e.error ? ` · ${e.error}` : ""}
                  </div>
                  <pre className="max-h-40 overflow-auto rounded bg-muted p-2 break-all whitespace-pre-wrap">
                    {open.requestHeaders.map(([k, v]) => `${k}: ${v}`).join("\n")}
                  </pre>
                  <BodyView title="Request body" body={open.requestBody} />
                  <pre className="max-h-40 overflow-auto rounded bg-muted p-2 break-all whitespace-pre-wrap">
                    {open.responseHeaders.map(([k, v]) => `${k}: ${v}`).join("\n")}
                  </pre>
                  <BodyView title="Response body" body={open.responseBody} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CapturePanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [hosts, setHosts] = useState("");
  const [https, setHttps] = useState(false);
  const [cookies, setCookies] = useState(false);
  const [issued, setIssued] = useState<{ url: string; name: string } | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const load = useCallback(() => {
    call<Session[]>(`/api/capture/sessions?workspaceId=${workspaceId}`)
      .then((rows) => {
        setSessions(rows);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  }, [workspaceId]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast.success(done);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const relayUrl = (path: string) => `${window.location.origin}${path}`;
  const patch = (s: Session, body: object, done: string) =>
    run(() => call(`/api/capture/sessions/${s.id}`, "PATCH", body), done);

  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label="Traffic capture">
      <div>
        <h3 className="font-medium">Traffic capture</h3>
        <p className="text-sm text-muted-foreground">
          Record the requests a client, script or app makes, then turn the ones you pick into requests. Start
          a session, send traffic through its relay URL (append the address you want to reach), and review
          what was recorded. Credentials, cookies and secret-looking values are removed before anything is
          stored. Recordings are deleted automatically after the retention period in App Settings.
        </p>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {issued && (
        <SecretBox
          secret={`${issued.url}https:/example.com/`}
          what="relay URL"
          note={`Session “${issued.name}”. Replace https:/example.com/ with the address you want to call (one slash after the scheme). Anyone with this URL can record traffic through the session, so keep it private.`}
        />
      )}

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No capture sessions yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {sessions.map((s) => (
            <li key={s.id} className={`space-y-2 p-3 text-sm ${s.status === "stopped" ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium">{s.name}</span>{" "}
                  <span className="rounded border px-1 text-xs">{s.status}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {s.entryCount} recorded · …{s.tokenHint}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReviewing(reviewing === s.id ? null : s.id)}
                  >
                    {reviewing === s.id ? "Hide" : "Review"}
                  </Button>
                  {s.status === "recording" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void patch(s, { status: "paused" }, "Paused")}
                    >
                      Pause
                    </Button>
                  )}
                  {s.status === "paused" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void patch(s, { status: "recording" }, "Recording")}
                    >
                      Resume
                    </Button>
                  )}
                  {s.status !== "stopped" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              call<{ path: string }>(`/api/capture/sessions/${s.id}/rotate`, "POST").then(
                                (r) => setIssued({ url: relayUrl(r.path), name: s.name }),
                              ),
                            "New relay URL issued",
                          )
                        }
                      >
                        New URL
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void patch(s, { status: "stopped" }, "Stopped")}
                      >
                        Stop
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(() => call(`/api/capture/sessions/${s.id}`, "DELETE"), "Session deleted")
                    }
                  >
                    Delete
                  </Button>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                {s.allowHttps
                  ? `HTTPS recording allowed${s.httpsConsentAt ? ` (consent ${formatDateTime(s.httpsConsentAt)})` : ""}`
                  : "HTTP only"}
                {" · "}
                {s.captureCookies ? "harmless cookies kept" : "cookies masked"}
                {" · "}
                {s.hosts.length ? s.hosts.join(", ") : "any host"}
                {s.lastCapturedAt ? ` · last ${formatDateTime(s.lastCapturedAt)}` : ""}
              </div>
              {reviewing === s.id && <Review session={s} onChanged={load} />}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-md border p-3">
        <h4 className="text-sm font-medium">Start a session</h4>
        <div className="flex flex-wrap gap-2">
          <Input
            className="w-48"
            aria-label="Session name"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            className="w-72"
            aria-label="Only record these hosts"
            placeholder="Only these hosts (api.example.com, *.cdn.test)"
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
          />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} />
          <span>
            Allow recording HTTPS traffic. The relay makes the secure connection itself and stores what it
            sees, including response bodies, after removing credentials. Only turn this on for traffic you are
            entitled to record.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={cookies} onChange={(e) => setCookies(e.target.checked)} />
          <span>
            Keep cookie values that do not look like logins (sessions and tokens are always masked).
          </span>
        </label>
        <Button
          size="sm"
          disabled={busy || !name.trim()}
          onClick={() =>
            void run(
              () =>
                call<{ path: string }>("/api/capture/sessions", "POST", {
                  workspaceId,
                  name: name.trim(),
                  hosts: hostList(hosts),
                  allowHttps: https,
                  captureCookies: cookies,
                }).then((r) => {
                  setIssued({ url: relayUrl(r.path), name: name.trim() });
                  setName("");
                  setHosts("");
                  setHttps(false);
                  setCookies(false);
                }),
              "Session started",
            )
          }
        >
          Start recording
        </Button>
      </div>
    </section>
  );
}
