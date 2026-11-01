"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { getCatalogEntry, searchCatalog } from "@/server/catalog";
export function CatalogBrowser() {
  const [query, setQuery] = useState(""),
    [tag, setTag] = useState(""),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [results, setResults] = useState<ReturnType<typeof searchCatalog> | null>(null),
    [selected, setSelected] = useState<ReturnType<typeof getCatalogEntry> | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api.catalog
      .search({ query, tag, offset, limit: 20 }, controller.signal)
      .then(setResults)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, tag, offset, refresh]);
  const open = async (id: string, version?: number) => {
    setError("");
    try {
      setSelected(await api.catalog.get(id, version));
    } catch (error) {
      setSelected(null);
      setError(error instanceof Error ? error.message : "Could not load entry");
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-medium">API catalog</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setSelected(null);
            setRefresh((v) => v + 1);
          }}
        >
          Refresh catalog
        </Button>
        <a
          className="text-xs text-primary underline"
          href="/api/catalog?format=html"
          target="_blank"
          rel="noreferrer"
        >
          Open consumer catalog
        </a>
      </div>
      <p className="text-xs text-muted-foreground">
        Discover public APIs and permitted team/private entries. Published versions are read only. Open an
        entry to browse documentation and explicitly import a version as an independent fork.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="Search catalog"
          placeholder="Search titles, summaries, tags or owners"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
        <Input
          aria-label="Filter catalog tag"
          placeholder="Exact tag"
          className="max-w-48"
          value={tag}
          onChange={(e) => {
            setTag(e.target.value);
            setOffset(0);
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <p role="status" className="text-xs text-muted-foreground">
        {loading ? "Searching…" : `${results?.total ?? 0} accessible entries`}
      </p>
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[300px_1fr]">
        <div className="space-y-2 overflow-auto">
          {results?.entries.map((entry) => (
            <button
              key={entry.id}
              className="block w-full rounded border p-3 text-left text-xs hover:bg-accent"
              onClick={() => void open(entry.id)}
            >
              <span className="font-medium">
                {entry.title} · {entry.latestLabel}
              </span>
              <p className="mt-1">{entry.description}</p>
              <p className="mt-1 text-muted-foreground">
                {entry.visibility} · {entry.tags.join(", ")}
              </p>
              <p className="text-muted-foreground">Owners: {entry.owners.join(", ")}</p>
            </button>
          ))}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!offset || loading}
              onClick={() => setOffset((v) => Math.max(0, v - 20))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || !results || offset + results.entries.length >= results.total}
              onClick={() => setOffset((v) => v + 20)}
            >
              Next
            </Button>
          </div>
        </div>
        <div className="min-h-[600px]">
          {selected ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <label className="text-xs">
                  Published version{" "}
                  <select
                    aria-label="Published catalog version"
                    className="ml-2 rounded border bg-background p-2"
                    value={selected.version}
                    onChange={(e) => void open(selected.id, Number(e.target.value))}
                  >
                    {selected.versions.map((version) => (
                      <option key={version.version} value={version.version}>
                        {version.label} · v{version.version}
                      </option>
                    ))}
                  </select>
                </label>
                <a
                  href={`/api/catalog/${selected.id}?format=html&version=${selected.version}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary underline"
                >
                  Open version
                </a>
              </div>
              <iframe
                key={`${selected.id}:${selected.version}`}
                title="Catalog documentation"
                src={`/api/catalog/${selected.id}?format=html&version=${selected.version}`}
                className="h-[750px] w-full rounded border"
              />
            </>
          ) : (
            <p className="p-8 text-sm text-muted-foreground">
              Select a catalog entry to inspect its versions.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
