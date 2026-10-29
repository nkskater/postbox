"use client";
import { History, Layers, Library } from "lucide-react";
import { useApp } from "@/stores/app";
import { cn } from "@/lib/utils";
import { CollectionTree } from "./CollectionTree";
import { EnvironmentList } from "./EnvironmentList";
import { HistoryList } from "./HistoryList";

const VIEWS = [
  { id: "collections", label: "Collections", icon: Library },
  { id: "environments", label: "Environments", icon: Layers },
  { id: "history", label: "History", icon: History },
] as const;

/** Icon rail + the active sidebar panel. */
export function Sidebar() {
  const view = useApp((s) => s.sidebarView);
  const setView = useApp((s) => s.setSidebarView);
  return (
    <div className="flex h-full bg-sidebar">
      <nav className="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r py-2">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={cn(
              "flex w-[68px] flex-col items-center gap-0.5 rounded-md py-1.5 text-[10px]",
              view === v.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            <v.icon className="size-4" />
            {v.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {view === "collections" && <CollectionTree />}
        {view === "environments" && <EnvironmentList />}
        {view === "history" && <HistoryList />}
      </div>
    </div>
  );
}
