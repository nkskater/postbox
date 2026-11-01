"use client";
import { formatDateTime } from "@/lib/format";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
interface Invite {
  id: string;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
  role: string | null;
}
export function InviteLinks({ workspaceId }: { workspaceId?: string }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [role, setRole] = useState("viewer");
  const [hours, setHours] = useState(24);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url = `/api/invites${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (response.ok) setInvites(await response.json());
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [url]);
  const create = async () => {
    setBusy(true);
    setError("");
    setLink("");
    try {
      const response = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, role, expiresInHours: hours }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setLink(`${window.location.origin}/invite?token=${encodeURIComponent(data.token)}`);
      setInvites((rows) => [{ ...data, token: undefined }, ...rows]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded border p-4">
      <h3 className="font-medium">Invite links</h3>
      <p className="text-sm text-muted-foreground">
        Links are shown once, expire automatically, and create one account.{" "}
        {workspaceId ? "The account also joins this workspace." : "No shared workspace access is granted."}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {workspaceId && (
          <label className="grid gap-1 text-sm">
            Workspace role
            <select
              aria-label="Invite workspace role"
              className="rounded border bg-background p-2"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {["viewer", "editor", "owner"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        )}
        <label className="grid gap-1 text-sm">
          Expires in hours
          <Input
            type="number"
            min={1}
            max={168}
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          />
        </label>
        <Button disabled={busy || hours < 1 || hours > 168} onClick={() => void create()}>
          Create invite link
        </Button>
      </div>
      {link && (
        <div className="space-y-1">
          <label className="grid gap-1 text-sm">
            Invite link
            <Input readOnly value={link} onFocus={(event) => event.target.select()} />
          </label>
          <p className="text-xs text-muted-foreground">
            Copy and share privately. The link cannot be retrieved again.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {invites.map((invite) => (
        <div key={invite.id} className="flex items-center justify-between gap-2 text-xs">
          <span>
            {invite.role ?? "Account"} · expires {formatDateTime(invite.expiresAt)} ·{" "}
            {invite.revokedAt ? "revoked" : invite.usedAt ? "used" : "unused"}
          </span>
          {!invite.usedAt && !invite.revokedAt && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const response = await fetch(`/api/invites/${invite.id}`, { method: "DELETE" });
                  if (!response.ok) throw new Error((await response.json()).error);
                  setInvites((rows) =>
                    rows.map((row) => (row.id === invite.id ? { ...row, revokedAt: Date.now() } : row)),
                  );
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Revoke invite
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}
