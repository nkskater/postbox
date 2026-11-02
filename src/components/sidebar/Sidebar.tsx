"use client";
import { Database, History, Layers, Library, Server } from "lucide-react";
import { useApp } from "@/stores/app";
import { useSetting } from "@/stores/settings";
import { cn } from "@/lib/utils";
import { CollectionTree } from "./CollectionTree";
import { EnvironmentList } from "./EnvironmentList";
import { PackageList } from "./PackageList";
import { MockList } from "./MockList";
import { DatasetList } from "./DatasetList";
import { HistoryList } from "./HistoryList";

const VIEWS = [
  { id: "mcp-client", label: "MCP client", icon: Server },
  { id: "catalog", label: "Catalog", icon: Library },
  { id: "packages", label: "Packages", icon: Library },
  { id: "mocks", label: "Mocks", icon: Server },
  { id: "datasets", label: "Datasets", icon: Database },
  { id: "collections", label: "Collections", icon: Library },
  { id: "environments", label: "Environments", icon: Layers },
  { id: "history", label: "History", icon: History },
] as const;

/** Icon rail + the active sidebar panel. */
export function Sidebar() {
  const view = useApp((s) => s.sidebarView);
  const setView = useApp((s) => s.setSidebarView);
  const labels = useSetting<boolean>("layout.sidebarLabels");
  const right = useSetting<string>("layout.sidebarPosition") === "right";
  return (
    <div className={cn("flex h-full bg-sidebar", right && "flex-row-reverse")}>
      <nav
        className={cn(
          "flex shrink-0 flex-col items-center gap-1 py-2",
          labels ? "w-[76px]" : "w-12",
          right ? "border-l" : "border-r",
        )}
      >
        {VIEWS.map((v) => (
          <button
            key={v.id}
            title={v.label}
            onClick={() => {
              setView(v.id);
              if (v.id === "mcp-client")
                useApp.getState().openTab({ id: "mcp-client", type: "mcp-client", name: "MCP client" });
              if (v.id === "catalog")
                useApp.getState().openTab({ id: "api-catalog", type: "catalog", name: "API catalog" });
            }}
            className={cn(
              labels ? "flex w-[68px] flex-col" : "flex w-9 flex-col justify-center",
              " items-center gap-0.5 rounded-md py-1.5 text-[10px]",
              view === v.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            <v.icon className="size-4" />
            {labels && v.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {view === "mcp-client" && (
          <div className="p-3 space-y-3 text-xs">
            <h2 className="font-medium">MCP client</h2>
            <p>
              Discover and test external MCP servers. Save calls in the current workspace and supply
              credentials through variables.
            </p>
            <button
              className="underline text-primary"
              onClick={() =>
                useApp.getState().openTab({ id: "mcp-client", type: "mcp-client", name: "MCP client" })
              }
            >
              Open MCP client
            </button>
          </div>
        )}
        {view === "catalog" && (
          <div className="space-y-3 p-3 text-xs">
            <h2 className="font-medium">API catalog</h2>
            <p>
              Browse versioned APIs across workspaces. Publish from a collection’s Catalog publishing tab.
            </p>
            <button
              className="text-primary underline"
              onClick={() =>
                useApp.getState().openTab({ id: "api-catalog", type: "catalog", name: "API catalog" })
              }
            >
              Browse catalog
            </button>
          </div>
        )}
        {view === "collections" && <CollectionTree />}
        {view === "environments" && <EnvironmentList />}
        {view === "history" && <HistoryList />}
        {view === "datasets" && <DatasetList />}
        {view === "mocks" && <MockList />}
        {view === "packages" && <PackageList />}
      </div>
    </div>
  );
}
