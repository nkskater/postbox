"use client";
/** Live server-sent events for the current request draft. */
import { useEffect, useRef, useState } from "react";
import { Radio, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readNdjson } from "@/lib/ndjson";
import { useApp } from "@/stores/app";
import type { RequestDef } from "@/core/types";

interface StreamEvent {
  index: number;
  event: string;
  data: string;
  id: string;
  receivedAt: number;
}
type Message =
  | { type: "open"; status: number; attempt: number }
  | ({ type: "event" } & StreamEvent)
  | { type: "reconnecting"; delayMs: number; lastEventId: string; reason: string }
  | { type: "done"; reason: string; events: number }
  | { type: "error"; error: string };

/** Events kept in the view; the server also stops after its own limit. */
const SHOWN = 500;

export function EventStreamPanel({
  draft,
  onClose,
}: {
  draft: RequestDef & { folderId?: string | null };
  onClose: () => void;
}) {
  const { workspaceId, environmentId } = useApp();
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [status, setStatus] = useState("Connecting…");
  const [live, setLive] = useState(true);
  const ctrl = useRef<AbortController | null>(null);
  const start = useRef(draft);

  useEffect(() => {
    const controller = new AbortController();
    ctrl.current = controller;
    const { folderId, ...request } = start.current;
    (async () => {
      try {
        const res = await fetch("/api/sse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, environmentId, folderId, request }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body)
          throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
        for await (const raw of readNdjson(res.body)) {
          const m = raw as Message;
          if (m.type === "open")
            setStatus(
              m.status === 200
                ? `Connected${m.attempt ? ` (reconnect ${m.attempt})` : ""}`
                : `HTTP ${m.status}`,
            );
          else if (m.type === "event") setEvents((list) => [...list.slice(-(SHOWN - 1)), m]);
          else if (m.type === "reconnecting")
            setStatus(
              `${m.reason}; reconnecting in ${Math.round(m.delayMs / 100) / 10}s${m.lastEventId ? ` from id ${m.lastEventId}` : ""}`,
            );
          else if (m.type === "done") setStatus(`${m.reason} · ${m.events} events`);
          else if (m.type === "error") setStatus(m.error);
        }
      } catch (err) {
        if (!controller.signal.aborted) setStatus((err as Error).message);
        else setStatus("Stopped");
      } finally {
        setLive(false);
      }
    })();
    return () => controller.abort();
  }, [workspaceId, environmentId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <Radio className={live ? "size-3.5 text-green-600" : "size-3.5 text-muted-foreground"} />
        <span className="flex-1 truncate text-muted-foreground" role="status">
          {status}
        </span>
        {live ? (
          <Button size="sm" variant="ghost" className="h-6" onClick={() => ctrl.current?.abort()}>
            <Square className="size-3" /> Stop
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-6" onClick={() => setEvents([])}>
            Clear
          </Button>
        )}
        <Button size="icon" variant="ghost" className="size-6" onClick={onClose} title="Close event stream">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        {events.length === 0 ? (
          <p className="p-3 text-muted-foreground">No events yet.</p>
        ) : (
          events.map((e) => (
            <div key={e.index} className="border-b px-3 py-1.5">
              <div className="text-[10px] text-muted-foreground">
                #{e.index + 1} · {e.event}
                {e.id && ` · id ${e.id}`} · {new Date(e.receivedAt).toLocaleTimeString()}
              </div>
              <pre className="whitespace-pre-wrap break-all">{e.data}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
