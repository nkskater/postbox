"use client";
/**
 * Import Postman collections/environments, OpenAPI/Swagger specs (file, text or link)
 * and cURL commands (opened as a new request tab).
 *
 * Multi-file imports track per-file outcomes, always refresh persisted sidebar state
 * when at least one file in a batch succeeds, surface a batch outcome summary on
 * partial/full failure, and allow retrying only the failed files without duplicating
 * already-imported files.
 */
import { useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileUp, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useApp, type RequestDraft } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { parseCurl } from "@/core/convert/curl";
import { paramsFromUrl } from "@/lib/url-params";
import { DEFAULT_SETTINGS } from "@/core/types";

export interface Outcome {
  kind: "collection" | "environment" | "globals";
  name?: string;
  requests?: number;
  variables?: number;
}

export interface FileImportLike {
  name: string;
  text: () => Promise<string>;
}

export interface FileImportEntry {
  file: FileImportLike;
  name: string;
  status: "succeeded" | "failed";
  summary?: string;
  error?: string;
  /** True when the file was persisted on the server (requiring a sidebar/store refresh). */
  persisted: boolean;
}

export interface BatchImportSummary {
  total: number;
  succeeded: number;
  failed: number;
  entries: FileImportEntry[];
}

export interface ImportDialogState {
  open: boolean;
  text: string;
  link: string;
  busy: boolean;
  drag: boolean;
  batchSummary: BatchImportSummary | null;
  textError: string | null;
  linkError: string | null;
}

export interface ImportControllerDeps {
  getWorkspaceId: () => string | null;
  refreshTree: () => Promise<void>;
  refreshEnvironments: () => Promise<void>;
  refreshVariables: () => Promise<void>;
  openDraft: (partial?: Partial<RequestDraft>) => void;
  setDialogOpen: (open: boolean) => void;
  fetchImpl?: typeof fetch;
  toastImpl?: {
    success: (message: string) => unknown;
    error: (message: string) => unknown;
  };
  onStateChange?: (state: ImportDialogState) => void;
}

export function formatOutcomeSummary(o: Outcome): string {
  if (o.kind === "collection") {
    return `Imported collection "${o.name}" (${o.requests} requests)`;
  }
  if (o.kind === "environment") {
    return `Imported environment "${o.name}" (${o.variables} variables)`;
  }
  return `Imported ${o.variables} global variables`;
}

/**
 * Stateful controller for ImportDialog workflows (multi-file batches, partial failure
 * recovery, retry-failed-only, text/cURL paste, link import, and busy concurrency lock).
 */
