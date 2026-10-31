"use client";
/** Runs a GraphQL subscription and shows its messages live. */
import { useRef, useState } from "react";
import { Radio, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { readNdjson } from "@/lib/ndjson";
import { useApp } from "@/stores/app";
import type { RequestDef } from "@/core/types";

type Message =
  | { type: "open"; transport: string; at: number }
  | { type: "next"; payload: unknown; at: number }
  | { type: "error"; errors?: unknown; error?: string; at?: number }
  | { type: "done"; reason: string; at: number };

const KEPT = 500;

export function GraphqlSubscriptionPanel({ draft }: { draft: RequestDef & { folderId?: string | null } }) {
  const { workspaceId, environmentId } = useApp();
  const [transport, setTransport] = useState<"ws" | "sse">("ws");
  const [params, setParams] = useState("");
  const [log, setLog] = useState<{ n: number; kind: string; text: string; at: number }[]>([]);
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const counter = useRef(0);

  const start = async () => {
    ctrl.current?.abort();
    const controller = new AbortController();
    ctrl.current = controller;
    setRunning(true);
    setStatus("Connecting…");
    const add = (kind: string, text: string, at = Date.now()) => {
      // Number outside the updater, which strict mode may run twice.
      const n = counter.current++;
      setLog((l) => [...l.slice(-(KEPT - 1)), { n, kind, text, at }]);
    };
    const { folderId, ...request } = draft;
    try {
      const res = await fetch("/api/graphql/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          environmentId,
          folderId,
          request,
          transport,
          connectionParams: params || undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      for await (const raw of readNdjson(res.body)) {
        if (ctrl.current !== controller) break;
        const m = raw as Message;
        if (m.type === "open") setStatus(`Subscribed over ${m.transport === "ws" ? "WebSocket" : "SSE"}`);
        else if (m.type === "next") add("next", JSON.stringify(m.payload, null, 2), m.at);
        else if (m.type === "error") add("error", m.error ?? JSON.stringify(m.errors), m.at);
        else if (m.type === "done") setStatus(m.reason);
      }
    } catch (err) {
      if (ctrl.current === controller)
        setStatus(controller.signal.aborted ? "Stopped" : (err as Error).message);
    } finally {
      if (ctrl.current === controller) setRunning(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-1 border-t pt-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Select value={transport} onValueChange={(v) => setTransport(v === "sse" ? "sse" : "ws")}>
          <SelectTrigger size="sm" className="h-7 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ws" className="text-xs">
              graphql-ws (WebSocket)
            </SelectItem>
            <SelectItem value="sse" className="text-xs">
              graphql-sse
            </SelectItem>
          </SelectContent>
        </Select>
        {transport === "ws" && (
          <input
            className="h-7 w-64 rounded-md border bg-transparent px-2 font-mono text-xs"
            placeholder='Connection params, e.g. {"token": "{{token}}"}'
            value={params}
            onChange={(e) => setParams(e.target.value)}
          />
        )}
        {running ? (
          <Button size="sm" variant="secondary" className="h-7" onClick={() => ctrl.current?.abort()}>
            <Square className="size-3" /> Stop
          </Button>
        ) : (
          <Button size="sm" className="h-7" onClick={() => void start()}>
            <Radio className="size-3.5" /> Subscribe
          </Button>
        )}
        <span className="text-muted-foreground" role="status">
          {status}
        </span>
        {log.length > 0 && !running && (
          <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => setLog([])}>
            Clear
          </Button>
        )}
      </div>
      <div
        className="max-h-56 min-h-16 overflow-auto rounded-md border font-mono text-[11px]"
        aria-label="Subscription messages"
      >
        {log.length === 0 ? (
          <p className="p-2 text-muted-foreground">No messages yet.</p>
        ) : (
          log.map((m) => (
            <div key={m.n} className="border-b px-2 py-1">
              <div className="text-[10px] text-muted-foreground">
                #{m.n + 1} · {new Date(m.at).toLocaleTimeString()}
              </div>
              <pre
                className={
                  m.kind === "error" ? "whitespace-pre-wrap text-destructive" : "whitespace-pre-wrap"
                }
              >
                {m.text}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
