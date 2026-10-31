"use client";
/** Workspace-wide list of saved OAuth 2.0 tokens; values are never shown. */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useApp } from "@/stores/app";

interface SavedToken {
  kind: "request" | "folder";
  id: string;
  name: string;
  grantType: string;
  tokenHost: string;
  expiresAt?: number;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  canRevoke: boolean;
}

interface ClearResult {
  cleared: number;
  revoked: number;
  errors: string[];
}

export function OAuthTokensDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { workspaceId } = useApp();
  const [tokens, setTokens] = useState<SavedToken[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);

  const [version, setVersion] = useState(0);
  const load = () => setVersion((v) => v + 1);

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    fetch(`/api/oauth2/tokens?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) return toast.error(data.error);
        setNow(Date.now());
        setTokens(data);
      })
      .catch((err: Error) => !cancelled && toast.error(err.message));
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, version]);

  const report = (r: ClearResult) => {
    if (r.errors.length) toast.warning(`Cleared ${r.cleared}; revocation problems: ${r.errors.join("; ")}`);
    else
      toast.success(
        `Cleared ${r.cleared} token${r.cleared === 1 ? "" : "s"}${r.revoked ? `, revoked ${r.revoked}` : ""}`,
      );
  };
  const post = async (url: string, body: object) => {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      report(data);
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Saved OAuth tokens</DialogTitle>
          <DialogDescription>
            Tokens saved on requests and folders in this workspace. Clearing stops them being sent; revoking
            also asks the provider to invalidate them. Reopen any open tabs to see the change.
          </DialogDescription>
        </DialogHeader>
        {!tokens ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-muted-foreground text-xs">No saved tokens.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground text-left">
                <tr>
                  <th className="py-1 font-normal">Owner</th>
                  <th className="font-normal">Grant / server</th>
                  <th className="font-normal">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={`${t.kind}:${t.id}`} className="border-t">
                    <td className="py-1.5">
                      {t.name} <span className="text-muted-foreground">({t.kind})</span>
                    </td>
                    <td>
                      {t.grantType}
                      {t.tokenHost && <span className="text-muted-foreground"> · {t.tokenHost}</span>}
                    </td>
                    <td className="text-muted-foreground">
                      {!t.hasAccessToken
                        ? "Refresh token only"
                        : t.expiresAt === undefined
                          ? "No expiry"
                          : t.expiresAt > now
                            ? `Expires ${new Date(t.expiresAt).toLocaleString()}`
                            : "Expired"}
                      {t.hasRefreshToken && t.hasAccessToken ? " · refreshable" : ""}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {t.canRevoke && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            post("/api/oauth2/tokens/clear", { kind: t.kind, id: t.id, revoke: true })
                          }
                        >
                          Revoke
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => post("/api/oauth2/tokens/clear", { kind: t.kind, id: t.id })}
                      >
                        Clear
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!tokens?.length && (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => post("/api/oauth2/tokens/clear-all", {})}
            >
              Clear all
            </Button>
            {tokens.some((t) => t.canRevoke) && (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => post("/api/oauth2/tokens/clear-all", { revoke: true })}
              >
                Revoke and clear all
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
