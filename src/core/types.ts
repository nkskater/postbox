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
}

export type RawLanguage = "json" | "xml" | "text" | "html" | "javascript";

export type BodyConfig =
  | { mode: "none" }
  | { mode: "raw"; raw: string; language: RawLanguage }
  | { mode: "urlencoded"; urlencoded: KeyValue[] }
  | { mode: "formdata"; formdata: FormDataField[] }
  | { mode: "binary"; binary: { fileName: string; contentType?: string; data: string } | null }
  | { mode: "graphql"; graphql: { query: string; variables: string; operationName?: string } };

export type BodyMode = BodyConfig["mode"];

export interface OAuth2Config {
  grantType: "client_credentials" | "password" | "manual";
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
  tokenType?: string;
  /** epoch ms when the cached token expires */
  expiresAt?: number;
  headerPrefix: string;
}

export type AuthConfig =
  | { type: "inherit" }
  | { type: "none" }
  | { type: "bearer"; bearer: { token: string; prefix?: string } }
  | { type: "basic"; basic: { username: string; password: string } }
  | { type: "apikey"; apikey: { key: string; value: string; in: "header" | "query" } }
  | { type: "digest"; digest: { username: string; password: string } }
  | { type: "oauth2"; oauth2: OAuth2Config };

export type AuthType = AuthConfig["type"];

export interface RequestSettings {
  followRedirects: boolean;
  maxRedirects: number;
  timeoutMs: number;
  verifySsl: boolean;
  /** Send and store cookies with the workspace cookie jar. */
  useCookieJar: boolean;
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
