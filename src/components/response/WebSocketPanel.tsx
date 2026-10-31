"use client";
/** Live WebSocket session for the current request: message log and composer. */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDownLeft, ArrowUpRight, Plug, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readNdjson } from "@/lib/ndjson";
import { useApp } from "@/stores/app";
import type { RequestDef } from "@/core/types";

interface LogEntry {
  n: number;
  kind: "in" | "out" | "info" | "error";
  text: string;
  binary?: boolean;
  size?: number;
  at: number;
}
type Message =
  | { type: "session"; id: string }
  | { type: "open"; protocol: string; at: number }
  | { type: "message"; direction: "in" | "out"; data: string; binary: boolean; size: number; at: number }
  | { type: "error"; error: string; at?: number }
  | { type: "done"; code: number; reason: string; at: number };

/** Messages kept in the view. */
const KEPT = 500;

export function WebSocketPanel({
  draft,
  onClose,
}: {
  draft: RequestDef & { folderId?: string | null };
  onClose: () => void;
}) {
  const { workspaceId, environmentId } = useApp();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("");
  const [binary, setBinary] = useState(false);
  const session = useRef<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const counter = useRef(0);
  const start = useRef(draft);

  useEffect(() => {
    const controller = new AbortController();
    ctrl.current = controller;
    const add = (e: Omit<LogEntry, "n">) =>
      setLog((l) => [...l.slice(-(KEPT - 1)), { ...e, n: counter.current++ }]);
    const { folderId, ...request } = start.current;
    (async () => {
      setLive(true);
      add({ kind: "info", text: `Connecting to ${request.url}`, at: Date.now() });
      try {
        const res = await fetch("/api/ws", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, environmentId, folderId, request }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body)
          throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
        for await (const raw of readNdjson(res.body)) {
          if (ctrl.current !== controller) break;
          const m = raw as Message;
          if (m.type === "session") session.current = m.id;
          else if (m.type === "open") {
            setConnected(true);
            add({ kind: "info", text: `Connected${m.protocol ? ` (${m.protocol})` : ""}`, at: m.at });
          } else if (m.type === "message")
            add({ kind: m.direction, text: m.data, binary: m.binary, size: m.size, at: m.at });
          else if (m.type === "error") add({ kind: "error", text: m.error, at: m.at ?? Date.now() });
          else if (m.type === "done")
            add({
              kind: "info",
              text: `Disconnected (${m.code}${m.reason ? ` ${m.reason}` : ""})`,
              at: m.at,
            });
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
    const res = await fetch(`/api/ws/${encodeURIComponent(id)}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) toast.error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.ok;
  };
  const send = async () => {
    if (!message) return;
    if (await call("send", { data: message, binary })) setMessage("");
  };

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
          title="Close WebSocket panel"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex gap-2 border-b p-2">
        <Textarea
          className="min-h-14 flex-1 font-mono text-xs"
          placeholder={binary ? "Base64-encoded binary message" : "Message (Ctrl+Enter to send)"}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex flex-col gap-1">
          <Button size="sm" disabled={!connected || !message} onClick={() => void send()}>
            Send
          </Button>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={binary} onChange={(e) => setBinary(e.target.checked)} /> Binary
          </label>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs" aria-label="WebSocket messages">
        {log.map((e) => (
          <div key={e.n} className="flex gap-2 border-b px-3 py-1">
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {new Date(e.at).toLocaleTimeString()}
            </span>
            {e.kind === "in" ? (
              <ArrowDownLeft className="size-3.5 shrink-0 text-blue-500" aria-label="received" />
            ) : e.kind === "out" ? (
              <ArrowUpRight className="size-3.5 shrink-0 text-green-600" aria-label="sent" />
            ) : null}
            <pre
              className={
                e.kind === "error"
                  ? "whitespace-pre-wrap break-all text-destructive"
                  : e.kind === "info"
                    ? "whitespace-pre-wrap text-muted-foreground"
                    : "whitespace-pre-wrap break-all"
              }
            >
              {e.binary ? `[binary ${e.size} bytes] ${e.text}` : e.text}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
