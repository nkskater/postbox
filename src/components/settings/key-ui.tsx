"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyText } from "@/lib/clipboard";
import { formatDateTime } from "@/lib/format";
import { KEY_SCOPES, SCOPE_LABELS, type KeyScope } from "@/core/scopes";

export interface KeyInfo {
  id: string;
  name: string;
  prefix: string;
  scope: KeyScope;
  rateLimitPerMinute: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

export function ScopeSelect({ value, onChange }: { value: KeyScope; onChange: (scope: KeyScope) => void }) {
  return (
    <select
      aria-label="Scope"
      value={value}
      onChange={(e) => onChange(e.target.value as KeyScope)}
      className="h-9 rounded-md border bg-background px-2 text-sm"
    >
      {KEY_SCOPES.map((s) => (
        <option key={s} value={s}>
          {SCOPE_LABELS[s]}
        </option>
      ))}
    </select>
  );
}

export const EXPIRY_OPTIONS = [
  ["30", "30 days"],
  ["90", "90 days"],
  ["365", "1 year"],
  ["", "Never"],
] as const;

/** One-time display of a freshly issued key, with a Copy button that also works over plain HTTP. */
export function SecretBox({ secret, note, what = "key" }: { secret: string; note?: string; what?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
      <p className="font-medium">Copy your new {what} now. It will not be shown again.</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <div className="flex gap-2">
        <Input readOnly value={secret} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button
          type="button"
          variant="outline"
          size="icon"
          title={`Copy ${what}`}
          onClick={() => {
            void copyText(secret).then((ok) => {
              setCopied(ok);
              if (ok) toast.success(`${what[0].toUpperCase()}${what.slice(1)} copied`);
              else toast.error("Could not copy. Select the text and copy it manually.");
            });
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

const when = (ms: number | null, none: string) => (ms ? formatDateTime(ms) : none);

export function KeyDetails({ k }: { k: KeyInfo }) {
  return (
    <div className="text-xs text-muted-foreground">
      <code>{k.prefix}…</code> · {SCOPE_LABELS[k.scope]} ·{" "}
      {k.rateLimitPerMinute ? `${k.rateLimitPerMinute}/min` : "no rate limit"} · last used{" "}
      {when(k.lastUsedAt, "never")} · expires {when(k.expiresAt, "never")}
    </div>
  );
}
