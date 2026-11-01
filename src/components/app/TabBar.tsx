"use client";
import { useShortcutLabel } from "@/lib/use-shortcuts";
import { Settings, Cookie, Globe, Layers, Library, Play, Plus, X } from "lucide-react";
import { useApp, snapshot, type Tab } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
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
    case "catalog":
      return (
        <>
          <Library className="size-3.5 shrink-0" />
          <span>API catalog</span>
        </>
      );
    case "settings":
      return (
        <>
          <Settings className="size-3.5 shrink-0" />
          <span>Settings</span>
        </>
      );
  }
}

export function TabBar() {
  const newRequestKey = useShortcutLabel("newRequest");
  const { tabs, activeTabId, setActiveTab, closeTab, requestCloseTab, closeOtherTabs, openDraft } = useApp();
  const confirmCloseTabId = useDialogs((s) => s.confirmCloseTabId);
  const setConfirmCloseTabId = useDialogs((s) => s.setConfirmCloseTabId);
  const confirmTab = tabs.find((t) => t.id === confirmCloseTabId);
  return (
    <>
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-sidebar">
        {tabs.map((t) => {
          const dirty = t.type === "request" && (t.saved === null ? false : t.saved !== snapshot(t.draft));
          return (
            <ContextMenu key={t.id}>
              <ContextMenuTrigger asChild>
                <div
                  onClick={() => setActiveTab(t.id)}
                  onAuxClick={(e) => e.button === 1 && requestCloseTab(t.id)}
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
                      requestCloseTab(t.id);
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
                <ContextMenuItem onClick={() => requestCloseTab(t.id)}>Close</ContextMenuItem>
                <ContextMenuItem onClick={() => closeOtherTabs(t.id)}>Close others</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        <button
          className="flex w-9 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent"
          onClick={() => openDraft()}
          title={`New request (${newRequestKey})`}
        >
          <Plus className="size-4" />
        </button>
      </div>
      <ConfirmDialog
        open={!!confirmTab}
        onOpenChange={(o) => !o && setConfirmCloseTabId(null)}
        title={`Discard unsaved changes to "${confirmTab?.type === "request" ? confirmTab.draft.name : "this tab"}"?`}
        description="Closing this tab discards your unsaved changes. You can turn this prompt off in Settings → Tabs."
        confirmLabel="Discard and close"
        destructive
        onConfirm={() => {
          if (confirmCloseTabId) closeTab(confirmCloseTabId);
          setConfirmCloseTabId(null);
        }}
      />
    </>
  );
}
