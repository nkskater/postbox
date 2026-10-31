"use client";
import { useEffect, useState } from "react";
import type { DatasetDocument, DatasetRef, DatasetSummary, DatasetVersionInfo } from "@/core/types";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { Button } from "@/components/ui/button";

export function DatasetPreview({ document }: { document: DatasetDocument }) {
  return (
    <div className="space-y-2 text-xs">
      <p>
        {document.rows} rows · version {document.version}
        {document.missingSecrets ? " · Secret values must be supplied before running" : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {document.columns.map((column) => (
          <code key={column} className="rounded bg-muted px-1">
            {`{{${column}}}`}
            {document.secretColumns.includes(column) ? " (secret)" : ""}
          </code>
        ))}
      </div>
      <div className="max-h-48 overflow-auto rounded border">
        <table className="w-full text-left">
          <thead>
            <tr>
              {document.columns.map((column) => (
                <th className="border-b p-1" key={column}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {document.table.rows.slice(0, 5).map((row, index) => (
              <tr key={index}>
                {document.columns.map((column) => (
                  <td className="max-w-64 truncate border-b p-1 font-mono" key={column}>
                    {document.secretColumns.includes(column) ? "[REDACTED]" : row[column]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground">
        Preview of the first five rows. Secret values stay on the server during runs.
      </p>
    </div>
  );
}

export function DatasetPicker({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string;
  value: DatasetRef | null;
  onChange: (value: DatasetRef | null) => void;
}) {
  const revision = useApp((s) => s.datasetVersion);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [versions, setVersions] = useState<DatasetVersionInfo[]>([]);
  const [document, setDocument] = useState<DatasetDocument | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    api.datasets
      .list(workspaceId, abort.signal)
      .then(setDatasets)
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      });
    return () => abort.abort();
  }, [workspaceId, revision]);
  useEffect(() => {
    if (!value) return;
    const abort = new AbortController();
    Promise.all([
      api.datasets.get(value.id, { version: value.version, previewRows: 5 }, abort.signal),
      api.datasets.versions(value.id, abort.signal),
    ])
      .then(([document, versions]) => {
        setDocument(document);
        setVersions(versions);
        setError("");
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setDocument(null);
          setError(error.message);
        }
      });
    return () => abort.abort();
  }, [value?.id, value?.version, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-2 rounded border p-2 text-xs">
      <label className="block">
        Saved dataset
        <select
          aria-label="Saved dataset"
          className="mt-1 h-8 w-full rounded border bg-background px-2"
          value={value?.id ?? ""}
          onChange={(e) => {
            setDocument(null);
            setVersions([]);
            setError("");
            onChange(e.target.value ? { id: e.target.value } : null);
          }}
        >
          <option value="">No saved dataset</option>
          {value && !datasets.some((d) => d.id === value.id) && (
            <option value={value.id}>Unavailable dataset</option>
          )}
          {datasets.map((dataset) => (
            <option key={dataset.id} value={dataset.id}>
              {dataset.name} ({dataset.rows} rows)
            </option>
          ))}
        </select>
      </label>
      {value && (
        <label className="block">
          Dataset version
          <select
            aria-label="Dataset version"
            className="mt-1 h-8 w-full rounded border bg-background px-2"
            value={value.version ?? "latest"}
            onChange={(e) => {
              setDocument(null);
              onChange({
                id: value.id,
                ...(e.target.value === "latest" ? {} : { version: Number(e.target.value) }),
              });
            }}
          >
            <option value="latest">Latest when the run starts</option>
            {value.version && !versions.some((v) => v.version === value.version) && (
              <option value={value.version}>Version {value.version}</option>
            )}
            {versions.map((version) => (
              <option key={version.version} value={version.version}>
                Version {version.version} · {version.rows} rows
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {value &&
        document?.id === value.id &&
        (value.version === undefined || document.version === value.version) && (
          <DatasetPreview document={document} />
        )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => useDialogs.getState().openDataset({ workspaceId, id: null })}
        >
          New dataset
        </Button>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => useDialogs.getState().openDataset({ workspaceId, id: value.id })}
          >
            Manage dataset
          </Button>
        )}
      </div>
    </div>
  );
}
