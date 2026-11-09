"use client";
/**
 * Repository section: how to keep a collection, environment or specification in Git. Shows what the
 * files look like right now, the checksum a push is guarded by, and the commands to run.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Kind = "collection" | "environment" | "specification";
type Pulled = Awaited<ReturnType<typeof api.repository.files>>;

const WORD: Record<Kind, string> = { collection: "collection", environment: "env", specification: "spec" };

/** A shell-safe directory name suggestion from a display name. */
const dirName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "postbox-files";

export function RepositoryPanel({ kind, id, name }: { kind: Kind; id: string; name: string }) {
  const [pulled, setPulled] = useState<Pulled | null>(null);
  const [error, setError] = useState("");
  const [showFiles, setShowFiles] = useState(false);

  useEffect(() => {
    let live = true;
    api.repository
      .files(kind, id)
      .then((p) => {
        if (!live) return;
        setPulled(p);
        setError("");
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [kind, id]);

  const dir = `./${dirName(name)}`;
  const word = WORD[kind];
  const commands = [
    { label: "Write the files", text: `postbox ${word} pull ${id} --dir ${dir}` },
    { label: "Preview your edits", text: `postbox ${word} push --dir ${dir} --dry-run` },
    { label: "Apply your edits", text: `postbox ${word} push --dir ${dir}` },
  ];
  const paths = pulled ? Object.keys(pulled.files).sort() : [];

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy; select the text instead");
    }
  };
  const download = () => {
    if (!pulled) return;
    const blob = new Blob([JSON.stringify(pulled.files, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${dirName(name)}-files.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-3xl space-y-5 text-sm" aria-label="Repository">
      <p className="text-xs text-muted-foreground">
        Keep this {kind} in Git as plain files. They are stable (the same content always gives the same
        files), contain no passwords or tokens, and diff and merge like source code. Postbox writes and reads
        the files; Git does the history and review.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}

      <section className="space-y-2" aria-label="Current state">
        <h3 className="font-medium">Right now</h3>
        {pulled ? (
          <>
            <p className="text-xs">
              {paths.length} file(s) · checksum{" "}
              <code title={pulled.checksum} data-testid="repository-checksum">
                {pulled.checksum.length > 16 ? pulled.checksum.slice(0, 12) : pulled.checksum}
              </code>
            </p>
            <p className="text-xs text-muted-foreground">
              A push is only accepted against this checksum. If this {kind} changes before you push, pull
              again and merge in Git.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowFiles((v) => !v)}>
                {showFiles ? "Hide files" : "Show files"}
              </Button>
              <Button size="sm" variant="outline" onClick={download}>
                Download as JSON
              </Button>
            </div>
            {showFiles && (
              <ul className="max-h-48 overflow-auto rounded border p-2 font-mono text-xs" aria-label="Files">
                {paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          !error && <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </section>

      <section className="space-y-2" aria-label="Commands">
        <h3 className="font-medium">Commands</h3>
        <ul className="space-y-2">
          {commands.map((c) => (
            <li key={c.text} className="flex items-center gap-2">
              <span className="w-32 shrink-0 text-xs text-muted-foreground">{c.label}</span>
              <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-xs">{c.text}</code>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void copy(c.text)}>
                Copy
              </Button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Pushing without <code>--dry-run</code> saves your edits. Add <code>--prune</code> to also remove
          things whose files you deleted. Details are in the repository format guide.
        </p>
      </section>
    </div>
  );
}