export function createImportController(
  deps: ImportControllerDeps,
  initial: Partial<ImportDialogState> = {},
) {
  const fetchFn = deps.fetchImpl ?? fetch;
  const notify = deps.toastImpl ?? toast;

  let state: ImportDialogState = {
    open: initial.open ?? false,
    text: initial.text ?? "",
    link: initial.link ?? "",
    busy: false,
    drag: false,
    batchSummary: initial.batchSummary ?? null,
    textError: initial.textError ?? null,
    linkError: initial.linkError ?? null,
  };
  let inFlight = false;

  const emit = (patch: Partial<ImportDialogState>) => {
    state = { ...state, ...patch };
    deps.onStateChange?.(state);
  };

  const refreshPersistedState = async () => {
    await Promise.all([deps.refreshTree(), deps.refreshEnvironments(), deps.refreshVariables()]);
  };

  const sendImportRequest = async (body: Record<string, string>): Promise<Outcome> => {
    const res = await fetchFn("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: deps.getWorkspaceId(), ...body }),
    });
    let data: (Partial<Outcome> & { error?: string }) | null = null;
    try {
      data = (await res.json()) as Partial<Outcome> & { error?: string };
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new Error(data?.error || `Import failed (${res.status})`);
    }
    if (!data || !data.kind) {
      throw new Error("Invalid import response");
    }
    return data as Outcome;
  };

  const importCurlContent = (cmd: string): string => {
    const trimmed = cmd.trim();
    const r = parseCurl(trimmed);
    if (!r.url || !/^https?:\/\//i.test(r.url)) {
      throw new Error("cURL command is missing a valid URL");
    }
    const name = r.url.replace(/^https?:\/\//, "").slice(0, 60) || "cURL request";
    deps.openDraft({
      name,
      method: r.method,
      url: r.url,
      params: paramsFromUrl(r.url),
      headers: r.headers,
      body: r.body,
      auth: r.auth,
      settings: { ...DEFAULT_SETTINGS, verifySsl: !r.insecure },
    });
    return "cURL command opened in a new tab";
  };

  const resetAndClose = () => {
    emit({
      open: false,
      text: "",
      link: "",
      drag: false,
      batchSummary: null,
      textError: null,
      linkError: null,
    });
    deps.setDialogOpen(false);
  };

  /**
   * Execute a list of files sequentially, preserving prior succeeded entries when retrying
   * only failed files.
   */
  const runFileBatch = async (
    filesToRun: FileImportLike[],
    preservedEntries: FileImportEntry[] = [],
  ): Promise<BatchImportSummary | null> => {
    if (inFlight || state.busy) return null;
    if (filesToRun.length === 0) return null;

    inFlight = true;
    emit({ busy: true, drag: false });

    const newEntries: FileImportEntry[] = [];
    let anyNewlyPersisted = false;

    try {
      for (const file of filesToRun) {
        try {
          const content = await file.text();
          if (!content.trim()) {
            throw new Error("File is empty");
          }
          if (/^\s*curl(?:\s|$)/i.test(content)) {
            const summary = importCurlContent(content);
            notify.success(summary);
            newEntries.push({
              file,
              name: file.name,
              status: "succeeded",
              summary,
              persisted: false,
            });
          } else {
            const outcome = await sendImportRequest({ content });
            const summary = formatOutcomeSummary(outcome);
            notify.success(summary);
            anyNewlyPersisted = true;
            newEntries.push({
              file,
              name: file.name,
              status: "succeeded",
              summary,
              persisted: true,
            });
          }
        } catch (err) {
          const message = (err as Error)?.message || "Import failed";
          newEntries.push({
            file,
            name: file.name,
            status: "failed",
            error: message,
            persisted: false,
          });
        }
      }

      // Always refresh persisted state if at least one server-persisted file succeeded,
      // even if a subsequent file in the same batch failed.
      if (anyNewlyPersisted) {
        await refreshPersistedState();
      }

      const combinedEntries = [...preservedEntries, ...newEntries];
      const succeeded = combinedEntries.filter((e) => e.status === "succeeded").length;
      const failedEntries = newEntries.filter((e) => e.status === "failed");
      const failed = failedEntries.length;
      const summary: BatchImportSummary = {
        total: combinedEntries.length,
        succeeded,
        failed,
        entries: combinedEntries,
      };

      if (failed === 0) {
        resetAndClose();
      } else {
        emit({ batchSummary: summary });
        if (filesToRun.length === 1 && preservedEntries.length === 0) {
          notify.error(failedEntries[0].error || "Import failed");
        } else {
          notify.error(
            `Imported ${newEntries.length - failed} of ${filesToRun.length} files (${failed} failed)`,
          );
        }
      }

      return summary;
    } finally {
      inFlight = false;
      emit({ busy: false });
    }
  };

  return {
    getState: () => state,

    setText: (text: string) => {
      if (inFlight || state.busy) return;
      emit({ text, textError: null });
    },

    setLink: (link: string) => {
      if (inFlight || state.busy) return;
      emit({ link, linkError: null });
    },

    setDrag: (drag: boolean) => {
      if (inFlight || state.busy) return;
      emit({ drag });
    },

    clearBatchSummary: () => {
      if (inFlight || state.busy) return;
      emit({ batchSummary: null });
    },

    handleOpenChange: (nextOpen: boolean) => {
      if (inFlight || state.busy) return false;
      if (!nextOpen) {
        emit({
          open: false,
          drag: false,
          batchSummary: null,
          textError: null,
          linkError: null,
        });
      } else {
        emit({ open: true });
      }
      deps.setDialogOpen(nextOpen);
      return true;
    },

    importFiles: async (files: FileList | FileImportLike[] | null | undefined) => {
      if (!files) return null;
      const list = Array.from(files);
      if (list.length === 0) return null;
      return runFileBatch(list, []);
    },

    retryFailedFiles: async () => {
      const currentSummary = state.batchSummary;
      if (!currentSummary) return null;
      const failedFiles = currentSummary.entries
        .filter((e) => e.status === "failed")
        .map((e) => e.file);
      if (failedFiles.length === 0) return null;
      const succeededEntries = currentSummary.entries.filter((e) => e.status === "succeeded");
      return runFileBatch(failedFiles, succeededEntries);
    },

    importText: async () => {
      if (inFlight || state.busy) return false;
      const raw = state.text;
      if (!raw.trim()) return false;

      inFlight = true;
      emit({ busy: true, textError: null });
      try {
        if (/^\s*curl(?:\s|$)/i.test(raw)) {
          const summary = importCurlContent(raw);
          notify.success(summary);
        } else {
          const outcome = await sendImportRequest({ content: raw });
          notify.success(formatOutcomeSummary(outcome));
          await refreshPersistedState();
        }
        resetAndClose();
        return true;
      } catch (err) {
        const message = (err as Error)?.message || "Import failed";
        emit({ textError: message });
        notify.error(message);
        return false;
      } finally {
        inFlight = false;
        emit({ busy: false });
      }
    },

    importLink: async () => {
      if (inFlight || state.busy) return false;
      const rawUrl = state.link.trim();
      if (!rawUrl) return false;

      inFlight = true;
      emit({ busy: true, linkError: null });
      try {
        const outcome = await sendImportRequest({ url: rawUrl });
        notify.success(formatOutcomeSummary(outcome));
        await refreshPersistedState();
        resetAndClose();
        return true;
      } catch (err) {
        const message = (err as Error)?.message || "Import failed";
        emit({ linkError: message });
        notify.error(message);
        return false;
      } finally {
        inFlight = false;
        emit({ busy: false });
      }
    },
  };
}

