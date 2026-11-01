"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InviteLinks } from "./InviteLinks";
import { ServiceAccounts } from "./ServiceAccounts";
interface User {
  id: string;
  username: string;
  displayName: string;
  disabled: boolean;
  isAdmin: boolean;
  isService?: boolean;
}
export function UsersSettings() {
  const [users, setUsers] = useState<User[]>([]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [admin, setAdmin] = useState(false);
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/users", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setUsers(data.filter((u: User) => !u.isService));
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, []);
  const perform = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const refreshed = await fetch("/api/admin/users");
      if (refreshed.ok) setUsers((await refreshed.json()).filter((u: User) => !u.isService));
      setPassword("");
      setResetPasswords({});
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-5">
      <header>
        <h2 className="text-xl font-semibold">Users</h2>
        <p className="text-sm text-muted-foreground">
          Manage local accounts. Disabling an account stops its access; revoke access to end all sessions and
          personal API tokens. The last active administrator is protected.
        </p>
      </header>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <form
        className="grid gap-3 rounded border p-4 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await perform("/api/admin/users", "POST", { username, displayName, password, isAdmin: admin })
          ) {
            setUsername("");
            setDisplayName("");
            setAdmin(false);
          }
        }}
      >
        <h3 className="font-medium sm:col-span-2">Create user</h3>
        <label className="grid gap-1 text-sm">
          Username
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
            maxLength={64}
            required
            disabled={busy}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Display name
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={200}
            disabled={busy}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Initial password
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={1024}
            required
            disabled={busy}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={admin}
            onChange={(event) => setAdmin(event.target.checked)}
            disabled={busy}
          />
          Administrator
        </label>
        <Button type="submit" disabled={busy}>
          Create user
        </Button>
      </form>
      <div className="space-y-3">
        {users.map((user) => (
          <article key={user.id} className="space-y-3 rounded border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">
                {user.displayName} <span className="text-muted-foreground">@{user.username}</span>
              </h3>
              <span className="text-xs">
                {user.isAdmin ? "Administrator" : "Member"} · {user.disabled ? "Disabled" : "Active"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void perform(`/api/admin/users/${user.id}`, "PATCH", { disabled: !user.disabled })
                }
              >
                {user.disabled ? "Enable" : "Disable"} {user.username}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void perform(`/api/admin/users/${user.id}`, "PATCH", { isAdmin: !user.isAdmin })
                }
              >
                {user.isAdmin ? "Demote" : "Promote"} {user.username}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void perform(`/api/admin/users/${user.id}/revoke`, "POST")}
              >
                Revoke sessions and tokens for {user.username}
              </Button>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(`/api/admin/users/${user.id}`, "PATCH", { password: resetPasswords[user.id] });
              }}
            >
              <Input
                aria-label={`New password for ${user.username}`}
                type="password"
                placeholder="New password"
                autoComplete="new-password"
                value={resetPasswords[user.id] ?? ""}
                onChange={(event) =>
                  setResetPasswords((values) => ({ ...values, [user.id]: event.target.value }))
                }
                minLength={8}
                maxLength={1024}
                required
                disabled={busy}
              />
              <Button variant="outline" size="sm" disabled={busy || !resetPasswords[user.id]}>
                Reset password for {user.username}
              </Button>
            </form>
          </article>
        ))}
      </div>
      <ServiceAccounts />
      <InviteLinks />
    </section>
  );
}
