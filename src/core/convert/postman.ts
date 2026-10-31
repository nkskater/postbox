/**
 * Postman Collection v2.0/v2.1 and environment import/export.
 */
import type {
  AuthConfig,
  BodyConfig,
  FolderNode,
  FormDataField,
  KeyValue,
  OAuth2Config,
  RawLanguage,
  RequestNode,
  ResponseExample,
  TreeNode,
  Variable,
} from "../types";
import { ASAP_ALGORITHMS, DEFAULT_SETTINGS, OAUTH1_SIGNATURE_METHODS } from "../types";
import { authCredentialValues, credentialRedactionValues, redactSensitiveFields } from "../retention";
import { redactStoredValue } from "../variables/resolver";
import { exampleRequest, sanitizeExample } from "../examples";

const id = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);

// ------------------------------------------------------------------ Postman types (subset)

type PmDescription = string | { content?: string } | undefined;
interface PmKV {
  key?: string;
  value?: unknown;
  disabled?: boolean;
  description?: PmDescription;
  type?: string;
  src?: string | string[];
  contentType?: string;
}
interface PmAuth {
  type: string;
  [k: string]: unknown;
}
interface PmEvent {
  listen: "prerequest" | "test";
  script?: { exec?: string | string[] };
}
interface PmUrl {
  raw?: string;
  protocol?: string;
  host?: string | string[];
  port?: string;
  path?: string | string[];
  query?: PmKV[];
  variable?: PmKV[];
  hash?: string;
}
interface PmBody {
  mode?: string;
  raw?: string;
  urlencoded?: PmKV[];
  formdata?: PmKV[];
  file?: { src?: string };
  graphql?: { query?: string; variables?: string | object; operationName?: string };
  options?: { raw?: { language?: string } };
  disabled?: boolean;
}
interface PmRequest {
  method?: string;
  url?: string | PmUrl;
  header?: PmKV[] | string;
  body?: PmBody;
  auth?: PmAuth | null;
  description?: PmDescription;
}
interface PmItem {
  name?: string;
  item?: PmItem[];
  request?: PmRequest | string;
  response?: {
    name?: string;
    code?: number;
    status?: string;
    header?: PmKV[];
    body?: string;
    originalRequest?: PmRequest | string;
    _postbox?: { bodyEncoding?: "utf8" | "base64"; bodyOmitted?: boolean; truncated?: boolean };
  }[];
  event?: PmEvent[];
  auth?: PmAuth | null;
  description?: PmDescription;
  variable?: PmKV[];
}
export interface PostmanCollection {
  info: { name: string; schema?: string; description?: PmDescription; _postman_id?: string };
  item: PmItem[];
  auth?: PmAuth | null;
  event?: PmEvent[];
  variable?: PmKV[];
}

// ------------------------------------------------------------------ import

const str = (v: unknown) =>
  v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
const desc = (d: PmDescription) => (typeof d === "string" ? d : (d?.content ?? ""));
const kv = (list: PmKV[] | undefined): KeyValue[] =>
  (list ?? [])
    .filter((x) => x && (x.key || x.value))
    .map((x) => ({
      key: x.key ?? "",
      value: str(x.value),
      enabled: !x.disabled,
      description: desc(x.description) || undefined,
    }));

function scriptOf(events: PmEvent[] | undefined, listen: "prerequest" | "test"): string {
  const e = events?.find((x) => x.listen === listen);
  const exec = e?.script?.exec;
  return Array.isArray(exec) ? exec.join("\n") : (exec ?? "");
}

/** Postman auth arrays are [{key, value}], v2.0 used plain objects. */
function authParams(a: PmAuth, type: string): Record<string, string> {
  const raw = a[type];
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((p: PmKV) => [p.key ?? "", str(p.value)]));
  if (raw && typeof raw === "object")
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, str(v)]));
  return {};
}

