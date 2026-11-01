"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScriptPackageDocument } from "@/core/packages/model";
import { useDialogs } from "@/stores/dialogs";
import { useApp } from "@/stores/app";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CodeEditor } from "@/components/editor/CodeEditor";
async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Package operation failed");
  return result;
}
const defaultSource = 'exports.greet = function(name) {\n  return "Hello, " + name;\n};';
export function ScriptPackageDialog() {
  const target = useDialogs((s) => s.scriptPackageEditor);
  return target ? <PackageEditor key={`${target.workspaceId}:${target.id ?? "new"}`} {...target} /> : null;
}
function PackageEditor({ id, workspaceId }: { id: string | null; workspaceId: string }) {
  const [document, setDocument] = useState<ScriptPackageDocument | null>(null),
    [name, setName] = useState("shared-utils"),
    [description, setDescription] = useState(""),
    [source, setSource] = useState(defaultSource),
    [baseline, setBaseline] = useState(defaultSource),
    [busy, setBusy] = useState(!!id),
    [error, setError] = useState("");
  const lock = useRef(false);
  const activeWorkspace = useApp((s) => s.workspaceId);
  const dirty = source !== baseline || (!id && (name !== "shared-utils" || description !== ""));
  const discard = () => !dirty || window.confirm("Discard unsaved package source changes?");
  const close = () => {
    if (!busy && discard()) useDialogs.getState().openScriptPackage(null);
  };
  const apply = useCallback((document: ScriptPackageDocument) => {
    setDocument(document);
    setName(document.name);
    setDescription(document.description);
    setSource(document.source);
    setBaseline(document.source);
  }, []);
  const load = useCallback(
    async (version?: number) => {
      if (id)
        apply(
          await call<ScriptPackageDocument>(
            `/api/script-packages/${id}${version ? `?version=${version}` : ""}`,
          ),
        );
    },
    [id, apply],
  );
  useEffect(() => {
    if (!id) return;
    let active = true;
    call<ScriptPackageDocument>(`/api/script-packages/${id}`)
      .then((document) => {
        if (active) apply(document);
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [id, apply]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  const action = async (fn: () => Promise<void>) => {
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
  const save = () =>
    action(async () => {
      const result =
        id && document
          ? await call<ScriptPackageDocument>(`/api/script-packages/${id}/versions`, "POST", {
              expectedVersion: document.latestVersion,
              source,
            })
          : await call<ScriptPackageDocument>("/api/script-packages", "POST", {
              workspaceId,
              name,
              description,
              source,
            });
      useApp.getState().packagesChanged();
      if (id) apply(result);
      else useDialogs.getState().openScriptPackage({ workspaceId, id: result.id });
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-4xl"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "s") {
            event.preventDefault();
            event.stopPropagation();
            if (!busy && (!document || document.canEdit)) void save();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{id ? "Script package" : "Create script package"}</DialogTitle>
          <DialogDescription>
            CommonJS exports shared by workspace requests. New source versions require owner approval before
            execution.
          </DialogDescription>
        </DialogHeader>
        {workspaceId !== activeWorkspace && (
          <p className="text-xs text-muted-foreground">
            Editing the workspace where this package was opened.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="min-h-0 space-y-3 overflow-auto text-sm">
          <label className="block">
            Package name
            <Input
              aria-label="Package name"
              disabled={busy || !!id}
              maxLength={63}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block">
            Description
            <Textarea
              aria-label="Package description"
              disabled={busy || !!id}
              maxLength={10000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {document && (
            <div className="flex flex-wrap items-center gap-3">
              <label>
                Version{" "}
                <select
                  aria-label="Package version"
                  disabled={busy}
                  className="rounded border bg-background p-1"
                  value={document.version}
                  onChange={(e) => {
                    if (discard()) void action(() => load(Number(e.target.value)));
                  }}
                >
                  {document.versions.map((version) => (
                    <option key={version.version} value={version.version}>
                      v{version.version} · {version.approved ? "Approved" : "Needs approval"}
                    </option>
                  ))}
                </select>
              </label>
              <code>{`pm.require('@team/${name}@${document.version}')`}</code>
              <p className="text-xs text-muted-foreground">
                Latest v{document.latestVersion} · SHA-256 {document.hash.slice(0, 12)}
              </p>
            </div>
          )}
          <div className="h-80 rounded border" aria-label="Package source">
            <CodeEditor
              value={source}
              onChange={setSource}
              language="javascript"
              variables={false}
              readOnly={busy || (!!document && !document.canEdit)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Use module.exports or exports. Imports remain inside the sandbox; require and pm.require cannot
            access the host. Reference credentials through pm variables instead of embedding them in source.
          </p>
          <div className="flex flex-wrap gap-2">
            {(!document || document.canEdit) && (
              <Button size="sm" disabled={busy || !source.trim() || !name.trim()} onClick={() => void save()}>
                {id ? "Save new version" : "Create package"}
              </Button>
            )}
            {document?.canApprove && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || dirty}
                onClick={() =>
                  void action(async () => {
                    apply(
                      await call<ScriptPackageDocument>(`/api/script-packages/${id}/approval`, "POST", {
                        version: document.version,
                        approved: !document.approved,
                      }),
                    );
                    useApp.getState().packagesChanged();
                  })
                }
              >
                {document.approved ? "Revoke approval" : "Approve version"}
              </Button>
            )}
            {id && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (discard()) void action(() => load());
                }}
              >
                Reload latest
              </Button>
            )}
          </div>
          {document && (
            <>
              <p className="text-xs text-muted-foreground">
                Referenced by {document.references.length} saved script(s). Computed imports may not be
                discoverable.
              </p>
              {document.references.map((ref, index) => (
                <p key={`${ref.id}:${index}`} className="text-xs">
                  {ref.kind}: {ref.name}
                </p>
              ))}
              {document.canEdit && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    if (
                      discard() &&
                      window.confirm("Delete all package versions? Saved imports prevent deletion.")
                    )
                      void action(async () => {
                        await call(`/api/script-packages/${id}`, "DELETE");
                        useApp.getState().packagesChanged();
                        useDialogs.getState().openScriptPackage(null);
                      });
                  }}
                >
                  Delete package
                </Button>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
