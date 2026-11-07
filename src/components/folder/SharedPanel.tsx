"use client";
/**
 * Sharing tab of a collection: publish versions of it for other workspaces, and, when this collection was
 * installed from someone else's release, see whether it has fallen behind and update it safely.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ConflictStrategy } from "@/core/dependencies/model";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Releases = Awaited<ReturnType<typeof api.dependencies.releases>>;
type Installs = Awaited<ReturnType<typeof api.dependencies.list>>;
type Preview = Awaited<ReturnType<typeof api.dependencies.preview>>;

const STATUS: Record<Installs[number]["status"], string> = {
  current: "Up to date",
  "update-available": "Update available",
  withdrawn: "This version was withdrawn",
  "source-unavailable": "Source unavailable",
};
const select = "h-8 rounded-md border bg-background px-2 text-xs";

export function SharedPanel({ folderId }: { folderId: string }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const [releases, setReleases] = useState<Releases>([]);
  const [installs, setInstalls] = useState<Installs>([]);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [visibility, setVisibility] = useState<"workspace" | "instance">("workspace");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [strategy, setStrategy] = useState<ConflictStrategy>("abort");
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    let live = true;
    Promise.all([api.dependencies.releases(folderId), workspaceId ? api.dependencies.list(workspaceId) : []])
      .then(([r, i]) => {
        if (!live) return;
        setReleases(r);
        setInstalls(i);
        setError("");
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [folderId, workspaceId, tick]);

  const reload = () => setTick((n) => n + 1);
  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await work();
      if (done) toast.success(done);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mine = installs.find((i) => i.folderId === folderId);

  return (
    <div className="max-w-3xl space-y-6 text-sm">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}

      {mine && (
        <section className="space-y-3 rounded-md border p-3" aria-label="Installed dependency">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">Installed from a shared release</h3>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {mine.name} · {mine.version}
            </span>
            <span className="text-xs text-muted-foreground">{STATUS[mine.status]}</span>
            {mine.modified && <span className="text-xs text-muted-foreground">· edited locally</span>}
          </div>
          {mine.withdrawnReason && <p className="text-xs text-destructive">{mine.withdrawnReason}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || mine.status === "source-unavailable"}
              onClick={() =>
                act(async () => {
                  setPreview(await api.dependencies.preview(mine.id));
                })
              }
            >
              Check for changes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => act(() => api.dependencies.remove(mine.id), "Stopped tracking")}
            >
              Stop tracking
            </Button>
          </div>
          {preview && (
            <div className="space-y-2" aria-label="Update preview">
              <p>
                {preview.from} → {preview.to}
                {preview.diff.identical && " · no differences"}
              </p>
              <ul className="space-y-0.5 text-xs">
                {preview.diff.added.map((n) => (
                  <li key={`a${n.sid}`}>+ {n.path}</li>
                ))}
                {preview.diff.removed.map((n) => (
                  <li key={`r${n.sid}`}>− {n.path}</li>
                ))}
                {preview.diff.changed.map((n) => (
                  <li key={`c${n.sid}`}>
                    ~ {n.path} ({n.fields?.join(", ")})
                  </li>
                ))}
                {preview.diff.variables.map((v) => (
                  <li key={`v${v.key}`}>
                    variable {v.key}: {v.change}
                  </li>
                ))}
              </ul>
              {preview.plan.conflicts > 0 && (
                <div className="space-y-1 rounded border border-destructive/40 p-2 text-xs">
                  <p className="font-medium">{preview.plan.conflicts} change(s) collide with your edits</p>
                  <ul>
                    {preview.plan.entries
                      .filter((e) => e.action === "conflict")
                      .map((e) => (
                        <li key={e.sid}>
                          {e.path}: {e.reason}
                        </li>
                      ))}
                    {preview.plan.variables
                      .filter((v) => v.action === "conflict")
                      .map((v) => (
                        <li key={v.key}>
                          variable {v.key}: {v.reason}
                        </li>
                      ))}
                  </ul>
                  <label className="flex items-center gap-2">
                    When they collide
                    <select
                      className={select}
                      aria-label="Conflict handling"
                      value={strategy}
                      onChange={(e) => setStrategy(e.target.value as ConflictStrategy)}
                    >
                      <option value="abort">Stop and ask me</option>
                      <option value="keep-local">Keep my version</option>
                      <option value="take-incoming">Use the new version</option>
                    </select>
                  </label>
                </div>
              )}
              <Button
                size="sm"
                disabled={busy || preview.diff.identical || preview.withdrawn}
                onClick={() =>
                  act(async () => {
                    await api.dependencies.update(mine.id, strategy, mine.latestReleaseId ?? undefined);
                    setPreview(null);
                  }, "Updated")
                }
              >
                Update to {preview.to}
              </Button>
            </div>
          )}
        </section>
      )}

      <section className="space-y-3" aria-label="Publish a version">
        <h3 className="font-medium">Publish a version</h3>
        <p className="text-xs text-muted-foreground">
          A version is a frozen copy of this collection without passwords or tokens. Other workspaces can
          install it, and update when you publish the next one.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs">
            Version
            <Input
              className="h-8 w-32"
              aria-label="Release version"
              placeholder="1.0.0"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </label>
          <label className="space-y-1 text-xs">
            Who can install it
            <select
              className={`${select} block`}
              aria-label="Release visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as typeof visibility)}
            >
              <option value="workspace">Members of this workspace</option>
              <option value="instance">Everyone on this server</option>
            </select>
          </label>
          <label className="min-w-48 flex-1 space-y-1 text-xs">
            Notes
            <Input
              className="h-8"
              aria-label="Release notes"
              value={notes}
              maxLength={2000}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={busy || !version.trim()}
            onClick={() =>
              act(async () => {
                await api.dependencies.publish(folderId, { version: version.trim(), notes, visibility });
                setVersion("");
                setNotes("");
              }, "Published")
            }
          >
            Publish
          </Button>
        </div>
      </section>

      <section className="space-y-2" aria-label="Published versions">
        <h3 className="font-medium">Published versions</h3>
        {releases.length === 0 && <p className="text-xs text-muted-foreground">Nothing published yet.</p>}
        <ul className="divide-y rounded-md border">
          {releases.map((r) => (
            <li key={r.id} className="space-y-1 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{r.version}</strong>
                <span className="text-xs text-muted-foreground">
                  {r.requestCount} requests · {new Date(r.createdAt).toLocaleString()} ·{" "}
                  {r.visibility === "instance" ? "everyone" : "workspace"}
                </span>
                <code className="text-[10px] text-muted-foreground" title="SHA-256 of the contents">
                  {r.checksum.slice(0, 12)}
                </code>
                {r.revokedAt ? (
                  <span className="text-xs text-destructive">Withdrawn: {r.revokedReason}</span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 text-xs"
                    disabled={busy}
                    onClick={() => {
                      setRevoking(revoking === r.id ? null : r.id);
                      setReason("");
                    }}
                  >
                    Withdraw
                  </Button>
                )}
              </div>
              {r.notes && <p className="text-xs">{r.notes}</p>}
              {revoking === r.id && (
                <div className="flex gap-2">
                  <Input
                    className="h-8"
                    aria-label="Withdraw reason"
                    placeholder="Why is this version being withdrawn?"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy || !reason.trim()}
                    onClick={() =>
                      act(async () => {
                        await api.dependencies.revoke(r.id, reason.trim());
                        setRevoking(null);
                      }, "Withdrawn")
                    }
                  >
                    Withdraw version
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