export function importAuth(a: PmAuth | null | undefined): AuthConfig {
  if (a === undefined) return { type: "inherit" };
  if (a === null) return { type: "inherit" };
  const p = authParams(a, a.type);
  switch (a.type) {
    case "noauth":
      return { type: "none" };
    case "bearer":
      return { type: "bearer", bearer: { token: p.token ?? "" } };
    case "basic":
      return { type: "basic", basic: { username: p.username ?? "", password: p.password ?? "" } };
    case "digest":
      return { type: "digest", digest: { username: p.username ?? "", password: p.password ?? "" } };
    case "ntlm":
      return {
        type: "ntlm",
        ntlm: {
          username: p.username ?? "",
          password: p.password ?? "",
          domain: p.domain || undefined,
          workstation: p.workstation || undefined,
        },
      };
    case "apikey":
      return {
        type: "apikey",
        apikey: { key: p.key ?? "", value: p.value ?? "", in: p.in === "query" ? "query" : "header" },
      };
    case "oauth2": {
      const grant =
        p.grant_type === "password_credentials"
          ? "password"
          : p.grant_type === "client_credentials"
            ? "client_credentials"
            : p.grant_type === "authorization_code" || p.grant_type === "authorization_code_with_pkce"
              ? "authorization_code"
              : "manual";
      const o: OAuth2Config = {
        grantType: grant,
        ...(grant === "authorization_code"
          ? {
              authUrl: p.authUrl ?? "",
              ...(p.redirect_uri ? { redirectUri: p.redirect_uri } : {}),
              ...(p.grant_type === "authorization_code" ? { usePkce: false } : {}),
              ...(p.challengeAlgorithm === "plain" ? { codeChallengeMethod: "plain" as const } : {}),
            }
          : {}),
        accessTokenUrl: p.accessTokenUrl ?? "",
        clientId: p.clientId ?? "",
        clientSecret: p.clientSecret ?? "",
        scope: p.scope ?? "",
        username: p.username,
        password: p.password,
        clientAuthentication: p.client_authentication === "body" ? "body" : "header",
        accessToken: p.accessToken ?? "",
        headerPrefix: p.headerPrefix ?? "Bearer",
      };
      return { type: "oauth2", oauth2: o };
    }
    case "edgegrid": {
      return {
        type: "edgegrid",
        edgegrid: {
          clientToken: p.clientToken ?? p.client_token ?? "",
          clientSecret: p.clientSecret ?? p.client_secret ?? "",
          accessToken: p.accessToken ?? p.access_token ?? "",
          baseURL: p.baseURL ?? p.base_url ?? p.host ?? undefined,
          headersToSign: p.headersToSign ?? p.headers_to_sign ?? undefined,
          maxBodySize: p.maxBodySize ? Number(p.maxBodySize) : undefined,
          nonce: p.nonce ?? undefined,
          timestamp: p.timestamp ?? undefined,
        },
      };
    }
    case "hawk": {
      return {
        type: "hawk",
        hawk: {
          authId: p.authId ?? "",
          authKey: p.authKey ?? "",
          algorithm: p.algorithm === "sha1" ? "sha1" : "sha256",
          user: p.user || undefined,
          nonce: p.nonce || undefined,
          ext: p.ext || p.extraData || undefined,
          app: p.app || undefined,
          dlg: p.dlg || undefined,
          timestamp: p.timestamp || undefined,
          includePayloadHash: p.includePayloadHash === "true" || (p.includePayloadHash as unknown) === true,
        },
      };
    }
    case "asap": {
      const claims = (p as Record<string, unknown>).claims;
      return {
        type: "asap",
        asap: {
          algorithm: ASAP_ALGORITHMS.find((alg) => alg === p.alg),
          issuer: p.issuer ?? p.iss ?? "",
          subject: p.subject || p.sub || undefined,
          audience: p.audience ?? p.aud ?? "",
          keyId: p.kid ?? p.keyId ?? "",
          privateKey: p.privateKey ?? "",
          expiry: p.exp || p.expiry || undefined,
          additionalClaims:
            claims === undefined || claims === ""
              ? undefined
              : typeof claims === "string"
                ? claims
                : JSON.stringify(claims),
        },
      };
    }
    case "oauth1": {
      const bool = (v: unknown) => v === true || v === "true";
      return {
        type: "oauth1",
        oauth1: {
          consumerKey: p.consumerKey ?? "",
          consumerSecret: p.consumerSecret ?? "",
          token: p.token || undefined,
          tokenSecret: p.tokenSecret || undefined,
          signatureMethod: OAUTH1_SIGNATURE_METHODS.find((m) => m === p.signatureMethod),
          privateKey: p.privateKey || undefined,
          addTo: p.addParamsToHeader !== undefined && !bool(p.addParamsToHeader) ? "query" : undefined,
          timestamp: p.timestamp || undefined,
          nonce: p.nonce || undefined,
          version: p.version ?? undefined,
          realm: p.realm || undefined,
          callback: p.callback || undefined,
          verifier: p.verifier || undefined,
          includeBodyHash: bool(p.includeBodyHash) || undefined,
          addEmptyParamsToSign: bool(p.addEmptyParamsToSign) || undefined,
        },
      };
    }
    case "awsv4":
      return {
        type: "awsv4",
        awsv4: {
          accessKey: p.accessKey ?? "",
          secretKey: p.secretKey ?? "",
          sessionToken: p.sessionToken || undefined,
          region: p.region || undefined,
          service: p.service ?? "",
          addTo:
            p.addAuthDataToQuery === "true" || (p.addAuthDataToQuery as unknown) === true
              ? "query"
              : undefined,
        },
      };
    default:
      return { type: "none" };
  }
}

