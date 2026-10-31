"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DataTable, DatasetDocument, DatasetVersionInfo } from "@/core/types";
import {
  DATASET_LIMITS,
  parseDatasetImport,
  suggestedSecretColumns,
  validateDataset,
} from "@/core/runner/datasets";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DataGrid } from "@/components/runner/DataGrid";
import { DatasetPreview } from "@/components/runner/DatasetPicker";

interface Draft {
  name: string;
  description: string;
  table: DataTable;
  secretColumns: string[];
  missingSecrets: boolean;
}
const blank = (): Draft => ({
  name: "New dataset",
  description: "",
  table: { columns: ["value"], rows: [{ value: "" }] },
  secretColumns: [],
  missingSecrets: false,
});
export function DatasetEditorDialog() {
  const target = useDialogs((s) => s.datasetEditor);
  return target ? <DatasetEditor key={`${target.workspaceId}:${target.id ?? "new"}`} {...target} /> : null;
}
function DatasetEditor({ id, workspaceId }: { id: string | null; workspaceId: string }) {
  const [document, setDocument] = useState<
    | (DatasetDocument & {
        references?: { schedules: { id: string; name: string }[]; runs: { id: string; name: string }[] };
      })
    | null
  >(null);
  const [versions, setVersions] = useState<DatasetVersionInfo[]>([]);
  const [draft, setDraft] = useState<Draft | null>(() => (id ? null : blank()));
  const [baseline, setBaseline] = useState(() => (id ? "" : JSON.stringify(blank())));
  const [pendingHeader, setPendingHeader] = useState(false);
  const [filter, setFilter] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const [exportSecrets, setExportSecrets] = useState(false);
  const [busy, setBusy] = useState(!!id);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const lock = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const activeWorkspace = useApp((s) => s.workspaceId);
  const dirty = !!draft && (pendingHeader || JSON.stringify(draft) !== baseline);
  const mayDiscard = () => !dirty || window.confirm("Discard unsaved dataset changes?");
  const close = () => {
    if (!busy && mayDiscard()) useDialogs.getState().openDataset(null);
  };
  const load = useCallback(
    async (version?: number) => {
      if (!id) return;
      const [document, versions] = await Promise.all([
        api.datasets.get(id, { version, previewRows: 5 }),
        api.datasets.versions(id),
      ]);
      setDocument(document);
      setVersions(versions);
      setDraft(null);
      setPendingHeader(false);
      setWarnings([]);
      setShowSecrets(false);
      setExportSecrets(false);
      setError("");
    },
    [id],
  );
  useEffect(() => {
    if (!id) return;
    let active = true;
    const abort = new AbortController();
    Promise.all([
      api.datasets.get(id, { previewRows: 5 }, abort.signal),
      api.datasets.versions(id, abort.signal),
    ])
      .then(([document, versions]) => {
        if (active) {
          setDocument(document);
          setVersions(versions);
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [id]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  const act = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const edit = () =>
    act(async () => {
      if (!id || !document) return;
      // Editing is an explicit write-authorized fetch; masked previews are never saved as data.
      const source = await api.datasets.get(id, { version: document.version, includeSecrets: true });
      const draft = {
        name: source.name,
        description: source.description,
        table: source.table,
        secretColumns: source.secretColumns,
        missingSecrets: source.missingSecrets,
      };
      setDocument(source);
      setDraft(draft);
      setBaseline(JSON.stringify(draft));
      setShowSecrets(false);
      setFilter("");
    });
  const changeTable = (table: DataTable | null) => {
    if (!draft) return;
    const next = table ?? { columns: [], rows: [] };
    const secretColumns =
      next.columns.length === draft.table.columns.length
        ? next.columns.filter((_, index) => draft.secretColumns.includes(draft.table.columns[index]))
        : draft.secretColumns.filter((column) => next.columns.includes(column));
    setDraft({ ...draft, table: next, secretColumns });
  };
  const importFile = (file: File) =>
    act(async () => {
      if (!draft) return;
      if (file.size > DATASET_LIMITS.bytes) throw new Error("Dataset import exceeds 20 MiB");
      const { readDataFile, formatIssue } = await import("@/core/runner/data");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let imported: Draft;
      if (/\.json$/i.test(file.name)) {
        const text = new TextDecoder().decode(bytes);
        const raw: unknown = JSON.parse(text);
        const parsed = parseDatasetImport({
          content: text,
          format:
            raw && typeof raw === "object" && "format" in raw && raw.format === "postbox.dataset"
              ? "package"
              : "json",
          name: draft.name,
        });
        imported = {
          name: parsed.name,
          description: parsed.description ?? "",
          table: parsed.table,
          secretColumns: parsed.secretColumns,
          missingSecrets: parsed.missingSecrets,
        };
        setWarnings(parsed.warnings.map(formatIssue));
      } else {
        const parsed = readDataFile(file.name, bytes);
        const secretColumns = suggestedSecretColumns(parsed.table.columns);
        imported = {
          ...draft,
          table: validateDataset(parsed.table, secretColumns),
          secretColumns,
          missingSecrets: false,
        };
        setWarnings(parsed.warnings.map(formatIssue));
      }
      setDraft(imported);
      setFilter("");
      setShowSecrets(false);
    });
  const save = () =>
    act(async () => {
      if (!draft || pendingHeader) return;
      const table = validateDataset(draft.table, draft.secretColumns);
      const result =
        id && document
          ? await api.datasets.revise(id, { ...draft, table, expectedVersion: document.latestVersion })
          : await api.datasets.create(workspaceId, { ...draft, table });
      useApp.getState().datasetsChanged();
      if (id) await load(result.version);
      else useDialogs.getState().openDataset({ id: result.id, workspaceId });
    });
  const download = () =>
    act(async () => {
      if (!id || !document) return;
      const data = await api.datasets.export(id, document.version, exportSecrets);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = `${data.name.replace(/[^a-z0-9_-]/gi, "_")}.postbox.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-5xl"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "s") {
            event.preventDefault();
            event.stopPropagation();
            if (draft && !busy) {
              saveButton.current?.focus();
              requestAnimationFrame(() => saveButton.current?.click());
            }
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{id ? "Saved dataset" : "Create dataset"}</DialogTitle>
          <DialogDescription>
            Version iteration data for collection runs and schedules. Columns are available as variables.
          </DialogDescription>
        </DialogHeader>
        {workspaceId !== activeWorkspace && (
          <p className="text-xs text-muted-foreground">
            This dataset belongs to the workspace in which it was opened.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <fieldset disabled={busy} className="min-h-0 space-y-3 overflow-auto text-sm">
          {document && (
            <div className="flex flex-wrap items-center gap-2">
              <strong>{document.name}</strong>
              <label>
                View version{" "}
                <select
                  aria-label="View dataset version"
                  className="rounded border bg-background p-1"
                  value={document.version}
                  onChange={(e) => {
                    if (mayDiscard()) void act(() => load(Number(e.target.value)));
                  }}
                >
                  {versions.map((version) => (
                    <option key={version.version} value={version.version}>
                      v{version.version} · {new Date(version.createdAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              <span className="text-xs text-muted-foreground">Latest: v{document.latestVersion}</span>
            </div>
          )}
          {draft ? (
            <>
              <label className="block space-y-1">
                Dataset name
                <Input
                  aria-label="Dataset name"
                  maxLength={200}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="block space-y-1">
                Description
                <Textarea
                  aria-label="Dataset description"
                  maxLength={10000}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>
              <label className="block">
                Import CSV, JSON, XLSX or a Postbox dataset package
                <input
                  aria-label="Import dataset file"
                  className="ml-2 max-w-full"
                  type="file"
                  accept=".csv,.tsv,.txt,.json,.xlsx,.xls"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void importFile(file);
                  }}
                />
              </label>
              {warnings.length > 0 && (
                <p role="status" className="whitespace-pre-wrap text-xs text-muted-foreground">
                  {warnings.join("\n")}
                </p>
              )}
              <div className="space-y-2 rounded border p-2">
                <p className="text-xs">
                  Secret columns are masked in previews, logs and results. Exports omit their values unless
                  explicitly included. Saved values share the database&apos;s storage protection.
                </p>
                <div className="flex flex-wrap gap-3">
                  {draft.table.columns.map((column) => (
                    <label key={column} className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={draft.secretColumns.includes(column)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            secretColumns: e.target.checked
                              ? [...draft.secretColumns, column]
                              : draft.secretColumns.filter((c) => c !== column),
                          })
                        }
                      />
                      {column} is secret
                    </label>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={showSecrets}
                    onChange={(e) => setShowSecrets(e.target.checked)}
                  />
                  Show secret values while editing
                </label>
              </div>
              <DataGrid
                table={draft.table}
                onChange={changeTable}
                filter={filter}
                onFilterChange={setFilter}
                allowDownload={false}
                maskedColumns={showSecrets ? [] : draft.secretColumns}
                onPendingChange={setPendingHeader}
              />
              {(draft.missingSecrets || document?.missingSecrets) && (
                <label className="flex items-center gap-2 rounded border p-2 text-xs">
                  <input
                    type="checkbox"
                    checked={!draft.missingSecrets}
                    onChange={(e) => setDraft({ ...draft, missingSecrets: !e.target.checked })}
                  />
                  I have supplied the omitted secret values or intentionally left them blank. This version may
                  run.
                </label>
              )}
              <div className="flex gap-2">
                <Button
                  ref={saveButton}
                  type="button"
                  disabled={!draft.name.trim()}
                  onClick={() => void save()}
                >
                  {id ? "Save new version" : "Create dataset"}
                </Button>
                {id && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      if (mayDiscard()) void act(() => load(document?.version));
                    }}
                  >
                    Cancel editing
                  </Button>
                )}
              </div>
            </>
          ) : (
            document && (
              <>
                {document.description && <p className="whitespace-pre-wrap">{document.description}</p>}
                <DatasetPreview document={document} />
                {document.canEdit && (
                  <Button type="button" onClick={() => void edit()}>
                    Edit as new version
                  </Button>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" variant="outline" onClick={() => void download()}>
                    Export dataset
                  </Button>
                  {document.canEdit && (
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={exportSecrets}
                        onChange={(e) => setExportSecrets(e.target.checked)}
                      />
                      Include secret values in export
                    </label>
                  )}
                </div>
                {document.references?.schedules.length || document.references?.runs.length ? (
                  <p className="text-xs text-muted-foreground">
                    Referenced by{" "}
                    {[...(document.references?.schedules ?? []), ...(document.references?.runs ?? [])]
                      .map((ref) => ref.name)
                      .join(", ")}
                    . Remove schedule references and finish active runs before deleting.
                  </p>
                ) : null}
                {document.canEdit && (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => {
                      if (window.confirm("Delete this dataset and all its versions?"))
                        void act(async () => {
                          await api.datasets.remove(document.id);
                          useApp.getState().datasetsChanged();
                          useDialogs.getState().openDataset(null);
                        });
                    }}
                  >
                    Delete dataset
                  </Button>
                )}
              </>
            )
          )}
        </fieldset>
        {busy && (
          <p role="status" className="text-xs text-muted-foreground">
            Loading…
          </p>
        )}
        <div className="flex justify-end">
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
