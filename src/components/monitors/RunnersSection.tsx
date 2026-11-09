"use client";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Runners = Awaited<ReturnType<typeof api.runners.list>>;
const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** Private runners: enrol one (its token is shown once), watch whether it is online, revoke or delete it. */
export function RunnersSection({
  workspaceId,
  runners,
  onChanged,
}: {
  workspaceId: string;
  runners: Runners;
  onChanged: (runners: Runners) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    location: "",
    labels: "",
    allowHosts: "",
    denyHosts: "",
    shareSecrets: false,
  });
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      onChanged(await api.runners.list(workspaceId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Runner operation failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded border p-3 space-y-3" aria-label="Private runners">
      <div className="flex items-center gap-3">
        <h2 className="font-medium">Private runners</h2>
        <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Add runner"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Run monitors from inside another network. They connect out to this server; nothing connects in.
        </span>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs whitespace-pre-wrap">
          {error}
        </p>
      )}
      {created && (
        <div role="status" className="rounded bg-muted p-2 text-xs space-y-1">
          <p>
            Token for <strong>{created.name}</strong> (shown once):
          </p>
          <Input aria-label="Runner token" readOnly value={created.token} />
          <p className="text-muted-foreground">
            On the runner host:{" "}
            <code>
              POSTBOX_RUNNER_TOKEN=… postbox runner start --server{" "}
              {typeof window === "undefined" ? "" : window.location.origin}
            </code>
          </p>
          <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
            Hide token
          </Button>
        </div>
      )}
      {open && (
        <form
          className="grid gap-2 md:grid-cols-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const made = await api.runners.create({
                workspaceId,
                name: form.name,
                location: form.location,
                labels: list(form.labels),
                allowHosts: list(form.allowHosts),
                denyHosts: list(form.denyHosts),
                shareSecrets: form.shareSecrets,
              });
              setCreated({ name: made.name, token: made.token });
              setForm({
                name: "",
                location: "",
                labels: "",
                allowHosts: "",
                denyHosts: "",
                shareSecrets: false,
              });
              setOpen(false);
              toast.success(`Runner ${made.name} added`);
            });
          }}
        >
          {(
            [
              ["name", "Runner name"],
              ["location", "Runner location"],
              ["labels", "Runner labels (comma separated)"],
              ["allowHosts", "Hosts the runner may call (comma separated)"],
              ["denyHosts", "Hosts the runner must not call (comma separated)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block">
              {label}
              <Input
                aria-label={label}
                className="mt-1"
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </label>
          ))}
          <label className="flex items-center gap-2 self-end">
            <input
              type="checkbox"
              aria-label="Send secret values to this runner"
              checked={form.shareSecrets}
              onChange={(e) => setForm({ ...form, shareSecrets: e.target.checked })}
            />
            Send secret values to this runner
          </label>
          <div className="md:col-span-3">
            <Button type="submit" size="sm" disabled={busy || !form.name.trim()}>
              Create runner
            </Button>
          </div>
        </form>
      )}
      {runners.length ? (
        <table className="w-full text-xs text-left">
          <thead>
            <tr>
              <th>Name</th>
              <th>Location</th>
              <th>Status</th>
              <th>Monitors</th>
              <th>Seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runners.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-2">
                  <strong>{r.name}</strong>
                  {r.labels.length ? (
                    <span className="text-muted-foreground"> · {r.labels.join(", ")}</span>
                  ) : null}
                </td>
                <td>{r.location || "—"}</td>
                <td>{r.status}</td>
                <td>{r.monitorCount}</td>
                <td>{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : "never"}</td>
                <td className="space-x-1 text-right">
                  {r.status !== "revoked" && (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Revoke runner ${r.name}`}
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Revoke ${r.name}? It stops connecting and its unfinished checks fail.`,
                          )
                        )
                          void run(async () => void (await api.runners.revoke(r.id)));
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    aria-label={`Delete runner ${r.name}`}
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Delete runner ${r.name}?`))
                        void run(async () => void (await api.runners.delete(r.id)));
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-muted-foreground">No runners yet. Monitors run on the Postbox server.</p>
      )}
    </section>
  );
}