function urlToString(u: string | PmUrl | undefined): string {
  if (!u) return "";
  if (typeof u === "string") return u;
  if (u.raw) return u.raw;
  const host = Array.isArray(u.host) ? u.host.join(".") : (u.host ?? "");
  const path = Array.isArray(u.path) ? u.path.join("/") : (u.path ?? "");
  const query = (u.query ?? [])
    .filter((q) => !q.disabled)
    .map((q) => `${q.key}${q.value != null ? `=${q.value}` : ""}`);
  return `${u.protocol ? `${u.protocol}://` : ""}${host}${u.port ? `:${u.port}` : ""}${path ? `/${path}` : ""}${query.length ? `?${query.join("&")}` : ""}`;
}

/** Postman `:name` path variables become {{name}} (with the value as a default in the URL when given). */
function convertPathVariables(url: string, vars: PmKV[] | undefined): string {
  const values = new Map((vars ?? []).map((v) => [v.key, str(v.value)]));
  return url.replace(/(^|\/):([A-Za-z_][\w-]*)/g, (m, slash, name) => {
    const v = values.get(name);
    return `${slash}${v ? v : `{{${name}}}`}`;
  });
}

const RAW_LANGS: RawLanguage[] = ["json", "xml", "text", "html", "javascript"];

function importBody(b: PmBody | undefined): BodyConfig {
  if (!b || !b.mode || b.disabled) return { mode: "none" };
  switch (b.mode) {
    case "raw": {
      const lang = b.options?.raw?.language as RawLanguage | undefined;
      return { mode: "raw", raw: b.raw ?? "", language: lang && RAW_LANGS.includes(lang) ? lang : "text" };
    }
    case "urlencoded":
      return { mode: "urlencoded", urlencoded: kv(b.urlencoded) };
    case "formdata":
      return {
        mode: "formdata",
        formdata: (b.formdata ?? []).map((f): FormDataField =>
          f.type === "file"
            ? {
                key: f.key ?? "",
                value: "",
                enabled: !f.disabled,
                type: "file",
                fileName: (Array.isArray(f.src) ? f.src[0] : f.src)?.split(/[\\/]/).pop() ?? "",
                contentType: f.contentType,
              }
            : { key: f.key ?? "", value: str(f.value), enabled: !f.disabled, type: "text" },
        ),
      };
    case "file":
      return {
        mode: "binary",
        binary: b.file?.src
          ? { fileName: b.file.src.split(/[\\/]/).pop() ?? "", data: "", missing: true }
          : null,
      };
    case "graphql":
      return {
        mode: "graphql",
        graphql: {
          query: b.graphql?.query ?? "",
          variables:
            typeof b.graphql?.variables === "string"
              ? b.graphql.variables
              : JSON.stringify(b.graphql?.variables ?? {}, null, 2),
          operationName: b.graphql?.operationName,
        },
      };
    default:
      return { mode: "none" };
  }
}

