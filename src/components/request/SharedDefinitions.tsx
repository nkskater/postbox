"use client";
/** Shared .proto sets of a workspace: choose one for a request, create, edit and delete them. */
import { useCallback, useEffect, useState } from "react";
import { Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProtoFilesEditor } from "./ProtoFilesEditor";

export interface DefinitionSummary {
  id: string;
  name: string;
  revision: number;
  fileCount: number;
  usedBy: { id: string; name: string }[];
}
interface DefinitionDetail extends DefinitionSummary {
  description: string;
  files: Record<string, string>;
  canEdit: boolean;
}

const STARTER = { "service.proto": 'syntax = "proto3";\n' };

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

/** Save a request's own files as a new shared set. */
export function SaveAsShared({
  workspaceId,
  files,
  onSaved,
}: {
  workspaceId: string;
  files: Record<string, string>;
  onSaved: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  if (!open)
    return (
      <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(true)}>
        Share these files…
      </Button>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          const created = await api<DefinitionDetail>("/api/grpc/definitions", "POST", {
            workspaceId,
            name,
            files,
          });
          setOpen(false);
          setName("");
          onSaved(created.id);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <Input
        aria-label="Shared definition name"
        className="h-7 w-48"
        placeholder="Name for the shared set"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button type="submit" size="sm" className="h-7" disabled={!name.trim()}>
        Save and use it
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && (
        <p role="alert" className="w-full text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export function SharedDefinitionPanel({
  workspaceId,
  definitionId,
  onSelect,
  onChanged,
}: {
  workspaceId: string;
  definitionId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onChanged: () => void;
}) {
  const [list, setList] = useState<DefinitionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<DefinitionDetail | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  const refreshList = useCallback(
    () =>
      api<DefinitionSummary[]>(`/api/grpc/definitions?workspaceId=${encodeURIComponent(workspaceId)}`)
        .then((rows) => {
          setList(rows);
          setLoaded(true);
        })
        .catch((e) => setError((e as Error).message)),
    [workspaceId],
  );
  useEffect(() => {
    void refreshList();
  }, [refreshList, version]);
  useEffect(() => {
    if (!definitionId) return;
    let active = true;
    api<DefinitionDetail>(`/api/grpc/definitions/${encodeURIComponent(definitionId)}`)
      .then((d) => {
        if (!active) return;
        setDetail(d);
        setFiles(d.files);
        setName(d.name);
      })
      .catch((e) => active && setError((e as Error).message));
    return () => {
      active = false;
    };
  }, [definitionId, version]);

  const shown = definitionId && detail?.id === definitionId ? detail : null;
  const dirty = !!shown && (name !== shown.name || JSON.stringify(files) !== JSON.stringify(shown.files));
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-7 min-w-56 rounded-md border bg-transparent px-2 text-xs"
          aria-label="Shared definition"
          value={definitionId ?? ""}
          onChange={(e) => onSelect(e.target.value || undefined)}
        >
          <option value="">
            {!loaded ? "Loading…" : list.length ? "Choose a shared definition" : "No shared definitions yet"}
          </option>
          {loaded && definitionId && !list.some((d) => d.id === definitionId) && (
            <option value={definitionId}>Definition not found (deleted?)</option>
          )}
          {list.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.usedBy.length} {d.usedBy.length === 1 ? "request" : "requests"})
            </option>
          ))}
        </select>
        <Input
          aria-label="New shared definition name"
          className="h-7 w-44"
          placeholder="New definition name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={busy || !newName.trim()}
          onClick={() =>
            void run(async () => {
              const created = await api<DefinitionDetail>("/api/grpc/definitions", "POST", {
                workspaceId,
                name: newName,
                files: STARTER,
              });
              setNewName("");
              setVersion((v) => v + 1);
              onSelect(created.id);
            })
          }
        >
          Create
        </Button>
      </div>

      {shown && (
        <div className="space-y-2 rounded-md border p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Definition name"
              className="h-7 w-56"
              value={name}
              disabled={!shown.canEdit}
              onChange={(e) => setName(e.target.value)}
            />
            <span className="text-muted-foreground">
              revision {shown.revision} ·{" "}
              <span title={shown.usedBy.map((u) => u.name).join(", ")}>
                used by {shown.usedBy.length} {shown.usedBy.length === 1 ? "request" : "requests"}
              </span>
            </span>
            {shown.canEdit && (
              <>
                <Button
                  size="sm"
                  className="ml-auto h-7"
                  disabled={busy || !dirty}
                  onClick={() =>
                    void run(async () => {
                      await api(`/api/grpc/definitions/${shown.id}`, "PATCH", {
                        ...(name !== shown.name ? { name } : {}),
                        ...(JSON.stringify(files) !== JSON.stringify(shown.files) ? { files } : {}),
                      });
                      setVersion((v) => v + 1);
                      onChanged();
                    })
                  }
                >
                  <Save className="size-3.5" /> Save changes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={busy}
                  aria-label="Delete shared definition"
                  onClick={() =>
                    void run(async () => {
                      if (!window.confirm(`Delete the shared definition "${shown.name}"?`)) return;
                      await api(`/api/grpc/definitions/${shown.id}`, "DELETE");
                      setDetail(null);
                      setVersion((v) => v + 1);
                      onSelect(undefined);
                    })
                  }
                >
                  <Trash2 className="size-3.5" /> Delete
                </Button>
              </>
            )}
          </div>
          <p className="text-muted-foreground">
            Every request that uses this definition follows it, so edits here apply to all of them.
          </p>
          <ProtoFilesEditor files={files} onChange={setFiles} disabled={!shown.canEdit} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
