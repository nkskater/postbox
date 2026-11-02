"use client";
/** The workspace's secrets vault: store, scope, restrict, reveal, export and import secrets. */
import { useCallback, useEffect, useRef, useState } from "react";
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
  domains: string[];
  enabled: boolean;
  personal: boolean;
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

const splitList = (text: string) =>
  text
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

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
  const [domains, setDomains] = useState("");
  const [personal, setPersonal] = useState(false);
  const [editingDomains, setEditingDomains] = useState<{ id: string; text: string } | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [newValue, setNewValue] = useState("");
  const [exportPass, setExportPass] = useState("");
  const [importPass, setImportPass] = useState("");
  const [conflict, setConflict] = useState("skip");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

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
        personal,
        ...(domains.trim() ? { domains: splitList(domains) } : {}),
      });
      setName("");
      setValue("");
      setDescription("");
      setScriptAccess(false);
      setScope([]);
      setDomains("");
      setPersonal(false);
    }, "Secret stored");

  const reveal = async (id: string) => {
    if (revealed?.id === id) {
      setRevealed(null);
      return;
    }
    try {
      const r = await call<{ value: string }>(`/api/vault/${id}/reveal`, "POST");
      setRevealed({ id, value: r.value });
      // A revealed value does not stay on screen.
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setRevealed(null), 15_000);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/vault/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, passphrase: exportPass, includePersonal: true }),
      });
      if (!res.ok)
        throw new Error(
          ((await res.json().catch(() => ({}))) as { error?: string }).error ??
            `Request failed (${res.status})`,
        );
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `postbox-vault-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      setExportPass("");
      toast.success("Encrypted export downloaded");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text());
      const r = await call<{ created: string[]; replaced: string[]; skipped: string[]; warnings: string[] }>(
        "/api/vault/import",
        "POST",
        { workspaceId, file: parsed, passphrase: importPass || undefined, onConflict: conflict },
      );
      toast.success(
        `Imported ${r.created.length}, replaced ${r.replaced.length}, skipped ${r.skipped.length}`,
      );
      for (const w of r.warnings) toast.message(w);
      setImportPass("");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const collectionName = (id: string) => collections.find((c) => c.id === id)?.name ?? "a deleted collection";
  const patch = (id: string, body: unknown, done = "Updated") =>
    run(() => call(`/api/vault/${id}`, "PATCH", body), done);

  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label="Secrets vault">
      <div>
        <h3 className="font-medium">Secrets vault</h3>
        <p className="text-sm text-muted-foreground">
          Values are encrypted at rest. Use <code>{"{{vault:name}}"}</code> in URLs, headers, bodies and auth;
          they are masked in history, results and logs. You can also move a value out of any password field
          with its lock button.
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
            <li key={s.id} className={`space-y-1 p-3 text-sm ${s.enabled ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <label className="mr-2 inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={busy}
                      aria-label={`Enable ${s.name}`}
                      onChange={() => void patch(s.id, { enabled: !s.enabled })}
                    />
                  </label>
                  <span className="font-medium">{s.name}</span>{" "}
                  <code className="text-xs text-muted-foreground">{s.reference}</code>
                  {s.personal && (
                    <span className="ml-2 rounded border px-1 text-xs text-muted-foreground">only you</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || s.state !== "ok"}
                    onClick={() => void reveal(s.id)}
                  >
                    {revealed?.id === s.id ? "Hide" : "Show value"}
                  </Button>
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
              {revealed?.id === s.id && (
                <code
                  className="block break-all rounded border bg-muted/40 p-2 text-xs"
                  aria-label="Revealed value"
                >
                  {revealed.value}
                </code>
              )}
              {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
              <div className="text-xs text-muted-foreground">
                {s.collectionIds.length
                  ? `Only in ${s.collectionIds.map(collectionName).join(", ")}`
                  : "Whole workspace"}{" "}
                ·{" "}
                {editingDomains?.id === s.id ? (
                  <span className="inline-flex items-center gap-1">
                    <Input
                      className="h-6 w-56"
                      aria-label={`Allowed domains for ${s.name}`}
                      value={editingDomains.text}
                      onChange={(e) => setEditingDomains({ id: s.id, text: e.target.value })}
                      placeholder="api.example.com, *.example.org"
                    />
                    <Button
                      size="sm"
                      className="h-6"
                      disabled={busy}
                      onClick={() =>
                        void patch(s.id, { domains: splitList(editingDomains.text) }, "Domains saved").then(
                          () => setEditingDomains(null),
                        )
                      }
                    >
                      Save
                    </Button>
                  </span>
                ) : (
                  <button
                    className="underline-offset-2 hover:underline"
                    onClick={() => setEditingDomains({ id: s.id, text: s.domains.join(", ") })}
                  >
                    {s.domains.length
                      ? `Only sent to ${s.domains.join(", ")}`
                      : "Can be sent to any host (set domains)"}
                  </button>
                )}{" "}
                ·{" "}
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={s.scriptAccess}
                    disabled={busy}
                    onChange={() => void patch(s.id, { scriptAccess: !s.scriptAccess })}
                  />
                  scripts may read and replace it
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
        <label className="block space-y-1 text-sm">
          <span>Allowed domains (optional)</span>
          <Input
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder="api.example.com, *.example.org"
            aria-label="Allowed domains"
          />
          <span className="text-xs text-muted-foreground">
            The secret is only sent to these hosts; a request to any other host is refused before it leaves.
            Leave empty to allow any host.
          </span>
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
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />
            Only me (personal secret)
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={scriptAccess}
              onChange={(e) => setScriptAccess(e.target.checked)}
            />
            Let scripts read and replace it with <code>pm.vault</code>
          </label>
        </div>
        <div>
          <Button size="sm" disabled={busy || !name.trim() || !value} onClick={() => void add()}>
            Store secret
          </Button>
        </div>
      </div>

      <div className="space-y-2 rounded-md border p-3 text-sm" aria-label="Move secrets">
        <h4 className="font-medium">Move secrets</h4>
        <div className="flex flex-wrap items-center gap-2">
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
            Replaces each secret variable&apos;s value with a vault reference.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            className="h-8 w-56"
            placeholder="Passphrase (8+ characters)"
            autoComplete="new-password"
            aria-label="Export passphrase"
            value={exportPass}
            onChange={(e) => setExportPass(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || exportPass.length < 8}
            onClick={() => void download()}
          >
            Export encrypted file
          </Button>
          <span className="text-xs text-muted-foreground">
            Workspace owners. Includes your personal secrets.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="text-xs"
            aria-label="Vault export file"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
            }}
          />
          <Input
            type="password"
            className="h-8 w-44"
            placeholder="File passphrase"
            autoComplete="off"
            aria-label="Import passphrase"
            value={importPass}
            onChange={(e) => setImportPass(e.target.value)}
          />
          <select
            className="h-8 rounded-md border bg-transparent px-2 text-xs"
            aria-label="When a name already exists"
            value={conflict}
            onChange={(e) => setConflict(e.target.value)}
          >
            <option value="skip">Skip existing names</option>
            <option value="replace">Replace existing</option>
            <option value="rename">Keep both (rename)</option>
          </select>
        </div>
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
