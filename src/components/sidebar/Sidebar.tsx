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
            onClick={() => setView(v.id)}
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
