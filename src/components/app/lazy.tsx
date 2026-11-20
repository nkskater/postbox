"use client";
/**
 * Panels, editors and dialogs that are not needed for the first paint. Each loads its code the
 * first time it is shown, so the home page only ships the request editor, response viewer and
 * collection tree. `scripts/bundle-budget.mjs` keeps the first load within budget.
 */
import dynamic from "next/dynamic";

function PanelSkeleton() {
  return (
    <div className="flex h-full items-center justify-center p-6" aria-busy="true">
      <div className="h-1 w-24 animate-pulse rounded bg-muted" />
    </div>
  );
}

// Feature tabs
export const AssistantPanel = dynamic(
  () => import("@/components/assistant/AssistantPanel").then((m) => m.AssistantPanel),
  { ssr: false, loading: PanelSkeleton },
);
export const TelemetryPanel = dynamic(
  () => import("@/components/telemetry/TelemetryPanel").then((m) => m.TelemetryPanel),
  { ssr: false, loading: PanelSkeleton },
);
export const GovernancePanel = dynamic(
  () => import("@/components/governance/GovernancePanel").then((m) => m.GovernancePanel),
  { ssr: false, loading: PanelSkeleton },
);
export const SpecificationsPanel = dynamic(
  () => import("@/components/specifications/SpecificationsPanel").then((m) => m.SpecificationsPanel),
  { ssr: false, loading: PanelSkeleton },
);
export const GraphPanel = dynamic(() => import("@/components/graph/GraphPanel").then((m) => m.GraphPanel), {
  ssr: false,
  loading: PanelSkeleton,
});
export const MonitorsPanel = dynamic(
  () => import("@/components/monitors/MonitorsPanel").then((m) => m.MonitorsPanel),
  { ssr: false, loading: PanelSkeleton },
);
export const McpClientPanel = dynamic(
  () => import("@/components/mcp-client/McpClientPanel").then((m) => m.McpClientPanel),
  { ssr: false, loading: PanelSkeleton },
);
export const CatalogBrowser = dynamic(
  () => import("@/components/catalog/CatalogBrowser").then((m) => m.CatalogBrowser),
  { ssr: false, loading: PanelSkeleton },
);

// Editors and views opened from the collection tree, the environment list or the top bar
export const FolderEditor = dynamic(
  () => import("@/components/folder/FolderEditor").then((m) => m.FolderEditor),
  { ssr: false, loading: PanelSkeleton },
);
export const EnvironmentEditor = dynamic(
  () => import("@/components/env/EnvironmentEditor").then((m) => m.EnvironmentEditor),
  { ssr: false, loading: PanelSkeleton },
);
export const RunnerTabs = dynamic(() => import("@/components/runner/RunnerTabs").then((m) => m.RunnerTabs), {
  ssr: false,
  loading: PanelSkeleton,
});
export const SettingsView = dynamic(
  () => import("@/components/settings/SettingsView").then((m) => m.SettingsView),
  { ssr: false, loading: PanelSkeleton },
);
export const CookiesView = dynamic(() => import("./CookiesView").then((m) => m.CookiesView), {
  ssr: false,
  loading: PanelSkeleton,
});
export const ConsolePanel = dynamic(
  () => import("@/components/console/ConsolePanel").then((m) => m.ConsolePanel),
  { ssr: false, loading: PanelSkeleton },
);

// Sidebar lists of optional areas
export const PackageList = dynamic(
  () => import("@/components/sidebar/PackageList").then((m) => m.PackageList),
  { ssr: false, loading: PanelSkeleton },
);
export const MockList = dynamic(() => import("@/components/sidebar/MockList").then((m) => m.MockList), {
  ssr: false,
  loading: PanelSkeleton,
});
export const DatasetList = dynamic(
  () => import("@/components/sidebar/DatasetList").then((m) => m.DatasetList),
  { ssr: false, loading: PanelSkeleton },
);

// Dialogs render nothing until their code is ready; they only mount once first opened.
export const ImportDialog = dynamic(
  () => import("@/components/dialogs/ImportDialog").then((m) => m.ImportDialog),
  { ssr: false, loading: () => null },
);
export const ExamplesDialog = dynamic(
  () => import("@/components/dialogs/ExamplesDialog").then((m) => m.ExamplesDialog),
  { ssr: false, loading: () => null },
);
export const DatasetEditorDialog = dynamic(
  () => import("@/components/dialogs/DatasetEditorDialog").then((m) => m.DatasetEditorDialog),
  { ssr: false, loading: () => null },
);
export const ScriptPackageDialog = dynamic(
  () => import("@/components/dialogs/ScriptPackageDialog").then((m) => m.ScriptPackageDialog),
  { ssr: false, loading: () => null },
);
export const CodeSnippetDialog = dynamic(
  () => import("@/components/dialogs/CodeSnippetDialog").then((m) => m.CodeSnippetDialog),
  { ssr: false, loading: () => null },
);
export const CommandPalette = dynamic(
  () => import("@/components/dialogs/CommandPalette").then((m) => m.CommandPalette),
  { ssr: false, loading: () => null },
);
export const ShortcutsDialog = dynamic(
  () => import("@/components/dialogs/ShortcutsDialog").then((m) => m.ShortcutsDialog),
  { ssr: false, loading: () => null },
);
