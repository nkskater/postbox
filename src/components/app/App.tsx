"use client";
/**
 * Application shell: header, resizable sidebar / main area / console layout,
 * global dialogs and keyboard shortcuts.
 */
import { ShortcutHint } from "./ShortcutHint";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthenticationRequired } from "@/lib/api";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { Toaster, type ToasterProps } from "sonner";
import { Terminal } from "lucide-react";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { RequestEditor } from "@/components/request/RequestEditor";
import { SaveRequestDialog } from "@/components/dialogs/SaveRequestDialog";
import { TopBar } from "./TopBar";
import { TabBar } from "./TabBar";
import { useSettings, useSetting } from "@/stores/settings";
import { actionForEvent, comboFromEvent } from "@/lib/shortcuts";
import { currentBindings } from "@/lib/use-shortcuts";
import { featureOfView } from "@/core/features";
import { FeatureGate } from "./FeatureGate";
import {
  AssistantPanel,
  TelemetryPanel,
  GovernancePanel,
  SpecificationsPanel,
  GraphPanel,
  MonitorsPanel,
  McpClientPanel,
  CatalogBrowser,
  FolderEditor,
  EnvironmentEditor,
  ConsolePanel,
  RunnerTabs,
  ImportDialog,
  ScriptPackageDialog,
  DatasetEditorDialog,
  ExamplesDialog,
  CodeSnippetDialog,
  CookiesView,
  SettingsView,
  CommandPalette,
  ShortcutsDialog,
} from "./lazy";

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
        <p className="text-xs">
          <ShortcutHint id="newRequest" /> new request · <ShortcutHint id="palette" /> command palette ·{" "}
          <ShortcutHint id="help" /> shortcuts
        </p>
      </div>
    );
  }
  // Every tab except a request stays mounted while open (hidden when another tab is active), so unsaved
  // edits, runner data tables, selections and runs in progress survive tab switches. Request tabs keep
  // their draft and result in the store instead, so only the active one is rendered.
  const kept = tabs.filter((t): t is Exclude<typeof t, { type: "request" }> => t.type !== "request");
  return (
    <>
      {kept.map((t) => (
        <div key={t.id} className={t.id === tab.id ? "h-full" : "hidden"}>
          {renderTab(t)}
        </div>
      ))}
      {tab.type === "request" && <RequestEditor key={tab.id} tab={tab} />}
    </>
  );
}

function renderTab(tab: Exclude<ReturnType<typeof useApp.getState>["tabs"][number], { type: "request" }>) {
  // A tab of a feature area that was switched off while open explains itself instead of failing.
  const feature = featureOfView(tab.type);
  const content = renderTabContent(tab);
  return feature ? (
    <FeatureGate feature={feature} notice>
      {content}
    </FeatureGate>
  ) : (
    content
  );
}

function renderTabContent(
  tab: Exclude<ReturnType<typeof useApp.getState>["tabs"][number], { type: "request" }>,
) {
  switch (tab.type) {
    case "runner":
      return <RunnerTabs folderId={tab.folderId} />;
    case "folder":
      return <FolderEditor key={tab.folderId} folderId={tab.folderId} />;
    case "environment":
      return <EnvironmentEditor key={tab.environmentId} environmentId={tab.environmentId} />;
    case "globals":
      return <EnvironmentEditor key="globals" environmentId={null} />;
    case "cookies":
      return <CookiesView />;
    case "assistant":
      return <AssistantPanel />;
    case "telemetry":
      return <TelemetryPanel />;
    case "governance":
      return <GovernancePanel />;
    case "specifications":
      return <SpecificationsPanel />;
    case "monitors":
      return <MonitorsPanel />;
    case "mcp-client":
      return <McpClientPanel />;
    case "catalog":
      return <CatalogBrowser />;
    case "graph":
      return <GraphPanel />;
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
  const toastPosition = useSetting<string>("notifications.position");
  const toastSeconds = useSetting<number>("notifications.durationSeconds");
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

  // Global keyboard shortcuts. The bindings are read on every key press, so a rebinding applies at once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      const d = useDialogs.getState();
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      const action = actionForEvent(e, currentBindings(), isTyping(e));
      if (action === "send" && tab?.type === "request") {
        e.preventDefault();
        void s.sendTab(tab.id);
      } else if (action === "save" && tab?.type === "request") {
        e.preventDefault();
        if (tab.requestId) void s.saveTab(tab.id);
        else d.openSave(tab.id);
      } else if (action === "settings") {
        e.preventDefault();
        s.openTab({ id: "settings", type: "settings", name: "Settings" });
      } else if (action === "palette") {
        e.preventDefault();
        d.setPaletteOpen(true);
      } else if (action === "console") {
        e.preventDefault();
        s.setConsoleOpen(!s.consoleOpen);
      } else if (action === "sidebar") {
        e.preventDefault();
        const p = sidebarRef.current;
        if (p?.isCollapsed()) p.expand();
        else p?.collapse();
      } else if (action === "newRequest") {
        e.preventDefault();
        s.openDraft();
      } else if (action === "closeTab" && s.activeTabId) {
        e.preventDefault();
        s.requestCloseTab(s.activeTabId);
      } else if (/^Alt\+[1-9]$/.test(comboFromEvent(e) ?? "")) {
        const t = s.tabs[Number(comboFromEvent(e)!.slice(-1)) - 1];
        if (t) {
          e.preventDefault();
          s.setActiveTab(t.id);
        }
      } else if (action === "help") {
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
                    <Panel id="main-content" minSize="20">
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
                        <Panel id="console-panel" defaultSize="30" minSize="10">
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
                    <Panel id="main-content-right" minSize="20">
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
                        <Panel id="console-panel-right" defaultSize="30" minSize="10">
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
          <span className="ml-auto">
            <ShortcutHint id="palette" /> commands · <ShortcutHint id="help" /> shortcuts
          </span>
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
      <LazyDialogs />
      <Toaster
        theme={theme}
        position={toastPosition as ToasterProps["position"]}
        duration={toastSeconds * 1000}
        richColors
        closeButton
      />
    </TooltipProvider>
  );
}

/**
 * Dialogs whose code loads on first use: each mounts the first time it is opened and stays mounted
 * afterwards, so closing animations and later openings behave as before.
 */
/** True from the first time `open` is true; lets a dialog mount on first use and then stay mounted. */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

function LazyDialogs() {
  const importOpen = useOpenedOnce(useDialogs((s) => s.importOpen));
  const examples = useOpenedOnce(useDialogs((s) => s.exampleRequestId !== null));
  const dataset = useOpenedOnce(useDialogs((s) => s.datasetEditor !== null));
  const scriptPackage = useOpenedOnce(useDialogs((s) => s.scriptPackageEditor !== null));
  const code = useOpenedOnce(useDialogs((s) => s.codeTabId !== null));
  const palette = useOpenedOnce(useDialogs((s) => s.paletteOpen));
  const shortcuts = useOpenedOnce(useDialogs((s) => s.shortcutsOpen));
  return (
    <>
      {importOpen && <ImportDialog />}
      {examples && <ExamplesDialog />}
      {dataset && <DatasetEditorDialog />}
      {scriptPackage && <ScriptPackageDialog />}
      {code && <CodeSnippetDialog />}
      {palette && <CommandPalette />}
      {shortcuts && <ShortcutsDialog />}
    </>
  );
}
