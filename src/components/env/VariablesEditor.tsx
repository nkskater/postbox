"use client";
/**
 * Variable table with enable toggle, type (default/secret), masked secret values
 * with reveal, and a trailing add row.
 */
import { useState } from "react";
import { Eye, EyeOff, Search, Trash2 } from "lucide-react";
import type { Variable } from "@/core/types";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useSetting } from "@/stores/settings";

export function VariablesEditor({
  variables,
  onChange,
}: {
  variables: Variable[];
  onChange: (v: Variable[]) => void;
}) {
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const revealSecrets = useSetting<boolean>("variables.revealSecrets");
  const [filter, setFilter] = useState("");
  const rows: Variable[] = [...variables, { key: "", value: "", type: "default", enabled: true }];

  const update = (i: number, patch: Partial<Variable>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next.filter((r, idx) => idx < variables.length || r.key || r.value));
  };

  const q = filter.toLowerCase();
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="relative w-64">
        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Filter variables"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-7 pl-7 text-xs"
        />
      </div>
      <div className="overflow-hidden rounded-md border">
        <div className="grid grid-cols-[32px_1fr_110px_1.5fr_64px] gap-1 border-b bg-muted/40 px-1 py-1.5 text-[11px] font-medium text-muted-foreground">
          <span />
          <span className="px-2">Variable</span>
          <span className="px-2">Type</span>
          <span className="px-2">Value</span>
          <span />
        </div>
        {rows.map((v, i) => {
          const isNew = i === variables.length;
          if (q && !isNew && !v.key.toLowerCase().includes(q)) return null;
          // The eye button toggles each row relative to the "Show secret values" setting.
          const masked = v.type === "secret" && (revealSecrets ? revealed.has(i) : !revealed.has(i));
          return (
            <div
              key={i}
              className={cn(
                "group grid grid-cols-[32px_1fr_110px_1.5fr_64px] items-center gap-1 border-b px-1 py-0.5 last:border-b-0",
                !v.enabled && !isNew && "opacity-50",
              )}
            >
              <div className="flex justify-center">
                {!isNew && (
                  <Checkbox checked={v.enabled} onCheckedChange={(c) => update(i, { enabled: !!c })} />
                )}
              </div>
              <Input
                value={v.key}
                placeholder={isNew ? "Add new variable" : "Name"}
                onChange={(e) => update(i, { key: e.target.value })}
                className="h-7 border-transparent font-mono text-xs shadow-none hover:border-input"
              />
              <Select value={v.type} onValueChange={(type) => update(i, { type: type as Variable["type"] })}>
                <SelectTrigger
                  size="sm"
                  className="h-7 border-transparent text-xs shadow-none hover:border-input"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default" className="text-xs">
                    default
                  </SelectItem>
                  <SelectItem value="secret" className="text-xs">
                    secret
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={v.value}
                type={masked ? "password" : "text"}
                autoComplete="off"
                placeholder="Value"
                onChange={(e) => update(i, { value: e.target.value })}
                className="h-7 border-transparent font-mono text-xs shadow-none hover:border-input"
              />
              <div className="flex justify-end gap-0.5">
                {v.type === "secret" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground"
                    title={masked ? "Reveal" : "Hide"}
                    onClick={() =>
                      setRevealed((s) => {
                        const n = new Set(s);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                  >
                    {masked ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                  </Button>
                )}
                {!isNew && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground opacity-0 group-hover:opacity-100"
                    onClick={() => onChange(variables.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