export function ImportDialog() {
  const open = useDialogs((s) => s.importOpen);
  const setOpen = useDialogs((s) => s.setImportOpen);
  const { workspaceId, refreshTree, refreshEnvironments, refreshVariables, openDraft } = useApp();

  const [uiState, setUiState] = useState<ImportDialogState>(() => ({
    open,
    text: "",
    link: "",
    busy: false,
    drag: false,
    batchSummary: null,
    textError: null,
    linkError: null,
  }));

  const latestDepsRef = useRef({
    workspaceId,
    refreshTree,
    refreshEnvironments,
    refreshVariables,
    openDraft,
    setOpen,
  });

  const controllerRef = useRef<ReturnType<typeof createImportController> | null>(null);
  const getController = () => {
    latestDepsRef.current = {
      workspaceId,
      refreshTree,
      refreshEnvironments,
      refreshVariables,
      openDraft,
      setOpen,
    };
    if (!controllerRef.current) {
      controllerRef.current = createImportController({
        getWorkspaceId: () => latestDepsRef.current.workspaceId,
        refreshTree: () => latestDepsRef.current.refreshTree(),
        refreshEnvironments: () => latestDepsRef.current.refreshEnvironments(),
        refreshVariables: () => latestDepsRef.current.refreshVariables(),
        openDraft: (partial) => latestDepsRef.current.openDraft(partial),
        setDialogOpen: (next) => latestDepsRef.current.setOpen(next),
        onStateChange: (nextState) => setUiState(nextState),
      });
    }
    return controllerRef.current;
  };

  const { text, link, busy, drag, batchSummary, textError, linkError } = uiState;

  return (
    <Dialog open={open} onOpenChange={(next) => getController().handleOpenChange(next)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import</DialogTitle>
          <DialogDescription>
            Postman collection (v2.0/v2.1) or environment, OpenAPI 3 / Swagger 2 (JSON or YAML), or a cURL
            command.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="file">
          <TabsList>
            <TabsTrigger value="file" disabled={busy}>
              File
            </TabsTrigger>
            <TabsTrigger value="text" disabled={busy}>
              Raw text / cURL
            </TabsTrigger>
            <TabsTrigger value="link" disabled={busy}>
              Link
            </TabsTrigger>
          </TabsList>
          <TabsContent value="file" className="space-y-3">
            <label
              aria-disabled={busy}
              onDragOver={(e) => {
                e.preventDefault();
                if (!busy) getController().setDrag(true);
              }}
              onDragLeave={() => {
                if (!busy) getController().setDrag(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (busy) return;
                getController().setDrag(false);
                void getController().importFiles(e.dataTransfer.files);
              }}
              className={`flex h-44 flex-col items-center justify-center gap-2 rounded-md border border-dashed text-muted-foreground ${
                busy
                  ? "cursor-not-allowed opacity-60"
                  : drag
                    ? "cursor-pointer border-primary bg-primary/5"
                    : "cursor-pointer hover:border-primary"
              }`}
            >
              {busy ? <Loader2 className="size-6 animate-spin" /> : <FileUp className="size-6" />}
              <span>{busy ? "Importing files…" : "Drop files here or click to choose"}</span>
              <span className="text-xs">.json, .yaml, .yml, .txt (multiple allowed)</span>
              <input
                type="file"
                multiple
                disabled={busy}
                accept=".json,.yaml,.yml,.txt,.sh"
                className="hidden"
                onChange={(e) => {
                  const selected = e.currentTarget.files ? Array.from(e.currentTarget.files) : [];
                  // Reset input value so re-selecting a corrected version of the same file fires onChange.
                  e.currentTarget.value = "";
                  if (!busy && selected.length > 0) {
                    void getController().importFiles(selected);
                  }
                }}
              />
            </label>

            {batchSummary && (
              <div
                role="region"
                aria-label="Batch import summary"
                className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    Imported {batchSummary.succeeded} of {batchSummary.total}{" "}
                    {batchSummary.total === 1 ? "file" : "files"}
                    {batchSummary.failed > 0 ? ` (${batchSummary.failed} failed)` : ""}
                  </span>
                  <div className="flex items-center gap-2">
                    {batchSummary.failed > 0 && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void getController().retryFailedFiles()}
                      >
                        {busy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="size-3.5" />
                        )}
                        Retry failed ({batchSummary.failed})
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => getController().clearBatchSummary()}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
                <ul className="max-h-36 space-y-1 overflow-y-auto">
                  {batchSummary.entries.map((entry, idx) => (
                    <li
                      key={`${entry.name}-${idx}`}
                      className="flex items-start justify-between gap-2 rounded px-1.5 py-1"
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        {entry.status === "succeeded" ? (
                          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                        ) : (
                          <AlertCircle className="size-3.5 shrink-0 text-destructive" />
                        )}
                        <span className="truncate font-mono">{entry.name}</span>
                      </div>
                      <span
                        className={`truncate ${
                          entry.status === "succeeded" ? "text-muted-foreground" : "text-destructive"
                        }`}
                      >
                        {entry.status === "succeeded" ? entry.summary : entry.error}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </TabsContent>
          <TabsContent value="text" className="space-y-2">
            <Textarea
              className="h-56 font-mono text-xs"
              disabled={busy}
              placeholder={
                "curl https://api.example.com/users -H 'Accept: application/json'\n\n— or paste Postman / OpenAPI JSON or YAML —"
              }
              value={text}
              onChange={(e) => getController().setText(e.target.value)}
            />
            {textError && <p className="text-xs text-destructive">{textError}</p>}
            <div className="flex justify-end">
              <Button
                disabled={!text.trim() || busy}
                onClick={() => void getController().importText()}
              >
                {busy && <Loader2 className="size-4 animate-spin" />} Import
              </Button>
            </div>
          </TabsContent>
          <TabsContent value="link" className="space-y-2">
            <Input
              placeholder="https://petstore3.swagger.io/api/v3/openapi.json"
              disabled={busy}
              value={link}
              onChange={(e) => getController().setLink(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The file is fetched by the Postbox server, so it can reach hosts on your network.
            </p>
            {linkError && <p className="text-xs text-destructive">{linkError}</p>}
            <div className="flex justify-end">
              <Button
                disabled={!link.trim() || busy}
                onClick={() => void getController().importLink()}
              >
                {busy && <Loader2 className="size-4 animate-spin" />} Import
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
