"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { getFolderCatalog } from "@/server/catalog";
export function CatalogPublisher({ folderId, name }: { folderId: string; name: string }) {
  const [state, setState] = useState<ReturnType<typeof getFolderCatalog> | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(name),
    [description, setDescription] = useState(""),
    [tags, setTags] = useState(""),
    [owners, setOwners] = useState("API team"),
    [visibility, setVisibility] = useState<"private" | "team" | "public">("private"),
    [label, setLabel] = useState("1.0.0");
  const apply = (value: ReturnType<typeof getFolderCatalog>) => {
    setState(value);
    if (value.entry) {
      setTitle(value.entry.title);
      setDescription(value.entry.description);
      setTags(value.entry.tags.join(", "));
      setOwners(value.entry.owners.join(", "));
      setVisibility(value.entry.visibility);
    }
  };
  useEffect(() => {
    let disposed = false;
    api.catalog
      .managed(folderId)
      .then((value) => {
        if (!disposed) apply(value);
      })
      .catch((error) => {
        if (!disposed) setError(error.message);
      });
    return () => {
      disposed = true;
    };
  }, [folderId]);
  const metadata = () => ({
    title,
    description,
    tags: tags
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    owners: owners
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    visibility,
    expectedRevision: state?.entry?.revision ?? 0,
  });
  const action = async (kind: "publish" | "metadata" | "revoke") => {
    if (
      kind === "revoke" &&
      !confirm(
        "Revoke this catalog entry and every retained version? Existing links and imports will stop working.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      if (kind === "publish") await api.catalog.publish(folderId, { ...metadata(), label });
      else if (kind === "metadata") await api.catalog.update(folderId, metadata());
      else await api.catalog.revoke(folderId);
      apply(await api.catalog.managed(folderId));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Catalog update failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="max-w-5xl space-y-4 text-sm"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "s") {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <p className="text-muted-foreground">
        Publish saved collection data as a versioned, sanitized, read-only catalog entry. Save source changes
        first and review the Documentation preview. Consumers import independent forks; source updates never
        change an older published version.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <fieldset disabled={!state?.canPublish || busy} className="space-y-4 disabled:opacity-60">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="catalog-title">Catalog title</Label>
            <Input id="catalog-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="catalog-version-label">New version label</Label>
            <Input
              id="catalog-version-label"
              placeholder="1.0.0"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="catalog-description">Catalog summary</Label>
          <Textarea
            id="catalog-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="catalog-tags">Tags (comma separated)</Label>
            <Input
              id="catalog-tags"
              placeholder="pets, platform"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="catalog-owners">Owners (display labels, comma separated)</Label>
            <Input id="catalog-owners" value={owners} onChange={(e) => setOwners(e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="catalog-visibility">Catalog visibility</Label>
          <select
            id="catalog-visibility"
            className="mt-1 block rounded border bg-background p-2"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
          >
            <option value="private">Private — workspace owners</option>
            <option value="team">Team — source workspace members</option>
            <option value="public">Public — anyone</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void action("publish")}>
            {state?.entry ? "Publish new version" : "Publish catalog entry"}
          </Button>
          {state?.entry && (
            <>
              <Button variant="outline" onClick={() => void action("metadata")}>
                Update sharing &amp; metadata
              </Button>
              <Button variant="destructive" onClick={() => void action("revoke")}>
                Revoke catalog entry
              </Button>
            </>
          )}
        </div>
      </fieldset>
      <Button
        variant="outline"
        onClick={() => {
          setError("");
          void api.catalog
            .managed(folderId)
            .then(apply)
            .catch((error) => setError(error.message));
        }}
        disabled={busy}
      >
        Reload catalog status
      </Button>
      <p className="text-xs text-muted-foreground">
        Only workspace owners can publish, change sharing or revoke. Owner labels are descriptive and grant no
        access. Private entries are visible only to workspace owners; team entries to all source workspace
        members; public entries to everyone. Public metadata and sanitized content become discoverable.
        Credentials, variable values, scripts and upload data are omitted.
      </p>
      <p role="status">
        {state?.entry
          ? `Published ${state.entry.visibility} · ${state.entry.latestLabel} · content version ${state.entry.latestVersion} · sharing revision ${state.entry.revision}`
          : "No accessible active catalog entry."}
      </p>
      {state?.entry && (
        <a className="text-primary underline" href={state.entry.path} target="_blank" rel="noreferrer">
          Open catalog documentation
        </a>
      )}
    </div>
  );
}
