"use client";
/** Install a collection another workspace has published, pinned to a version so it can be updated later. */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Releases = Awaited<ReturnType<typeof api.dependencies.browse>>;

export function SharedImport({
  workspaceId,
  disabled,
  onImported,
}: {
  workspaceId: string | null;
  disabled: boolean;
  onImported: () => Promise<void>;
}) {
  const [releases, setReleases] = useState<Releases | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    api.dependencies
      .browse(workspaceId)
      .then((r) => live && setReleases(r))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const install = async (id: string, label: string) => {
    if (!workspaceId) return;
    setBusy(id);
    setError("");
    try {
      await api.dependencies.install(workspaceId, id);
      await onImported();
      toast.success(`Installed ${label}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Newest first per collection; withdrawn versions are not offered.
  const offered = (releases ?? []).filter((r) => !r.revokedAt);
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-muted-foreground">
        Collections other workspaces have published. An installed copy stays linked to its version, keeps your
        own edits and credentials, and can be updated when a newer version is published.
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {releases && offered.length === 0 && (
        <p className="text-xs text-muted-foreground">Nothing has been shared with this workspace yet.</p>
      )}
      <ul className="max-h-64 divide-y overflow-auto rounded-md border" aria-label="Shared collections">
        {offered.map((r) => (
          <li key={r.id} className="flex items-center gap-2 p-2">
            <div className="min-w-0 flex-1">
              <div className="truncate">
                <strong>{r.name}</strong> <span className="text-xs text-muted-foreground">{r.version}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {r.requestCount} requests{r.notes ? ` · ${r.notes}` : ""}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || busy !== null}
              aria-label={`Install ${r.name} ${r.version}`}
              onClick={() => void install(r.id, `${r.name} ${r.version}`)}
            >
              Install
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
