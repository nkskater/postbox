"use client";
import { formatDateTime } from "@/lib/format";
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { CookieInfo } from "@/core/types";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Workspace cookie jar manager. */
export function CookiesView() {
  const workspaceId = useApp((s) => s.workspaceId);
  const historyVersion = useApp((s) => s.historyVersion);
  const [cookies, setCookies] = useState<(CookieInfo & { id: string })[]>([]);
  const [draft, setDraft] = useState({ name: "", value: "", domain: "", path: "/" });

  const load = useCallback(() => {
    if (workspaceId) api.cookies.list(workspaceId).then(setCookies);
  }, [workspaceId]);
  useEffect(load, [load, historyVersion]);

  const domains = [...new Set(cookies.map((c) => c.domain))];
  return (
    <div className="h-full overflow-auto p-4 text-xs">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-medium">Cookies</h2>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={async () => {
            if (!workspaceId) return;
            await api.cookies.clear(workspaceId);
            load();
          }}
        >
          <Trash2 className="size-3.5" /> Clear all
        </Button>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["name", "value", "domain", "path"] as const).map((k) => (
          <Input
            key={k}
            placeholder={k}
            value={draft[k]}
            onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
            className="h-7 w-44 text-xs"
          />
        ))}
        <Button
          size="sm"
          disabled={!draft.name || !draft.domain}
          onClick={async () => {
            if (!workspaceId) return;
            await api.cookies.add(workspaceId, { ...draft, httpOnly: false, secure: false, expires: null });
            setDraft({ name: "", value: "", domain: "", path: "/" });
            load();
          }}
        >
          <Plus className="size-3.5" /> Add cookie
        </Button>
      </div>
      {domains.length === 0 && (
        <p className="text-muted-foreground">
          The cookie jar is empty. Cookies set by servers are stored here automatically.
        </p>
      )}
      {domains.map((d) => (
        <div key={d} className="mb-4">
          <div className="mb-1 font-medium">{d}</div>
          <table className="w-full">
            <tbody className="font-mono">
              {cookies
                .filter((c) => c.domain === d)
                .map((c) => (
                  <tr key={c.id} className="group border-b">
                    <td className="py-1 pr-2">{c.name}</td>
                    <td className="max-w-80 truncate py-1 pr-2 text-muted-foreground">{c.value}</td>
                    <td className="py-1 pr-2">{c.path}</td>
                    <td className="py-1 pr-2">{c.expires ? formatDateTime(c.expires) : "Session"}</td>
                    <td className="py-1 pr-2">
                      {[c.httpOnly && "HttpOnly", c.secure && "Secure"].filter(Boolean).join(" ")}
                    </td>
                    <td className="w-8">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 opacity-0 group-hover:opacity-100"
                        onClick={async () => {
                          await api.cookies.remove(c.id);
                          load();
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
