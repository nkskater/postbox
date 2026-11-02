"use client";
/** A model request, live: streamed text, reasoning, tool calls to inspect, usage, and the raw events. */
import { useEffect, useRef, useState } from "react";
import { Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AiEvent, AiMessage, AiResult } from "@/core/ai/types";
import type { RequestDef } from "@/core/types";
import { readNdjson } from "@/lib/ndjson";
import { useApp } from "@/stores/app";

type Message =
  | { type: "open"; status: number }
  | { type: "done"; status: number | null; elapsedMs: number; result: AiResult }
  | { type: "error"; status: number | null; message: string }
  | Exclude<AiEvent, { type: "error" }>;

/** Raw events kept for inspection; the answer itself is never cut. */
const LOG_LIMIT = 2000;

export function AiPanel({
  draft,
  onClose,
  onAppend,
}: {
  draft: RequestDef & { folderId?: string | null };
  onClose: () => void;
  /** Add messages to the conversation in the request body. */
  onAppend: (messages: AiMessage[]) => void;
}) {
  const { workspaceId, environmentId } = useApp();
  const [text, setText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [result, setResult] = useState<AiResult | null>(null);
  const [status, setStatus] = useState("Sending…");
  const [error, setError] = useState("");
  const [live, setLive] = useState(true);
  const [log, setLog] = useState<Message[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [toolResults, setToolResults] = useState<Record<string, string>>({});
  const ctrl = useRef<AbortController | null>(null);
  const start = useRef(draft);

  useEffect(() => {
    const controller = new AbortController();
    ctrl.current = controller;
    const { folderId, ...request } = start.current;
    (async () => {
      try {
        const res = await fetch("/api/ai", {
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
          setLog((list) => (list.length >= LOG_LIMIT ? list : [...list, m]));
          if (m.type === "open") setStatus(`HTTP ${m.status}`);
          else if (m.type === "text") setText((t) => t + m.text);
          else if (m.type === "reasoning") setReasoning((t) => t + m.text);
          else if (m.type === "error") setError(`${m.status ? `HTTP ${m.status}: ` : ""}${m.message}`);
          else if (m.type === "done") {
            setResult(m.result);
            setText(m.result.text);
            setReasoning(m.result.reasoning);
            setElapsed(m.elapsedMs);
            setStatus(m.status ? `HTTP ${m.status}` : "Done");
            if (m.result.error) setError(m.result.error);
          }
        }
      } catch (err) {
        if (ctrl.current !== controller) return;
        setError(controller.signal.aborted ? "Stopped" : (err as Error).message);
      } finally {
        if (ctrl.current === controller) setLive(false);
      }
    })();
    return () => {
      controller.abort();
      if (ctrl.current === controller) ctrl.current = null;
    };
  }, [workspaceId, environmentId]);

  const usage = result?.usage;
  const calls = result?.toolCalls ?? [];
  const pretty = (args: string) => {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  };
  const assistant = (): AiMessage => ({
    role: "assistant",
    content: result?.text ?? text,
    ...(calls.length
      ? { toolCalls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })) }
      : {}),
  });

  return (
    <div className="flex h-full min-h-0 flex-col text-sm" aria-label="Model response">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className="font-medium">Model response</span>
        <span className="text-muted-foreground">{status}</span>
        {elapsed !== null && <span className="text-muted-foreground">{elapsed} ms</span>}
        {result?.model && <span className="text-muted-foreground">{result.model}</span>}
        {result?.finishReason && (
          <span className="rounded border px-1" title="Why the model stopped">
            {result.finishReason}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          {live && (
            <Button size="sm" variant="outline" onClick={() => ctrl.current?.abort()}>
              <Square className="size-3.5" /> Stop
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Answer" : "Raw events"}
          </Button>
          <Button size="icon" variant="ghost" className="size-7" title="Close" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {error && (
          <p className="rounded border border-destructive/50 p-2 text-destructive" role="alert">
            {error}
          </p>
        )}
        {showLog ? (
          <ol className="space-y-1 font-mono text-xs">
            {log.map((m, i) => (
              <li key={i} className="break-all">
                {JSON.stringify(m.type === "done" ? { ...m, result: "…" } : m)}
              </li>
            ))}
          </ol>
        ) : (
          <>
            {reasoning && (
              <details>
                <summary className="cursor-pointer text-xs font-medium">Reasoning</summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                  {reasoning}
                </pre>
              </details>
            )}
            {text ? (
              <pre className="font-sans text-sm whitespace-pre-wrap" aria-label="Answer">
                {text}
              </pre>
            ) : (
              live && <p className="text-muted-foreground">Waiting for the first token…</p>
            )}
            {calls.length > 0 && (
              <section className="space-y-2" aria-label="Tool calls">
                <h4 className="text-xs font-medium">
                  Tool calls <span className="font-normal text-muted-foreground">(not run by Postbox)</span>
                </h4>
                {calls.map((c, i) => (
                  <div key={c.id || i} className="space-y-1 rounded-md border p-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono font-medium">{c.name || "(unnamed)"}</span>
                      {c.id && <code className="text-muted-foreground">{c.id}</code>}
                      {!c.valid && (
                        <span className="rounded border border-destructive/50 px-1 text-destructive">
                          arguments are not valid JSON
                        </span>
                      )}
                    </div>
                    <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">
                      {pretty(c.arguments) || "{}"}
                    </pre>
                    <Textarea
                      className="min-h-12 font-mono text-xs"
                      aria-label={`Result for ${c.name || "tool call"} ${i + 1}`}
                      placeholder="Result to send back (you run the tool yourself)"
                      value={toolResults[c.id || String(i)] ?? ""}
                      onChange={(e) =>
                        setToolResults({ ...toolResults, [c.id || String(i)]: e.target.value })
                      }
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  onClick={() => {
                    onAppend([
                      assistant(),
                      ...calls.map((c, i): AiMessage => ({
                        role: "tool",
                        toolCallId: c.id,
                        content: toolResults[c.id || String(i)] ?? "",
                      })),
                    ]);
                    onClose();
                  }}
                >
                  Add results to the conversation
                </Button>
              </section>
            )}
            {usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined) && (
              <p className="text-xs text-muted-foreground" aria-label="Usage">
                Tokens: {usage.inputTokens ?? "?"} in · {usage.outputTokens ?? "?"} out
                {usage.totalTokens !== undefined ? ` · ${usage.totalTokens} total` : ""}
              </p>
            )}
            {!live && !calls.length && (result?.text || text) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onAppend([assistant()]);
                  onClose();
                }}
              >
                Add reply to the conversation
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
