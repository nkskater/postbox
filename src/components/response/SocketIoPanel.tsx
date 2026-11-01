"use client";
/** Live Socket.IO session: saved listeners, event composer with acknowledgements, event log. */
import { formatTime } from "@/lib/format";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDownLeft, ArrowUpRight, Plug, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readNdjson } from "@/lib/ndjson";
import { useApp } from "@/stores/app";
import type { RequestDef, SocketIoSettings } from "@/core/types";

interface Entry {
  n: number;
  kind: "in" | "out" | "ack" | "info" | "error";
  event?: string;
  text: string;
  at: number;
}
type Message =
  | { type: "session"; id: string }
  | { type: "open"; id: string; namespace: string; at: number }
  | { type: "event"; direction: "in" | "out"; event: string; args: unknown[]; at: number }
  | { type: "ack"; event: string; args: unknown[]; at: number }
  | { type: "ack-timeout"; event: string; timeoutMs: number; at: number }
  | { type: "error"; error: string; at?: number }
  | { type: "done"; reason: string; at: number };

const KEPT = 500;

export function SocketIoPanel({
  draft,
  onSettings,
  onClose,
}: {
  draft: RequestDef & { folderId?: string | null };
  onSettings: (s: SocketIoSettings) => void;
  onClose: () => void;
}) {
  const { workspaceId, environmentId } = useApp();
  const cfg = draft.settings.socketio ?? {};
  const listeners = cfg.listeners ?? [];
  const [log, setLog] = useState<Entry[]>([]);
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [event, setEvent] = useState("message");
  const [args, setArgs] = useState("");
  const [ack, setAck] = useState(false);
  const [newListener, setNewListener] = useState("");
  const session = useRef<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const counter = useRef(0);
  const start = useRef(draft);

  useEffect(() => {
    const controller = new AbortController();
    ctrl.current = controller;
    const add = (e: Omit<Entry, "n">) => {
      const n = counter.current++;
      setLog((l) => [...l.slice(-(KEPT - 1)), { ...e, n }]);
    };
    // Listeners filter in the view, so the server streams every event.
    const { folderId, ...request } = start.current;
    const req = {
      ...request,
      settings: { ...request.settings, socketio: { ...request.settings.socketio, listeners: [] } },
    };
    (async () => {
      setLive(true);
      try {
        const res = await fetch("/api/socketio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, environmentId, folderId, request: req }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body)
          throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
        for await (const raw of readNdjson(res.body)) {
          if (ctrl.current !== controller) break;
          const m = raw as Message;
          const json = (v: unknown[]) =>
            v.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(", ");
          if (m.type === "session") session.current = m.id;
          else if (m.type === "open") {
            setConnected(true);
            add({ kind: "info", text: `Connected to ${m.namespace} as ${m.id}`, at: m.at });
          } else if (m.type === "event")
            add({ kind: m.direction, event: m.event, text: json(m.args), at: m.at });
          else if (m.type === "ack") add({ kind: "ack", event: m.event, text: json(m.args), at: m.at });
          else if (m.type === "ack-timeout")
            add({
              kind: "error",
              event: m.event,
              text: `No acknowledgement within ${m.timeoutMs} ms`,
              at: m.at,
            });
          else if (m.type === "error") add({ kind: "error", text: m.error, at: m.at ?? Date.now() });
          else if (m.type === "done") add({ kind: "info", text: `Disconnected (${m.reason})`, at: m.at });
        }
      } catch (err) {
        if (ctrl.current === controller && !controller.signal.aborted)
          add({ kind: "error", text: (err as Error).message, at: Date.now() });
      } finally {
        if (ctrl.current === controller) {
          setConnected(false);
          setLive(false);
          session.current = null;
        }
      }
    })();
    return () => controller.abort();
  }, [workspaceId, environmentId, attempt]);

  const call = async (path: string, body: object) => {
    const id = session.current;
    if (!id) return toast.error("Not connected");
    const res = await fetch(`/api/socketio/${encodeURIComponent(id)}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) toast.error((await res.json().catch(() => ({}))).error ?? res.statusText);
  };
  const emit = () => {
    let parsed: unknown[] = [];
    if (args.trim()) {
      try {
        const v = JSON.parse(args);
        parsed = Array.isArray(v) ? v : [v];
      } catch {
        return toast.error("Arguments must be JSON (a value, or an array of arguments)");
      }
    }
    void call("emit", { event, args: parsed, ack });
  };
  const shown = log.filter(
    (e) => e.kind !== "in" || listeners.length === 0 || listeners.includes(e.event ?? ""),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <Plug className={connected ? "size-3.5 text-green-600" : "size-3.5 text-muted-foreground"} />
        <span className="flex-1 text-muted-foreground" role="status">
          {connected ? "Connected" : live ? "Connecting…" : "Disconnected"}
        </span>
        {live ? (
          <Button size="sm" variant="ghost" className="h-6" onClick={() => void call("close", {})}>
            Disconnect
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-6" onClick={() => setAttempt((a) => a + 1)}>
            <RotateCcw className="size-3" /> Reconnect
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-6" onClick={() => setLog([])}>
          Clear
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          onClick={onClose}
          title="Close Socket.IO panel"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5 text-xs">
        <span className="text-muted-foreground">Listening to:</span>
        {listeners.length === 0 && <span className="text-muted-foreground">all events</span>}
        {listeners.map((l) => (
          <span key={l} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono">
            {l}
            <button
              aria-label={`Stop listening to ${l}`}
              onClick={() => onSettings({ ...cfg, listeners: listeners.filter((x) => x !== l) })}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          className="h-6 w-32 rounded border bg-transparent px-1.5 font-mono"
          placeholder="Add listener"
          value={newListener}
          onChange={(e) => setNewListener(e.target.value)}
          onKeyDown={(e) => {
            const name = newListener.trim();
            if (e.key === "Enter" && name && !listeners.includes(name)) {
              onSettings({ ...cfg, listeners: [...listeners, name] });
              setNewListener("");
            }
          }}
        />
      </div>
      <div className="flex gap-2 border-b p-2">
        <div className="flex flex-1 flex-col gap-1">
          <input
            className="h-7 rounded-md border bg-transparent px-2 font-mono text-xs"
            placeholder="Event name"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
          />
          <Textarea
            className="min-h-12 font-mono text-xs"
            placeholder='Arguments as JSON, e.g. {"text": "hi"} or ["a", 1]'
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Button size="sm" disabled={!connected || !event.trim()} onClick={emit}>
            Emit
          </Button>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Ack
          </label>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs" aria-label="Socket.IO events">
        {shown.map((e) => (
          <div key={e.n} className="flex gap-2 border-b px-3 py-1">
            <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(e.at)}</span>
            {e.kind === "in" && (
              <ArrowDownLeft className="size-3.5 shrink-0 text-blue-500" aria-label="received" />
            )}
            {e.kind === "out" && (
              <ArrowUpRight className="size-3.5 shrink-0 text-green-600" aria-label="emitted" />
            )}
            {e.event && (
              <span className="shrink-0 font-semibold">{e.kind === "ack" ? `ack ${e.event}` : e.event}</span>
            )}
            <pre
              className={
                e.kind === "error"
                  ? "whitespace-pre-wrap break-all text-destructive"
                  : e.kind === "info"
                    ? "whitespace-pre-wrap text-muted-foreground"
                    : "whitespace-pre-wrap break-all"
              }
            >
              {e.text}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
