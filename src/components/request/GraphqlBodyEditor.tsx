"use client";
/**
 * GraphQL body editor: schema-aware query editing (completion and lint through
 * cm6-graphql), introspection or file-loaded schemas, operation selection,
 * validation and a searchable schema explorer.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { graphql as graphqlLanguage } from "cm6-graphql";
import type { GraphQLSchema } from "graphql";
import { Group, Panel, Separator } from "react-resizable-panels";
import { RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { listOperations, schemaFromSource, summarizeSchema, validateQuery } from "@/core/graphql/schema";
import type { BodyConfig, RequestDef } from "@/core/types";
import { useApp } from "@/stores/app";

type GraphqlBody = Extract<BodyConfig, { mode: "graphql" }>;
interface CachedSchema {
  schema: GraphQLSchema;
  source: string;
  loadedAt: number;
}

/** Schemas by endpoint URL, shared across tabs for this browser session. */
const cache = new Map<string, CachedSchema>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const setCached = (url: string, entry: CachedSchema) => {
  cache.set(url, entry);
  listeners.forEach((fn) => fn());
};

export function GraphqlBodyEditor({
  body,
  onChange,
  draft,
}: {
  body: GraphqlBody;
  onChange: (b: BodyConfig) => void;
  draft?: RequestDef & { folderId?: string | null };
}) {
  const { workspaceId, environmentId } = useApp();
  const key = draft?.url.trim() ?? "";
  const cached = useSyncExternalStore(
    subscribe,
    () => cache.get(key),
    () => undefined,
  );
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const set = (patch: Partial<GraphqlBody["graphql"]>) =>
    onChange({ ...body, graphql: { ...body.graphql, ...patch } });

  const schema = cached?.schema ?? null;
  const extensions = useMemo(() => graphqlLanguage(schema ?? undefined), [schema]);
  const problems = useMemo(() => validateQuery(body.graphql.query, schema), [body.graphql.query, schema]);
  const operations = useMemo(() => listOperations(body.graphql.query), [body.graphql.query]);
  const named = operations.filter((o) => o.name);
  const summary = useMemo(() => (schema ? summarizeSchema(schema) : null), [schema]);
  const shown = useMemo(() => {
    if (!summary) return [];
    const f = filter.trim().toLowerCase();
    return f
      ? summary.types.filter(
          (t) => t.name.toLowerCase().includes(f) || t.fields.some((x) => x.name.toLowerCase().includes(f)),
        )
      : summary.types;
  }, [summary, filter]);

  const introspect = async () => {
    if (!draft || !key) return toast.error("Enter the GraphQL endpoint URL first");
    setLoading(true);
    try {
      const { folderId, ...request } = draft;
      const res = await fetch("/api/graphql/schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, environmentId, folderId, request }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCached(key, {
        schema: schemaFromSource(data.introspection),
        source: "introspection",
        loadedAt: Date.now(),
      });
      toast.success("Schema loaded");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadFile = async (file: File) => {
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Schema files must be 20 MB or smaller");
      setCached(key, {
        schema: schemaFromSource(await file.text()),
        source: file.name,
        loadedAt: Date.now(),
      });
      toast.success(`Schema loaded from ${file.name}`);
    } catch (err) {
      toast.error(`Could not read schema: ${(err as Error).message}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button size="sm" variant="outline" className="h-7" onClick={introspect} disabled={loading}>
          <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
          {schema ? "Refresh schema" : "Fetch schema"}
        </Button>
        <label className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 hover:bg-accent">
          <Upload className="size-3.5" /> Load SDL / JSON
          <input
            type="file"
            accept=".graphql,.graphqls,.gql,.json,.sdl"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void loadFile(file);
              e.currentTarget.value = "";
            }}
          />
        </label>
        <span className="text-muted-foreground">
          {cached
            ? `Schema from ${cached.source}, ${new Date(cached.loadedAt).toLocaleTimeString()}`
            : "No schema: syntax checks only"}
        </span>
        {named.length > 1 && (
          <Select
            value={body.graphql.operationName ?? ""}
            onValueChange={(operationName) => set({ operationName: operationName || undefined })}
          >
            <SelectTrigger size="sm" className="ml-auto h-7 w-56 text-xs">
              <SelectValue placeholder="Operation to run" />
            </SelectTrigger>
            <SelectContent>
              {named.map((o) => (
                <SelectItem key={o.name!} value={o.name!} className="text-xs">
                  {o.type} {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize={summary ? "45" : "60"} minSize="20">
          <div className="flex h-full flex-col">
            <span className="mb-1 text-[11px] font-medium text-muted-foreground">QUERY</span>
            <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
              <CodeEditor
                value={body.graphql.query}
                extensions={extensions}
                onChange={(query) => set({ query })}
              />
            </div>
            {problems.length > 0 && (
              <ul
                className="mt-1 max-h-20 overflow-auto text-[11px] text-destructive"
                aria-label="Query problems"
              >
                {problems.slice(0, 20).map((p, i) => (
                  <li key={i}>
                    {p.line ? `${p.line}:${p.column} ` : ""}
                    {p.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
        <Separator className="mx-1 w-1 rounded hover:bg-primary/40" />
        <Panel defaultSize={summary ? "25" : "40"} minSize="15">
          <div className="flex h-full flex-col">
            <span className="mb-1 text-[11px] font-medium text-muted-foreground">GRAPHQL VARIABLES</span>
            <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
              <CodeEditor
                value={body.graphql.variables}
                language="json"
                onChange={(variables) => set({ variables })}
              />
            </div>
          </div>
        </Panel>
        {summary && (
          <>
            <Separator className="mx-1 w-1 rounded hover:bg-primary/40" />
            <Panel defaultSize="30" minSize="15">
              <div className="flex h-full flex-col">
                <span className="mb-1 text-[11px] font-medium text-muted-foreground">SCHEMA</span>
                <input
                  className="mb-1 h-7 rounded-md border bg-transparent px-2 text-xs"
                  placeholder="Filter types and fields"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <div
                  className="min-h-0 flex-1 overflow-auto rounded-md border p-1 font-mono text-[11px]"
                  aria-label="Schema explorer"
                >
                  {shown.map((t) => (
                    <details key={t.name} open={Object.values(summary.roots).includes(t.name) || !!filter}>
                      <summary className="cursor-pointer py-0.5">
                        <span className="text-muted-foreground">{t.kind} </span>
                        {t.name}
                      </summary>
                      <div className="pl-3">
                        {t.description && <p className="text-muted-foreground">{t.description}</p>}
                        {t.fields.map((f) => (
                          <div
                            key={f.name}
                            title={f.description}
                            className={f.deprecated ? "line-through opacity-60" : ""}
                          >
                            {f.name}
                            {f.args.length > 0 && (
                              <span className="text-muted-foreground">({f.args.join(", ")})</span>
                            )}
                            : <span className="text-primary">{f.type}</span>
                          </div>
                        ))}
                        {t.values?.map((v) => (
                          <div key={v}>{v}</div>
                        ))}
                        {t.members && <div className="text-muted-foreground">{t.members.join(" | ")}</div>}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}
