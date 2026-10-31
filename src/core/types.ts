/**
 * Core domain model shared by the UI, API routes, runner and CLI.
 * This module must stay free of Node/Next/DB imports so it can be used anywhere.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | (string & {});

export const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** A row in a params / headers / urlencoded table. */
export interface KeyValue {
  id?: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

/** A row in a multipart form-data table. Files carry their content inline as base64. */
export interface FormDataField extends KeyValue {
  type: "text" | "file";
  fileName?: string;
  contentType?: string;
  /** base64 encoded file content (type === "file") */
  data?: string;
  /** Browser-restored draft lost its intentionally unpersisted upload bytes. */
  missing?: boolean;
}

export type RawLanguage = "json" | "xml" | "text" | "html" | "javascript";

export type BodyConfig =
  | { mode: "none" }
  | { mode: "raw"; raw: string; language: RawLanguage }
  | { mode: "urlencoded"; urlencoded: KeyValue[] }
  | { mode: "formdata"; formdata: FormDataField[] }
  | {
      mode: "binary";
      binary: { fileName: string; contentType?: string; data: string; missing?: boolean } | null;
    }
  | { mode: "graphql"; graphql: { query: string; variables: string; operationName?: string } };

export type BodyMode = BodyConfig["mode"];

export interface OAuth2Config {
  grantType: "client_credentials" | "password" | "authorization_code" | "manual";
  /** Authorization endpoint (authorization_code). */
  authUrl?: string;
  /** Redirect URI registered with the provider; defaults to this server's /api/oauth2/callback. */
  redirectUri?: string;
  /** Use PKCE (RFC 7636) with the authorization code; on by default. */
  usePkce?: boolean;
  codeChallengeMethod?: "S256" | "plain";
  accessTokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  username?: string;
  password?: string;
  /** Where client credentials are sent: Authorization header or request body. */
  clientAuthentication: "header" | "body";
  /** Token obtained previously (or entered manually). */
  accessToken: string;
  /** Refresh token from the last authorization-code sign-in; used when the access token expires. */
  refreshToken?: string;
  tokenType?: string;
  /** epoch ms when the cached token expires */
  expiresAt?: number;
  /** Binds an automatically fetched token to its resolved credentials and workspace. */
  tokenContext?: string;
  headerPrefix: string;
}

export interface EdgeGridConfig {
  clientToken: string;
  clientSecret: string;
  accessToken: string;
  baseURL?: string;
  headersToSign?: string;
  maxBodySize?: number;
  nonce?: string;
  timestamp?: string;
}
export const OAUTH1_SIGNATURE_METHODS = [
  "HMAC-SHA1",
  "HMAC-SHA256",
  "HMAC-SHA512",
  "RSA-SHA1",
  "RSA-SHA256",
  "RSA-SHA512",
  "PLAINTEXT",
] as const;
export type OAuth1SignatureMethod = (typeof OAUTH1_SIGNATURE_METHODS)[number];

export interface OAuth1Config {
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  /** Defaults to HMAC-SHA1. */
  signatureMethod?: OAuth1SignatureMethod;
  /** PEM private key for RSA-* methods. */
  privateKey?: string;
  /** Where oauth_* parameters go; "body" needs a form-encoded body. Defaults to header. */
  addTo?: "header" | "query" | "body";
  /** Fixed oauth_timestamp / oauth_nonce for reproducible signatures; generated when empty. */
  timestamp?: string;
  nonce?: string;
  /** oauth_version; defaults to "1.0", empty omits it. */
  version?: string;
  realm?: string;
  /** Temporary-credential and token-exchange steps of the three-legged flow. */
  callback?: string;
  verifier?: string;
  includeBodyHash?: boolean;
  addEmptyParamsToSign?: boolean;
}

export const ASAP_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
] as const;
export type AsapAlgorithm = (typeof ASAP_ALGORITHMS)[number];

export interface AsapConfig {
  /** Defaults to RS256. */
  algorithm?: AsapAlgorithm;
  issuer: string;
  subject?: string;
  /** One audience, or several separated by commas. */
  audience: string;
  /** Key ID (kid): the key's path in the issuer's public key repository. */
  keyId: string;
  /** PEM private key; usually a {{secret}} variable reference. */
  privateKey: string;
  /** Lifetime as seconds or a duration (30m, 1h); at most one hour. */
  expiry?: string;
  /** Extra claims as a JSON object. */
  additionalClaims?: string;
}

export interface NtlmConfig {
  /** A plain user name, or DOMAIN\user when no domain is given. */
  username: string;
  password: string;
  domain?: string;
  workstation?: string;
}

export interface AwsSigV4Config {
  accessKey: string;
  secretKey: string;
  /** Temporary (STS) credentials; sent as X-Amz-Security-Token and signed. */
  sessionToken?: string;
  /** Defaults to us-east-1. */
  region?: string;
  /** Signing name, for example execute-api, s3 or lambda. */
  service: string;
  /** Where the signature goes: Authorization header (default) or presigned query parameters. */
  addTo?: "header" | "query";
  /** Presigned URL lifetime in seconds (query mode, max 7 days). */
  expiresSeconds?: number;
  /** Fixed X-Amz-Date (yyyyMMddTHHmmssZ) for reproducible signatures; defaults to now. */
  timestamp?: string;
}

