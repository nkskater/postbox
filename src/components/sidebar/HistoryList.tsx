"use client";
import { useEffect, useMemo, useState } from "react";
import { History, Search, Trash2 } from "lucide-react";
import { useApp } from "@/stores/app";
import { api, type HistorySummary, type ProxyResult } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { methodColor, relativeTime, statusColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RequestDef } from "@/core/types";

/** Request history grouped by day; clicking an entry reopens it in a new tab. */
export function HistoryList() {
  const workspaceId = useApp((s) => s.workspaceId);
  const version = useApp((s) => s.historyVersion);
  const openDraft = useApp((s) => s.openDraft);
  const [items, setItems] = useState<HistorySummary[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (workspaceId)
      api.history
        .list(workspaceId)
        .then(setItems)
        .catch(() => undefined);
  }, [workspaceId, version]);

  const groups = useMemo(() => {
    const q = filter.toLowerCase();
    const map = new Map<string, HistorySummary[]>();
    for (const h of items) {
      if (q && !h.url.toLowerCase().includes(q)) continue;
      const day = new Date(h.createdAt).toDateString();
      map.set(day, [...(map.get(day) ?? []), h]);
    }
    return [...map.entries()];
  }, [items, filter]);

  const open = async (id: string) => {
    const h = await api.history.get(id);
    const { id: _id, ...req } = h.request as RequestDef & { folderId?: string | null };
    const r = h.response as Record<string, unknown> | null;
    // Rebuild a minimal result so the stored response is visible immediately.
    const result =
      r && typeof r.status === "number"
        ? ({
            response: {
              status: r.status,
              statusText: String(r.statusText ?? ""),
              httpVersion: "1.1",
              headers: (r.headers as [string, string][]) ?? [],
              bodyText: String(r.body ?? ""),
              bodyBase64: "",
              isBinary: !!r.isBinary,
              contentType:
                ((r.headers as [string, string][]) ?? []).find(
                  ([k]) => k.toLowerCase() === "content-type",
                )?.[1] ?? "",
              size: Number(r.size ?? 0),
              headersSize: 0,
              timings: r.timings,
              url: h.url,
              redirects: [],
              cookies: [],
            },
            tests: [],
            logs: [],
            scriptErrors: [],
            unresolved: [],
            scopes: { globals: {}, collection: {}, environment: {}, data: {}, local: {} },
            skipped: false,
            nextRequestSet: false,
            warnings: [],
          } as unknown as ProxyResult)
        : null;
    openDraft({ ...req, name: req.name || h.url, folderId: req.folderId ?? null }, result);
  };

  return (
    <div className="flex h-full flex-col text-[13px]">
      <div className="flex items-center gap-1 p-2">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter history"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Clear history"
          onClick={async () => {
            if (!workspaceId) return;
            await api.history.clear(workspaceId);
            setItems([]);
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto px-1 pb-4">
        {groups.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-muted-foreground">
            <History className="size-8 opacity-40" />
            Requests you send appear here.
          </div>
        )}
        {groups.map(([day, list]) => (
          <div key={day} className="mb-2">
            <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{day}</div>
            {list.map((h) => (
              <button
                key={h.id}
                onClick={() => open(h.id)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent"
                title={h.url}
              >
                <span
                  className={cn(
                    "w-11 shrink-0 text-right font-mono text-[10px] font-bold",
                    methodColor(h.method),
                  )}
                >
                  {h.method}
                </span>
                <span className="min-w-0 flex-1 truncate">{h.url}</span>
                <span className={cn("text-[10px]", statusColor(h.status))}>{h.status ?? "ERR"}</span>
                <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground">
                  {relativeTime(h.createdAt)}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
