"use client";
import { useEffect, useState } from "react";
import type { ScriptPackageSummary } from "@/core/packages/model";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { Button } from "@/components/ui/button";
export function PackageList() {
  const workspaceId = useApp((s) => s.workspaceId),
    revision = useApp((s) => s.packageVersion);
  const [rows, setRows] = useState<ScriptPackageSummary[]>([]),
    [libraries, setLibraries] = useState<
      { name: string; version: string; specifier: string; license: string }[]
    >([]),
    [error, setError] = useState("");
  useEffect(() => {
    if (!workspaceId) return;
    const abort = new AbortController();
    fetch(`/api/script-packages?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: abort.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setRows(result.packages);
        setLibraries(result.libraries);
        setError("");
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      });
    return () => abort.abort();
  }, [workspaceId, revision]);
  return (
    <div className="h-full space-y-3 overflow-auto p-3 text-xs">
      <div className="flex items-center justify-between">
        <strong>Script packages</strong>
        <Button
          size="sm"
          variant="outline"
          disabled={!workspaceId}
          onClick={() => workspaceId && useDialogs.getState().openScriptPackage({ workspaceId, id: null })}
        >
          New package
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <p className="text-muted-foreground">
        Share versioned scripts across collections. Only owner-approved versions can run.
      </p>
      {rows
        .filter((row) => row.workspaceId === workspaceId)
        .map((row) => (
          <button
            key={row.id}
            className="block w-full rounded border p-2 text-left hover:bg-accent"
            onClick={() =>
              useDialogs.getState().openScriptPackage({ workspaceId: row.workspaceId, id: row.id })
            }
          >
            <strong className="block truncate">{row.name}</strong>
            <span>
              v{row.latestVersion} · {row.approved ? "Approved" : "Needs approval"}
            </span>
          </button>
        ))}
      <h3 className="font-medium">Approved bundled libraries</h3>
      {libraries.map((library) => (
        <div key={library.specifier} className="rounded border p-2">
          <code className="break-all">{library.specifier}</code>
          <p className="text-muted-foreground">{library.license} · bundled locally</p>
        </div>
      ))}
      <p className="text-muted-foreground">
        Use pm.require with a pinned specifier. No remote installs or host modules are available.
      </p>
    </div>
  );
}