function importRequest(item: PmItem): RequestNode {
  const r: PmRequest =
    typeof item.request === "string" ? { url: item.request, method: "GET" } : (item.request ?? {});
  const urlObj = typeof r.url === "object" ? r.url : undefined;
  const url = convertPathVariables(urlToString(r.url), urlObj?.variable);
  const disabledQuery = (urlObj?.query ?? []).filter((q) => q.disabled);
  const enabledParams: KeyValue[] = (urlObj?.query ?? [])
    .filter((q) => !q.disabled)
    .map((q) => ({
      key: q.key ?? "",
      value: str(q.value),
      enabled: true,
      description: desc(q.description) || undefined,
    }));
  const headers =
    typeof r.header === "string"
      ? r.header
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf(":");
            return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim(), enabled: true };
          })
      : kv(r.header);
  const examples: ResponseExample[] = (item.response ?? []).map((ex) => ({
    id: id(),
    name: ex.name?.trim() || "Example",
    status: ex.code ?? 200,
    statusText: ex.status ?? "",
    headers: kv(ex.header),
    body: ex.body ?? "",
    createdAt: Date.now(),
    ...(ex.originalRequest
      ? { originalRequest: exampleRequest(importRequest({ request: ex.originalRequest })) }
      : {}),
    ...(ex._postbox?.bodyEncoding ? { bodyEncoding: ex._postbox.bodyEncoding } : {}),
    ...(ex._postbox?.bodyOmitted ? { bodyOmitted: true } : {}),
    ...(ex._postbox?.truncated ? { truncated: true } : {}),
  }));
  return {
    kind: "request",
    id: id(),
    name: item.name || url || "Request",
    method: (r.method ?? "GET").toUpperCase(),
    url,
    params: [...enabledParams, ...kv(disabledQuery).map((q) => ({ ...q, enabled: false }))],
    headers,
    body: importBody(r.body),
    auth: r.auth === undefined ? { type: "inherit" } : importAuth(r.auth),
    preRequestScript: scriptOf(item.event, "prerequest"),
    testScript: scriptOf(item.event, "test"),
    settings: { ...DEFAULT_SETTINGS },
    description: desc(r.description ?? item.description),
    examples,
  };
}

function importItems(items: PmItem[]): TreeNode[] {
  return items.map((it) =>
    Array.isArray(it.item)
      ? ({
          kind: "folder",
          id: id(),
          name: it.name || "Folder",
          description: desc(it.description),
          auth: it.auth === undefined ? { type: "inherit" } : importAuth(it.auth),
          headers: [],
          preRequestScript: scriptOf(it.event, "prerequest"),
          testScript: scriptOf(it.event, "test"),
          children: importItems(it.item),
        } satisfies FolderNode)
      : importRequest(it),
  );
}

export interface ImportedCollection {
  root: FolderNode;
  variables: Variable[];
}

export function isPostmanCollection(data: unknown): data is PostmanCollection {
  const d = data as PostmanCollection;
  return !!d && typeof d === "object" && !!d.info && Array.isArray(d.item);
}

