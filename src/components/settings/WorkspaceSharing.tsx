"use client";
import { useEffect, useState } from "react";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { InviteLinks } from "./InviteLinks";
import { AuditLog } from "./AuditLog";
import { UsagePanel } from "./UsagePanel";
import { WebhooksPanel } from "./WebhooksPanel";
import { Input } from "@/components/ui/input";

type Role = "owner" | "editor" | "viewer";
interface Member {
  userId: string;
  username: string;
  displayName: string;
  role: Role;
}
export function WorkspaceSharing() {
  const workspaceId = useApp((s) => s.workspaceId);
  return workspaceId ? <Sharing key={workspaceId} workspaceId={workspaceId} /> : <p>Select a workspace.</p>;
}
function Sharing({ workspaceId }: { workspaceId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [error, setError] = useState("");
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/members`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            response.status === 403
              ? "Only workspace owners and administrators can manage sharing."
              : data.error,
          );
        setMembers(data);
        setAllowed(true);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [url]);
  const update = async (name: string, next: Role | null) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, {
        method: next ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name, ...(next ? { role: next } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMembers(data);
      window.dispatchEvent(new Event("postbox:membership-changed"));
      setUsername("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Workspace sharing</h2>
      <p className="text-sm text-muted-foreground">
        Viewers can read and export. Editors can also edit and run requests. Owners manage sharing and can
        delete this workspace. Administrators can access every workspace.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {allowed && (
        <>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void update(username, role);
            }}
          >
            <Input
              aria-label="Member username"
              placeholder="Existing account username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={busy}
            />
            <select
              aria-label="New member role"
              className="rounded border bg-background p-2"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              disabled={busy}
            >
              {(["viewer", "editor", "owner"] as const).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <Button disabled={busy || !username.trim()}>Add member</Button>
          </form>
          <InviteLinks workspaceId={workspaceId} />
          {members.map((member) => (
            <div key={member.userId} className="flex items-center gap-3 rounded border p-3">
              <span className="min-w-0 flex-1 truncate">
                {member.displayName} <span className="text-muted-foreground">@{member.username}</span>
              </span>
              <select
                aria-label={`Role for ${member.username}`}
                className="rounded border bg-background p-2"
                disabled={busy}
                value={member.role}
                onChange={(event) => void update(member.username, event.target.value as Role)}
              >
                {(["viewer", "editor", "owner"] as const).map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <Button variant="outline" disabled={busy} onClick={() => void update(member.username, null)}>
                Remove
              </Button>
            </div>
          ))}
          <UsagePanel workspaceId={workspaceId} />
          <WebhooksPanel workspaceId={workspaceId} />
          <AuditLog workspaceId={workspaceId} />
        </>
      )}
    </section>
  );
}
