"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { ExampleRequest, ResponseExample } from "@/core/types";
import { responseExampleSchema, exampleCommandSchema } from "@/core/schemas";
import { exampleRequest, requestFromExample, sanitizeExample, validateExamples } from "@/core/examples";
import { api, type SavedRequest } from "@/lib/api";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { KeyValueEditor } from "@/components/request/KeyValueEditor";
import { BodyEditor } from "@/components/request/BodyEditor";
import { paramsFromUrl, urlWithParams } from "@/lib/url-params";

const clone = <T,>(value: T): T => structuredClone(value);
function blank(request: SavedRequest): ResponseExample {
  return sanitizeExample({
    id: crypto.randomUUID(),
    name: "New example",
    status: 200,
    statusText: "OK",
    headers: [],
    body: "",
    createdAt: Date.now(),
    originalRequest: exampleRequest(request),
  });
}
export function ExamplesDialog() {
  const requestId = useDialogs((state) => state.exampleRequestId);
  const workspaceId = useApp((state) => state.workspaceId);
  return requestId ? <ExampleEditor key={`${workspaceId}:${requestId}`} requestId={requestId} /> : null;
}
function ExampleEditor({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<SavedRequest | null>(null);
  const [examples, setExamples] = useState<ResponseExample[]>([]);
  const [version, setVersion] = useState("");
  const [draft, setDraft] = useState<ResponseExample | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const dirty = !!draft && (baseline === null || JSON.stringify(draft) !== baseline);
  const saved = !!draft && examples.some((example) => example.id === draft.id);
  const select = useCallback((example: ResponseExample | null) => {
    setDraft(example ? clone(example) : null);
    setBaseline(example ? JSON.stringify(example) : null);
  }, []);
  const mayDiscard = () => !dirty || window.confirm("Discard unsaved example changes?");
  const close = () => {
    if (!pending && mayDiscard()) useDialogs.getState().openExamples(null);
  };
  const fetchExamples = useCallback(
    () => Promise.all([api.requests.get(requestId), api.examples.list(requestId)]),
    [requestId],
  );
  const applyLoaded = useCallback(
    ([parent, result]: Awaited<ReturnType<typeof fetchExamples>>) => {
      setError(null);
      setRequest(parent);
      setExamples(result.examples);
      setVersion(result.version);
      select(result.examples[0] ?? null);
      useApp.getState().onExamplesChanged(requestId, result.examples);
    },
    [requestId, select],
  );
  const load = async () => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    try {
      applyLoaded(await fetchExamples());
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load examples");
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  useEffect(() => {
    let active = true;
    lock.current = true;
    fetchExamples()
      .then((result) => {
        if (active) applyLoaded(result);
      })
      .catch((error) => {
        if (active) setError(error instanceof Error ? error.message : "Could not load examples");
      })
      .finally(() => {
        if (active) {
          lock.current = false;
          setPending(false);
        }
      });
    return () => {
      active = false;
    };
  }, [fetchExamples, applyLoaded]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  const change = async (mutation: z.input<typeof exampleCommandSchema>["mutation"]): Promise<boolean> => {
    if (lock.current || pending) return false;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await api.examples.change(requestId, { expectedVersion: version, mutation });
      setExamples(result.examples);
      setVersion(result.version);
      const selected =
        result.example ??
        result.examples.find((example) => example.id === draft?.id) ??
        result.examples[0] ??
        null;
      select(selected);
      useApp.getState().onExamplesChanged(requestId, result.examples);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update examples");
      return false;
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  const save = async () => {
    if (!draft) return;
    try {
      const parsed = validateExamples([
        responseExampleSchema.parse({
          ...draft,
          headers: draft.headers.filter((header) => header.key.trim()),
        }),
      ])[0];
      const { id: _id, createdAt: _createdAt, ...fields } = parsed;
      await change(
        saved
          ? { action: "update", exampleId: draft.id, changes: fields }
          : { action: "create", example: fields },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid example");
    }
  };
  const patch = (fields: Partial<ResponseExample>) =>
    !pending && setDraft((current) => (current ? { ...current, ...fields } : null));
  const original = draft?.originalRequest ?? (request ? blank(request).originalRequest : undefined);
  const patchRequest = (fields: Partial<ExampleRequest>) => {
    if (original) patch({ originalRequest: { ...original, ...fields } });
  };
  const move = (offset: number) => {
    if (!draft) return;
    const ids = examples.map((example) => example.id),
      index = ids.indexOf(draft.id),
      target = index + offset;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void change({ action: "reorder", exampleIds: ids });
  };
  const tryRequest = () => {
    if (!draft || !request || pending) return;
    if (dirty && !window.confirm("Open this request in a new tab? Unsaved example edits will be discarded."))
      return;
    const template = requestFromExample(draft, request);
    useDialogs.getState().openExamples(null);
    useApp.getState().openDraft({
      ...template,
      name: draft.name,
      folderId: request.folderId,
      preRequestScript: "",
      testScript: "",
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-5xl"
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Saved examples{request ? ` — ${request.name}` : ""}</DialogTitle>
          <DialogDescription>
            Edit paired request templates and responses. Credentials and upload bytes are omitted from example
            snapshots. Trying an example opens a request tab without sending it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={pending || !request}
            onClick={() => {
              if (request && mayDiscard()) {
                setDraft(blank(request));
                setBaseline(null);
                setError(null);
              }
            }}
          >
            Create example
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (mayDiscard()) {
                setPending(true);
                void load();
              }
            }}
          >
            Reload examples
          </Button>
        </div>
        {error && (
          <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">
            {error}
          </p>
        )}
        {pending && (
          <p role="status" className="text-xs text-muted-foreground">
            Loading examples…
          </p>
        )}
        <div className="grid min-h-0 gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Saved example list" className="space-y-1 rounded border p-2">
            {!examples.length && (
              <p className="p-2 text-xs text-muted-foreground">
                No saved examples. Create one or save a response from the request editor.
              </p>
            )}
            {examples.map((example) => (
              <button
                key={example.id}
                disabled={pending}
                aria-current={draft?.id === example.id ? "true" : undefined}
                className={`block w-full rounded px-2 py-2 text-left text-xs ${draft?.id === example.id ? "bg-muted" : "hover:bg-muted/50"}`}
                onClick={() => {
                  if (mayDiscard()) {
                    select(example);
                    setError(null);
                  }
                }}
              >
                <span className="block truncate font-medium">{example.name}</span>
                <span className="text-muted-foreground">
                  {example.status} {example.statusText}
                </span>
              </button>
            ))}
          </nav>
          {draft && original ? (
            <section aria-label="Example editor" className="min-w-0 space-y-3">
              <label className="block space-y-1 text-xs">
                Example name
                <Input
                  aria-label="Example name"
                  value={draft.name}
                  maxLength={300}
                  disabled={pending}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={pending || !dirty} onClick={() => void save()}>
                  Save example
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={tryRequest}>
                  Try request
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !saved || dirty}
                  onClick={() => void change({ action: "duplicate", exampleId: draft.id })}
                >
                  Duplicate example
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !saved || dirty || examples[0]?.id === draft.id}
                  onClick={() => move(-1)}
                >
                  Move up
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !saved || dirty || examples.at(-1)?.id === draft.id}
                  onClick={() => move(1)}
                >
                  Move down
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={pending || !saved}
                  onClick={() => {
                    if (window.confirm(`Delete example "${draft.name}"? Unsaved edits will be discarded.`))
                      void change({ action: "delete", exampleId: draft.id });
                  }}
                >
                  Delete example
                </Button>
                {dirty && (
                  <span role="status" className="text-xs text-amber-500">
                    Unsaved example changes
                  </span>
                )}
              </div>
              <details open className="rounded border p-3">
                <summary className="cursor-pointer text-sm font-medium">Request template</summary>
                {!draft.originalRequest && (
                  <p className="my-2 text-xs text-muted-foreground">
                    This older example has no saved request snapshot. The current parent request is shown;
                    editing the request fields will capture it.
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <Input
                    aria-label="Example request method"
                    className="w-28"
                    disabled={pending}
                    value={original.method}
                    onChange={(e) => patchRequest({ method: e.target.value.toUpperCase() })}
                  />
                  <Input
                    aria-label="Example request URL"
                    disabled={pending}
                    value={original.url}
                    onChange={(e) =>
                      patchRequest({
                        url: e.target.value,
                        params: paramsFromUrl(e.target.value, original.params),
                      })
                    }
                  />
                </div>
                <fieldset disabled={pending} className="mt-3 space-y-3">
                  <div>
                    <p className="mb-1 text-xs font-medium">Query parameters</p>
                    <KeyValueEditor
                      rows={original.params}
                      onChange={(params) =>
                        patchRequest({ params, url: urlWithParams(original.url, params) })
                      }
                      showDescription
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium">Request headers</p>
                    <KeyValueEditor
                      rows={original.headers}
                      onChange={(headers) => patchRequest({ headers })}
                      showDescription
                    />
                  </div>
                  <div className="h-64">
                    <p className="mb-1 text-xs font-medium">Request body</p>
                    <BodyEditor body={original.body} onChange={(body) => patchRequest({ body })} />
                  </div>
                </fieldset>
              </details>
              <section aria-label="Example response" className="space-y-3 rounded border p-3">
                <h3 className="text-sm font-medium">Response</h3>
                <div className="flex gap-2">
                  <label className="block space-y-1 text-xs">
                    Status code
                    <Input
                      aria-label="Example status code"
                      type="number"
                      min={100}
                      max={599}
                      className="w-28"
                      value={draft.status}
                      disabled={pending}
                      onChange={(e) => patch({ status: Number(e.target.value) })}
                    />
                  </label>
                  <label className="block flex-1 space-y-1 text-xs">
                    Status text
                    <Input
                      aria-label="Example status text"
                      value={draft.statusText}
                      disabled={pending}
                      onChange={(e) => patch({ statusText: e.target.value })}
                    />
                  </label>
                </div>
                <fieldset disabled={pending}>
                  <legend className="mb-1 text-xs font-medium">Response headers</legend>
                  <KeyValueEditor
                    rows={draft.headers}
                    onChange={(headers) => patch({ headers })}
                    showDescription
                  />
                </fieldset>
                <label className="block space-y-1 text-xs">
                  Body encoding
                  <select
                    aria-label="Example response encoding"
                    className="block rounded border bg-background p-2"
                    value={draft.bodyEncoding ?? "utf8"}
                    disabled={pending}
                    onChange={(e) =>
                      patch({ bodyEncoding: e.target.value as "utf8" | "base64", bodyOmitted: undefined })
                    }
                  >
                    <option value="utf8">UTF-8 text</option>
                    <option value="base64">Base64 binary</option>
                  </select>
                </label>
                <Textarea
                  aria-label="Example response body"
                  className="h-52 font-mono text-xs"
                  value={draft.body}
                  disabled={pending}
                  onChange={(e) => patch({ body: e.target.value, bodyOmitted: undefined })}
                />
                {draft.bodyOmitted && (
                  <p className="text-xs text-amber-500">
                    Binary response content was omitted because it contained recognized sensitive values.
                  </p>
                )}
                {draft.truncated && (
                  <p className="text-xs text-amber-500">
                    This response snapshot was truncated by the request capture limit.
                  </p>
                )}
              </section>
            </section>
          ) : (
            <p className="py-6 text-sm text-muted-foreground">
              Select or create an example to view its request and response.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
