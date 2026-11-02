"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import type {
  getCollectionSpecification,
  listSpecificationCollections,
  previewSpecificationSync,
} from "@/server/specification-sync";
import type { SyncChoice } from "@/core/specifications/merge";
type Preview = Awaited<ReturnType<typeof previewSpecificationSync>>;
const show = (value: unknown) => {
  const text = JSON.stringify(value, null, 2) ?? "(removed)";
  return text.length > 12000 ? text.slice(0, 12000) + "\n… display truncated" : text;
};
export function SyncReview({
  specificationId,
  folderId,
  disabled = false,
  onSynced,
}: {
  specificationId: string;
  folderId: string;
  disabled?: boolean;
  onSynced: () => Promise<void>;
}) {
  const [direction, setDirection] = useState<"collection" | "specification">("collection"),
    [preview, setPreview] = useState<Preview | null>(null),
    [choices, setChoices] = useState<Record<string, SyncChoice>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function inspect() {
    setBusy(true);
    setError("");
    setChoices({});
    try {
      setPreview(await api.specificationSync.preview(specificationId, { folderId, direction }));
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await api.specificationSync.apply(specificationId, {
        folderId,
        direction,
        token: preview.token,
        choices,
      });
      setPreview(null);
      setChoices({});
      await useApp.getState().refreshTree();
      await onSynced();
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">
        <label className="text-xs">
          Sync target{" "}
          <select
            aria-label="Synchronization target"
            className="rounded border p-2 bg-background ml-2"
            value={direction}
            disabled={disabled || busy}
            onChange={(e) => {
              setDirection(e.target.value as typeof direction);
              setPreview(null);
              setChoices({});
            }}
          >
            <option value="collection">Update collection from specification</option>
            <option value="specification">Update specification from collection</option>
          </select>
        </label>
        <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void inspect()}>
          Preview synchronization
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {preview && (
        <section aria-label="Synchronization preview" className="rounded border p-3 space-y-3">
          <h3 className="font-medium">
            {preview.inSync ? "No synchronization changes" : "Review synchronization changes"}
          </h3>
          <p className="text-xs">
            Source v{preview.specVersion} · {preview.changes.length} proposed changes ·{" "}
            {preview.conflicts.length} conflicts. Scripts and execution settings stay with their requests.
          </p>
          {preview.warnings.map((warning, i) => (
            <p className="text-xs" key={i}>
              {warning}
            </p>
          ))}
          {preview.conflicts.map((conflict) => (
            <article key={conflict.path} className="border rounded p-3 space-y-2">
              <p className="text-sm font-medium [overflow-wrap:anywhere]">Conflict: {conflict.path}</p>
              <div className="grid gap-2 md:grid-cols-3">
                {[
                  ["Last linked", conflict.base],
                  ["Current target", conflict.current],
                  ["Incoming", conflict.incoming],
                ].map(([name, value]) => (
                  <div key={name as string}>
                    <h4 className="text-xs">{name as string}</h4>
                    <pre className="whitespace-pre-wrap text-xs bg-muted p-2 rounded max-h-40 overflow-auto [overflow-wrap:anywhere]">
                      {show(value)}
                    </pre>
                  </div>
                ))}
              </div>
              <label className="text-xs">
                Conflict decision{" "}
                <select
                  aria-label={`Conflict decision ${conflict.path}`}
                  value={choices[conflict.path] ?? ""}
                  className="border rounded bg-background p-2 ml-2"
                  disabled={busy || disabled}
                  onChange={(e) => setChoices({ ...choices, [conflict.path]: e.target.value as SyncChoice })}
                >
                  <option value="">Choose a resolution</option>
                  <option value="keep">Keep current target</option>
                  <option value="take">Take incoming change</option>
                </select>
              </label>
            </article>
          ))}
          <div className="space-y-1 max-h-80 overflow-auto">
            {preview.changes.map((change, i) => (
              <details key={i} className="rounded border p-2 text-xs">
                <summary className="cursor-pointer [overflow-wrap:anywhere]">
                  {change.kind} · {change.path}
                </summary>
                <div className="grid gap-2 md:grid-cols-2 mt-2">
                  <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                    Before: {show(change.before)}
                  </pre>
                  <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                    After: {show(change.after)}
                  </pre>
                </div>
              </details>
            ))}
          </div>
          <Button
            size="sm"
            disabled={disabled || busy || preview.inSync || preview.conflicts.some((c) => !choices[c.path])}
            onClick={() => void apply()}
          >
            Apply reviewed changes
          </Button>
        </section>
      )}
    </div>
  );
}
export function CollectionSpecificationPanel({
  folderId,
  disabled = false,
  onChanged,
}: {
  folderId: string;
  disabled?: boolean;
  onChanged: () => Promise<void>;
}) {
  const [link, setLink] = useState<ReturnType<typeof getCollectionSpecification> | undefined>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    api.specificationSync
      .link(folderId)
      .then((v) => {
        if (live) setLink(v);
      })
      .catch((e) => {
        if (live) setError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [folderId]);
  async function refresh() {
    setLink(await api.specificationSync.link(folderId));
    await onChanged();
  }
  return (
    <div className="space-y-3">
      <h2 className="font-medium">Linked OpenAPI specification</h2>
      <p className="text-xs text-muted-foreground">
        Generate from saved typed requests and response examples, then review drift in either direction before
        applying.
      </p>
      {disabled && <p className="text-xs">Save collection settings before generating or synchronizing.</p>}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {warnings.map((warning, i) => (
        <p className="text-xs" key={i}>
          {warning}
        </p>
      ))}
      {link === undefined ? (
        <p className="text-xs">Loading source link…</p>
      ) : link ? (
        <>
          <p className="text-sm">
            {link.name} · linked v{link.specVersion} · latest v{link.latestVersion}
          </p>
          <SyncReview
            key={link.specificationId}
            specificationId={link.specificationId}
            folderId={folderId}
            disabled={disabled || busy}
            onSynced={refresh}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => {
              if (!window.confirm("Unlink this collection? Both documents will be kept.")) return;
              setBusy(true);
              setError("");
              api.specificationSync
                .unlink(folderId)
                .then(refresh)
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            Unlink specification
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          disabled={disabled || busy}
          onClick={() => {
            setBusy(true);
            setError("");
            api.specificationSync
              .generateSpecification(folderId)
              .then(async (value) => {
                setWarnings(value.warnings);
                await refresh();
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          Generate OpenAPI specification
        </Button>
      )}
    </div>
  );
}
export function SpecificationCollectionsPanel({
  specificationId,
  version,
  disabled = false,
  onChanged,
}: {
  specificationId: string;
  version: number;
  disabled?: boolean;
  onChanged: () => Promise<void>;
}) {
  const [collections, setCollections] = useState<ReturnType<typeof listSpecificationCollections>>([]),
    [selected, setSelected] = useState(""),
    [sourceUrl, setSourceUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [warnings, setWarnings] = useState<string[]>([]);
  const refresh = async () => {
    const value = await api.specificationSync.collections(specificationId);
    setCollections(value);
    return value;
  };
  useEffect(() => {
    let live = true;
    api.specificationSync
      .collections(specificationId)
      .then((value) => {
        if (live) {
          setCollections(value);
          setSelected(value[0]?.folderId ?? "");
        }
      })
      .catch((e) => {
        if (live) setError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [specificationId]);
  async function generated() {
    setBusy(true);
    setError("");
    try {
      const value = await api.specificationSync.generateCollection(specificationId, {
        version,
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      });
      setWarnings(value.warnings);
      await refresh();
      setSelected(value.id);
      await useApp.getState().refreshTree();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="border rounded p-3 space-y-3">
      <h2 className="font-medium">Linked collections</h2>
      <p className="text-xs text-muted-foreground">
        Generate from saved v{version}. Synchronization previews compare each collection with the latest saved
        specification.
      </p>
      {disabled && (
        <p className="text-xs">Save or discard source edits before generating or synchronizing.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {warnings.map((warning, i) => (
        <p className="text-xs" key={i}>
          {warning}
        </p>
      ))}
      <div className="flex flex-wrap gap-2 items-center">
        <label className="text-xs">
          Source URL for relative servers{" "}
          <input
            aria-label="Specification source URL for relative servers"
            className="block border rounded p-2 bg-background w-80 max-w-full"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="Optional https://example.test/spec/openapi.json"
            disabled={disabled || busy}
          />
        </label>
        <Button size="sm" disabled={disabled || busy} onClick={() => void generated()}>
          Generate linked collection
        </Button>
      </div>
      {collections.length > 0 && (
        <>
          <label className="text-xs">
            Linked collection{" "}
            <select
              aria-label="Linked collection"
              className="border rounded p-2 bg-background ml-2"
              disabled={busy || disabled}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {collections.map((c) => (
                <option key={c.folderId} value={c.folderId}>
                  {c.name} · linked v{c.specVersion}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || disabled}
              onClick={() =>
                useApp.getState().openTab({
                  id: `folder-${selected}`,
                  type: "folder",
                  folderId: selected,
                  name: collections.find((c) => c.folderId === selected)?.name ?? "Collection",
                })
              }
            >
              Open linked collection
            </Button>
          )}
          {selected && (
            <SyncReview
              key={selected}
              specificationId={specificationId}
              folderId={selected}
              disabled={disabled || busy}
              onSynced={async () => {
                await refresh();
                await onChanged();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
