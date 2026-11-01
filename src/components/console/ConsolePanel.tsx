"use client";
/**
 * Console panel showing script console.* output and network log lines.
 */
import { formatTime } from "@/lib/format";
import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, ChevronDown, Search } from "lucide-react";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSetting } from "@/stores/settings";

const LEVEL_CLASS: Record<string, string> = {
  error: "text-destructive",
  warn: "text-warning",
  info: "text-sky-400",
  debug: "text-muted-foreground",
  log: "",
};

export function ConsolePanel() {
  const entries = useApp((s) => s.consoleEntries);
  const clear = useApp((s) => s.clearConsole);
  const setOpen = useApp((s) => s.setConsoleOpen);
  const timestamps = useSetting<boolean>("console.timestamps");
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<string>("all");
  const end = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () =>
      entries.filter(
        (e) =>
          (level === "all" || e.level === level) &&
          (!filter || e.message.toLowerCase().includes(filter.toLowerCase())),
      ),
    [entries, filter, level],
  );

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [shown.length]);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center gap-2 border-b px-2 py-1 text-xs">
        <span className="font-medium">Console</span>
        <div className="relative ml-2 w-56">
          <Search className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search messages"
            className="h-6 pl-6 text-xs"
          />
        </div>
        {["all", "log", "info", "warn", "error"].map((l) => (
          <button
            key={l}
            onClick={() => setLevel(l)}
            className={cn(
              "rounded px-1.5 py-0.5 capitalize",
              level === l ? "bg-accent" : "text-muted-foreground",
            )}
          >
            {l}
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon" className="size-6" title="Clear" onClick={clear}>
            <Ban className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6" title="Close" onClick={() => setOpen(false)}>
            <ChevronDown className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-xs">
        {shown.length === 0 && (
          <div className="p-2 text-muted-foreground">
            No console output yet. Use console.log() in scripts.
          </div>
        )}
        {shown.map((e, i) => (
          <div key={i} className="flex gap-3 border-b border-border/40 py-0.5">
            {timestamps && <span className="shrink-0 text-muted-foreground">{formatTime(e.timestamp)}</span>}
            <span className={cn("min-w-0 flex-1 break-all whitespace-pre-wrap", LEVEL_CLASS[e.level])}>
              {e.message}
            </span>
            <span className="shrink-0 truncate text-[10px] text-muted-foreground">{e.source}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
