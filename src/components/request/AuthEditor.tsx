"use client";
/**
 * Auth configuration editor used by requests, folders and collections.
 */
import { useState } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import type { AuthConfig, AuthType, HawkAlgorithm, OAuth2Config } from "@/core/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { VarInput } from "@/components/editor/VarInput";
import { useApp } from "@/stores/app";

const TYPES: { type: AuthType; label: string }[] = [
  { type: "inherit", label: "Inherit auth from parent" },
  { type: "none", label: "No Auth" },
  { type: "bearer", label: "Bearer Token" },
  { type: "basic", label: "Basic Auth" },
  { type: "apikey", label: "API Key" },
  { type: "digest", label: "Digest Auth" },
  { type: "oauth2", label: "OAuth 2.0" },
  { type: "hawk", label: "Hawk Authentication" },
];

export function defaultAuth(type: AuthType): AuthConfig {
  switch (type) {
    case "bearer":
      return { type, bearer: { token: "" } };
    case "basic":
      return { type, basic: { username: "", password: "" } };
    case "apikey":
      return { type, apikey: { key: "", value: "", in: "header" } };
    case "digest":
      return { type, digest: { username: "", password: "" } };
    case "oauth2":
      return {
        type,
        oauth2: {
          grantType: "client_credentials",
          accessTokenUrl: "",
          clientId: "",
          clientSecret: "",
          scope: "",
          clientAuthentication: "header",
          accessToken: "",
          headerPrefix: "Bearer",
        },
      };
    case "hawk":
      return {
        type,
        hawk: {
          authId: "",
          authKey: "",
          algorithm: "sha256",
          includePayloadHash: false,
        },
      };
    default:
      return { type } as AuthConfig;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-center gap-3">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

export function AuthEditor({
  auth,
  onChange,
  isCollection,
  folderId,
}: {
  auth: AuthConfig;
  onChange: (a: AuthConfig) => void;
  /** Collections have no parent, so "inherit" means "no auth". */
  isCollection?: boolean;
  folderId?: string | null;
}) {
  const types = isCollection ? TYPES.filter((t) => t.type !== "inherit") : TYPES;
  const value = isCollection && auth.type === "inherit" ? "none" : auth.type;
  return (
    <div className="flex max-w-3xl flex-col gap-4 text-xs">
      <Field label="Auth Type">
        <Select value={value} onValueChange={(t) => onChange(defaultAuth(t as AuthType))}>
          <SelectTrigger size="sm" className="w-64 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {types.map((t) => (
              <SelectItem key={t.type} value={t.type} className="text-xs">
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {auth.type === "inherit" && !isCollection && (
        <p className="text-muted-foreground">
          This request uses the auth configured on its parent folder or collection.
        </p>
      )}
      {auth.type === "none" && <p className="text-muted-foreground">No authorization will be sent.</p>}
      {auth.type === "bearer" && (
        <>
          <Field label="Token">
            <VarInput
              value={auth.bearer.token}
              onChange={(token) => onChange({ ...auth, bearer: { ...auth.bearer, token } })}
              placeholder="Token"
            />
          </Field>
          <Field label="Prefix">
            <VarInput
              value={auth.bearer.prefix ?? "Bearer"}
              onChange={(prefix) => onChange({ ...auth, bearer: { ...auth.bearer, prefix } })}
              className="w-48"
            />
          </Field>
        </>
      )}
      {(auth.type === "basic" || auth.type === "digest") && (
        <>
          <Field label="Username">
            <VarInput
              value={auth.type === "basic" ? auth.basic.username : auth.digest.username}
              onChange={(username) =>
                onChange(
                  auth.type === "basic"
                    ? { ...auth, basic: { ...auth.basic, username } }
                    : { ...auth, digest: { ...auth.digest, username } },
                )
              }
            />
          </Field>
          <Field label="Password">
            <VarInput
              masked
              value={auth.type === "basic" ? auth.basic.password : auth.digest.password}
              onChange={(password) =>
                onChange(
                  auth.type === "basic"
                    ? { ...auth, basic: { ...auth.basic, password } }
                    : { ...auth, digest: { ...auth.digest, password } },
                )
              }
            />
          </Field>
          {auth.type === "digest" && (
            <p className="text-muted-foreground">
              Postbox answers the server&apos;s digest challenge automatically (MD5, SHA-256, qop=auth).
            </p>
          )}
        </>
      )}
      {auth.type === "apikey" && (
        <>
          <Field label="Key">
            <VarInput
              value={auth.apikey.key}
              onChange={(key) => onChange({ ...auth, apikey: { ...auth.apikey, key } })}
              placeholder="X-API-Key"
            />
          </Field>
          <Field label="Value">
            <VarInput
              value={auth.apikey.value}
              onChange={(v) => onChange({ ...auth, apikey: { ...auth.apikey, value: v } })}
            />
          </Field>
          <Field label="Add to">
            <Select
              value={auth.apikey.in}
              onValueChange={(where) =>
                onChange({ ...auth, apikey: { ...auth.apikey, in: where as "header" | "query" } })
              }
            >
              <SelectTrigger size="sm" className="w-48 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="header" className="text-xs">
                  Header
                </SelectItem>
                <SelectItem value="query" className="text-xs">
                  Query Params
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </>
      )}
      {auth.type === "oauth2" && (
        <OAuth2Editor
          config={auth.oauth2}
          onChange={(oauth2) => onChange({ ...auth, oauth2 })}
          folderId={folderId}
        />
      )}
      {auth.type === "hawk" && (
        <>
          <Field label="Hawk Auth ID">
            <VarInput
              value={auth.hawk.authId}
              onChange={(authId) => onChange({ ...auth, hawk: { ...auth.hawk, authId } })}
              placeholder="Hawk Auth ID"
            />
          </Field>
          <Field label="Hawk Auth Key">
            <VarInput
              masked
              value={auth.hawk.authKey}
              onChange={(authKey) => onChange({ ...auth, hawk: { ...auth.hawk, authKey } })}
              placeholder="Hawk Auth Key"
            />
          </Field>
          <Field label="Algorithm">
            <Select
              value={auth.hawk.algorithm}
              onValueChange={(algorithm) =>
                onChange({ ...auth, hawk: { ...auth.hawk, algorithm: algorithm as HawkAlgorithm } })
              }
            >
              <SelectTrigger size="sm" className="w-64 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sha256" className="text-xs">
                  SHA-256
                </SelectItem>
                <SelectItem value="sha1" className="text-xs">
                  SHA-1
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Include Payload Hash">
            <div className="flex items-center gap-2">
              <Switch
                checked={auth.hawk.includePayloadHash ?? false}
                onCheckedChange={(includePayloadHash) =>
                  onChange({ ...auth, hawk: { ...auth.hawk, includePayloadHash } })
                }
              />
              <span className="text-muted-foreground text-xs">
                Calculate cryptographic hash of the request body
              </span>
            </div>
          </Field>
          <Field label="User">
            <VarInput
              value={auth.hawk.user ?? ""}
              onChange={(user) => onChange({ ...auth, hawk: { ...auth.hawk, user: user || undefined } })}
              placeholder="User"
            />
          </Field>
          <Field label="Nonce">
            <VarInput
              value={auth.hawk.nonce ?? ""}
              onChange={(nonce) => onChange({ ...auth, hawk: { ...auth.hawk, nonce: nonce || undefined } })}
              placeholder="Auto-generated if empty"
            />
          </Field>
          <Field label="Extra Data (ext)">
            <VarInput
              value={auth.hawk.ext ?? ""}
              onChange={(ext) => onChange({ ...auth, hawk: { ...auth.hawk, ext: ext || undefined } })}
              placeholder="Application-specific data"
            />
          </Field>
          <Field label="App ID">
            <VarInput
              value={auth.hawk.app ?? ""}
              onChange={(app) => onChange({ ...auth, hawk: { ...auth.hawk, app: app || undefined } })}
              placeholder="Application ID"
            />
          </Field>
          <Field label="Delegation (dlg)">
            <VarInput
              value={auth.hawk.dlg ?? ""}
              onChange={(dlg) => onChange({ ...auth, hawk: { ...auth.hawk, dlg: dlg || undefined } })}
              placeholder="Delegation ID"
            />
          </Field>
          <Field label="Timestamp">
            <VarInput
              value={auth.hawk.timestamp ?? ""}
              onChange={(timestamp) =>
                onChange({ ...auth, hawk: { ...auth.hawk, timestamp: timestamp || undefined } })
              }
              placeholder="Auto-generated if empty"
            />
          </Field>
        </>
      )}
      {auth.type !== "inherit" && auth.type !== "none" && (
        <p role="note" className="text-[11px] text-muted-foreground">
          Saved authentication credentials stay in the workspace database. Browser drafts and collection
          exports omit them by default.
        </p>
      )}
    </div>
  );
}

function OAuth2Editor({
  config,
  onChange,
  folderId,
}: {
  config: OAuth2Config;
  onChange: (c: OAuth2Config) => void;
  folderId?: string | null;
}) {
  const set = (patch: Partial<OAuth2Config>) => onChange({ ...config, ...patch });
  const [loading, setLoading] = useState(false);
  const [now] = useState(() => Date.now());
  const { workspaceId, environmentId } = useApp();

  const fetchToken = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, environmentId, folderId, config }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      set({
        accessToken: data.accessToken,
        tokenType: data.tokenType,
        expiresAt: data.expiresAt,
        tokenContext: data.tokenContext,
      });
      toast.success("Access token obtained");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Field label="Grant Type">
        <Select
          value={config.grantType}
          onValueChange={(g) => set({ grantType: g as OAuth2Config["grantType"] })}
        >
          <SelectTrigger size="sm" className="w-64 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="client_credentials" className="text-xs">
              Client Credentials
            </SelectItem>
            <SelectItem value="password" className="text-xs">
              Password Credentials
            </SelectItem>
            <SelectItem value="manual" className="text-xs">
              Manual token
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Access Token">
        <VarInput
          value={config.accessToken}
          onChange={(accessToken) => set({ accessToken, expiresAt: undefined })}
          placeholder="Obtained automatically or paste one"
        />
      </Field>
      <Field label="Header Prefix">
        <VarInput
          value={config.headerPrefix}
          onChange={(headerPrefix) => set({ headerPrefix })}
          className="w-48"
        />
      </Field>
      {config.grantType !== "manual" && (
        <>
          <Field label="Access Token URL">
            <VarInput
              value={config.accessTokenUrl}
              onChange={(accessTokenUrl) => set({ accessTokenUrl })}
              placeholder="https://auth.example.com/oauth/token"
            />
          </Field>
          <Field label="Client ID">
            <VarInput value={config.clientId} onChange={(clientId) => set({ clientId })} />
          </Field>
          <Field label="Client Secret">
            <VarInput masked value={config.clientSecret} onChange={(clientSecret) => set({ clientSecret })} />
          </Field>
          {config.grantType === "password" && (
            <>
              <Field label="Username">
                <VarInput value={config.username ?? ""} onChange={(username) => set({ username })} />
              </Field>
              <Field label="Password">
                <VarInput masked value={config.password ?? ""} onChange={(password) => set({ password })} />
              </Field>
            </>
          )}
          <Field label="Scope">
            <VarInput value={config.scope} onChange={(scope) => set({ scope })} placeholder="read write" />
          </Field>
          <Field label="Client Authentication">
            <Select
              value={config.clientAuthentication}
              onValueChange={(v) => set({ clientAuthentication: v as "header" | "body" })}
            >
              <SelectTrigger size="sm" className="w-64 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="header" className="text-xs">
                  Send as Basic Auth header
                </SelectItem>
                <SelectItem value="body" className="text-xs">
                  Send client credentials in body
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-center gap-3 pl-[172px]">
            <Button size="sm" onClick={fetchToken} disabled={loading}>
              <KeyRound className="size-3.5" /> {loading ? "Requesting…" : "Get New Access Token"}
            </Button>
            {config.expiresAt && (
              <span className="text-muted-foreground">
                {config.expiresAt > now
                  ? `Expires ${new Date(config.expiresAt).toLocaleTimeString()}`
                  : "Token expired"}
              </span>
            )}
          </div>
          <p className="pl-[172px] text-muted-foreground">
            If the token is empty or expired, Postbox requests a new one automatically when sending.
          </p>
        </>
      )}
    </>
  );
}
