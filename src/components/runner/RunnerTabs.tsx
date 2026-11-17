"use client";
/** The runner tab of a collection: a functional run, or a load test. */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { LoadTestPanel } from "./LoadTestPanel";
import { RunnerView } from "./RunnerView";
import { useFeature } from "@/components/app/FeatureGate";

export function RunnerTabs({ folderId }: { folderId: string }) {
  const [mode, setMode] = useState<"run" | "load">("run");
  // Without load testing there is only the collection run, so the mode switch is not shown.
  if (!useFeature("load")) return <RunnerView folderId={folderId} />;
  return (
    <div className="flex h-full flex-col">
      <div role="tablist" aria-label="Runner mode" className="flex gap-1 border-b px-3 pt-2 text-xs">
        {(
          [
            ["run", "Collection run"],
            ["load", "Load test"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={mode === id}
            onClick={() => setMode(id)}
            className={cn(
              "rounded-t px-3 py-1.5",
              mode === id
                ? "border border-b-0 bg-background font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {mode === "run" ? <RunnerView folderId={folderId} /> : <LoadTestPanel folderId={folderId} />}
      </div>
    </div>
  );
}
