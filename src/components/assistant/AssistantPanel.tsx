"use client";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_AI_CONFIG, type AiMessage, type AiResult, type AiResultToolCall } from "@/core/ai/types";
import { DEFAULT_SETTINGS, type RequestDef } from "@/core/types";
import {
  assistantEndpoint,
  assistantProposal,
  ASSISTANT_SYSTEM,
  ASSISTANT_TOOLS,
  type AssistantProposal,
} from "@/core/assistant/model";
import { readNdjson } from "@/lib/ndjson";
import { api } from "@/lib/api";
function request(proposal: AssistantProposal): RequestDef {
  return {
    id: crypto.randomUUID(),
    name: proposal.name,
    method: proposal.method,
    url: proposal.url,
    description: proposal.description,
    params: [],
    headers: [],
    auth: { type: "none" },
    body: proposal.body ? { mode: "raw", raw: proposal.body, language: "text" } : { mode: "none" },
    preRequestScript: "",
    testScript: proposal.testScript,
    settings: { ...DEFAULT_SETTINGS },
  };
}
export function AssistantPanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  return workspaceId ? (
    <Chat key={workspaceId} workspaceId={workspaceId} />
  ) : (
    <p className="p-4">Select a workspace.</p>
  );
}
function Chat({ workspaceId }: { workspaceId: string }) {
  const [server, setServer] = useState(""),
    [model, setModel] = useState(""),
    [token, setToken] = useState(""),
    [provider, setProvider] = useState<"strata" | "ollama" | "openai">("strata");
  const [prompt, setPrompt] = useState(""),
    [messages, setMessages] = useState<AiMessage[]>([]),
    [answer, setAnswer] = useState(""),
    [calls, setCalls] = useState<AiResultToolCall[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [review, setReview] = useState(""),
    [handled, setHandled] = useState<string[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function ask() {
    if (!prompt.trim() || busy) return;
    const ctrl = new AbortController();
    controller.current = ctrl;
    setBusy(true);
    setError("");
    setAnswer("");
    setCalls([]);
    setHandled([]);
    try {
      const conversation = [...messages, { role: "user" as const, content: prompt.trim() }];
      if (conversation.length > 40) throw Error("Start a new conversation after 40 messages");
      const draft = request({
        name: "Assistant model request",
        method: "POST",
        url: assistantEndpoint(server),
        description: "",
        testScript: "",
        body: "",
      });
      draft.auth = token ? { type: "bearer", bearer: { token } } : { type: "none" };
      draft.body = {
        mode: "ai",
        ai: {
          ...DEFAULT_AI_CONFIG,
          provider,
          model,
          system: ASSISTANT_SYSTEM,
          messages: conversation,
          tools: ASSISTANT_TOOLS,
          maxTokens: 4096,
        },
      };
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, request: draft, assistant: true }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw Error((await res.json()).error ?? "Model request failed");
      let result: AiResult | null = null;
      for await (const raw of readNdjson(res.body)) {
        const event = raw as { type: string; text?: string; message?: string; result?: AiResult };
        if (event.type === "text") setAnswer((v) => v + (event.text ?? ""));
        if (event.type === "error") throw Error(event.message ?? "Model request failed");
        if (event.type === "done") result = event.result ?? null;
      }
      if (!result) throw Error("The model stream ended without a complete result");
      if (result.error) throw Error(result.error);
      setAnswer(result.text);
      setCalls(result.toolCalls.map((call) => ({ ...call, id: crypto.randomUUID() })));
      setMessages([...conversation, { role: "assistant", content: result.text }]);
      setPrompt("");
    } catch (e) {
      setError(ctrl.signal.aborted ? "Stopped" : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }
  async function approve(call: AiResultToolCall) {
    setError("");
    try {
      if (!["propose_request", "propose_execution"].includes(call.name))
        throw Error("Unsupported proposed action");
      const parsed = assistantProposal.parse(JSON.parse(call.arguments));
      const draft = request(parsed);
      setHandled((v) => [...v, call.id]);
      if (call.name === "propose_execution") {
        setBusy(true);
        const ctrl = new AbortController();
        controller.current = ctrl;
        const result = await api.proxy(
          {
            workspaceId,
            environmentId: null,
            folderId: null,
            requestId: null,
            request: draft,
          },
          ctrl.signal,
        );
        setReview(JSON.stringify(result, null, 2));
      } else {
        useApp.getState().openDraft({ ...draft, folderId: null });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }
  return (
    <div className="h-full overflow-auto p-5 space-y-4 text-sm">
      <h1 className="text-xl font-semibold">API assistant</h1>
      <p>
        Ask for help designing requests, writing tests or explaining failures. Review each proposed action
        before opening a draft or sending a request.
      </p>
      <section className="border rounded p-4 space-y-3" aria-label="Assistant model settings">
        <div className="flex flex-wrap gap-3">
          <label>
            Provider
            <select
              className="block border rounded p-2 bg-background"
              value={provider}
              disabled={busy}
              onChange={(e) => setProvider(e.target.value as typeof provider)}
            >
              <option value="strata">Strata</option>
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </label>
          <label>
            Server URL
            <Input
              value={server}
              disabled={busy}
              placeholder="http://your-server:11434"
              onChange={(e) => setServer(e.target.value)}
            />
          </label>
          <label>
            Model
            <Input
              value={model}
              disabled={busy}
              placeholder="Your server's model name"
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label>
            API key (optional)
            <Input
              type="password"
              autoComplete="off"
              value={token}
              disabled={busy}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Connects from the Postbox server using the OpenAI-compatible chat completions endpoint. Settings,
          credentials and conversation stay in this open tab. Only text you enter here is sent to the model.
          Use variable references for secrets.
        </p>
      </section>
      <section aria-label="Assistant conversation" className="space-y-3">
        {messages.map((m, i) => (
          <article key={i} className="border rounded p-3">
            <strong>{m.role}</strong>
            <pre className="whitespace-pre-wrap break-words">{m.content}</pre>
          </article>
        ))}
        {busy && answer && <pre className="whitespace-pre-wrap">{answer}</pre>}
      </section>
      <label className="block">
        Message
        <Textarea
          value={prompt}
          disabled={busy}
          maxLength={30000}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the request, tests or failure. Remove credentials before sharing context."
        />
      </label>
      <div className="flex gap-2">
        <Button
          disabled={busy || !model.trim() || !server.trim() || !prompt.trim()}
          onClick={() => void ask()}
        >
          Ask assistant
        </Button>
        {busy && (
          <Button variant="outline" onClick={() => controller.current?.abort()}>
            Stop
          </Button>
        )}
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => {
            setMessages([]);
            setAnswer("");
            setCalls([]);
            setReview("");
            setError("");
          }}
        >
          New conversation
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {calls.map((call) => (
        <article key={call.id} className="border rounded p-4 space-y-2">
          <h2 className="font-semibold">
            {call.name === "propose_execution"
              ? "Review proposed execution"
              : "Review proposed request draft"}
          </h2>
          <pre className="whitespace-pre-wrap break-all">{call.arguments}</pre>
          <p>
            Review the target URL, body and test script. Sending executes the request and its tests on the
            Postbox server.
          </p>
          <Button
            disabled={
              busy ||
              handled.includes(call.id) ||
              !["propose_request", "propose_execution"].includes(call.name) ||
              !call.valid
            }
            onClick={() => void approve(call)}
          >
            {handled.includes(call.id)
              ? rejected.includes(call.id)
                ? "Rejected"
                : "Approved"
              : call.name === "propose_execution"
                ? "Approve and send request"
                : "Approve and open new draft"}
          </Button>
          <Button
            variant="outline"
            disabled={busy || handled.includes(call.id)}
            onClick={() => {
              setRejected((v) => [...v, call.id]);
              setHandled((v) => [...v, call.id]);
            }}
          >
            Reject
          </Button>
        </article>
      ))}
      {review && (
        <section>
          <h2 className="font-semibold">Execution result</h2>
          <pre className="whitespace-pre-wrap break-all">{review}</pre>
        </section>
      )}
    </div>
  );
}
