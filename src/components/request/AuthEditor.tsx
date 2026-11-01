"use client";
/**
 * Auth configuration editor used by requests, folders and collections.
 */
import { formatTime } from "@/lib/format";
import { useState } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import type {
  AsapAlgorithm,
  AsapConfig,
  AuthConfig,
  AuthType,
  AwsSigV4Config,
  EdgeGridConfig,
  HawkAlgorithm,
  OAuth1Config,
  OAuth1SignatureMethod,
  OAuth2Config,
} from "@/core/types";
import { ASAP_ALGORITHMS, OAUTH1_SIGNATURE_METHODS } from "@/core/types";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { VarInput } from "@/components/editor/VarInput";
import { useApp } from "@/stores/app";
import { OAuthTokensDialog } from "@/components/dialogs/OAuthTokensDialog";

const TYPES: { type: AuthType; label: string }[] = [
  { type: "inherit", label: "Inherit auth from parent" },
  { type: "none", label: "No Auth" },
  { type: "bearer", label: "Bearer Token" },
  { type: "basic", label: "Basic Auth" },
  { type: "apikey", label: "API Key" },
  { type: "digest", label: "Digest Auth" },
  { type: "ntlm", label: "NTLM Authentication" },
  { type: "oauth1", label: "OAuth 1.0" },
  { type: "oauth2", label: "OAuth 2.0" },
  { type: "edgegrid", label: "Akamai EdgeGrid" },
  { type: "hawk", label: "Hawk Authentication" },
  { type: "awsv4", label: "AWS Signature" },
  { type: "asap", label: "ASAP (Atlassian)" },
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
    case "edgegrid":
      return {
        type,
        edgegrid: {
          clientToken: "",
          clientSecret: "",
          accessToken: "",
          baseURL: "",
          headersToSign: "",
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
    case "ntlm":
      return { type, ntlm: { username: "", password: "" } };
    case "asap":
      return { type, asap: { algorithm: "RS256", issuer: "", audience: "", keyId: "", privateKey: "" } };
    case "oauth1":
      return { type, oauth1: { consumerKey: "", consumerSecret: "", signatureMethod: "HMAC-SHA1" } };
    case "awsv4":
      return { type, awsv4: { accessKey: "", secretKey: "", region: "us-east-1", service: "" } };
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
      {auth.type === "ntlm" && (
        <>
          <Field label="Username">
            <VarInput
              value={auth.ntlm.username}
              onChange={(username) => onChange({ ...auth, ntlm: { ...auth.ntlm, username } })}
              placeholder="user or DOMAIN\user"
            />
          </Field>
          <Field label="Password">
            <VarInput
              masked
              value={auth.ntlm.password}
              onChange={(password) => onChange({ ...auth, ntlm: { ...auth.ntlm, password } })}
              placeholder="Password"
            />
          </Field>
          <Field label="Domain">
            <VarInput
              value={auth.ntlm.domain ?? ""}
              onChange={(domain) =>
                onChange({ ...auth, ntlm: { ...auth.ntlm, domain: domain || undefined } })
              }
              placeholder="Optional"
            />
          </Field>
          <Field label="Workstation">
            <VarInput
              value={auth.ntlm.workstation ?? ""}
              onChange={(workstation) =>
                onChange({ ...auth, ntlm: { ...auth.ntlm, workstation: workstation || undefined } })
              }
              placeholder="Optional"
            />
          </Field>
        </>
      )}
      {auth.type === "asap" && (
        <AsapEditor config={auth.asap} onChange={(asap) => onChange({ ...auth, asap })} />
      )}
      {auth.type === "oauth1" && (
        <OAuth1Editor config={auth.oauth1} onChange={(oauth1) => onChange({ ...auth, oauth1 })} />
      )}
      {auth.type === "awsv4" && (
        <AwsSigV4Editor config={auth.awsv4} onChange={(awsv4) => onChange({ ...auth, awsv4 })} />
      )}
      {auth.type === "edgegrid" && (
        <EdgeGridEditor config={auth.edgegrid} onChange={(edgegrid) => onChange({ ...auth, edgegrid })} />
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
  const [managing, setManaging] = useState(false);
  const [now] = useState(() => Date.now());
  const { workspaceId, environmentId } = useApp();

  const authorizeInBrowser = async () => {
    // Open synchronously so popup blockers treat it as user-initiated.
    const popup = window.open("about:blank", "postbox-oauth2", "width=520,height=720");
    if (!popup) throw new Error("Allow pop-ups for Postbox to sign in");
    const res = await fetch("/api/oauth2/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        environmentId,
        folderId,
        callbackUrl: `${window.location.origin}/api/oauth2/callback`,
        config,
      }),
    });
    const start = await res.json();
    if (!res.ok) {
      popup.close();
      throw new Error(start.error);
    }
    popup.location.href = start.authorizationUrl;
    const collect = async () => {
      const r = await fetch(`/api/oauth2/authorize?state=${encodeURIComponent(start.state)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      return data as { status: "pending" | "done" | "error"; error?: string } & Partial<OAuth2Config>;
    };
    const result = await new Promise<Awaited<ReturnType<typeof collect>>>((resolve, reject) => {
      const deadline = Date.now() + 10 * 60 * 1000;
      let busy = false;
      const check = async () => {
        if (busy) return;
        busy = true;
        try {
          const data = await collect();
          if (data.status !== "pending") return finish(() => resolve(data));
          if (popup.closed || Date.now() > deadline)
            return finish(() =>
              reject(new Error(popup.closed ? "Sign-in window was closed" : "Sign-in timed out")),
            );
        } catch (err) {
          finish(() => reject(err));
        } finally {
          busy = false;
        }
      };
      const onMessage = (e: MessageEvent) => {
        if (
          e.origin === window.location.origin &&
          e.data?.type === "postbox-oauth2" &&
          e.data.state === start.state
        )
          void check();
      };
      const timer = window.setInterval(check, 1000);
      const finish = (done: () => void) => {
        window.clearInterval(timer);
        window.removeEventListener("message", onMessage);
        done();
      };
      window.addEventListener("message", onMessage);
    });
    if (result.status === "error") throw new Error(result.error);
    return result;
  };

  const fetchToken = async () => {
    setLoading(true);
    try {
      if (config.grantType === "authorization_code") {
        const data = await authorizeInBrowser();
        set({
          accessToken: data.accessToken ?? "",
          refreshToken: data.refreshToken,
          tokenType: data.tokenType,
          expiresAt: data.expiresAt,
          tokenContext: data.tokenContext,
        });
        toast.success(
          data.refreshToken
            ? "Signed in; it will refresh automatically when it expires"
            : "Signed in; access token saved to this request",
        );
        return;
      }
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
            <SelectItem value="authorization_code" className="text-xs">
              Authorization Code (with PKCE)
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
          {config.grantType === "authorization_code" && (
            <>
              <Field label="Auth URL">
                <VarInput
                  value={config.authUrl ?? ""}
                  onChange={(authUrl) => set({ authUrl })}
                  placeholder="https://auth.example.com/oauth/authorize"
                />
              </Field>
              <Field label="Callback URL">
                <VarInput
                  value={config.redirectUri ?? ""}
                  onChange={(redirectUri) => set({ redirectUri: redirectUri || undefined })}
                  placeholder={
                    typeof window === "undefined"
                      ? "/api/oauth2/callback"
                      : `${window.location.origin}/api/oauth2/callback`
                  }
                />
              </Field>
              <Field label="PKCE">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={config.usePkce !== false}
                    onCheckedChange={(usePkce) => set({ usePkce: usePkce ? undefined : false })}
                  />
                  <Select
                    value={config.codeChallengeMethod ?? "S256"}
                    onValueChange={(m) => set({ codeChallengeMethod: m === "plain" ? "plain" : undefined })}
                  >
                    <SelectTrigger size="sm" className="w-32 text-xs" disabled={config.usePkce === false}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="S256" className="text-xs">
                        SHA-256
                      </SelectItem>
                      <SelectItem value="plain" className="text-xs">
                        Plain
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </Field>
            </>
          )}
          <Field label="Access Token URL">
            <VarInput
              value={config.accessTokenUrl}
              onChange={(accessTokenUrl) => set({ accessTokenUrl })}
              placeholder="https://auth.example.com/oauth/token"
            />
          </Field>
          <Field label="Revocation URL">
            <VarInput
              value={config.revocationUrl ?? ""}
              onChange={(revocationUrl) => set({ revocationUrl: revocationUrl || undefined })}
              placeholder="Optional; https://auth.example.com/oauth/revoke"
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
                  ? `Expires ${formatTime(config.expiresAt)}`
                  : config.refreshToken
                    ? "Expired; refreshes on next send"
                    : "Token expired"}
              </span>
            )}
            {config.refreshToken && <span className="text-muted-foreground">Refresh token saved</span>}
            {(config.accessToken || config.refreshToken) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  set({
                    accessToken: "",
                    refreshToken: undefined,
                    expiresAt: undefined,
                    tokenContext: undefined,
                    tokenType: undefined,
                  })
                }
              >
                Clear tokens
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setManaging(true)}>
              Manage saved tokens
            </Button>
            <OAuthTokensDialog open={managing} onOpenChange={setManaging} />
          </div>
          <p className="pl-[172px] text-muted-foreground">
            {config.grantType === "authorization_code"
              ? "Signs in through the provider in a pop-up window; the saved token is then used for sends and runs. Register the callback URL with the provider."
              : "If the token is empty or expired, Postbox requests a new one automatically when sending."}
          </p>
        </>
      )}
    </>
  );
}

function AsapEditor({ config, onChange }: { config: AsapConfig; onChange: (c: AsapConfig) => void }) {
  const set = (patch: Partial<AsapConfig>) => onChange({ ...config, ...patch });
  return (
    <div className="flex flex-col gap-3">
      <Field label="Algorithm">
        <Select
          value={config.algorithm ?? "RS256"}
          onValueChange={(v) => set({ algorithm: v as AsapAlgorithm })}
        >
          <SelectTrigger size="sm" className="w-64 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ASAP_ALGORITHMS.map((alg) => (
              <SelectItem key={alg} value={alg} className="text-xs">
                {alg}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Issuer">
        <VarInput value={config.issuer} onChange={(issuer) => set({ issuer })} placeholder="my-service" />
      </Field>
      <Field label="Subject">
        <VarInput
          value={config.subject ?? ""}
          onChange={(subject) => set({ subject: subject || undefined })}
          placeholder="Optional; defaults to the issuer on the receiving side"
        />
      </Field>
      <Field label="Audience">
        <VarInput
          value={config.audience}
          onChange={(audience) => set({ audience })}
          placeholder="other-service (comma-separate several)"
        />
      </Field>
      <Field label="Key ID">
        <VarInput value={config.keyId} onChange={(keyId) => set({ keyId })} placeholder="my-service/key-1" />
      </Field>
      <Field label="Private Key">
        <VarInput
          masked
          value={config.privateKey}
          onChange={(privateKey) => set({ privateKey })}
          placeholder="{{asapPrivateKey}} (a secret variable holding the PEM key)"
        />
      </Field>
      <Field label="Expiry">
        <VarInput
          value={config.expiry ?? ""}
          onChange={(expiry) => set({ expiry: expiry || undefined })}
          placeholder="1h (max), 30m or seconds"
        />
      </Field>
      <Field label="Additional claims">
        <Textarea
          className="min-h-16 font-mono text-xs"
          value={config.additionalClaims ?? ""}
          onChange={(e) => set({ additionalClaims: e.target.value || undefined })}
          placeholder='{"scope": "read"}'
          spellCheck={false}
        />
      </Field>
    </div>
  );
}

function OAuth1Editor({ config, onChange }: { config: OAuth1Config; onChange: (c: OAuth1Config) => void }) {
  const set = (patch: Partial<OAuth1Config>) => onChange({ ...config, ...patch });
  const method = config.signatureMethod ?? "HMAC-SHA1";
  const rsa = method.startsWith("RSA-");
  const optional =
    (key: "token" | "timestamp" | "nonce" | "realm" | "callback" | "verifier") => (value: string) =>
      set({ [key]: value || undefined });
  return (
    <div className="flex flex-col gap-3">
      <Field label="Signature Method">
        <Select value={method} onValueChange={(v) => set({ signatureMethod: v as OAuth1SignatureMethod })}>
          <SelectTrigger size="sm" className="w-64 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OAUTH1_SIGNATURE_METHODS.map((m) => (
              <SelectItem key={m} value={m} className="text-xs">
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Add auth data to">
        <Select
          value={config.addTo ?? "header"}
          onValueChange={(v) => set({ addTo: v === "header" ? undefined : (v as "query" | "body") })}
        >
          <SelectTrigger size="sm" className="w-64 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="header" className="text-xs">
              Request headers
            </SelectItem>
            <SelectItem value="query" className="text-xs">
              Request URL
            </SelectItem>
            <SelectItem value="body" className="text-xs">
              Request body (form-urlencoded)
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Consumer Key">
        <VarInput
          value={config.consumerKey}
          onChange={(consumerKey) => set({ consumerKey })}
          placeholder="Consumer key"
        />
      </Field>
      {rsa ? (
        <Field label="Private Key (PEM)">
          <Textarea
            className="min-h-24 font-mono text-xs"
            value={config.privateKey ?? ""}
            onChange={(e) => set({ privateKey: e.target.value || undefined })}
            placeholder="-----BEGIN PRIVATE KEY-----"
            spellCheck={false}
          />
        </Field>
      ) : (
        <Field label="Consumer Secret">
          <VarInput
            masked
            value={config.consumerSecret}
            onChange={(consumerSecret) => set({ consumerSecret })}
            placeholder="Consumer secret"
          />
        </Field>
      )}
      <Field label="Access Token">
        <VarInput value={config.token ?? ""} onChange={optional("token")} placeholder="Token (optional)" />
      </Field>
      {!rsa && (
        <Field label="Token Secret">
          <VarInput
            masked
            value={config.tokenSecret ?? ""}
            onChange={(tokenSecret) => set({ tokenSecret: tokenSecret || undefined })}
            placeholder="Token secret (optional)"
          />
        </Field>
      )}
      <Field label="Callback URL">
        <VarInput
          value={config.callback ?? ""}
          onChange={optional("callback")}
          placeholder="Request-token step (optional)"
        />
      </Field>
      <Field label="Verifier">
        <VarInput
          value={config.verifier ?? ""}
          onChange={optional("verifier")}
          placeholder="Access-token step (optional)"
        />
      </Field>
      <Field label="Timestamp">
        <VarInput
          value={config.timestamp ?? ""}
          onChange={optional("timestamp")}
          placeholder="Auto-generated if empty"
        />
      </Field>
      <Field label="Nonce">
        <VarInput
          value={config.nonce ?? ""}
          onChange={optional("nonce")}
          placeholder="Auto-generated if empty"
        />
      </Field>
      <Field label="Version">
        <VarInput
          value={config.version ?? "1.0"}
          onChange={(version) => set({ version })}
          placeholder="1.0"
        />
      </Field>
      <Field label="Realm">
        <VarInput value={config.realm ?? ""} onChange={optional("realm")} placeholder="Optional" />
      </Field>
      <Field label="Include body hash">
        <Switch
          checked={!!config.includeBodyHash}
          onCheckedChange={(v) => set({ includeBodyHash: v || undefined })}
        />
      </Field>
      <Field label="Add empty parameters to signature">
        <Switch
          checked={!!config.addEmptyParamsToSign}
          onCheckedChange={(v) => set({ addEmptyParamsToSign: v || undefined })}
        />
      </Field>
    </div>
  );
}

function AwsSigV4Editor({
  config,
  onChange,
}: {
  config: AwsSigV4Config;
  onChange: (c: AwsSigV4Config) => void;
}) {
  const set = (patch: Partial<AwsSigV4Config>) => onChange({ ...config, ...patch });
  return (
    <div className="flex flex-col gap-3">
      <Field label="Add auth data to">
        <Select
          value={config.addTo ?? "header"}
          onValueChange={(v) => set({ addTo: v === "query" ? "query" : undefined })}
        >
          <SelectTrigger size="sm" className="w-64 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="header" className="text-xs">
              Request headers
            </SelectItem>
            <SelectItem value="query" className="text-xs">
              Request URL (presigned)
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Access Key">
        <VarInput value={config.accessKey} onChange={(accessKey) => set({ accessKey })} placeholder="AKIA…" />
      </Field>
      <Field label="Secret Key">
        <VarInput
          masked
          value={config.secretKey}
          onChange={(secretKey) => set({ secretKey })}
          placeholder="Secret access key"
        />
      </Field>
      <Field label="AWS Region">
        <VarInput
          value={config.region ?? ""}
          onChange={(region) => set({ region: region || undefined })}
          placeholder="us-east-1"
        />
      </Field>
      <Field label="Service Name">
        <VarInput
          value={config.service}
          onChange={(service) => set({ service })}
          placeholder="execute-api, s3, lambda…"
        />
      </Field>
      <Field label="Session Token">
        <VarInput
          masked
          value={config.sessionToken ?? ""}
          onChange={(sessionToken) => set({ sessionToken: sessionToken || undefined })}
          placeholder="For temporary (STS) credentials (optional)"
        />
      </Field>
      {config.addTo === "query" && (
        <Field label="Expires (seconds)">
          <VarInput
            value={config.expiresSeconds !== undefined ? String(config.expiresSeconds) : ""}
            onChange={(v) => {
              const n = Number(v);
              set({ expiresSeconds: v && Number.isInteger(n) && n > 0 ? Math.min(n, 604800) : undefined });
            }}
            placeholder="3600"
          />
        </Field>
      )}
    </div>
  );
}

function EdgeGridEditor({
  config,
  onChange,
}: {
  config: EdgeGridConfig;
  onChange: (c: EdgeGridConfig) => void;
}) {
  const set = (patch: Partial<EdgeGridConfig>) => onChange({ ...config, ...patch });

  return (
    <div className="flex flex-col gap-3">
      <Field label="Access Token">
        <VarInput
          value={config.accessToken}
          onChange={(accessToken) => set({ accessToken })}
          placeholder="akab-xxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxx"
        />
      </Field>
      <Field label="Client Token">
        <VarInput
          value={config.clientToken}
          onChange={(clientToken) => set({ clientToken })}
          placeholder="akab-xxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxx"
        />
      </Field>
      <Field label="Client Secret">
        <VarInput
          masked
          value={config.clientSecret}
          onChange={(clientSecret) => set({ clientSecret })}
          placeholder="Secret key"
        />
      </Field>
      <Field label="Base URL">
        <VarInput
          value={config.baseURL ?? ""}
          onChange={(baseURL) => set({ baseURL: baseURL || undefined })}
          placeholder="https://akab-xxxx.luna.akamaiapis.net (optional)"
        />
      </Field>
      <Field label="Headers to Sign">
        <VarInput
          value={config.headersToSign ?? ""}
          onChange={(headersToSign) => set({ headersToSign: headersToSign || undefined })}
          placeholder="e.g. Content-Type (comma separated, optional)"
        />
      </Field>
      <Field label="Max Body Size">
        <VarInput
          value={config.maxBodySize !== undefined ? String(config.maxBodySize) : ""}
          onChange={(val) => {
            const num = parseInt(val, 10);
            set({ maxBodySize: Number.isNaN(num) ? undefined : num });
          }}
          placeholder="131072 (bytes, optional)"
        />
      </Field>
      <p className="text-muted-foreground">
        Requests will be signed with Akamai EdgeGrid V1 (EG1-HMAC-SHA256).
      </p>
    </div>
  );
}
