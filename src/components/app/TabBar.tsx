"use client";
import { Cookie, Globe, Layers, Library, Play, Plus, X } from "lucide-react";
import { useApp, snapshot, type Tab } from "@/stores/app";
import { methodColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

function TabTitle({ tab }: { tab: Tab }) {
  switch (tab.type) {
    case "request":
      return (
        <>
          <span className={cn("font-mono text-[10px] font-bold", methodColor(tab.draft.method))}>
            {tab.draft.method}
          </span>
          <span className={cn("truncate", tab.preview && "italic")}>{tab.draft.name}</span>
        </>
      );
    case "folder":
      return (
        <>
          <Library className="size-3.5 shrink-0 text-primary" />
          <span className="truncate">{tab.name}</span>
        </>
      );
    case "runner":
      return (
        <>
          <Play className="size-3.5 shrink-0 text-success" />
          <span className="truncate">Runner · {tab.name}</span>
        </>
      );
    case "environment":
      return (
        <>
          <Layers className="size-3.5 shrink-0" />
          <span className="truncate">{tab.name}</span>
        </>
      );
    case "globals":
      return (
        <>
          <Globe className="size-3.5 shrink-0" />
          <span>Globals</span>
        </>
      );
    case "cookies":
      return (
        <>
          <Cookie className="size-3.5 shrink-0" />
          <span>Cookies</span>
        </>
      );
  }
}

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, closeOtherTabs, openDraft } = useApp();
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-sidebar">
      {tabs.map((t) => {
        const dirty = t.type === "request" && (t.saved === null ? false : t.saved !== snapshot(t.draft));
        return (
          <ContextMenu key={t.id}>
            <ContextMenuTrigger asChild>
              <div
                onClick={() => setActiveTab(t.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
                className={cn(
                  "group flex max-w-56 min-w-32 cursor-pointer items-center gap-1.5 border-r px-3 text-xs",
                  activeTabId === t.id
                    ? "border-t-2 border-t-primary bg-background"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                <TabTitle tab={t} />
                <button
                  className={cn(
                    "ml-auto flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent hover:text-foreground",
                    activeTabId === t.id ? "text-foreground/80" : "text-muted-foreground",
                  )}
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  title="Close tab (Alt+W)"
                >
                  {dirty ? (
                    <>
                      <span className="size-2 rounded-full bg-primary group-hover:hidden" />
                      <X className="hidden size-3.5 group-hover:block" />
                    </>
                  ) : (
                    <X className="size-3.5" />
                  )}
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => closeTab(t.id)}>Close</ContextMenuItem>
              <ContextMenuItem onClick={() => closeOtherTabs(t.id)}>Close others</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      <button
        className="flex w-9 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent"
        onClick={() => openDraft()}
        title="New request (Ctrl+T)"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}
