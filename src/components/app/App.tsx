"use client";
/**
 * Application shell: header, resizable sidebar / main area / console layout,
 * global dialogs and keyboard shortcuts.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthenticationRequired } from "@/lib/api";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { Toaster } from "sonner";
import { Terminal } from "lucide-react";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { RequestEditor } from "@/components/request/RequestEditor";
import { FolderEditor } from "@/components/folder/FolderEditor";
import { EnvironmentEditor } from "@/components/env/EnvironmentEditor";
import { ConsolePanel } from "@/components/console/ConsolePanel";
import { RunnerView } from "@/components/runner/RunnerView";
import { SaveRequestDialog } from "@/components/dialogs/SaveRequestDialog";
import { ShortcutsDialog } from "@/components/dialogs/ShortcutsDialog";
import { CommandPalette } from "@/components/dialogs/CommandPalette";
import { ImportDialog } from "@/components/dialogs/ImportDialog";
import { DatasetEditorDialog } from "@/components/dialogs/DatasetEditorDialog";
import { ExamplesDialog } from "@/components/dialogs/ExamplesDialog";
import { CodeSnippetDialog } from "@/components/dialogs/CodeSnippetDialog";
import { TopBar } from "./TopBar";
import { TabBar } from "./TabBar";
import { CookiesView } from "./CookiesView";
import { SettingsView } from "@/components/settings/SettingsView";
import { useSettings, useSetting } from "@/stores/settings";

function MainArea() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const openDraft = useApp((s) => s.openDraft);
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>No open tabs.</p>
        <button className="text-primary hover:underline" onClick={() => openDraft()}>
          Create a new request
        </button>
        <p className="text-xs">Alt+T new request · Ctrl+K command palette · ? shortcuts</p>
      </div>
    );
  }
  switch (tab.type) {
    case "request":
      return <RequestEditor key={tab.id} tab={tab} />;
    case "folder":
      return <FolderEditor key={tab.folderId} folderId={tab.folderId} />;
    case "environment":
      return <EnvironmentEditor key={tab.environmentId} environmentId={tab.environmentId} />;
    case "globals":
      return <EnvironmentEditor key="globals" environmentId={null} />;
    case "runner":
      return <RunnerView key={tab.folderId} folderId={tab.folderId} />;
    case "cookies":
      return <CookiesView />;
    case "settings":
      return <SettingsView />;
  }
}

const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return (
    !!el &&
    (el.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
      !!el.closest(".cm-editor"))
  );
};

export function App({ authEnabled }: { authEnabled: boolean }) {
  const router = useRouter();
  const init = useApp((s) => s.init);
  const consoleOpen = useApp((s) => s.consoleOpen);
  const setConsoleOpen = useApp((s) => s.setConsoleOpen);
  const theme = useApp((s) => s.theme);
  const sidebarRight = useSetting<string>("layout.sidebarPosition") === "right";
  const entriesCount = useApp((s) => s.consoleEntries.length);
  const saveTabId = useDialogs((s) => s.saveTabId);
  const openSave = useDialogs((s) => s.openSave);
  const saveTab = useApp((s) => s.saveTab);
  const tabs = useApp((s) => s.tabs);
  const sidebarRef = usePanelRef();
  const [ready, setReady] = useState(false);
  const initOnce = useRef(false);

  // Subscribe before initialization so bootstrap requests can also report an expired session.
  useEffect(() => {
    let redirecting = false;
    return onAuthenticationRequired(() => {
      if (redirecting) return;
      redirecting = true;
      router.replace("/login");
      router.refresh();
    });
  }, [router]);

  useEffect(() => {
    if (initOnce.current) return;
    initOnce.current = true;
    void useSettings.getState().init();
    init()
      .catch((e) => console.error(e))
      .finally(() => setReady(true));
  }, [init]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      const d = useDialogs.getState();
      const mod = e.ctrlKey || e.metaKey;
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      const key = e.key.toLowerCase();
      if (mod && key === "enter" && tab?.type === "request") {
        e.preventDefault();
        void s.sendTab(tab.id);
      } else if (mod && key === "s" && tab?.type === "request") {
        e.preventDefault();
        if (tab.requestId) void s.saveTab(tab.id);
        else d.openSave(tab.id);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        s.openTab({ id: "settings", type: "settings", name: "Settings" });
      } else if (mod && key === "k") {
        e.preventDefault();
        d.setPaletteOpen(true);
      } else if (mod && key === "`") {
        e.preventDefault();
        s.setConsoleOpen(!s.consoleOpen);
      } else if (mod && key === "b") {
        e.preventDefault();
        const p = sidebarRef.current;
        if (p?.isCollapsed()) p.expand();
        else p?.collapse();
      } else if (e.altKey && key === "t") {
        e.preventDefault();
        s.openDraft();
      } else if (e.altKey && key === "w" && s.activeTabId) {
        e.preventDefault();
        s.requestCloseTab(s.activeTabId);
      } else if (e.altKey && /^[1-9]$/.test(e.key)) {
        const t = s.tabs[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          s.setActiveTab(t.id);
        }
      } else if (!mod && e.key === "?" && !isTyping(e)) {
        d.setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarRef]);

  const saveTarget = tabs.find((t) => t.id === saveTabId);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col">
        <TopBar authEnabled={authEnabled} />
        {ready ? (
          <Group orientation="horizontal" className="min-h-0 flex-1">
            {sidebarRight ? (
              <>
                <Panel id="main" minSize="30">
                  <Group orientation="vertical" className="h-full">
                    <Panel minSize="20">
                      <div className="flex h-full min-h-0 flex-col">
                        <TabBar />
                        <div className="min-h-0 flex-1">
                          <MainArea />
                        </div>
                      </div>
                    </Panel>
                    {consoleOpen && (
                      <>
                        <Separator className="h-px bg-border transition-colors hover:bg-primary data-[separator=active]:bg-primary" />
                        <Panel defaultSize="30" minSize="10">
                          <ConsolePanel />
                        </Panel>
                      </>
                    )}
                  </Group>
                </Panel>
                <Separator className="w-px bg-border transition-colors hover:bg-primary data-[separator=active]:bg-primary" />
                <Panel
                  id="sidebar"
                  panelRef={sidebarRef}
                  defaultSize={300}
                  minSize={200}
                  maxSize="50"
                  collapsible
                  collapsedSize={0}
                >
                  <Sidebar />
                </Panel>
              </>
            ) : (
              <>
                <Panel
                  id="sidebar"
                  panelRef={sidebarRef}
                  defaultSize={300}
                  minSize={200}
                  maxSize="50"
                  collapsible
                  collapsedSize={0}
                >
                  <Sidebar />
                </Panel>
                <Separator className="w-px bg-border transition-colors hover:bg-primary data-[separator=active]:bg-primary" />
                <Panel id="main" minSize="30">
                  <Group orientation="vertical" className="h-full">
                    <Panel minSize="20">
                      <div className="flex h-full min-h-0 flex-col">
                        <TabBar />
                        <div className="min-h-0 flex-1">
                          <MainArea />
                        </div>
                      </div>
                    </Panel>
                    {consoleOpen && (
                      <>
                        <Separator className="h-px bg-border transition-colors hover:bg-primary data-[separator=active]:bg-primary" />
                        <Panel defaultSize="30" minSize="10">
                          <ConsolePanel />
                        </Panel>
                      </>
                    )}
                  </Group>
                </Panel>
              </>
            )}
          </Group>
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">Loading…</div>
        )}
        <footer className="flex h-6 shrink-0 items-center gap-3 border-t bg-sidebar px-3 text-[11px] text-muted-foreground">
          <button
            className="flex items-center gap-1 hover:text-foreground"
            onClick={() => setConsoleOpen(!consoleOpen)}
          >
            <Terminal className="size-3" /> Console {entriesCount > 0 && `(${entriesCount})`}
          </button>
          <span className="ml-auto">Ctrl+K commands · ? shortcuts</span>
        </footer>
      </div>
      <SaveRequestDialog
        open={!!saveTabId}
        onOpenChange={(o) => !o && openSave(null)}
        defaultName={saveTarget?.type === "request" ? saveTarget.draft.name : ""}
        onSave={async (target) => {
          if (saveTabId) await saveTab(saveTabId, target);
        }}
      />
      <ShortcutsDialog />
      <CommandPalette />
      <ImportDialog />
      <ExamplesDialog />
      <DatasetEditorDialog />
      <CodeSnippetDialog />
      <Toaster theme={theme} position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
