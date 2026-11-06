"use client";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { CommentTarget, CommentView } from "@/core/comments/model";

const when = (t: number) => new Date(t).toLocaleString();
/** A revision is a specification version ("v3") or the time the element last changed. */
const revisionLabel = (r: string) =>
  /^\d{10,}$/.test(r) ? `element as of ${when(Number(r))}` : `version ${r.replace(/^v/, "")}`;
const failed = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong");

type People = { id: string; username: string; displayName: string }[];

/** Discussion on one element. Suggests `@mentions` from the people who can read the workspace. */
export function CommentsPanel({ kind, targetId }: { kind: CommentTarget; targetId: string }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const [threads, setThreads] = useState<CommentView[]>([]);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [showResolved, setShowResolved] = useState(false);
  const [people, setPeople] = useState<People>([]);
  const [loaded, setLoaded] = useState(false);

  const [tick, setTick] = useState(0);
  const load = useCallback(async () => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    api.comments
      .list(kind, targetId)
      .then((r) => {
        if (!live) return;
        setThreads(r.threads);
        setResolvedCount(r.resolvedThreads);
        setLoaded(true);
      })
      .catch((e) => live && (failed(e), setLoaded(true)));
    return () => {
      live = false;
    };
  }, [kind, targetId, tick]);
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void api.comments.mentionable(workspaceId).then(
      (list) => live && setPeople(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const shown = showResolved ? threads : threads.filter((t) => !t.resolvedAt);
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await load();
    } catch (e) {
      failed(e);
    }
  };

  return (
    <section className="max-w-3xl space-y-3" aria-label="Comments">
      <Composer
        people={people}
        placeholder="Add a comment. Use @name to mention someone."
        submit="Comment"
        onSubmit={(body) => run(() => api.comments.add(kind, targetId, body))}
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{loaded ? `${threads.length - resolvedCount} open thread(s)` : "Loading…"}</span>
        {resolvedCount > 0 && (
          <button className="underline" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "Hide" : "Show"} {resolvedCount} resolved
          </button>
        )}
      </div>
      {loaded && shown.length === 0 && <p className="text-sm text-muted-foreground">No discussion yet.</p>}
      {shown.map((t) => (
        <Thread key={t.id} thread={t} people={people} run={run} kind={kind} targetId={targetId} />
      ))}
    </section>
  );
}

function Thread({
  thread,
  people,
  run,
  kind,
  targetId,
}: {
  thread: CommentView;
  people: People;
  run: (work: () => Promise<unknown>) => Promise<void>;
  kind: CommentTarget;
  targetId: string;
}) {
  const [replying, setReplying] = useState(false);
  const resolved = !!thread.resolvedAt;
  return (
    <div className={`rounded border p-3 space-y-2 ${resolved ? "opacity-70" : ""}`}>
      <Entry comment={thread} people={people} run={run} />
      {resolved && (
        <p className="text-xs text-muted-foreground">
          Resolved by {thread.resolvedBy} · {when(thread.resolvedAt!)}
        </p>
      )}
      {thread.replies?.map((r) => (
        <div key={r.id} className="ml-4 border-l pl-3">
          <Entry comment={r} people={people} run={run} />
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setReplying((v) => !v)}>
          Reply
        </Button>
        {thread.can.resolve && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => run(() => api.comments.resolve(thread.id, !resolved))}
          >
            {resolved ? "Reopen" : "Resolve"}
          </Button>
        )}
      </div>
      {replying && (
        <Composer
          people={people}
          placeholder="Write a reply"
          submit="Reply"
          onSubmit={async (body) => {
            await run(() => api.comments.add(kind, targetId, body, thread.id));
            setReplying(false);
          }}
        />
      )}
    </div>
  );
}

function Entry({
  comment,
  people,
  run,
}: {
  comment: CommentView;
  people: People;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className="font-medium">{comment.authorName}</span>
        <span className="text-muted-foreground">{when(comment.createdAt)}</span>
        {comment.editedAt && <span className="text-muted-foreground">(edited)</span>}
        <span className="text-muted-foreground" title="Version of the element when this was written">
          {revisionLabel(comment.revision)}
        </span>
      </div>
      {editing ? (
        <Composer
          people={people}
          initial={comment.body}
          submit="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            await run(() => api.comments.edit(comment.id, body));
            setEditing(false);
          }}
        />
      ) : (
        <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{comment.body}</p>
      )}
      {!editing && (comment.can.edit || comment.can.delete) && (
        <div className="flex gap-3 text-xs text-muted-foreground">
          {comment.can.edit && (
            <button className="underline" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {comment.can.delete && (
            <button
              className="underline"
              onClick={() => {
                if (
                  window.confirm(
                    comment.parentId ? "Delete this reply?" : "Delete this comment and its replies?",
                  )
                )
                  void run(() => api.comments.remove(comment.id));
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Composer({
  people,
  placeholder,
  submit,
  initial = "",
  onSubmit,
  onCancel,
}: {
  people: People;
  placeholder?: string;
  submit: string;
  initial?: string;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const token = /(?:^|\s)@([\w.-]*)$/.exec(text)?.[1];
  const suggestions =
    token === undefined
      ? []
      : people.filter((p) => p.username.toLowerCase().startsWith(token.toLowerCase())).slice(0, 5);
  return (
    <div className="space-y-1">
      <Textarea
        className="min-h-16 text-sm"
        placeholder={placeholder}
        value={text}
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
      />
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Mention suggestions">
          {suggestions.map((p) => (
            <button
              key={p.id}
              className="rounded border px-2 py-0.5 text-xs hover:bg-accent"
              onClick={() => setText(text.replace(/@[\w.-]*$/, `@${p.username} `))}
            >
              @{p.username}
              {p.displayName ? ` · ${p.displayName}` : ""}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy || !text.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(text);
              if (!onCancel) setText("");
            } finally {
              setBusy(false);
            }
          }}
        >
          {submit}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