export type HawkAlgorithm = "sha256" | "sha1";

export interface HawkConfig {
  authId: string;
  authKey: string;
  algorithm: HawkAlgorithm;
  user?: string;
  nonce?: string;
  ext?: string;
  app?: string;
  dlg?: string;
  timestamp?: string;
  includePayloadHash?: boolean;
}

export type AuthConfig =
  | { type: "inherit" }
  | { type: "none" }
  | { type: "bearer"; bearer: { token: string; prefix?: string } }
  | { type: "basic"; basic: { username: string; password: string } }
  | { type: "apikey"; apikey: { key: string; value: string; in: "header" | "query" } }
  | { type: "digest"; digest: { username: string; password: string } }
  | { type: "oauth2"; oauth2: OAuth2Config }
  | { type: "edgegrid"; edgegrid: EdgeGridConfig }
  | { type: "hawk"; hawk: HawkConfig }
  | { type: "awsv4"; awsv4: AwsSigV4Config }
  | { type: "oauth1"; oauth1: OAuth1Config }
  | { type: "asap"; asap: AsapConfig }
  | { type: "ntlm"; ntlm: NtlmConfig };

export type AuthType = AuthConfig["type"];

export interface RequestSettings {
  followRedirects: boolean;
  maxRedirects: number;
  timeoutMs: number;
  verifySsl: boolean;
  /** Send and store cookies with the workspace cookie jar. */
  useCookieJar: boolean;
  /**
   * Unix domain socket path or Windows named pipe (\\.\pipe\name) to connect to instead of
   * TCP. The URL still supplies the path, query and Host header. Must be in PROXY_ALLOW_SOCKETS.
   */
  socketPath?: string;
}

export const DEFAULT_SETTINGS: RequestSettings = {
  followRedirects: true,
  maxRedirects: 10,
  timeoutMs: 30000,
  verifySsl: true,
  useCookieJar: true,
};

export interface ResponseExample {
  id: string;
  name: string;
  status: number;
  statusText: string;
  headers: KeyValue[];
  body: string;
  createdAt: number;
}

/** A request definition as stored/edited (templates, not yet resolved). */
export interface RequestDef {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: BodyConfig;
  auth: AuthConfig;
  preRequestScript: string;
  testScript: string;
  settings: RequestSettings;
  description?: string;
  examples?: ResponseExample[];
}

/** A folder or collection (collection = folder without parent). */
export interface FolderDef {
  id: string;
  name: string;
  description?: string;
  auth: AuthConfig;
  headers: KeyValue[];
  preRequestScript: string;
  testScript: string;
}

/** In-memory collection tree used by the runner and CLI. */
export interface FolderNode extends FolderDef {
  kind: "folder";
  children: TreeNode[];
}
export interface RequestNode extends RequestDef {
  kind: "request";
}
export type TreeNode = FolderNode | RequestNode;

export type VariableType = "default" | "secret";

export interface Variable {
  id?: string;
  key: string;
  value: string;
  type: VariableType;
  enabled: boolean;
}

export interface Environment {
  id: string;
  name: string;
  variables: Variable[];
}

/** Resolved request ready to be sent over the wire. */
export interface PreparedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: Buffer;
  settings: RequestSettings;
  /** Digest credentials need the challenge from the server, so they are applied by the engine. */
  digest?: { username: string; password: string };
  /** NTLM authenticates a connection, so the engine runs its handshake. */
  ntlm?: NtlmConfig;
  /** AWS signatures cover the URL, so the engine re-signs after same-origin redirects. */
  awsv4?: AwsSigV4Config;
}

export interface Timings {
  /** DNS lookup duration */
  dns: number;
  /** TCP connect duration */
  tcp: number;
  /** TLS handshake duration */
  tls: number;
  /** Time from request sent to first response byte */
  ttfb: number;
  /** Time spent downloading the body */
  download: number;
  /** Total time including redirects */
  total: number;
}

export interface CookieInfo {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string | null;
  hostOnly?: boolean;
}

export interface RedirectHop {
  url: string;
  status: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: [string, string][];
  /** base64 body (raw bytes after decompression) */
  bodyBase64: string;
  /** body decoded as utf-8 (empty for binary payloads) */
  bodyText: string;
  isBinary: boolean;
  contentType: string;
  /** decoded body size in bytes */
  size: number;
  /** True when the response exceeded the configured capture limit. */
  truncated: boolean;
  /** headers size in bytes (approximate) */
  headersSize: number;
  timings: Timings;
  url: string;
  redirects: RedirectHop[];
  cookies: CookieInfo[];
  remoteAddress?: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  skipped?: boolean;
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  source: string;
  timestamp: number;
}

export interface RunOptions {
  iterations: number;
  delayMs: number;
  stopOnFailure: boolean;
  timeoutMs?: number;
  verifySsl?: boolean;
  /** Persist variable changes from scripts after the run (default true). */
  persistVariables?: boolean;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  iterations: 1,
  delayMs: 0,
  stopOnFailure: false,
  persistVariables: true,
};

/** Iteration data parsed from CSV / JSON / XLSX. */
export interface DataTable {
  columns: string[];
  rows: Record<string, string>[];
}
