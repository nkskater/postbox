"use client";
/** Turns the value of a sensitive field into a vault secret and leaves a {{vault:name}} reference behind. */
import { useState } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useApp } from "@/stores/app";

const REFERENCE = /^\s*\{\{\s*vault:[^{}]+\}\}\s*$/;

/** Only plain values qualify: empty, a reference already, or text that mixes in other variables do not. */
export const canMoveToVault = (value: string) => !!value && !REFERENCE.test(value) && !value.includes("{{");

export function MoveToVault({ value, onMoved }: { value: string; onMoved: (reference: string) => void }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [busy, setBusy] = useState(false);

  if (!canMoveToVault(value)) return null;

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          name: name.trim(),
          value,
          ...(domains.trim()
            ? {
                domains: domains
                  .split(",")
                  .map((d) => d.trim())
                  .filter(Boolean),
              }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
      onMoved(`{{vault:${name.trim()}}}`);
      toast.success(`Stored as vault secret "${name.trim()}"`);
      setOpen(false);
      setName("");
      setDomains("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          title="Move this value to the secrets vault"
          aria-label="Move value to vault"
        >
          <Lock className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="space-y-2 text-xs" align="end">
        <p className="font-medium">Move to the secrets vault</p>
        <p className="text-muted-foreground">
          The value is stored encrypted and this field keeps a reference to it. It is masked everywhere.
        </p>
        <label className="block space-y-1">
          <span>Secret name</span>
          <Input
            className="h-7"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="stripe-live"
            aria-label="Vault secret name"
          />
        </label>
        <label className="block space-y-1">
          <span>Only send to (optional, comma separated)</span>
          <Input
            className="h-7"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder="api.example.com, *.example.org"
            aria-label="Allowed domains"
          />
        </label>
        <Button size="sm" disabled={busy || !name.trim()} onClick={() => void save()}>
          Move to vault
        </Button>
      </PopoverContent>
    </Popover>
  );
}
