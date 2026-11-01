"use client";
/** Database information, maintenance, scoped clearing and backup/restore (administrators only). */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DatabaseBackup, Download, Eraser, HardDrive, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useApp } from "@/stores/app";

interface Info {
  path: string;
  sizeBytes: number;
  walBytes: number;
  reclaimableBytes: number;
  counts: Record<"workspaces" | "requests" | "history" | "cookies" | "runs" | "datasets", number>;
}
type Target = "history" | "cookies" | "runs";
const TARGETS: { id: Target; label: string; noun: string }[] = [
  { id: "history", label: "Clear history", noun: "request history" },
  { id: "cookies", label: "Clear cookies", noun: "saved cookies" },
  { id: "runs", label: "Clear run results", noun: "collection run results" },
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? res.statusText);
  return body as T;
}
const post = (url: string, body?: unknown) =>
  api<Record<string, unknown>>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

interface PendingRestore {
  file: string;
  backup: unknown;
  summary: string;
}

export function DataManagement({ isAdmin }: { isAdmin: boolean }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<"workspace" | "all">("workspace");
  // The dialogs keep their last content while they fade out, so "open" is tracked separately.
  const [clear, setClear] = useState<Target>("history");
  const [clearOpen, setClearOpen] = useState(false);
  const [secrets, setSecrets] = useState(true);
  const [restore, setRestore] = useState<PendingRestore | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<Info>("/api/backup/info")
      .then(setInfo)
      .catch((err) => toast.error((err as Error).message));
  }, []);
  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  if (!isAdmin)
    return (
      <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
        Database maintenance, clearing data and backups are available to administrators.
      </p>
    );

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const compact = () =>
    run(async () => {
      const r = (await post("/api/backup/compact")) as { before: number; after: number };
      toast.success(`Database compacted: ${formatBytes(r.before)} → ${formatBytes(r.after)}`);
      load();
    });

  const doClear = (target: Target) =>
    run(async () => {
      const r = (await post("/api/backup/clear", {
        target,
        workspaceId: scope === "workspace" ? workspaceId : undefined,
      })) as { removed: number };
      toast.success(`Removed ${r.removed.toLocaleString()} ${r.removed === 1 ? "record" : "records"}`);
      load();
    });

  const choose = async (file: File) => {
    try {
      const backup = JSON.parse(await file.text());
      if (backup?.postboxBackup !== 1 || typeof backup.tables !== "object")
        throw new Error("This is not a Postbox backup file");
      const n = (name: string) => (Array.isArray(backup.tables?.[name]) ? backup.tables[name].length : 0);
      setRestoreOpen(true);
      setRestore({
        file: file.name,
        backup,
        summary: `${n("workspaces")} workspaces, ${n("requests")} requests, ${n("environments")} environments${
          backup.exportedAt ? `, exported ${formatDateTime(new Date(backup.exportedAt).getTime())}` : ""
        }${backup.secretsIncluded === false ? ". Secret values were left out of this file" : ""}`,
      });
    } catch (err) {
      toast.error(`Could not read the backup: ${(err as Error).message}`);
    }
  };

  const doRestore = (pending: PendingRestore) =>
    run(async () => {
      await post("/api/backup", { backup: pending.backup, confirm: "restore" });
      toast.success("Backup restored. Reloading…");
      setTimeout(() => window.location.reload(), 800);
    });

  const section = "space-y-3 rounded-lg border p-4";
  return (
    <div className="space-y-4">
      <section className={section} aria-label="Database">
        <h3 className="flex items-center gap-2 font-medium">
          <HardDrive className="size-4" /> Database
        </h3>
        {info ? (
          <>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">File</dt>
              <dd className="break-all font-mono text-xs">{info.path}</dd>
              <dt className="text-muted-foreground">Size</dt>
              <dd>
                {formatBytes(info.sizeBytes)}
                {info.walBytes > 0 && ` + ${formatBytes(info.walBytes)} write-ahead log`}
              </dd>
              <dt className="text-muted-foreground">Reclaimable</dt>
              <dd>{formatBytes(info.reclaimableBytes)}</dd>
              <dt className="text-muted-foreground">Contents</dt>
              <dd>
                {info.counts.workspaces} workspaces · {info.counts.requests} requests ·{" "}
                {info.counts.history.toLocaleString()} history entries · {info.counts.cookies} cookies ·{" "}
                {info.counts.runs} runs · {info.counts.datasets} datasets
              </dd>
            </dl>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void compact()}>
              Compact database
            </Button>
            <p className="text-xs text-muted-foreground">
              Rewrites the database file to give free space back to the disk. It may take a moment on large
              databases.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </section>

      <section className={section} aria-label="Clear data">
        <h3 className="flex items-center gap-2 font-medium">
          <Eraser className="size-4" /> Clear data
        </h3>
        <label className="flex items-center gap-2 text-sm">
          Applies to
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            aria-label="Clear scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as "workspace" | "all")}
          >
            <option value="workspace">The current workspace</option>
            <option value="all">All workspaces</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          {TARGETS.map((t) => (
            <Button
              key={t.id}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setClear(t.id);
                setClearOpen(true);
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </section>

      <section className={section} aria-label="Backup and restore">
        <h3 className="flex items-center gap-2 font-medium">
          <DatabaseBackup className="size-4" /> Backup and restore
        </h3>
        <p className="text-sm text-muted-foreground">
          A backup is one file with every workspace, collection, request, environment, variable, dataset,
          schedule and instance setting. It does not include accounts, API tokens, history, cookies or run
          results.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={secrets}
            onChange={(e) => setSecrets(e.target.checked)}
          />
          <span>
            Include secret values and credentials
            <span className="block text-xs text-muted-foreground">
              {secrets
                ? "The file will contain passwords, tokens and secret variables in plain text. Store it like a credentials file."
                : "Secret variables, authorization credentials, secret dataset columns and credential headers are left blank. Best effort: review the file before sharing it."}
            </span>
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={secrets ? "/api/backup" : "/api/backup?secrets=omit"} download>
              <Download className="size-3.5" /> Download backup
            </a>
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="size-3.5" /> Restore from file…
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Backup file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void choose(file);
            }}
          />
        </div>
      </section>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={`${TARGETS.find((t) => t.id === clear)!.label}?`}
        description={`This permanently deletes ${TARGETS.find((t) => t.id === clear)!.noun} for ${
          scope === "workspace" ? "the current workspace" : "all workspaces"
        }. It cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void doClear(clear)}
      />
      <ConfirmDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        title="Replace all workspace data?"
        description={
          restore
            ? `Restoring ${restore.file} (${restore.summary}) deletes every current workspace, request, environment and variable, along with their history, cookies and run results, and replaces them with the backup. Accounts and API tokens are kept. This cannot be undone. Download a backup first if you may need the current data.`
            : ""
        }
        confirmLabel="Replace everything"
        destructive
        onConfirm={() => restore && void doRestore(restore)}
      />
    </div>
  );
}
