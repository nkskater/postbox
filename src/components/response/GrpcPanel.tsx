"use client";
/** Live gRPC call: streamed events, plus send / end / cancel for interactive streams. */
import { formatTime } from "@/lib/format";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDownLeft, ArrowUpRight, Plug, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readNdjson } from "@/lib/ndjson";
import { logEntry, type GrpcLogEntry, type GrpcWireEvent } from "@/lib/grpc";
import { useApp } from "@/stores/app";
import type { RequestDef } from "@/core/types";

const KEPT = 1000;

export function GrpcPanel({
  draft,
  onClose,
}: {
  draft: RequestDef & { folderId?: string | null };
  onClose: () => void;
}) {
  const { workspaceId, environmentId } = useApp();
  const [log, setLog] = useState<(GrpcLogEntry & { n: number })[]>([]);
  const [live, setLive] = useState(true);
  const [interactive, setInteractive] = useState(false);
  const [ended, setEnded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("{}");
  const session = useRef<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const counter = useRef(0);
  const start = useRef(draft);

  useEffect(() => {
    const controller = new AbortController();
    ctrl.current = controller;
    const add = (e: GrpcLogEntry) => {
      const n = counter.current++;
      setLog((l) => [...l.slice(-(KEPT - 1)), { ...e, n }]);
    };
    const { folderId, ...request } = start.current;
    (async () => {
      setLive(true);
      setEnded(false);
      setInteractive(false);
      try {
        const res = await fetch("/api/grpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, environmentId, folderId, request, interactive: "auto" }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body)
          throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
        for await (const raw of readNdjson(res.body)) {
          if (ctrl.current !== controller) break;
          const e = raw as GrpcWireEvent;
          if (e.type === "session") {
            session.current = e.id;
            setInteractive(true);
          }
          const entry = logEntry(e);
          if (entry) add(entry);
        }
      } catch (err) {
        if (ctrl.current === controller && !controller.signal.aborted)
          add({ kind: "error", title: "Error", text: (err as Error).message, at: Date.now() });
      } finally {
        if (ctrl.current === controller) {
          setLive(false);
          setInteractive(false);
          session.current = null;
        }
      }
    })();
    return () => controller.abort();
  }, [workspaceId, environmentId, attempt]);

  const call = async (path: string, body: object) => {
    const id = session.current;
    if (!id) return false;
    const res = await fetch(`/api/grpc/${encodeURIComponent(id)}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) toast.error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.ok;
  };
  const send = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      toast.error("The message must be valid JSON");
      return;
    }
    await call("send", { message: parsed });
  };
  const cancel = () => (session.current ? void call("cancel", {}) : ctrl.current?.abort());

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <Plug className={live ? "size-3.5 text-green-600" : "size-3.5 text-muted-foreground"} />
        <span className="flex-1 text-muted-foreground" role="status">
          {live
            ? interactive
              ? ended
                ? "Receiving (request stream ended)"
                : "Streaming"
              : "Running…"
            : "Finished"}
        </span>
        {live ? (
          <Button size="sm" variant="ghost" className="h-6" onClick={cancel}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-6" onClick={() => setAttempt((a) => a + 1)}>
            <RotateCcw className="size-3" /> Invoke again
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-6" onClick={() => setLog([])}>
          Clear
        </Button>
        <Button size="icon" variant="ghost" className="size-6" onClick={onClose} title="Close gRPC panel">
          <X className="size-3.5" />
        </Button>
      </div>
      {interactive && live && (
        <div className="flex gap-2 border-b p-2">
          <Textarea
            className="min-h-12 flex-1 font-mono text-xs"
            aria-label="Next message"
            placeholder="Next message as JSON"
            disabled={ended}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="flex flex-col gap-1">
            <Button size="sm" disabled={ended} onClick={() => void send()}>
              Send
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={ended}
              title="Half-close the request stream; the server can keep responding"
              onClick={async () => {
                if (await call("end", {})) setEnded(true);
              }}
            >
              End stream
            </Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs" aria-label="gRPC events">
        {log.map((e) => (
          <div key={e.n} className="flex gap-2 border-b px-3 py-1">
            <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(e.at)}</span>
            {e.kind === "in" && (
              <ArrowDownLeft className="size-3.5 shrink-0 text-blue-500" aria-label="received" />
            )}
            {e.kind === "out" && (
              <ArrowUpRight className="size-3.5 shrink-0 text-green-600" aria-label="sent" />
            )}
            <span className="shrink-0 font-semibold">{e.title}</span>
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