export function importPostmanCollection(data: PostmanCollection): ImportedCollection {
  if (!isPostmanCollection(data)) throw new Error("Not a Postman collection (missing info/item)");
  const root: FolderNode = {
    kind: "folder",
    id: id(),
    name: data.info.name || "Imported Collection",
    description: desc(data.info.description),
    auth: data.auth ? importAuth(data.auth) : { type: "none" },
    headers: [],
    preRequestScript: scriptOf(data.event, "prerequest"),
    testScript: scriptOf(data.event, "test"),
    children: importItems(data.item),
  };
  const variables: Variable[] = (data.variable ?? [])
    .filter((v) => v.key)
    .map((v) => ({
      key: v.key!,
      value: str(v.value),
      enabled: !v.disabled,
      type: v.type === "secret" ? "secret" : "default",
    }));
  return {
    root: sanitizeImportedExamples(root, [
      ...authCredentialValues(root.auth),
      ...variables.filter((variable) => variable.type === "secret").map((variable) => variable.value),
    ]),
    variables,
  };
}

function sanitizeImportedExamples(node: FolderNode, inheritedSecrets: string[]): FolderNode;
function sanitizeImportedExamples(node: RequestNode, inheritedSecrets: string[]): RequestNode;
function sanitizeImportedExamples(node: TreeNode, inheritedSecrets: string[]): TreeNode;
function sanitizeImportedExamples(node: TreeNode, inheritedSecrets: string[]): TreeNode {
  const secrets = [...inheritedSecrets, ...authCredentialValues(node.auth)];
  if (node.kind === "folder")
    return {
      ...node,
      children: node.children.map((child) => sanitizeImportedExamples(child, secrets)),
    };
  return {
    ...node,
    examples: (node.examples ?? []).map((example) => sanitizeExample(example, secrets)),
  };
}

// ------------------------------------------------------------------ environments

export interface PostmanEnvironment {
  id?: string;
  name: string;
  values: { key: string; value: unknown; enabled?: boolean; type?: string }[];
  _postman_variable_scope?: string;
}

export function isPostmanEnvironment(data: unknown): data is PostmanEnvironment {
  const d = data as PostmanEnvironment;
  return !!d && typeof d === "object" && typeof d.name === "string" && Array.isArray(d.values);
}

export function importPostmanEnvironment(data: PostmanEnvironment): {
  name: string;
  variables: Variable[];
  isGlobals: boolean;
} {
  if (!isPostmanEnvironment(data)) throw new Error("Not a Postman environment (missing name/values)");
  return {
    name: data.name,
    isGlobals: data._postman_variable_scope === "globals",
    variables: data.values
      .filter((v) => v.key)
      .map((v) => ({
        key: v.key,
        value: str(v.value),
        enabled: v.enabled !== false,
        type: v.type === "secret" ? "secret" : "default",
      })),
  };
}

export function exportPostmanEnvironment(
  name: string,
  vars: Variable[],
  opts: { includeSecrets?: boolean } = {},
): PostmanEnvironment {
  return {
    id: id(),
    name,
    values: vars.map((v) => ({
      key: v.key,
      value: v.type === "secret" && !opts.includeSecrets ? "" : v.value,
      type: v.type === "secret" ? "secret" : "default",
      enabled: v.enabled,
    })),
    _postman_variable_scope: "environment",
  };
}

// ------------------------------------------------------------------ export

