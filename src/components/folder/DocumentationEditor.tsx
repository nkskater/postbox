"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { getDocumentation } from "@/server/documentation";

type State = ReturnType<typeof getDocumentation>;
export function DocumentationEditor({ folderId }: { folderId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [customOrigin, setCustomOrigin] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const load = async () => {
    const value = await api.documentation.get(folderId);
    setState(value);
    setTitle(value.publication?.title ?? "");
    setVisibility(value.publication?.visibility ?? "private");
    setCustomOrigin(value.publication?.customOrigin ?? "");
  };
  useEffect(() => {
    let disposed = false;
    api.documentation
      .get(folderId)
      .then((value) => {
        if (disposed) return;
        setState(value);
        setTitle(value.publication?.title ?? "");
        setVisibility(value.publication?.visibility ?? "private");
        setCustomOrigin(value.publication?.customOrigin ?? "");
      })
      .catch((error) => {
        if (!disposed) setError(error.message);
      });
    return () => {
      disposed = true;
    };
  }, [folderId]);
  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      await api.documentation.publish(folderId, {
        visibility,
        ...(title.trim() ? { title: title.trim() } : {}),
        customOrigin: customOrigin.trim(),
        expectedRevision: state?.publication?.revision ?? 0,
      });
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Publish failed");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (!confirm("Revoke this publication? Its existing link will stop working immediately.")) return;
    setBusy(true);
    setError("");
    try {
      await api.documentation.revoke(folderId);
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Revoke failed");
    } finally {
      setBusy(false);
    }
  };
  const publication = state?.publication;
  const href = publication ? `${publication.customOrigin}${publication.path}` : "";
  return (
    <div
      className="space-y-4 text-sm"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "s") {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <p className="text-muted-foreground">
        Preview saved collection data, then publish a read-only snapshot. Save collection/request changes
        first. Republishing updates the snapshot at the same link. Credentials, variable values, scripts and
        file uploads are omitted; review the preview before sharing.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {state && (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="docs-title">Publication title (optional)</Label>
            <Input
              id="docs-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={!state.canPublish || busy}
            />
          </div>
          <div>
            <Label htmlFor="docs-visibility">Visibility</Label>
            <select
              id="docs-visibility"
              className="mt-1 block rounded border bg-background p-2"
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as "private" | "public")}
              disabled={!state.canPublish || busy}
            >
              <option value="private">Private — workspace members</option>
              <option value="public">Public — anyone with link</option>
            </select>
          </div>
          <div>
            <Label htmlFor="docs-origin">Custom origin (optional)</Label>
            <Input
              id="docs-origin"
              placeholder="https://docs.example.com"
              value={customOrigin}
              onChange={(event) => setCustomOrigin(event.target.value)}
              disabled={!state.canPublish || busy}
            />
          </div>
          {state.canPublish && (
            <Button onClick={publish} disabled={busy}>
              {publication ? "Republish snapshot" : "Publish snapshot"}
            </Button>
          )}
          {state.canPublish && publication && (
            <Button variant="destructive" onClick={revoke} disabled={busy}>
              Revoke publication
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => {
              setPreviewKey((k) => k + 1);
              void load().catch((error) => setError(error.message));
            }}
            disabled={busy}
          >
            Reload preview &amp; status
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Only workspace owners can publish or revoke. Public links require no login; private links always check
        workspace access. A custom origin requires DNS, TLS and a reverse proxy serving this Postbox instance;
        this field only changes the displayed link.
      </p>
      {publication ? (
        <p role="status">
          Published {publication.visibility} · revision {publication.revision} ·{" "}
          <a className="text-primary underline" href={href} target="_blank" rel="noreferrer">
            Open published documentation
          </a>
        </p>
      ) : (
        <p role="status">No active publication.</p>
      )}
      <iframe
        key={previewKey}
        title="Documentation preview"
        src={`/api/folders/${folderId}/documentation?preview=1&v=${previewKey}`}
        className="h-[650px] w-full rounded border"
      />
    </div>
  );
}
