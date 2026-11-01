"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { KeyScope } from "@/core/scopes";
import { EXPIRY_OPTIONS, KeyDetails, ScopeSelect, SecretBox, type KeyInfo } from "./key-ui";

interface Account {
  id: string;
  username: string;
  displayName: string;
  disabled: boolean;
  tokens: KeyInfo[];
}

async function send<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

function IssueKey({ account, onIssued }: { account: Account; onIssued: (secret: string) => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<KeyScope>("run");
  const [days, setDays] = useState("90");
  const [limit, setLimit] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          const res = await send<{ token: string }>(
            `/api/admin/service-accounts/${account.id}/tokens`,
            "POST",
            {
              name,
              scope,
              expiresInDays: days ? Number(days) : null,
              rateLimitPerMinute: limit ? Number(limit) : null,
            },
          );
          setName("");
          onIssued(res.token);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <label className="grid min-w-48 flex-1 gap-1 text-sm">
        Key name
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder="e.g. nightly CI"
          aria-label={`Key name for ${account.username}`}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Scope
        <ScopeSelect value={scope} onChange={setScope} />
      </label>
      <label className="grid gap-1 text-sm">
        Expires
        <select
          aria-label="Expires"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {EXPIRY_OPTIONS.map(([v, l]) => (
            <option key={l} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="grid w-28 gap-1 text-sm">
        Requests/min
        <Input
          type="number"
          min={1}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          placeholder="Unlimited"
        />
      </label>
      <Button type="submit" variant="outline" size="sm" disabled={!name.trim() || account.disabled}>
        Issue key
      </Button>
      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

/** Service accounts: non-human identities for automation, each with scoped, rate-limited, revocable keys. */
export function ServiceAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    send<Account[]>("/api/admin/service-accounts")
      .then(setAccounts)
      .catch((err) => setError((err as Error).message));
  }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="space-y-3">
      <header>
        <h3 className="text-lg font-semibold">Service accounts</h3>
        <p className="text-sm text-muted-foreground">
          Accounts for CI, scripts and agents. They cannot sign in, take workspace roles like any member (add
          them from a workspace&apos;s Members) and are reached only through keys. A key is never more
          powerful than its account&apos;s role and its scope.
        </p>
      </header>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {secret && <SecretBox secret={secret} />}
      <form
        className="flex flex-wrap items-end gap-2 rounded border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await send("/api/admin/service-accounts", "POST", {
              username,
              displayName: displayName || undefined,
            });
            setUsername("");
            setDisplayName("");
          });
        }}
      >
        <label className="grid gap-1 text-sm">
          Service account name
          <Input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={64} required />
        </label>
        <label className="grid gap-1 text-sm">
          Description
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={200} />
        </label>
        <Button type="submit" disabled={!username.trim()}>
          Create service account
        </Button>
      </form>
      <div className="space-y-3">
        {accounts.map((a) => (
          <article key={a.id} className="space-y-3 rounded border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-medium">
                {a.displayName} <span className="text-muted-foreground">@{a.username}</span>
              </h4>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">Service account</span>
              <span className="text-xs">{a.disabled ? "Disabled" : "Active"}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void act(() => send(`/api/admin/users/${a.id}`, "PATCH", { disabled: !a.disabled }))
                }
              >
                {a.disabled ? "Enable" : "Disable"} {a.username}
              </Button>
            </div>
            {a.tokens.length > 0 && (
              <ul className="divide-y rounded-md border text-sm">
                {a.tokens.map((k) => (
                  <li key={k.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{k.name}</div>
                      <KeyDetails k={k} />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!window.confirm(`Rotate "${k.name}"? The old key keeps working for 15 minutes.`))
                          return;
                        void act(async () => {
                          const res = await send<{ token: string }>(
                            `/api/admin/tokens/${k.id}/rotate`,
                            "POST",
                            {
                              graceMinutes: 15,
                            },
                          );
                          setSecret(res.token);
                        });
                      }}
                    >
                      Rotate {k.name}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!window.confirm(`Revoke "${k.name}"? Clients using it stop working immediately.`))
                          return;
                        void act(() => send(`/api/admin/tokens/${k.id}`, "DELETE"));
                      }}
                    >
                      Revoke {k.name}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <IssueKey
              account={a}
              onIssued={(s) => {
                setSecret(s);
                load();
              }}
            />
          </article>
        ))}
      </div>
    </section>
  );
}
