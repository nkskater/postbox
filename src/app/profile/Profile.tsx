"use client";
/**
 * Profile: first-run administrator setup, password change and personal API tokens.
 */
import { copyText } from "@/lib/clipboard";
import { useApp } from "@/stores/app";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, KeyRound, Loader2, Mailbox, Trash2, UserRound } from "lucide-react";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Status {
  authEnabled: boolean;
  hasUsers: boolean;
  envCredentials: boolean;
  caller: {
    kind: "open" | "env" | "user" | "anonymous";
    user: { id: string; username: string; displayName: string; isAdmin: boolean } | null;
  };
}

interface Token {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "never");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function SetupForm() {
  const [form, setForm] = useState({ username: "", displayName: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return toast.error("Passwords do not match");
    setBusy(true);
    try {
      await call("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({
          username: form.username,
          displayName: form.displayName,
          password: form.password,
        }),
      });
      toast.success("Administrator account created");
      window.location.reload();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value }),
  });
  return (
    <Section title="Create the administrator account">
      <p className="text-sm text-muted-foreground">
        Once an account exists, everyone signs in with a username and password, and each person can create
        their own API tokens. POSTBOX_TOKEN keeps working as a recovery login.
      </p>
      <form onSubmit={submit} className="grid gap-3">
        <Label className="grid gap-1.5">
          Username
          <Input autoComplete="username" {...field("username")} />
        </Label>
        <Label className="grid gap-1.5">
          Display name
          <Input {...field("displayName")} placeholder="Optional" />
        </Label>
        <Label className="grid gap-1.5">
          Password
          <Input type="password" autoComplete="new-password" {...field("password")} />
        </Label>
        <Label className="grid gap-1.5">
          Confirm password
          <Input type="password" autoComplete="new-password" {...field("confirm")} />
        </Label>
        <Button type="submit" disabled={busy || !form.username || form.password.length < 8}>
          {busy && <Loader2 className="size-4 animate-spin" />} Create account
        </Button>
      </form>
    </Section>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await call("/api/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      toast.success("Password changed. Other sessions were signed out.");
      setCurrent("");
      setNext("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Change password">
      <form onSubmit={submit} className="grid gap-3">
        <Label className="grid gap-1.5">
          Current password
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Label>
        <Label className="grid gap-1.5">
          New password (at least 8 characters)
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Label>
        <Button type="submit" variant="outline" disabled={busy || !current || next.length < 8}>
          Change password
        </Button>
      </form>
    </Section>
  );
}

function Tokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => {
    call<Token[]>("/api/me/tokens")
      .then(setTokens)
      .catch((err) => toast.error((err as Error).message));
  }, []);
  useEffect(load, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await call<Token & { token: string }>("/api/me/tokens", {
        method: "POST",
        body: JSON.stringify({ name, expiresInDays: days ? Number(days) : null }),
      });
      setCreated(res.token);
      setCopied(false);
      setName("");
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const revoke = async (t: Token) => {
    if (!window.confirm(`Revoke "${t.name}"? Clients using it stop working immediately.`)) return;
    try {
      await call(`/api/me/tokens/${t.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Section title="API tokens">
      <p className="text-sm text-muted-foreground">
        Use a token for the CLI, scripts and MCP clients: <code>Authorization: Bearer &lt;token&gt;</code>. It
        acts as you.
      </p>
      {created && (
        <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <p className="font-medium">Copy your new token now. It will not be shown again.</p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={created}
              className="font-mono text-xs"
              onFocus={(e) => e.target.select()}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              title="Copy token"
              onClick={() => {
                void copyText(created).then((ok) => {
                  setCopied(ok);
                  if (ok) toast.success("Token copied");
                  else toast.error("Could not copy. Select the token and copy it manually.");
                });
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
        </div>
      )}
      <form onSubmit={create} className="flex flex-wrap items-end gap-2">
        <Label className="grid flex-1 gap-1.5">
          Name
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code MCP" />
        </Label>
        <Label className="grid gap-1.5">
          Expires
          <select
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
            <option value="">Never</option>
          </select>
        </Label>
        <Button type="submit" disabled={!name.trim()}>
          <KeyRound className="size-4" /> Create token
        </Button>
      </form>
      {tokens.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{t.name}</div>
                <div className="text-xs text-muted-foreground">
                  <code>{t.prefix}…</code> · created {date(t.createdAt)} · last used {date(t.lastUsedAt)} ·
                  expires {date(t.expiresAt)}
                </div>
              </div>
              <Button variant="ghost" size="icon" title="Revoke token" onClick={() => void revoke(t)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function Profile() {
  const theme = useApp((s) => s.theme);
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    call<Status>("/api/auth/status")
      .then(setStatus)
      .catch((err) => toast.error((err as Error).message));
  }, []);

  const user = status?.caller.user;
  return (
    // The app shell disables page scrolling, so this page scrolls itself.
    <div className="h-full overflow-y-auto">
      {/* The toaster otherwise only exists in the main app shell, so toasts here were never shown. */}
      <Toaster theme={theme} position="bottom-right" richColors closeButton />
      <main className="mx-auto w-full max-w-xl space-y-4 p-4 sm:p-8">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="icon" title="Back">
            <Link href="/">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <Mailbox className="size-5 text-primary" />
          <h1 className="text-lg font-semibold">Profile</h1>
        </div>
        {!status && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
        {status && !status.hasUsers && <SetupForm />}
        {status?.hasUsers && status.caller.kind === "env" && (
          <Section title="Recovery login">
            <p className="text-sm text-muted-foreground">
              You are signed in with POSTBOX_TOKEN, which has no account. Sign in with a username to manage a
              profile.
            </p>
          </Section>
        )}
        {user && (
          <>
            <Section title="Account">
              <div className="flex items-center gap-3 text-sm">
                <UserRound className="size-8 rounded-full border p-1.5 text-muted-foreground" />
                <div>
                  <div className="font-medium">{user.displayName}</div>
                  <div className="text-muted-foreground">
                    {user.username}
                    {user.isAdmin && " · administrator"}
                  </div>
                </div>
              </div>
            </Section>
            <PasswordForm />
            <Tokens />
          </>
        )}
      </main>
    </div>
  );
}