function exportAuth(a: AuthConfig, includeCredentials = false): PmAuth | null | undefined {
  const arr = (o: Record<string, string>) =>
    Object.entries(o).map(([key, value]) => ({ key, value, type: "string" }));
  const credential = (value: string) =>
    includeCredentials || /^\{\{\s*[^{}]+\s*\}\}$/.test(value) ? value : "";
  switch (a.type) {
    case "inherit":
      return undefined;
    case "none":
      return { type: "noauth" };
    case "bearer":
      return { type: "bearer", bearer: arr({ token: credential(a.bearer.token) }) };
    case "basic":
      return {
        type: "basic",
        basic: arr({ username: a.basic.username, password: credential(a.basic.password) }),
      };
    case "digest":
      return {
        type: "digest",
        digest: arr({ username: a.digest.username, password: credential(a.digest.password) }),
      };
    case "ntlm": {
      const raw: Record<string, string> = {
        username: a.ntlm.username,
        password: credential(a.ntlm.password),
      };
      if (a.ntlm.domain) raw.domain = a.ntlm.domain;
      if (a.ntlm.workstation) raw.workstation = a.ntlm.workstation;
      return { type: "ntlm", ntlm: arr(raw) };
    }
    case "apikey":
      return {
        type: "apikey",
        apikey: arr({ key: a.apikey.key, value: credential(a.apikey.value), in: a.apikey.in }),
      };
    case "oauth2": {
      const o = a.oauth2;
      return {
        type: "oauth2",
        oauth2: arr({
          grant_type:
            o.grantType === "password"
              ? "password_credentials"
              : o.grantType === "client_credentials"
                ? "client_credentials"
                : o.grantType === "authorization_code"
                  ? o.usePkce === false
                    ? "authorization_code"
                    : "authorization_code_with_pkce"
                  : "implicit",
          ...(o.grantType === "authorization_code"
            ? {
                authUrl: o.authUrl ?? "",
                ...(o.redirectUri ? { redirect_uri: o.redirectUri } : {}),
                ...(o.usePkce !== false ? { challengeAlgorithm: o.codeChallengeMethod ?? "S256" } : {}),
              }
            : {}),
          accessTokenUrl: o.accessTokenUrl,
          clientId: o.clientId,
          clientSecret: credential(o.clientSecret),
          scope: o.scope,
          client_authentication: o.clientAuthentication,
          headerPrefix: o.headerPrefix,
          ...(o.username ? { username: o.username, password: credential(o.password ?? "") } : {}),
        }),
      };
    }
    case "edgegrid": {
      const e = a.edgegrid;
      const dict: Record<string, string> = {
        accessToken: credential(e.accessToken),
        clientToken: credential(e.clientToken),
        clientSecret: credential(e.clientSecret),
      };
      if (e.baseURL) dict.baseURL = e.baseURL;
      if (e.headersToSign) dict.headersToSign = e.headersToSign;
      if (e.maxBodySize !== undefined) dict.maxBodySize = String(e.maxBodySize);
      if (e.nonce) dict.nonce = e.nonce;
      if (e.timestamp) dict.timestamp = e.timestamp;
      return {
        type: "edgegrid",
        edgegrid: arr(dict),
      };
    }
    case "hawk": {
      const h = a.hawk;
      const raw: Record<string, string> = {
        authId: h.authId,
        authKey: credential(h.authKey),
        algorithm: h.algorithm,
      };
      if (h.user !== undefined) raw.user = h.user;
      if (h.nonce !== undefined) raw.nonce = h.nonce;
      if (h.ext !== undefined) raw.ext = h.ext;
      if (h.app !== undefined) raw.app = h.app;
      if (h.dlg !== undefined) raw.dlg = h.dlg;
      if (h.timestamp !== undefined) raw.timestamp = h.timestamp;
      if (h.includePayloadHash !== undefined) raw.includePayloadHash = String(h.includePayloadHash);
      return {
        type: "hawk",
        hawk: arr(raw),
      };
    }
    case "asap": {
      const s = a.asap;
      const raw: Record<string, string> = {
        alg: s.algorithm ?? "RS256",
        issuer: s.issuer,
        audience: s.audience,
        kid: s.keyId,
        privateKey: credential(s.privateKey),
      };
      if (s.subject) raw.subject = s.subject;
      if (s.expiry) raw.exp = s.expiry;
      if (s.additionalClaims) raw.claims = s.additionalClaims;
      return { type: "asap", asap: arr(raw) };
    }
    case "oauth1": {
      const o = a.oauth1;
      const raw: Record<string, string> = {
        consumerKey: o.consumerKey,
        consumerSecret: credential(o.consumerSecret),
        signatureMethod: o.signatureMethod ?? "HMAC-SHA1",
        addParamsToHeader: String((o.addTo ?? "header") === "header"),
      };
      if (o.token) raw.token = o.token;
      if (o.tokenSecret) raw.tokenSecret = credential(o.tokenSecret);
      if (o.privateKey) raw.privateKey = credential(o.privateKey);
      for (const key of ["timestamp", "nonce", "version", "realm", "callback", "verifier"] as const) {
        const value = o[key];
        if (value !== undefined) raw[key] = value;
      }
      if (o.includeBodyHash) raw.includeBodyHash = "true";
      if (o.addEmptyParamsToSign) raw.addEmptyParamsToSign = "true";
      return { type: "oauth1", oauth1: arr(raw) };
    }
    case "awsv4": {
      const w = a.awsv4;
      const raw: Record<string, string> = {
        accessKey: w.accessKey,
        secretKey: credential(w.secretKey),
        service: w.service,
      };
      if (w.region) raw.region = w.region;
      if (w.sessionToken) raw.sessionToken = credential(w.sessionToken);
      if (w.addTo === "query") raw.addAuthDataToQuery = "true";
      return { type: "awsv4", awsv4: arr(raw) };
    }
  }
}

