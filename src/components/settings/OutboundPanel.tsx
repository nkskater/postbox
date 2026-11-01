"use client";
/** Administrators: outbound proxy, custom CAs / client certificates, and the active host policy. */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";

interface ProxyView {
  configured: boolean;
  enabled: boolean;
  url: string;
  username: string;
  passwordSet: boolean;
  bypass: string[];
}
interface ProfileView {
  id: string;
  name: string;
  hosts: string[];
  ca: { subjects: string[]; expires: string | null } | null;
  clientCertificate: { subject: string; issuer: string; expires: string; fingerprint: string } | null;
  passphraseSet: boolean;
}
interface PolicyView {
  allow: string[];
  deny: string[];
  sockets: string[];
  proxiedTargets: string[];
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

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);

function RuleList({ title, rules }: { title: string; rules: string[] }) {
  return (
    <div>
      <h5 className="text-xs font-medium text-muted-foreground">{title}</h5>
      {rules.length ? (
        <ul className="font-mono text-xs">
          {rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">None</p>
      )}
    </div>
  );
}

function ProxyForm({ proxy, onChange }: { proxy: ProxyView; onChange: () => void }) {
  const [url, setUrl] = useState(proxy.url);
  const [username, setUsername] = useState(proxy.username);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [bypass, setBypass] = useState(proxy.bypass.join("\n"));
  const [enabled, setEnabled] = useState(proxy.configured ? proxy.enabled : true);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await call("/api/admin/outbound/proxy", "PUT", {
        url,
        enabled,
        username,
        bypass: lines(bypass),
        ...(password ? { password } : clearPassword ? { password: "" } : {}),
      });
      setPassword("");
      setClearPassword(false);
      toast.success("Proxy saved");
      onChange();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await call("/api/admin/outbound/proxy", "DELETE");
      toast.success("Proxy removed");
      onChange();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Outbound proxy">
      <div>
        <h3 className="font-medium">Outbound proxy</h3>
        <p className="text-sm text-muted-foreground">
          Send requests, SSE, WebSocket and Socket.IO connections through an HTTP(S) proxy. gRPC and MQTT
          cannot use it; add their hosts to the bypass list.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>Proxy URL</span>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://proxy.corp:3128" />
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Use this proxy</span>
        </label>
        <label className="space-y-1 text-sm">
          <span>Username</span>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <label className="space-y-1 text-sm">
          <span>Password</span>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={proxy.passwordSet ? "Saved. Type to replace." : ""}
            autoComplete="new-password"
          />
          {proxy.passwordSet && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={clearPassword}
                onChange={(e) => setClearPassword(e.target.checked)}
                aria-label="Remove the saved password"
              />
              Remove the saved password
            </span>
          )}
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span>Bypass list (one per line: host, *.domain, address or CIDR)</span>
        <Textarea
          value={bypass}
          onChange={(e) => setBypass(e.target.value)}
          rows={3}
          className="font-mono text-xs"
          placeholder={"localhost\n*.internal.corp\n10.0.0.0/8"}
        />
      </label>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} disabled={busy || !url.trim()}>
          Save proxy
        </Button>
        {proxy.configured && (
          <Button size="sm" variant="outline" onClick={() => void remove()} disabled={busy}>
            Remove
          </Button>
        )}
      </div>
    </section>
  );
}

function ProfileForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [hosts, setHosts] = useState("");
  const [ca, setCa] = useState("");
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await call("/api/admin/outbound/tls-profiles", "POST", {
        name,
        hosts: lines(hosts),
        ...(ca.trim() ? { ca } : {}),
        ...(cert.trim() ? { cert } : {}),
        ...(key.trim() ? { key } : {}),
        ...(passphrase ? { passphrase } : {}),
      });
      setName("");
      setHosts("");
      setCa("");
      setCert("");
      setKey("");
      setPassphrase("");
      toast.success("TLS profile saved");
      onCreated();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <h4 className="text-sm font-medium">Add a TLS profile</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Internal APIs" />
        </label>
        <label className="space-y-1 text-sm">
          <span>Hosts (one per line: host, *.domain or host:port)</span>
          <Textarea
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            rows={2}
            className="font-mono text-xs"
            placeholder={"*.internal.corp\napi.corp:8443"}
          />
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span>CA certificate (PEM, trusted in addition to the system roots)</span>
        <Textarea value={ca} onChange={(e) => setCa(e.target.value)} rows={3} className="font-mono text-xs" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>Client certificate (PEM)</span>
          <Textarea
            value={cert}
            onChange={(e) => setCert(e.target.value)}
            rows={3}
            className="font-mono text-xs"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>Private key (PEM, never shown again)</span>
          <Textarea
            value={key}
            onChange={(e) => setKey(e.target.value)}
            rows={3}
            className="font-mono text-xs"
            autoComplete="off"
          />
        </label>
      </div>
      <label className="block space-y-1 text-sm sm:max-w-xs">
        <span>Key passphrase (if encrypted)</span>
        <Input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      <Button size="sm" onClick={() => void create()} disabled={busy || !name.trim() || !hosts.trim()}>
        Save profile
      </Button>
    </div>
  );
}

export function OutboundPanel({ isAdmin }: { isAdmin: boolean }) {
  const [proxy, setProxy] = useState<ProxyView | null>(null);
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    Promise.all([
      call<ProxyView>("/api/admin/outbound/proxy"),
      call<ProfileView[]>("/api/admin/outbound/tls-profiles"),
      call<PolicyView>("/api/admin/outbound/policy"),
    ])
      .then(([p, t, rules]) => {
        setProxy(p);
        setProfiles(t);
        setPolicy(rules);
        setError("");
      })
      .catch((err) => setError((err as Error).message));
  }, []);
  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  if (!isAdmin) return null;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!proxy) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const remove = async (id: string) => {
    try {
      await call(`/api/admin/outbound/tls-profiles/${id}`, "DELETE");
      toast.success("Profile deleted");
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <ProxyForm
        key={`${proxy.url}|${proxy.enabled}|${proxy.passwordSet}|${proxy.bypass.join()}`}
        proxy={proxy}
        onChange={() => load()}
      />

      <section className="space-y-3 rounded-lg border p-4" aria-label="TLS profiles">
        <div>
          <h3 className="font-medium">Certificates and mutual TLS</h3>
          <p className="text-sm text-muted-foreground">
            A profile applies to the hosts it lists. Its CA is trusted in addition to the system roots, and
            its client certificate is presented when the server asks for one. The most specific match wins.
          </p>
        </div>
        {profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No profiles yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {profiles.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 p-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <div className="font-medium">{p.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{p.hosts.join(", ")}</div>
                  {p.ca && (
                    <div className="text-xs">
                      CA: {p.ca.subjects.join("; ")}
                      {p.ca.expires && ` (expires ${formatDateTime(new Date(p.ca.expires).getTime())})`}
                    </div>
                  )}
                  {p.clientCertificate && (
                    <div className="text-xs">
                      Client certificate: {p.clientCertificate.subject} (expires{" "}
                      {formatDateTime(new Date(p.clientCertificate.expires).getTime())})
                      {p.passphraseSet && ", key passphrase saved"}
                    </div>
                  )}
                </div>
                <Button size="sm" variant="outline" onClick={() => void remove(p.id)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
        <ProfileForm onCreated={() => load()} />
      </section>

      {policy && (
        <section className="space-y-3 rounded-lg border p-4" aria-label="Host policy">
          <div>
            <h3 className="font-medium">Active host policy</h3>
            <p className="text-sm text-muted-foreground">
              Set with PROXY_ALLOW_HOSTS, PROXY_DENY_HOSTS and PROXY_ALLOW_SOCKETS when the server starts.
              Read-only.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <RuleList title="Allowed hosts" rules={policy.allow} />
            <RuleList title="Denied hosts" rules={policy.deny} />
            <RuleList title="Allowed sockets" rules={policy.sockets} />
          </div>
          <div>
            <h5 className="text-xs font-medium text-muted-foreground">How the rules apply through a proxy</h5>
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              {policy.proxiedTargets.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
