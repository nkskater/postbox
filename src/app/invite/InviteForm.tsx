"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function InviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    // The app shell disables page scrolling, so this page scrolls itself.
    <div className="h-full overflow-y-auto">
      <main className="mx-auto max-w-md space-y-4 p-8">
        <h1 className="text-2xl font-semibold">Join Postbox</h1>
        <p className="text-sm text-muted-foreground">
          Create your account using this single-use invitation. You will receive a private workspace and any
          workspace access included in the invite.
        </p>
        <form
          className="grid gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              const response = await fetch("/api/auth/invite", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, username, displayName, password }),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error);
              router.replace("/");
              router.refresh();
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          <label className="grid gap-1">
            Username
            <Input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              maxLength={64}
            />
          </label>
          <label className="grid gap-1">
            Display name
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={200}
            />
          </label>
          <label className="grid gap-1">
            Password
            <Input
              autoComplete="new-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              maxLength={1024}
              required
            />
          </label>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {!token && <p role="alert">This invite link is missing its token.</p>}
          <Button disabled={busy || !token}>{busy ? "Creating account…" : "Create account"}</Button>
        </form>
      </main>
    </div>
  );
}