function exportBody(b: BodyConfig): PmBody | undefined {
  switch (b.mode) {
    case "none":
      return undefined;
    case "raw":
      return { mode: "raw", raw: b.raw, options: { raw: { language: b.language } } };
    case "urlencoded":
      return {
        mode: "urlencoded",
        urlencoded: b.urlencoded.map((x) => ({
          key: x.key,
          value: x.value,
          disabled: !x.enabled,
          type: "text",
        })),
      };
    case "formdata":
      return {
        mode: "formdata",
        formdata: b.formdata.map((f) =>
          f.type === "file"
            ? { key: f.key, type: "file", src: f.fileName ?? "", disabled: !f.enabled }
            : { key: f.key, value: f.value, type: "text", disabled: !f.enabled },
        ),
      };
    case "binary":
      return { mode: "file", file: { src: b.binary?.fileName ?? "" } };
    case "graphql":
      return {
        mode: "graphql",
        graphql: {
          query: b.graphql.query,
          variables: b.graphql.variables,
          ...(b.graphql.operationName ? { operationName: b.graphql.operationName } : {}),
        },
      };
  }
}

function exportUrl(raw: string, params: KeyValue[]): PmUrl {
  const qIdx = raw.indexOf("?");
  const base = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(base);
  const query = params
    .filter((p) => p.key)
    .map((p) => ({ key: p.key, value: p.value, disabled: !p.enabled }));
  if (!m) return { raw, host: [base.split("/")[0]], path: base.split("/").slice(1), query };
  const [hostPart, port] = m[2].split(":");
  return {
    raw,
    protocol: m[1],
    host: hostPart.startsWith("{{") ? [hostPart] : hostPart.split("."),
    ...(port ? { port } : {}),
    path: (m[3] ?? "").split("/").filter(Boolean),
    query,
  };
}

const events = (pre: string, test: string): PmEvent[] | undefined => {
  const out: PmEvent[] = [];
  if (pre.trim()) out.push({ listen: "prerequest", script: { exec: pre.split("\n") } });
  if (test.trim()) out.push({ listen: "test", script: { exec: test.split("\n") } });
  return out.length ? out : undefined;
};

