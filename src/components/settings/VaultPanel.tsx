"use client";
/** The workspace's secrets vault: store, scope, replace and delete secrets. Values are write-only. */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import { useApp } from "@/stores/app";

interface Secret {
  id: string;
  name: string;
  description: string;
  keyId: string;
  scriptAccess: boolean;
  collectionIds: string[];
  state: "ok" | "needs-value" | "unreadable";
  updatedAt: number;
  rotatedAt: number | null;
  reference: string;
}
interface Status {
  keySource: "environment" | "file";
  keyFile: string | null;
  currentKeyId: string | null;
  secrets: number;
  byKey: { keyId: string; secrets: number; available: boolean }[];
  needValue: number;
}

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const STATE_TEXT: Record<Secret["state"], string> = {
  ok: "",
  "needs-value": "Needs a value (a backup withheld it)",
  unreadable: "Unreadable: its encryption key is not available",
};

export function VaultPanel({ isAdmin }: { isAdmin: boolean }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const folders = useApp((s) => s.folders);
  const collections = folders.filter((f) => f.parentId === null);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [scriptAccess, setScriptAccess] = useState(false);
  const [scope, setScope] = useState<string[]>([]);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    call<Secret[]>(`/api/vault?workspaceId=${workspaceId}`)
      .then((list) => {
        setSecrets(list);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
    if (isAdmin)
      call<Status>("/api/admin/vault")
        .then(setStatus)
        .catch(() => undefined);
  }, [workspaceId, isAdmin]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast.success(done);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      await call("/api/vault", "POST", {
        workspaceId,
        name,
        value,
        description,
        scriptAccess,
        collectionIds: scope,
      });
      setName("");
      setValue("");
      setDescription("");
      setScriptAccess(false);
      setScope([]);
    }, "Secret stored");

  const collectionName = (id: string) => collections.find((c) => c.id === id)?.name ?? "a deleted collection";

  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label="Secrets vault">
      <div>
        <h3 className="font-medium">Secrets vault</h3>
        <p className="text-sm text-muted-foreground">
          Values are encrypted at rest and never shown again. Use <code>{"{{vault:name}}"}</code> in URLs,
          headers, bodies and auth. They are masked in history, results and logs.
        </p>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {secrets.map((s) => (
            <li key={s.id} className="space-y-1 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium">{s.name}</span>{" "}
                  <code className="text-xs text-muted-foreground">{s.reference}</code>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setReplacing(replacing === s.id ? null : s.id);
                      setNewValue("");
                    }}
                  >
                    Replace value
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => call(`/api/vault/${s.id}`, "DELETE"), "Secret deleted")}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
              <div className="text-xs text-muted-foreground">
                {s.collectionIds.length
                  ? `Only in ${s.collectionIds.map(collectionName).join(", ")}`
                  : "Whole workspace"}{" "}
                ·{" "}
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={s.scriptAccess}
                    disabled={busy}
                    onChange={() =>
                      void run(
                        () => call(`/api/vault/${s.id}`, "PATCH", { scriptAccess: !s.scriptAccess }),
                        "Updated",
                      )
                    }
                  />
                  scripts may read it (pm.vault.get)
                </label>{" "}
                · updated {formatDateTime(s.rotatedAt ?? s.updatedAt)}
              </div>
              {s.state !== "ok" && <div className="text-xs text-destructive">{STATE_TEXT[s.state]}</div>}
              {replacing === s.id && (
                <div className="flex gap-2 pt-1">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    aria-label={`New value for ${s.name}`}
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    placeholder="New value"
                  />
                  <Button
                    size="sm"
                    disabled={busy || !newValue}
                    onClick={() =>
                      void run(async () => {
                        await call(`/api/vault/${s.id}`, "PATCH", { value: newValue });
                        setReplacing(null);
                        setNewValue("");
                      }, "Value replaced")
                    }
                  >
                    Save
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-3 rounded-md border bg-muted/20 p-3">
        <h4 className="text-sm font-medium">Add a secret</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="stripe-live"
              aria-label="Secret name"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>Description (optional)</span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="Secret description"
            />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span>Value</span>
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={2}
            className="font-mono text-xs"
            autoComplete="off"
            aria-label="Secret value"
          />
        </label>
        <fieldset className="space-y-1 text-sm">
          <legend>Available in</legend>
          <p className="text-xs text-muted-foreground">Leave all unchecked for the whole workspace.</p>
          <div className="flex flex-wrap gap-3">
            {collections.map((c) => (
              <label key={c.id} className="inline-flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={scope.includes(c.id)}
                  onChange={(e) =>
                    setScope(e.target.checked ? [...scope, c.id] : scope.filter((x) => x !== c.id))
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={scriptAccess} onChange={(e) => setScriptAccess(e.target.checked)} />
          Let scripts read it with <code>pm.vault.get</code>
        </label>
        <div>
          <Button size="sm" disabled={busy || !name.trim() || !value} onClick={() => void add()}>
            Store secret
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await call<{ moved: unknown[] }>("/api/vault/migrate", "POST", { workspaceId });
              toast.message(`${r.moved.length} secret variables moved into the vault`);
            }, "Migration finished")
          }
        >
          Move secret variables into the vault
        </Button>
        <span className="text-xs text-muted-foreground">
          Replaces each secret variable&apos;s value with a vault reference. Scripts then read the reference,
          not the value.
        </span>
      </div>

      {isAdmin && status && (
        <div className="space-y-2 rounded-md border p-3 text-sm" aria-label="Vault keys">
          <h4 className="font-medium">Encryption key</h4>
          <p className="text-xs text-muted-foreground">
            {status.currentKeyId === null ? (
              "No key yet: one is created when you store the first secret. "
            ) : (
              <>
                Source:{" "}
                {status.keySource === "environment" ? "POSTBOX_VAULT_KEY" : `key file ${status.keyFile}`} ·
                current key <code>{status.currentKeyId}</code> · {status.secrets} secrets
              </>
            )}
            {status.byKey.map((k) => (
              <span key={k.keyId}>
                {" "}
                · key {k.keyId}: {k.secrets}
                {k.available ? "" : " (unavailable)"}
              </span>
            ))}
          </p>
          <div className="flex flex-wrap gap-2">
            {status.keySource === "file" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => call("/api/admin/vault/rotate", "POST", { newKey: true }),
                    "New key created; secrets re-encrypted",
                  )
                }
              >
                Create new key and re-encrypt
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() => call("/api/admin/vault/rotate", "POST", {}), "Secrets re-encrypted")
              }
            >
              Re-encrypt under the current key
            </Button>
            {status.keySource === "file" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => call("/api/admin/vault/rotate", "POST", { prune: true }),
                    "Unused keys removed",
                  )
                }
              >
                Remove unused keys
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
