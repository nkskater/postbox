"use client";
/** Live sample of the current appearance settings. */
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { methodColor } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AppearancePreview() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card" aria-label="Appearance preview">
      <div className="flex h-8 items-stretch border-b bg-sidebar text-xs">
        <div className="flex items-center gap-1.5 border-t-2 border-r border-t-primary bg-background px-3">
          <span className={cn("font-mono text-[10px] font-bold", methodColor("GET"))}>GET</span> List users
        </div>
        <div className="flex items-center gap-1.5 border-r px-3 text-muted-foreground">
          <span className={cn("font-mono text-[10px] font-bold", methodColor("POST"))}>POST</span> Create user
        </div>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value="https://api.example.com/users?page=1"
            className="h-8 flex-1 font-mono text-xs"
          />
          <Button size="sm">
            <Send className="size-3.5" /> Send
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <span className="text-muted-foreground">
            Status: <span className="font-medium text-success">200 OK</span>
          </span>
          <a className="text-primary hover:underline" href="#" onClick={(e) => e.preventDefault()}>
            A link
          </a>
          <span className="flex items-center gap-2">
            <Switch checked aria-label="Sample switch" /> Toggle
          </span>
          <Button size="sm" variant="outline" className="h-7">
            Secondary
          </Button>
          <span className="rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">badge</span>
        </div>
      </div>
    </div>
  );
}
