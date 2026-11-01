"use client";
/** Failure simulations for one mock endpoint: add, enable, remove and reset them. */
import { useState } from "react";
import { nanoid } from "nanoid";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MockDocument } from "@/core/mocks/model";
import type { Scenario } from "@/core/mocks/scenarios";
import {
  KINDS,
  buildScenario,
  describeScenario,
  emptyForm,
  withKind,
  type ScenarioForm,
} from "@/lib/mock-scenario-form";

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

const field = "h-7 rounded-md border bg-transparent px-2";

export function MockScenarios({
  mock,
  busy,
  onChanged,
}: {
  mock: MockDocument;
  busy: boolean;
  onChanged: (mock: MockDocument) => void;
}) {
  const [form, setForm] = useState<ScenarioForm>(emptyForm());
  const [adding, setAdding] = useState(false);
  const [session, setSession] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const scenarios = mock.scenarios ?? [];

  const save = async (next: Scenario[]) => {
    setWorking(true);
    setError("");
    setNote("");
    try {
      onChanged(await call<MockDocument>(`/api/mocks/${mock.id}`, "PATCH", { scenarios: next }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const set = <K extends keyof ScenarioForm>(key: K, value: ScenarioForm[K]) =>
    setForm({ ...form, [key]: value });
  const kind = KINDS.find((k) => k.kind === form.kind)!;
  const needsStatus = form.kind !== "delay" && form.kind !== "sequence";

  return (
    <section className="space-y-2 rounded border p-2" aria-label="Failure simulations">
      <h4 className="font-medium">Failure simulations</h4>
      <p className="text-muted-foreground">
        Rules run in order on every request; one that fails the request ends the list. Send{" "}
        <code>x-mock-session: name</code> to keep test runs apart. Counters restart with the server or when
        the rules change.
      </p>
      {!scenarios.length && <p className="text-muted-foreground">No simulations.</p>}
      <ul className="space-y-1">
        {scenarios.map((s, i) => (
          <li key={s.id} className="flex items-start gap-2 rounded border px-2 py-1">
            <input
              type="checkbox"
              aria-label={`Enable ${s.name}`}
              checked={s.enabled}
              disabled={!mock.canEdit || working || busy}
              onChange={() =>
                void save(scenarios.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))
              }
            />
            <div className="min-w-0 flex-1">
              <div className="break-words font-medium">{s.name}</div>
              <div className="break-words text-muted-foreground">{describeScenario(s)}</div>
            </div>
            {mock.canEdit && (
              <Button
                size="icon"
                variant="ghost"
                className="size-6"
                aria-label={`Remove ${s.name}`}
                disabled={working || busy}
                onClick={() => void save(scenarios.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>

      {mock.canEdit && !adding && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy || working} onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add simulation
          </Button>
          <Input
            aria-label="Session to reset"
            className="h-7 w-32"
            placeholder="session (all)"
            value={session}
            onChange={(e) => setSession(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || working}
            onClick={async () => {
              setError("");
              try {
                const r = await call<{ cleared: number }>(`/api/mocks/${mock.id}/reset`, "POST", {
                  ...(session.trim() ? { session: session.trim() } : {}),
                });
                setNote(`Reset ${r.cleared} ${r.cleared === 1 ? "session" : "sessions"}`);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <RotateCcw className="size-3.5" /> Reset counters
          </Button>
        </div>
      )}

      {adding && (
        <form
          className="space-y-2 rounded border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const scenario = buildScenario(form, nanoid(10));
              setAdding(false);
              setForm(emptyForm());
              void save([...scenarios, scenario]);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={field}
              aria-label="Simulation type"
              value={form.kind}
              onChange={(e) => setForm(withKind(form, e.target.value as ScenarioForm["kind"]))}
            >
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            <Input
              aria-label="Simulation name"
              className="h-7 w-40"
              placeholder="Name (optional)"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
          <p className="text-muted-foreground">{kind.hint}</p>
          <div className="flex flex-wrap items-center gap-2">
            {form.kind === "delay" && (
              <label className="flex items-center gap-1">
                Latency (ms)
                <Input
                  aria-label="Latency in milliseconds"
                  className="h-7 w-20"
                  value={form.ms}
                  onChange={(e) => set("ms", e.target.value)}
                />
              </label>
            )}
            {form.kind === "failFirst" && (
              <label className="flex items-center gap-1">
                Requests
                <Input
                  aria-label="Number of requests to fail"
                  className="h-7 w-16"
                  value={form.count}
                  onChange={(e) => set("count", e.target.value)}
                />
              </label>
            )}
            {form.kind === "failEvery" && (
              <label className="flex items-center gap-1">
                Every
                <Input
                  aria-label="Fail every Nth request"
                  className="h-7 w-16"
                  value={form.every}
                  onChange={(e) => set("every", e.target.value)}
                />
              </label>
            )}
            {form.kind === "sequence" && (
              <>
                <label className="flex items-center gap-1">
                  Statuses
                  <Input
                    aria-label="Status sequence"
                    className="h-7 w-44"
                    value={form.statuses}
                    onChange={(e) => set("statuses", e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={form.repeat}
                    onChange={(e) => set("repeat", e.target.checked)}
                  />{" "}
                  Repeat
                </label>
              </>
            )}
            {form.kind === "rateLimit" && (
              <>
                <label className="flex items-center gap-1">
                  Requests
                  <Input
                    aria-label="Requests allowed per window"
                    className="h-7 w-16"
                    value={form.limit}
                    onChange={(e) => set("limit", e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-1">
                  per (s)
                  <Input
                    aria-label="Window in seconds"
                    className="h-7 w-16"
                    value={form.windowSeconds}
                    onChange={(e) => set("windowSeconds", e.target.value)}
                  />
                </label>
              </>
            )}
            {needsStatus && (
              <label className="flex items-center gap-1">
                Status
                <Input
                  aria-label="Failure status"
                  className="h-7 w-16"
                  value={form.status}
                  onChange={(e) => set("status", e.target.value)}
                />
              </label>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">
              Method
              <Input
                aria-label="Only for method"
                className="h-7 w-20"
                placeholder="any"
                value={form.method}
                onChange={(e) => set("method", e.target.value)}
              />
            </label>
            <label className="flex items-center gap-1">
              Path
              <Input
                aria-label="Only for path"
                className="h-7 w-44"
                placeholder="/users/:id (any)"
                value={form.path}
                onChange={(e) => set("path", e.target.value)}
              />
            </label>
          </div>
          {form.kind !== "delay" && (
            <label className="block">
              Response body (optional, JSON error otherwise)
              <textarea
                aria-label="Failure response body"
                className="mt-1 min-h-12 w-full rounded-md border bg-transparent p-1 font-mono"
                value={form.body}
                onChange={(e) => set("body", e.target.value)}
              />
            </label>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={working}>
              Add
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setError("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {note && <p role="status">{note}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
