"use client";
/**
 * Collections sidebar: nested folders and requests with search, inline rename,
 * duplicate/delete, drag & drop (reorder or move into folders) and quick actions.
 */
import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Library,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { defaultRequestSettings, useApp } from "@/stores/app";
import { getSetting } from "@/lib/settings/runtime";
import { useDialogs } from "@/stores/dialogs";
import { api, type TreeFolderSummary, type TreeRequestSummary } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { methodColor } from "@/lib/format";
import { cn } from "@/lib/utils";

type DragItem = { kind: "folder" | "request"; id: string };
type DropTarget = { id: string; kind: "folder" | "request"; position: "before" | "after" | "inside" };

const EXPANDED_KEY = "postbox-expanded";

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

export function CollectionTree() {
  const {
    folders,
    requests,
    workspaceId,
    refreshTree,
    openRequest,
    openDraft,
    openTab,
    onEntityDeleted,
    onRequestRenamed,
    tabs,
    activeTabId,
  } = useApp();
  const setImportOpen = useDialogs((s) => s.setImportOpen);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    typeof window === "undefined" ? new Set() : loadExpanded(),
  );
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "folder" | "request"; id: string; name: string } | null>(
    null,
  );

  const activeRequestId = useMemo(() => {
    const t = tabs.find((x) => x.id === activeTabId);
    return t?.type === "request" ? t.requestId : null;
  }, [tabs, activeTabId]);

  const toggle = (id: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  // Children lookup, sorted by `sort` (folders and requests interleaved).
  const children = useMemo(() => {
    const map = new Map<
      string | null,
      ({ kind: "folder"; item: TreeFolderSummary } | { kind: "request"; item: TreeRequestSummary })[]
    >();
    for (const f of folders) {
      const list = map.get(f.parentId) ?? [];
      list.push({ kind: "folder", item: f });
      map.set(f.parentId, list);
    }
    for (const r of requests) {
      const list = map.get(r.folderId) ?? [];
      list.push({ kind: "request", item: r });
      map.set(r.folderId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.item.sort - b.item.sort);
    return map;
  }, [folders, requests]);

  // Search: keep matching requests/folders and their ancestors.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    const keep = new Set<string>();
    const parentOf = new Map<string, string | null>();
    folders.forEach((f) => parentOf.set(f.id, f.parentId));
    const addAncestors = (id: string | null) => {
      while (id) {
        keep.add(id);
        id = parentOf.get(id) ?? null;
      }
    };
    for (const r of requests) {
      if (r.name.toLowerCase().includes(q) || r.method.toLowerCase() === q) {
        keep.add(r.id);
        addAncestors(r.folderId);
      }
    }
    for (const f of folders) if (f.name.toLowerCase().includes(q)) addAncestors(f.id);
    return keep;
  }, [filter, folders, requests]);

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      await refreshTree();
      if (success) toast.success(success);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const newCollection = () =>
    run(async () => {
      const c = await api.folders.create(workspaceId!, null, "New Collection");
      setRenaming(c.id);
    });
  const newFolder = (parentId: string) =>
    run(async () => {
      const f = await api.folders.create(workspaceId!, parentId, "New Folder");
      toggle(parentId, true);
      setRenaming(f.id);
    });
  const newRequest = (folderId: string) =>
    run(async () => {
      const r = await api.requests.create(workspaceId!, folderId, {
        name: "New Request",
        method: getSetting<string>("requests.defaultMethod") || "GET",
        settings: defaultRequestSettings(),
      });
      toggle(folderId, true);
      await refreshTree();
      await openRequest(r.id);
      setRenaming(r.id);
    });

  const rename = (kind: "folder" | "request", id: string, name: string) => {
    setRenaming(null);
    if (!name.trim()) return;
    void run(async () => {
      if (kind === "folder") await api.folders.update(id, { name });
      else {
        await api.requests.update(id, { name });
        onRequestRenamed(id, name);
      }
    });
  };

  const remove = (kind: "folder" | "request", id: string) =>
    run(async () => {
      if (kind === "folder") await api.folders.remove(id);
      else await api.requests.remove(id);
      onEntityDeleted(kind, id);
    }, "Deleted");

  const exportCollection = async (id: string, name: string, format: "v2.1" | "v3" = "v2.1") => {
    const includeCredentials = window.confirm(
      "Include authentication credentials in this collection export? Choose Cancel to export without credentials.",
    );
    const query = [includeCredentials && "includeCredentials=1", format === "v3" && "format=v3"].filter(
      Boolean,
    );
    const res = await fetch(`/api/export/collection/${id}${query.length ? `?${query.join("&")}` : ""}`);
    if (!res.ok) return toast.error("Export failed");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w.-]+/g, "_")}.postman_collection${format === "v3" ? ".v3" : ""}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ---------------------------------------------------------------- drag & drop
  const onDragOver = (e: React.DragEvent, kind: "folder" | "request", id: string) => {
    if (!drag || (drag.id === id && drag.kind === kind)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    let position: DropTarget["position"];
    if (kind === "folder")
      position = y < 0.25 ? "before" : y > 0.75 && expanded.has(id) === false ? "after" : "inside";
    else position = y < 0.5 ? "before" : "after";
    // Requests cannot be placed at the root level (next to collections).
    const target = kind === "folder" ? folders.find((f) => f.id === id) : null;
    if (drag.kind === "request" && target && !target.parentId && position !== "inside") position = "inside";
    setDrop({ id, kind, position });
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const d = drag;
    const t = drop;
    setDrag(null);
    setDrop(null);
    if (!d || !t) return;
    let parentId: string | null;
    let index: number;
    if (t.position === "inside") {
      parentId = t.id;
      index = (children.get(t.id) ?? []).length;
      toggle(t.id, true);
    } else {
      parentId =
        t.kind === "folder"
          ? (folders.find((f) => f.id === t.id)?.parentId ?? null)
          : (requests.find((r) => r.id === t.id)?.folderId ?? null);
      const siblings = (children.get(parentId) ?? []).filter(
        (s) => !(s.item.id === d.id && s.kind === d.kind),
      );
      const pos = siblings.findIndex((s) => s.item.id === t.id && s.kind === t.kind);
      index = t.position === "before" ? pos : pos + 1;
    }
    if (d.kind === "request" && !parentId) return;
    await run(() => api.move(d.kind, d.id, parentId, Math.max(0, index)));
  };

  const dropClass = (kind: "folder" | "request", id: string) => {
    if (!drop || drop.id !== id || drop.kind !== kind) return "";
    if (drop.position === "inside") return "bg-primary/15 ring-1 ring-primary/50";
    return drop.position === "before"
      ? "shadow-[inset_0_2px_0_var(--primary)]"
      : "shadow-[inset_0_-2px_0_var(--primary)]";
  };

  // ---------------------------------------------------------------- rendering
  const renderNodes = (parentId: string | null, depth: number): React.ReactNode =>
    (children.get(parentId) ?? []).map((node) => {
      if (visible && !visible.has(node.item.id)) return null;
      if (node.kind === "folder") {
        const f = node.item;
        const isOpen = expanded.has(f.id) || !!visible;
        const isRoot = !f.parentId;
        return (
          <div key={f.id}>
            <div
              draggable={renaming !== f.id}
              onDragStart={(e) => {
                e.stopPropagation();
                setDrag({ kind: "folder", id: f.id });
              }}
              onDragEnd={() => (setDrag(null), setDrop(null))}
              onDragOver={(e) => onDragOver(e, "folder", f.id)}
              onDrop={onDrop}
              className={cn(
                "group flex h-7 cursor-pointer items-center gap-1 rounded pr-1 hover:bg-accent",
                dropClass("folder", f.id),
              )}
              style={{ paddingLeft: 4 + depth * 14 }}
              onClick={() => toggle(f.id)}
              onDoubleClick={() => setRenaming(f.id)}
            >
              {isOpen ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              {isRoot ? (
                <Library className="size-4 shrink-0 text-primary" />
              ) : isOpen ? (
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              )}
              {renaming === f.id ? (
                <RenameInput initial={f.name} onDone={(name) => rename("folder", f.id, name)} />
              ) : (
                <span className={cn("min-w-0 flex-1 truncate", isRoot && "font-medium")}>{f.name}</span>
              )}
              <div
                className="ml-auto flex shrink-0 items-center gap-0.5"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={`Run ${isRoot ? "collection" : "folder"} ${f.name}`}
                  title={`Run ${isRoot ? "collection" : "folder"}`}
                  onClick={() =>
                    openTab({ id: `runner-${f.id}`, type: "runner", folderId: f.id, name: f.name })
                  }
                >
                  <Play className="size-3" /> Run
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      aria-label={`Actions for ${isRoot ? "collection" : "folder"} ${f.name}`}
                      title={isRoot ? "Collection actions" : "Folder actions"}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-52">
                    <DropdownMenuItem
                      onClick={() =>
                        openTab({ id: `folder-${f.id}`, type: "folder", folderId: f.id, name: f.name })
                      }
                    >
                      <Settings2 /> {isRoot ? "Edit collection" : "Edit folder"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        openTab({ id: `runner-${f.id}`, type: "runner", folderId: f.id, name: f.name })
                      }
                    >
                      <Play /> Run {isRoot ? "collection" : "folder"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => newRequest(f.id)}>
                      <FilePlus /> Add request
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => newFolder(f.id)}>
                      <FolderPlus /> Add folder
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setRenaming(f.id)}>
                      <Pencil /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => run(() => api.folders.duplicate(f.id), "Duplicated")}>
                      <Copy /> Duplicate
                    </DropdownMenuItem>
                    {isRoot && (
                      <DropdownMenuItem onClick={() => exportCollection(f.id, f.name)}>
                        <Download /> Export (Postman v2.1)
                      </DropdownMenuItem>
                    )}
                    {isRoot && (
                      <DropdownMenuItem onClick={() => exportCollection(f.id, f.name, "v3")}>
                        <Download /> Export (Postman v3)
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setConfirm({ kind: "folder", id: f.id, name: f.name })}
                    >
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            {isOpen && (
              <div>
                {renderNodes(f.id, depth + 1)}
                {(children.get(f.id) ?? []).length === 0 && (
                  <div
                    className="py-1 text-xs text-muted-foreground"
                    style={{ paddingLeft: 24 + (depth + 1) * 14 }}
                  >
                    Empty.{" "}
                    <button className="text-primary hover:underline" onClick={() => newRequest(f.id)}>
                      Add a request
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      }
      const r = node.item;
      return (
        <div
          key={r.id}
          draggable={renaming !== r.id}
          onDragStart={(e) => {
            e.stopPropagation();
            setDrag({ kind: "request", id: r.id });
          }}
          onDragEnd={() => (setDrag(null), setDrop(null))}
          onDragOver={(e) => onDragOver(e, "request", r.id)}
          onDrop={onDrop}
          onClick={() => openRequest(r.id, { preview: getSetting<boolean>("tabs.previewOnClick") })}
          onDoubleClick={() => openRequest(r.id)}
          className={cn(
            "group flex h-7 cursor-pointer items-center gap-2 rounded pr-1 hover:bg-accent",
            activeRequestId === r.id && "bg-accent",
            dropClass("request", r.id),
          )}
          style={{ paddingLeft: 22 + depth * 14 }}
        >
          <span
            className={cn("w-11 shrink-0 text-right font-mono text-[10px] font-bold", methodColor(r.method))}
          >
            {r.method.length > 6 ? r.method.slice(0, 5) : r.method === "DELETE" ? "DEL" : r.method}
          </span>
          {renaming === r.id ? (
            <RenameInput initial={r.name} onDone={(name) => rename("request", r.id, name)} />
          ) : (
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
          )}
          <div
            className="ml-auto flex shrink-0"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={`Actions for request ${r.name}`}
                  title="Request actions"
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuItem onClick={() => openRequest(r.id)}>Open in tab</DropdownMenuItem>
                <DropdownMenuItem onClick={() => useDialogs.getState().openExamples(r.id)}>
                  Manage examples
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRenaming(r.id)}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => run(() => api.requests.duplicate(r.id), "Duplicated")}>
                  <Copy /> Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setConfirm({ kind: "request", id: r.id, name: r.name })}
                >
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      );
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 p-2">
        <Button variant="ghost" size="icon" className="size-7" title="New collection" onClick={newCollection}>
          <Plus className="size-4" />
        </Button>
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Import"
          onClick={() => setImportOpen(true)}
        >
          <Upload className="size-4" />
        </Button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto px-1 pb-4 text-[13px]"
        onDragOver={(e) => drag?.kind === "folder" && e.preventDefault()}
      >
        {folders.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-6 text-center text-xs text-muted-foreground">
            <Library className="size-8 opacity-40" />
            <span>Collections group your requests. Create one or import from Postman, OpenAPI or cURL.</span>
            <div className="flex gap-2">
              <Button size="sm" onClick={newCollection}>
                New collection
              </Button>
              <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                Import
              </Button>
            </div>
            <button className="text-primary hover:underline" onClick={() => openDraft()}>
              or open a scratch request
            </button>
          </div>
        ) : (
          renderNodes(null, 0)
        )}
      </div>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete "${confirm?.name}"?`}
        description={
          confirm?.kind === "folder"
            ? "This deletes the folder and everything inside it."
            : "This request will be permanently deleted."
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => confirm && remove(confirm.kind, confirm.id)}
      />
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      className="h-6 min-w-0 flex-1 rounded border border-primary bg-background px-1 outline-none"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.target.select()}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value);
        if (e.key === "Escape") onDone(initial);
      }}
    />
  );
}