function exportNode(
  n: TreeNode,
  opts: { includeSecrets?: boolean; includeCredentials?: boolean },
  inheritedSecrets: string[],
): PmItem {
  const secrets = credentialRedactionValues(
    opts.includeCredentials ? inheritedSecrets : [...inheritedSecrets, ...authCredentialValues(n.auth)],
  );
  if (n.kind === "folder") {
    return {
      name: n.name,
      description: n.description || undefined,
      item: n.children.map((child) => exportNode(child, opts, secrets)),
      auth: exportAuth(n.auth, opts.includeCredentials),
      event: events(n.preRequestScript, n.testScript),
    };
  }
  const header = n.headers
    .filter((h) => h.key)
    .map((h) => ({
      key: h.key,
      value: h.value,
      disabled: !h.enabled,
      type: "text",
    }));
  const requestData = {
    header,
    body: exportBody(n.body),
    url: exportUrl(n.url, n.params),
  };
  const safeRequestData = redactStoredValue(
    opts.includeCredentials ? requestData : redactSensitiveFields(requestData),
    secrets,
  );
  return {
    name: n.name,
    event: events(n.preRequestScript, n.testScript),
    request: {
      method: n.method,
      ...safeRequestData,
      auth: exportAuth(n.auth, opts.includeCredentials),
      description: n.description || undefined,
    },
    response: (n.examples ?? []).map((e) => {
      const safe = sanitizeExample(e, [...secrets, ...authCredentialValues(n.auth)]);
      return {
        name: safe.name,
        code: safe.status,
        status: safe.statusText,
        header: safe.headers.map((h) => ({
          key: h.key,
          value: h.value,
          ...(!h.enabled ? { disabled: true } : {}),
          ...(h.description ? { description: h.description } : {}),
        })),
        body: safe.body,
        ...(safe.originalRequest
          ? {
              originalRequest: exportNode(
                {
                  ...safe.originalRequest,
                  kind: "request",
                  id: "example",
                  name: "Example request",
                  preRequestScript: "",
                  testScript: "",
                  settings: { ...DEFAULT_SETTINGS },
                  examples: [],
                },
                { includeCredentials: false },
                secrets,
              ).request,
            }
          : {}),
        ...(safe.bodyEncoding || safe.bodyOmitted || safe.truncated
          ? {
              _postbox: {
                bodyEncoding: safe.bodyEncoding,
                bodyOmitted: safe.bodyOmitted,
                truncated: safe.truncated,
              },
            }
          : {}),
      };
    }),
  };
}

/**
 * Export a collection tree as Postman v2.1. Folder-level headers have no Postman
 * equivalent, so they are copied onto each request below them.
 */
export function exportPostmanCollection(
  root: FolderNode,
  variables: Variable[] = [],
  opts: { includeSecrets?: boolean; includeCredentials?: boolean } = {},
): PostmanCollection {
  const pushHeaders = (node: TreeNode, inherited: KeyValue[]): TreeNode => {
    if (node.kind === "request") {
      const names = new Set(node.headers.map((h) => h.key.toLowerCase()));
      return {
        ...node,
        headers: [...inherited.filter((h) => !names.has(h.key.toLowerCase())), ...node.headers],
      };
    }
    const merged = [
      ...inherited.filter((h) => !node.headers.some((x) => x.key.toLowerCase() === h.key.toLowerCase())),
      ...node.headers,
    ];
    return { ...node, children: node.children.map((c) => pushHeaders(c, merged)) };
  };
  const tree = pushHeaders(root, []) as FolderNode;
  return {
    info: {
      _postman_id: id(),
      name: root.name,
      description: root.description || undefined,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: tree.children.map((node) => {
      const secrets = credentialRedactionValues([
        ...(!opts.includeSecrets ? variables.filter((v) => v.type === "secret").map((v) => v.value) : []),
        ...(!opts.includeCredentials ? authCredentialValues(root.auth) : []),
      ]);
      return exportNode(node, opts, secrets);
    }),
    auth: exportAuth(root.auth.type === "inherit" ? { type: "none" } : root.auth, opts.includeCredentials),
    event: events(root.preRequestScript, root.testScript),
    variable: variables.map((v) => ({
      key: v.key,
      value: v.type === "secret" && !opts.includeSecrets ? "" : v.value,
      type: v.type === "secret" ? "secret" : "string",
      disabled: !v.enabled || undefined,
    })),
  };
}
