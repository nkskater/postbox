"use client";
/** Sandboxed JavaScript handlers for one mock endpoint: edit them and try them in a test console. */
import { useState } from "react";
import { nanoid } from "nanoid";
import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { MockHandler } from "@/core/mocks/handlers";
import type { MockDocument } from "@/core/mocks/model";

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

interface TestOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  state: unknown;
  logs: string[];
  ms: number;
}

const STARTER = `// Runs for every matching request. Return a response, or nothing to serve the saved example.
const hits = state.get("hits", 0) + 1;
state.set("hits", hits);
return { status: 200, json: { hits, path: req.path } };`;

interface Draft {
  id: string;
  name: string;
  method: string;
  path: string;
  code: string;
  enabled: boolean;
}

const toDraft = (h?: MockHandler): Draft => ({
  id: h?.id ?? nanoid(10),
  name: h?.name ?? "",
  method: h?.match.method ?? "",
  path: h?.match.path ?? "",
  code: h?.code ?? STARTER,
  enabled: h?.enabled ?? true,
});

export function MockHandlers({
  mock,
  busy,
  onChanged,
}: {
  mock: MockDocument;
  busy: boolean;
  onChanged: (mock: MockDocument) => void;
}) {
  const handlers = mock.handlers ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [test, setTest] = useState({ method: "GET", path: "/", body: "", state: "{}", count: "1" });
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [sessions, setSessions] = useState<string>("");

  const save = async (next: MockHandler[]) => {
    setWorking(true);
    setError("");
    try {
      onChanged(await call<MockDocument>(`/api/mocks/${mock.id}`, "PATCH", { handlers: next }));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setWorking(false);
    }
  };

  const commit = async () => {
    if (!draft) return;
    const handler: MockHandler = {
      id: draft.id,
      name: draft.name.trim() || "Handler",
      enabled: draft.enabled,
      match: {
        ...(draft.method.trim() ? { method: draft.method.trim().toUpperCase() } : {}),
        ...(draft.path.trim() ? { path: draft.path.trim() } : {}),
      },
      code: draft.code,
    };
    const exists = handlers.some((h) => h.id === handler.id);
    if (
      await save(exists ? handlers.map((h) => (h.id === handler.id ? handler : h)) : [...handlers, handler])
    )
      setDraft(null);
  };

  const run = async () => {
    if (!draft) return;
    setWorking(true);
    setError("");
    try {
      const state = JSON.parse(test.state || "{}");
      setOutcome(
        await call<TestOutcome>(`/api/mocks/${mock.id}/handlers/test`, "POST", {
          code: draft.code,
          request: { method: test.method, path: test.path, ...(test.body ? { body: test.body } : {}) },
          state,
          count: Number(test.count) || 1,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const disabled = !mock.canEdit || working || busy;

  return (
    <section className="space-y-2 rounded border p-2" aria-label="Handlers">
      <h4 className="font-medium">Handlers</h4>
      <p className="text-muted-foreground">
        JavaScript that computes a response from <code>req</code>, per-session <code>state</code> and the
        matched <code>example</code>. It runs in a sandbox with no network or file access, after failure
        simulations, with limits on time, memory, output and state. Random numbers and dates are
        deterministic.
      </p>
      {!handlers.length && <p className="text-muted-foreground">No handlers.</p>}
      <ul className="space-y-1">
        {handlers.map((h) => (
          <li key={h.id} className="flex items-start gap-2 rounded border px-2 py-1">
            <input
              type="checkbox"
              aria-label={`Enable ${h.name}`}
              checked={h.enabled}
              disabled={disabled}
              onChange={() =>
                void save(handlers.map((x) => (x.id === h.id ? { ...x, enabled: !x.enabled } : x)))
              }
            />
            <div className="min-w-0 flex-1">
              <div className="break-words font-medium">{h.name}</div>
              <div className="break-words text-muted-foreground">
                {h.match.method ?? "Any method"} {h.match.path ?? "any path"}
              </div>
            </div>
            {mock.canEdit && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Edit ${h.name}`}
                  disabled={disabled}
                  onClick={() => {
                    setDraft(toDraft(h));
                    setOutcome(null);
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Remove ${h.name}`}
                  disabled={disabled}
                  onClick={() => void save(handlers.filter((x) => x.id !== h.id))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>

      {mock.canEdit && !draft && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setDraft(toDraft());
              setOutcome(null);
            }}
          >
            <Plus className="size-3.5" /> Add handler
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={working}
            onClick={async () => {
              try {
                const s = await call<{ sessions: unknown[] }>(`/api/mocks/${mock.id}/state`, "GET");
                setSessions(
                  s.sessions.length ? JSON.stringify(s.sessions, null, 2) : "No session state yet.",
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            View session state
          </Button>
        </div>
      )}
      {sessions && (
        <pre className="max-h-40 overflow-auto rounded border bg-muted/40 p-2 text-xs whitespace-pre-wrap">
          {sessions}
        </pre>
      )}

      {draft && (
        <form
          className="space-y-2 rounded border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void commit();
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Handler name"
              className="h-7 w-40"
              placeholder="Name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Input
              aria-label="Handler method"
              className="h-7 w-20"
              placeholder="Method"
              value={draft.method}
              onChange={(e) => setDraft({ ...draft, method: e.target.value })}
            />
            <Input
              aria-label="Handler path"
              className="h-7 w-44"
              placeholder="/users/:id (any)"
              value={draft.path}
              onChange={(e) => setDraft({ ...draft, path: e.target.value })}
            />
          </div>
          <Textarea
            aria-label="Handler code"
            className="min-h-40 font-mono text-xs"
            spellCheck={false}
            value={draft.code}
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          />
          <div className="space-y-1 rounded border p-2">
            <div className="font-medium">Test console</div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Test method"
                className="h-7 w-20"
                value={test.method}
                onChange={(e) => setTest({ ...test, method: e.target.value })}
              />
              <Input
                aria-label="Test path"
                className="h-7 w-44"
                value={test.path}
                onChange={(e) => setTest({ ...test, path: e.target.value })}
              />
              <label className="flex items-center gap-1">
                Call #
                <Input
                  aria-label="Test call number"
                  className="h-7 w-14"
                  value={test.count}
                  onChange={(e) => setTest({ ...test, count: e.target.value })}
                />
              </label>
            </div>
            <Input
              aria-label="Test request body"
              className="h-7"
              placeholder="Request body (optional)"
              value={test.body}
              onChange={(e) => setTest({ ...test, body: e.target.value })}
            />
            <Textarea
              aria-label="Test starting state"
              className="min-h-12 font-mono text-xs"
              value={test.state}
              onChange={(e) => setTest({ ...test, state: e.target.value })}
            />
            <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => void run()}>
              <Play className="size-3.5" /> Run (nothing is saved)
            </Button>
            {outcome && (
              <div className="space-y-1" aria-label="Test result">
                {outcome.ok ? (
                  <pre className="overflow-auto rounded border bg-muted/40 p-2 text-xs whitespace-pre-wrap">
                    {JSON.stringify(
                      outcome.result ?? "No response: the saved example would be served",
                      null,
                      2,
                    )}
                  </pre>
                ) : (
                  <p className="text-destructive" role="alert">
                    {outcome.error}
                  </p>
                )}
                <div className="text-muted-foreground">
                  {outcome.ms} ms · state after: <code>{JSON.stringify(outcome.state)}</code>
                </div>
                {outcome.logs.length > 0 && (
                  <pre className="overflow-auto rounded border p-2 text-xs whitespace-pre-wrap">
                    {outcome.logs.join("\n")}
                  </pre>
                )}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={working}>
              Save handler
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
