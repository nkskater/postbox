"use client";
/** Sign-in status, version information and "sign out all sessions" (administrators only). */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { LogOut, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";

interface Info {
  version: string;
  commit: string | null;
  node: string;
  auth: { mode: "open" | "password" | "accounts"; passwordConfigured: boolean; tokenConfigured: boolean };
  sessionDays: number;
}

const MODES: Record<Info["auth"]["mode"], string> = {
  open: "Off: anyone who can reach this server has full access",
  password: "Single-user password",
  accounts: "User accounts",
};

export function SecurityPanel({ isAdmin }: { isAdmin: boolean }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isAdmin) return;
    void fetch("/api/admin/security")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? r.statusText);
        setInfo(body);
      })
      .catch((err) => toast.error((err as Error).message));
  }, [isAdmin]);

  if (!isAdmin)
    return (
      <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
        Sign-in status and version details are available to administrators.
      </p>
    );

  const signOutAll = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/sessions/revoke", { method: "POST" });
      if (!res.ok)
        throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
      toast.success("Signed out everywhere");
      window.location.href = info?.auth.mode === "open" ? "/" : "/login";
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };

  const section = "space-y-3 rounded-lg border p-4";
  return (
    <div className="space-y-4">
      <section className={section} aria-label="Sign-in">
        <h3 className="flex items-center gap-2 font-medium">
          <ShieldCheck className="size-4" /> Sign-in
        </h3>
        {info ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Sign-in</dt>
            <dd>{MODES[info.auth.mode]}</dd>
            <dt className="text-muted-foreground">Recovery login</dt>
            <dd>
              {info.auth.passwordConfigured || info.auth.tokenConfigured
                ? [
                    info.auth.passwordConfigured && "POSTBOX_PASSWORD",
                    info.auth.tokenConfigured && "POSTBOX_TOKEN",
                  ]
                    .filter(Boolean)
                    .join(" and ") + " configured"
                : "None configured"}
            </dd>
            <dt className="text-muted-foreground">New sessions last</dt>
            <dd>{info.sessionDays} days</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm(true)}>
          <LogOut className="size-3.5" /> Sign out all sessions
        </Button>
        <p className="text-xs text-muted-foreground">
          Ends every browser session, including yours. Personal API tokens and POSTBOX_TOKEN keep working;
          revoke those from the Users page or a profile.
        </p>
      </section>

      <section className={section} aria-label="About">
        <h3 className="font-medium">About</h3>
        {info && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd>{info.version}</dd>
            <dt className="text-muted-foreground">Build</dt>
            <dd className="font-mono text-xs">{info.commit ?? "not recorded"}</dd>
            <dt className="text-muted-foreground">Node.js</dt>
            <dd>{info.node}</dd>
          </dl>
        )}
      </section>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Sign out all sessions?"
        description="Everyone, including you, will have to sign in again. API tokens keep working."
        confirmLabel="Sign out everyone"
        destructive
        onConfirm={() => void signOutAll()}
      />
    </div>
  );
}
