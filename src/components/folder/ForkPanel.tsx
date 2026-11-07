"use client";
/**
 * Forks tab of a collection: copy it to work on a change, keep the copy up to date with the original,
 * and propose the change back. For the original, the same tab lists forks and the requests to review.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ConflictStrategy } from "@/core/dependencies/model";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CommentsPanel } from "@/components/comments/CommentsPanel";

type Forks = Awaited<ReturnType<typeof api.forks.list>>;
type Requests = Awaited<ReturnType<typeof api.mergeRequests.list>>;
type MergeView = Awaited<ReturnType<typeof api.mergeRequests.get>>;
type Sync = Awaited<ReturnType<typeof api.forks.previewSync>>;

const select = "h-8 rounded-md border bg-background px-2 text-xs";
const STATUS_TEXT: Record<Forks[number]["status"], string> = {
  "in-sync": "Same as the original",
  ahead: "Has changes the original does not",
  behind: "The original has changes you do not",
  diverged: "Changed on both sides",
  "parent-unavailable": "The original is not available",
};

export function ForkPanel({ folderId, name }: { folderId: string; name: string }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const workspaces = useApp((s) => s.workspaces);
  const [mine, setMine] = useState<Forks>([]);
  const [children, setChildren] = useState<Awaited<ReturnType<typeof api.forks.listOf>>>([]);
  const [requests, setRequests] = useState<Requests>([]);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [forkName, setForkName] = useState("");
  const [sync, setSync] = useState<Sync | null>(null);
  const [strategy, setStrategy] = useState<ConflictStrategy>("abort");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    Promise.all([
      api.forks.list(workspaceId),
      api.forks.listOf(folderId),
      api.mergeRequests.list(workspaceId),
    ])
      .then(([f, c, r]) => {
        if (!live) return;
        setMine(f);
        setChildren(c);
        setRequests(r);
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

  const fork = mine.find((f) => f.folderId === folderId);
  const toReview = requests.filter((r) => r.parentFolderId === folderId);
  const proposed = requests.filter((r) => r.forkFolderId === folderId);

  return (
    <div className="max-w-3xl space-y-6 text-sm">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}

      {fork && (
        <section className="space-y-3 rounded-md border p-3" aria-label="This fork">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">Fork of {fork.parentName}</h3>
            <span className="text-xs text-muted-foreground">{STATUS_TEXT[fork.status]}</span>
            {fork.ahead > 0 && <span className="text-xs">· {fork.ahead} change(s) of yours</span>}
            {fork.behind > 0 && <span className="text-xs">· {fork.behind} new upstream</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || fork.status === "parent-unavailable"}
              onClick={() =>
                act(async () => {
                  setSync(await api.forks.previewSync(fork.id));
                })
              }
            >
              Update from original
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => act(() => api.forks.remove(fork.id), "Fork unlinked")}
            >
              Stop tracking
            </Button>
          </div>

          {sync && (
            <div className="space-y-2" aria-label="Update preview">
              <ul className="space-y-0.5 text-xs">
                {sync.diff.added.map((n) => (
                  <li key={`a${n.sid}`}>+ {n.path}</li>
                ))}
                {sync.diff.removed.map((n) => (
                  <li key={`r${n.sid}`}>− {n.path}</li>
                ))}
                {sync.diff.changed.map((n) => (
                  <li key={`c${n.sid}`}>
                    ~ {n.path} ({n.fields?.join(", ")})
                  </li>
                ))}
                {sync.diff.identical && <li>Nothing new upstream.</li>}
              </ul>
              {sync.plan.conflicts > 0 && (
                <label className="flex items-center gap-2 text-xs">
                  {sync.plan.conflicts} collide with your edits.
                  <select
                    className={select}
                    aria-label="Conflict handling"
                    value={strategy}
                    onChange={(e) => setStrategy(e.target.value as ConflictStrategy)}
                  >
                    <option value="abort">Stop and ask me</option>
                    <option value="keep-local">Keep my version</option>
                    <option value="take-incoming">Use the original&apos;s</option>
                  </select>
                </label>
              )}
              <Button
                size="sm"
                disabled={busy || sync.diff.identical}
                onClick={() =>
                  act(async () => {
                    await api.forks.sync(fork.id, strategy);
                    setSync(null);
                  }, "Updated")
                }
              >
                Apply update
              </Button>
            </div>
          )}

          {fork.openMergeRequestId ? (
            <p className="text-xs">
              A merge request is open.{" "}
              <button className="underline" onClick={() => setOpen(fork.openMergeRequestId)}>
                View it
              </button>
            </p>
          ) : (
            <div className="space-y-2" aria-label="Propose changes">
              <h4 className="text-xs font-medium">Propose your changes to the original</h4>
              <Input
                className="h-8"
                aria-label="Merge request title"
                placeholder="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Input
                className="h-8"
                aria-label="Merge request description"
                placeholder="What changed and why (optional)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <Button
                size="sm"
                disabled={busy || !title.trim() || fork.ahead === 0}
                onClick={() =>
                  act(async () => {
                    const mr = await api.forks.propose(fork.id, title.trim(), description);
                    setTitle("");
                    setDescription("");
                    setOpen(mr.id);
                  }, "Merge request opened")
                }
              >
                Open merge request
              </Button>
              {fork.ahead === 0 && (
                <p className="text-xs text-muted-foreground">No changes to propose yet.</p>
              )}
            </div>
          )}
        </section>
      )}

      {open && <MergeRequestDetail key={open} id={open} onChanged={reload} onClose={() => setOpen(null)} />}

      {proposed.length > 0 && (
        <RequestList title="Requests from this fork" rows={proposed} onOpen={setOpen} />
      )}

      <section className="space-y-3" aria-label="Fork this collection">
        <h3 className="font-medium">Fork this collection</h3>
        <p className="text-xs text-muted-foreground">
          A fork is your own copy of {name}, without anyone&apos;s passwords or tokens. Change it freely, keep
          it up to date, and propose what you changed back.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs">
            Into workspace
            <select
              className={`${select} block`}
              aria-label="Fork destination"
              value={target || workspaceId || ""}
              onChange={(e) => setTarget(e.target.value)}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-48 flex-1 space-y-1 text-xs">
            Name
            <Input
              className="h-8"
              aria-label="Fork name"
              placeholder={`${name} (fork)`}
              value={forkName}
              onChange={(e) => setForkName(e.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={busy || !(target || workspaceId)}
            onClick={() =>
              act(async () => {
                await api.forks.create(folderId, target || workspaceId!, forkName.trim() || undefined);
                setForkName("");
                await useApp.getState().refreshTree();
              }, "Forked")
            }
          >
            Fork
          </Button>
        </div>
      </section>

      {children.length > 0 && (
        <section className="space-y-1" aria-label="Forks of this collection">
          <h3 className="font-medium">Forks of this collection</h3>
          <ul className="divide-y rounded-md border">
            {children.map((f) => (
              <li key={f.id} className="flex items-center gap-2 p-2 text-xs">
                <span>{STATUS_TEXT[f.status]}</span>
                {f.ahead > 0 && <span className="text-muted-foreground">{f.ahead} change(s)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <RequestList title="Merge requests to review" rows={toReview} onOpen={setOpen} />
    </div>
  );
}

function RequestList({
  title,
  rows,
  onOpen,
}: {
  title: string;
  rows: Requests;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="space-y-1" aria-label={title}>
      <h3 className="font-medium">{title}</h3>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">None.</p>}
      <ul className="divide-y rounded-md border">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2 p-2">
            <button className="flex-1 text-left hover:underline" onClick={() => onOpen(r.id)}>
              {r.title}
            </button>
            <span className="text-xs text-muted-foreground">
              {r.status} · {r.createdByName}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MergeRequestDetail({
  id,
  onChanged,
  onClose,
}: {
  id: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [mr, setMr] = useState<MergeView | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let live = true;
    api.mergeRequests
      .get(id)
      .then((m) => {
        if (!live) return;
        setMr(m);
        setError("");
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id, tick]);

  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast.success(done);
      setNote("");
      setTick((n) => n + 1);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!mr) return <p className="text-xs text-muted-foreground">{error || "Loading…"}</p>;
  const info = mr.open && "diff" in mr.open ? mr.open : null;
  return (
    <section className="space-y-3 rounded-md border p-3" aria-label="Merge request">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{mr.title}</h3>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{mr.status}</span>
        <span className="text-xs text-muted-foreground">by {mr.createdByName}</span>
        <Button size="sm" variant="ghost" className="ml-auto h-6 text-xs" onClick={onClose}>
          Hide
        </Button>
      </div>
      {mr.description && <p className="text-xs">{mr.description}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {mr.status === "merged" && (
        <p className="text-xs">
          Merged by {mr.mergedByName}
          {mr.mergedSummary
            ? `: ${mr.mergedSummary.added} added, ${mr.mergedSummary.updated} changed, ${mr.mergedSummary.removed} removed`
            : ""}
          .
        </p>
      )}
      {mr.status === "closed" && (
        <p className="text-xs">Closed{mr.closedNote ? `: ${mr.closedNote}` : ""}.</p>
      )}

      {info && (
        <>
          <ul className="space-y-0.5 text-xs" aria-label="Changes">
            {info.diff.added.map((n) => (
              <li key={`a${n.sid}`}>+ {n.path}</li>
            ))}
            {info.diff.removed.map((n) => (
              <li key={`r${n.sid}`}>− {n.path}</li>
            ))}
            {info.diff.changed.map((n) => (
              <li key={`c${n.sid}`}>
                ~ {n.path} ({n.fields?.join(", ")})
              </li>
            ))}
            {info.diff.variables.map((v) => (
              <li key={`v${v.key}`}>
                variable {v.key}: {v.change}
              </li>
            ))}
          </ul>
          {info.protectedChanges.length > 0 && (
            <p className="rounded border border-amber-500/50 p-2 text-xs">
              Changes scripts or saved examples (only an owner can merge):{" "}
              {info.protectedChanges.map((c) => `${c.path} (${c.fields.join(", ")})`).join("; ")}
            </p>
          )}
          {info.conflicts.length > 0 && (
            <p className="rounded border border-destructive/50 p-2 text-xs">
              Conflicts with changes made since the fork: {info.conflicts.map((c) => c.path).join("; ")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {info.approvals} approval(s){info.rejections > 0 ? `, ${info.rejections} asking for changes` : ""}
            {info.staleReviews > 0 ? `, ${info.staleReviews} out of date` : ""}
          </p>
          {!info.readiness.ok && (
            <ul
              className="list-disc pl-4 text-xs text-muted-foreground"
              aria-label="Why it cannot be merged yet"
            >
              {info.readiness.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <Input
            className="h-8"
            aria-label="Review note"
            placeholder="Note for the author (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !info.can.review}
              onClick={() => act(() => api.mergeRequests.review(id, "approve", note), "Approved")}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !info.can.review}
              onClick={() => act(() => api.mergeRequests.review(id, "reject", note), "Changes requested")}
            >
              Request changes
            </Button>
            <Button
              size="sm"
              disabled={busy || !info.can.merge}
              onClick={() => act(() => api.mergeRequests.merge(id), "Merged")}
            >
              Merge
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !info.can.close}
              onClick={() => act(() => api.mergeRequests.close(id, note), "Closed")}
            >
              Close
            </Button>
          </div>
        </>
      )}

      {mr.reviews.length > 0 && (
        <ul className="space-y-0.5 text-xs" aria-label="Reviews">
          {mr.reviews.map((r) => (
            <li key={r.id} className={r.current ? "" : "text-muted-foreground"}>
              {r.reviewerName}: {r.decision === "approve" ? "approved" : "asked for changes"}
              {r.note ? ` — ${r.note}` : ""}
              {mr.status === "open" && !r.current ? " (out of date)" : ""}
            </li>
          ))}
        </ul>
      )}
      <CommentsPanel kind="mergeRequest" targetId={id} />
    </section>
  );
}
