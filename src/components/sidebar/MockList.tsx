"use client";
import { useCallback, useEffect, useState } from "react";
import type { MockDocument, MockSummary } from "@/core/mocks/model";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { MockScenarios } from "./MockScenarios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Mock operation failed");
  return data;
}
interface Draft {
  name: string;
  enabled: boolean;
  public: boolean;
  matchQuery: boolean;
  matchBody: boolean;
  delayMs: number;
  status: string;
  headers: string;
}
const empty: Draft = {
  name: "New mock",
  enabled: true,
  public: false,
  matchQuery: true,
  matchBody: true,
  delayMs: 0,
  status: "",
  headers: "",
};
export function MockList() {
  const workspaceId = useApp((s) => s.workspaceId);
  return workspaceId ? <MockPanel key={workspaceId} workspaceId={workspaceId} /> : null;
}
function MockPanel({ workspaceId }: { workspaceId: string }) {
  const folders = useApp((s) => s.folders);
  const [rows, setRows] = useState<MockSummary[]>([]),
    [selected, setSelected] = useState<MockDocument | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [folderId, setFolderId] = useState(""),
    [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [logs, setLogs] = useState<
      { id: string; method: string; path: string; status: number; createdAt: number; durationMs: number }[]
    >([]);
  const refresh = useCallback(
    async () =>
      setRows(await call<MockSummary[]>(`/api/mocks?workspaceId=${encodeURIComponent(workspaceId)}`)),
    [workspaceId],
  );
  useEffect(() => {
    let active = true;
    call<MockSummary[]>(`/api/mocks?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((rows) => {
        if (active) setRows(rows);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);
  const action = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const load = async (id: string) => {
    const document = await call<MockDocument>(`/api/mocks/${id}`);
    setSelected(document);
    setDraft(null);
    setLogs(await call(`/api/mocks/${id}/logs`));
  };
  const discard = () => !draft || window.confirm("Discard unsaved mock settings?");
  useEffect(() => {
    if (!draft) return;
    const leave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [draft]);
  const edit = (mock: MockDocument) =>
    setDraft({
      name: mock.name,
      enabled: mock.enabled,
      public: mock.public,
      matchQuery: mock.matchQuery,
      matchBody: mock.matchBody,
      delayMs: mock.delayMs,
      status: mock.status === null ? "" : String(mock.status),
      headers: mock.headers
        .filter((h) => h.enabled)
        .map((h) => `${h.key}: ${h.value}`)
        .join("\n"),
    });
  return (
    <div className="h-full space-y-3 overflow-auto p-3 text-xs">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Mock servers</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (discard()) {
              setSelected(null);
              setDraft({ ...empty });
              setKey("");
              setLogs([]);
              setFolderId(folders.find((f) => !f.parentId)?.id ?? "");
            }
          }}
        >
          New mock
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <p className="text-muted-foreground">
        Serve saved response examples from a collection. Endpoints are private unless you explicitly share
        them publicly.
      </p>
      {rows.map((mock) => (
        <button
          key={mock.id}
          disabled={busy}
          className="block w-full rounded border p-2 text-left hover:bg-accent"
          onClick={() => {
            if (discard())
              void action(async () => {
                setKey("");
                await load(mock.id);
              });
          }}
        >
          <strong className="block truncate">{mock.name}</strong>
          <span className="text-muted-foreground">
            {mock.public ? "Public" : "Private"} · {mock.enabled ? "Enabled" : "Disabled"} · {mock.routeCount}{" "}
            examples
          </span>
        </button>
      ))}
      {key && (
        <div className="space-y-2 rounded border p-2">
          <strong>Copy your mock key now</strong>
          <p className="text-muted-foreground">
            Shown once. Send it in the x-postbox-mock-key header. Rotation revokes the old key.
          </p>
          <Input aria-label="New mock key" readOnly value={key} />
          <Button size="sm" variant="ghost" onClick={() => setKey("")}>
            Hide key
          </Button>
        </div>
      )}
      {draft ? (
        <form
          className="space-y-3 rounded border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const headers = draft.headers
                .split("\n")
                .filter((line) => line.trim())
                .map((line) => {
                  const colon = line.indexOf(":");
                  if (colon < 1) throw new Error("Headers must use Name: value");
                  return {
                    key: line.slice(0, colon).trim(),
                    value: line.slice(colon + 1).trim(),
                    enabled: true,
                  };
                });
              const body = { ...draft, status: draft.status ? Number(draft.status) : null, headers };
              if (selected) {
                await call(`/api/mocks/${selected.id}`, "PATCH", body);
                await load(selected.id);
              } else {
                const made = await call<MockDocument & { key: string }>("/api/mocks", "POST", {
                  ...body,
                  workspaceId,
                  folderId,
                });
                setKey(made.key);
                await load(made.id);
              }
              await refresh();
            });
          }}
        >
          <fieldset disabled={busy} className="space-y-3">
            <label className="block">
              Mock name
              <Input
                required
                aria-label="Mock name"
                maxLength={200}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            {!selected && (
              <label className="block">
                Collection
                <select
                  required
                  aria-label="Mock collection"
                  className="w-full rounded border bg-background p-2"
                  value={folderId}
                  onChange={(e) => setFolderId(e.target.value)}
                >
                  <option value="">Select collection</option>
                  {folders
                    .filter((f) => !f.parentId)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {(
              [
                ["enabled", "Enabled"],
                ["public", "Share publicly without a mock key"],
                ["matchQuery", "Match query parameters exactly"],
                ["matchBody", "Match request body"],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft[field]}
                  onChange={(e) => setDraft({ ...draft, [field]: e.target.checked })}
                />
                {label}
              </label>
            ))}
            {draft.public && (
              <p className="rounded border p-2">
                Anyone with the endpoint URL can read its saved responses. Review the examples before sharing.
              </p>
            )}
            <label className="block">
              Response delay (ms)
              <Input
                aria-label="Mock delay"
                type="number"
                min={0}
                max={30000}
                required
                value={draft.delayMs}
                onChange={(e) => setDraft({ ...draft, delayMs: Number(e.target.value) })}
              />
            </label>
            <label className="block">
              Override response status (blank uses example)
              <Input
                aria-label="Mock response status"
                type="number"
                min={200}
                max={599}
                value={draft.status}
                onChange={(e) => setDraft({ ...draft, status: e.target.value })}
              />
            </label>
            <label className="block">
              Response headers (Name: value)
              <Textarea
                aria-label="Mock response headers"
                value={draft.headers}
                onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
              />
            </label>
            <Button type="submit" size="sm">
              {selected ? "Save settings" : "Create mock"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                if (discard()) setDraft(null);
              }}
            >
              Cancel
            </Button>
          </fieldset>
        </form>
      ) : (
        selected && (
          <section className="space-y-3 rounded border p-2">
            <h3 className="font-medium">{selected.name}</h3>
            <Input
              aria-label="Mock endpoint"
              readOnly
              value={`${window.location.origin}/mock/${selected.id}`}
            />
            <p>
              Append the original API path and query to this URL. Snapshot revision {selected.revision} ·{" "}
              {selected.routeCount} examples.
            </p>
            <p className="text-muted-foreground">
              Snapshots change only when refreshed. No request scripts run; failure simulations are fixed
              rules. Logs retain matched templates and status, without incoming query values, headers or
              bodies.
            </p>
            <MockScenarios
              mock={selected}
              busy={busy}
              onChanged={(updated) => {
                setSelected(updated);
                void refresh();
              }}
            />
            <div className="flex flex-wrap gap-2">
              {selected.canEdit && (
                <>
                  <Button size="sm" disabled={busy} onClick={() => edit(selected)}>
                    Edit settings
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await call(`/api/mocks/${selected.id}/refresh`, "POST");
                        await load(selected.id);
                        await refresh();
                      })
                    }
                  >
                    Refresh examples
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("Rotate mock key? Clients using the old key will stop working."))
                        void action(async () =>
                          setKey((await call<{ key: string }>(`/api/mocks/${selected.id}/key`, "POST")).key),
                        );
                    }}
                  >
                    Rotate key
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const data = await call(`/api/mocks/${selected.id}/export`);
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
                    );
                    const anchor = document.createElement("a");
                    anchor.href = url;
                    anchor.download = "mock.postbox.json";
                    anchor.click();
                    URL.revokeObjectURL(url);
                  })
                }
              >
                Export mock
              </Button>
            </div>
            <div className="space-y-1">
              {selected.routes.map((route, index) => (
                <div key={`${route.requestId}:${route.id}:${index}`} className="rounded border p-2">
                  <code>
                    {route.method} {route.path}
                  </code>
                  <p>
                    {route.status} · {route.name}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => useDialogs.getState().openExamples(route.requestId)}
                  >
                    Source examples
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void action(() => load(selected.id))}
              >
                Refresh request log
              </Button>
              {selected.canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await call(`/api/mocks/${selected.id}/logs`, "DELETE");
                      setLogs([]);
                    })
                  }
                >
                  Clear log
                </Button>
              )}
            </div>
            {!logs.length && <p className="text-muted-foreground">No retained requests.</p>}
            {logs.map((log) => (
              <p key={log.id} className="break-all font-mono">
                {log.method} {log.path} · {log.status} · {log.durationMs} ms ·{" "}
                {new Date(log.createdAt).toLocaleString()}
              </p>
            ))}
            {selected.canEdit && (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Delete this mock endpoint and its logs?"))
                    void action(async () => {
                      await call(`/api/mocks/${selected.id}`, "DELETE");
                      setSelected(null);
                      setKey("");
                      setLogs([]);
                      await refresh();
                    });
                }}
              >
                Delete mock
              </Button>
            )}
          </section>
        )
      )}
    </div>
  );
}
