"use client";
import { useEffect, useState } from "react";
import type { DatasetSummary } from "@/core/types";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { Button } from "@/components/ui/button";
export function DatasetList() {
  const workspaceId = useApp((s) => s.workspaceId);
  const revision = useApp((s) => s.datasetVersion);
  const [rows, setRows] = useState<DatasetSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!workspaceId) return;
    const abort = new AbortController();
    api.datasets
      .list(workspaceId, abort.signal)
      .then((rows) => {
        setRows(rows);
        setError("");
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setRows([]);
          setError(error.message);
        }
      });
    return () => abort.abort();
  }, [workspaceId, revision]);
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Datasets</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={!workspaceId}
          onClick={() => workspaceId && useDialogs.getState().openDataset({ workspaceId, id: null })}
        >
          New dataset
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!rows.length && !error && (
        <p className="text-muted-foreground">Save iteration data to reuse in runs and schedules.</p>
      )}
      {rows
        .filter((row) => row.workspaceId === workspaceId)
        .map((row) => (
          <button
            className="block w-full rounded border p-2 text-left hover:bg-accent"
            key={row.id}
            onClick={() => useDialogs.getState().openDataset({ workspaceId: row.workspaceId, id: row.id })}
          >
            <span className="block truncate font-medium">{row.name}</span>
            <span className="text-muted-foreground">
              v{row.latestVersion} · {row.rows} rows · {row.columns.length} columns
              {row.missingSecrets ? " · Needs secrets" : ""}
            </span>
          </button>
        ))}
    </div>
  );
}
