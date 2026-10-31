"use client";
/** Live MQTT session: connection profile, saved subscriptions, publisher and message history. */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDownLeft, ArrowUpRight, Plug, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readNdjson } from "@/lib/ndjson";
import { useApp } from "@/stores/app";
import type { MqttSettings, RequestDef } from "@/core/types";

interface Entry {
  n: number;
  kind: "in" | "out" | "info" | "error";
  topic?: string;
  text: string;
  meta?: string;
  at: number;
}
type Message =
  | { type: "session"; id: string }
  | { type: "open"; clientId: string; at: number }
  | {
      type: "message";
      topic: string;
      payload: string;
      binary: boolean;
      qos: number;
      retain: boolean;
      size: number;
      at: number;
    }
  | { type: "published"; topic: string; payload: string; qos: number; retain: boolean; at: number }
  | { type: "subscribed"; topic: string; granted: number; at: number }
  | { type: "unsubscribed"; topic: string; at: number }
  | { type: "error"; error: string; at?: number }
  | { type: "done"; reason: string; at: number };

const KEPT = 500;
const QOS = [0, 1, 2] as const;

export function MqttPanel({
  draft,
  onSettings,
  onClose,
}: {
  draft: RequestDef & { folderId?: string | null };
  onSettings: (s: MqttSettings) => void;
  onClose: () => void;
}) {
  const { workspaceId, environmentId } = useApp();
  const cfg = draft.settings.mqtt ?? {};
  const subs = cfg.subscriptions ?? [];
  const [log, setLog] = useState<Entry[]>([]);
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [topic, setTopic] = useState("");
  const [payload, setPayload] = useState("");
  const [qos, setQos] = useState<0 | 1 | 2>(0);
  const [retain, setRetain] = useState(false);
  const [subTopic, setSubTopic] = useState("");
  const [subQos, setSubQos] = useState<0 | 1 | 2>(0);
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
    const { folderId, ...request } = start.current;
    (async () => {
      setLive(true);
      try {
        const res = await fetch("/api/mqtt", {
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
            add({ kind: "info", text: `Connected as ${m.clientId}`, at: m.at });
          } else if (m.type === "message")
            add({
              kind: "in",
              topic: m.topic,
              text: m.binary ? `[binary ${m.size} bytes] ${m.payload}` : m.payload,
              meta: `QoS ${m.qos}${m.retain ? " · retained" : ""}`,
              at: m.at,
            });
          else if (m.type === "published")
            add({
              kind: "out",
              topic: m.topic,
              text: m.payload,
              meta: `QoS ${m.qos}${m.retain ? " · retain" : ""}`,
              at: m.at,
            });
          else if (m.type === "subscribed")
            add({ kind: "info", text: `Subscribed to ${m.topic} (QoS ${m.granted})`, at: m.at });
          else if (m.type === "unsubscribed")
            add({ kind: "info", text: `Unsubscribed from ${m.topic}`, at: m.at });
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
    if (!id) {
      toast.error("Not connected");
      return false;
    }
    const res = await fetch(`/api/mqtt/${encodeURIComponent(id)}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) toast.error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.ok;
  };
  const addSubscription = async () => {
    const t = subTopic.trim();
    if (!t) return;
    if (connected && !(await call("subscribe", { topic: t, qos: subQos }))) return;
    onSettings({ ...cfg, subscriptions: [...subs.filter((s) => s.topic !== t), { topic: t, qos: subQos }] });
    setSubTopic("");
  };
  const removeSubscription = async (t: string) => {
    if (connected) await call("unsubscribe", { topic: t });
    onSettings({ ...cfg, subscriptions: subs.filter((s) => s.topic !== t) });
  };
  const select = "h-7 rounded-md border bg-transparent px-1 text-xs";

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
        <Button size="icon" variant="ghost" className="size-6" onClick={onClose} title="Close MQTT panel">
          <X className="size-3.5" />
        </Button>
      </div>
      <details className="border-b px-3 py-1 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Connection profile (applies on reconnect; username and password come from Basic auth)
        </summary>
        <div className="flex flex-wrap items-center gap-2 py-1.5">
          <input
            className="h-7 w-48 rounded-md border bg-transparent px-2 font-mono"
            placeholder="Client ID (random if empty)"
            value={cfg.clientId ?? ""}
            onChange={(e) => onSettings({ ...cfg, clientId: e.target.value || undefined })}
          />
          <select
            className={select}
            aria-label="MQTT version"
            value={cfg.protocolVersion ?? 4}
            onChange={(e) => onSettings({ ...cfg, protocolVersion: e.target.value === "5" ? 5 : 4 })}
          >
            <option value={4}>MQTT 3.1.1</option>
            <option value={5}>MQTT 5</option>
          </select>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={cfg.clean ?? true}
              onChange={(e) => onSettings({ ...cfg, clean: e.target.checked })}
            />
            Clean session
          </label>
          <label className="flex items-center gap-1">
            Keepalive
            <input
              type="number"
              min={0}
              className="h-7 w-16 rounded-md border bg-transparent px-1"
              value={cfg.keepalive ?? 60}
              onChange={(e) => onSettings({ ...cfg, keepalive: Math.max(0, Number(e.target.value) || 0) })}
            />
            s
          </label>
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5 text-xs">
        <span className="text-muted-foreground">Subscriptions:</span>
        {subs.map((s) => (
          <span
            key={s.topic}
            className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono"
          >
            {s.topic} <span className="text-muted-foreground">q{s.qos ?? 0}</span>
            <button
              aria-label={`Unsubscribe from ${s.topic}`}
              onClick={() => void removeSubscription(s.topic)}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          className="h-6 w-40 rounded border bg-transparent px-1.5 font-mono"
          placeholder="topic/# to subscribe"
          value={subTopic}
          onChange={(e) => setSubTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void addSubscription()}
        />
        <select
          className={select}
          aria-label="Subscription QoS"
          value={subQos}
          onChange={(e) => setSubQos(Number(e.target.value) as 0 | 1 | 2)}
        >
          {QOS.map((q) => (
            <option key={q} value={q}>
              QoS {q}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" className="h-6" onClick={() => void addSubscription()}>
          Subscribe
        </Button>
      </div>
      <div className="flex gap-2 border-b p-2">
        <div className="flex flex-1 flex-col gap-1">
          <input
            className="h-7 rounded-md border bg-transparent px-2 font-mono text-xs"
            placeholder="Topic to publish to"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
          <Textarea
            className="min-h-12 font-mono text-xs"
            placeholder="Payload"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1 text-[11px]">
          <Button
            size="sm"
            disabled={!connected || !topic.trim()}
            onClick={() => void call("publish", { topic, payload, qos, retain })}
          >
            Publish
          </Button>
          <select
            className={select}
            aria-label="Publish QoS"
            value={qos}
            onChange={(e) => setQos(Number(e.target.value) as 0 | 1 | 2)}
          >
            {QOS.map((q) => (
              <option key={q} value={q}>
                QoS {q}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} /> Retain
          </label>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs" aria-label="MQTT messages">
        {log.map((e) => (
          <div key={e.n} className="flex gap-2 border-b px-3 py-1">
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {new Date(e.at).toLocaleTimeString()}
            </span>
            {e.kind === "in" && (
              <ArrowDownLeft className="size-3.5 shrink-0 text-blue-500" aria-label="received" />
            )}
            {e.kind === "out" && (
              <ArrowUpRight className="size-3.5 shrink-0 text-green-600" aria-label="published" />
            )}
            {e.topic && <span className="shrink-0 font-semibold">{e.topic}</span>}
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
            {e.meta && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{e.meta}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
