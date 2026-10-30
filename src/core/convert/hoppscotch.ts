/** Hoppscotch native collection (1–12), REST request (0–17), and environment (0–2) migration. */
import { z } from "zod";
import type { AuthConfig, BodyConfig, FolderNode, KeyValue, RequestNode, Variable } from "../types";
import { DEFAULT_SETTINGS } from "../types";

const object = z.record(z.string(), z.unknown());
type Data = Record<string, unknown>;
const data = (value: unknown): Data => object.parse(value);
const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const list = (value: unknown): unknown[] => (value === undefined ? [] : z.array(z.unknown()).parse(value));
const version = (value: unknown, maximum: number, minimum = 0) => {
  const n = value === undefined ? minimum : Number(value);
  if (!Number.isInteger(n) || n < minimum || n > maximum)
    throw new Error("Unsupported Hoppscotch export version.");
  return n;
};
export type HoppscotchItem =
  | { kind: "collection"; root: FolderNode; variables: Variable[] }
  | { kind: "environment"; name: string; variables: Variable[] };
export function isHoppscotch(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isHoppscotch);
  if (!value || typeof value !== "object") return false;
  const v = value as Data;
  return (
    typeof v.name === "string" &&
    ((Array.isArray(v.folders) && Array.isArray(v.requests)) ||
      (Array.isArray(v.variables) && !v._postman_variable_scope))
  );
}
export function importHoppscotch(
  value: unknown,
  options: { includeCredentials?: boolean } = {},
): { items: HoppscotchItem[]; warnings: string[] } {
  if (!options.includeCredentials)
    throw new Error(
      "Hoppscotch exports may contain credentials. Explicitly enable includeCredentials to import them.",
    );
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (warnings.length < 200) warnings.push(message);
  };
  let count = 0;
  const items = (Array.isArray(value) ? value : [value]).map((raw): HoppscotchItem => {
    const source = data(raw);
    if (!Array.isArray(source.requests)) {
      version(source.v, 2);
      return {
        kind: "environment",
        name: z.string().parse(source.name),
        variables: list(source.variables).map((v) => variable(data(v), (s) => s)),
      };
    }
    version(source.v, 12, 1);
    const variables: Variable[] = [];
    const used = new Set(list(source.variables).map((v) => text(data(v).key)));
    let id = 0;
    const translate = (s: string, names: Map<string, string>) =>
      s.replace(/<<([^<>]+)>>/g, (_match, key: string) => `{{${names.get(key) ?? key}}}`);
    const walk = (raw: unknown, inherited: Map<string, string>, depth: number): FolderNode => {
      if (depth > 50 || ++count > 10000)
        throw new Error("Hoppscotch collection exceeds nesting or item limits.");
      const folder = data(raw);
      version(folder.v, 12, 1);
      const folderId = `hopp-folder-${id++}`;
      const names = new Map(inherited);
      const ownVariables = list(folder.variables).map(data);
      for (const v of ownVariables) {
        const key = z.string().parse(v.key);
        let target = key;
        if (depth > 0) {
          target = `_hoppscotch_${folderId}_${key}`;
          while (used.has(target)) target += "_";
        }
        used.add(target);
        names.set(key, target);
      }
      const tx = (value: unknown) => translate(text(value), names);
      for (const v of ownVariables)
        variables.push({ ...variable(v, (s) => translate(s, names)), key: names.get(text(v.key))! });
      if (folder.preRequestScript || folder.testScript)
        warn(`${text(folder.name)}: scripts were not executed or translated; rewrite them for Postbox.`);
      const result: FolderNode = {
        kind: "folder",
        id: folderId,
        name: z.string().parse(folder.name),
        description: text(folder.description),
        auth: auth(folder.auth, tx, warn),
        headers: pairs(folder.headers, tx),
        preRequestScript: "",
        testScript: "",
        children: [],
      };
      result.children.push(...list(folder.folders).map((f) => walk(f, names, depth + 1)));
      for (const rawRequest of list(folder.requests)) {
        if (++count > 10000) throw new Error("Hoppscotch collection exceeds item limits.");
        const r = data(rawRequest);
        version(r.v, 17);
        const name = z.string().parse(r.name);
        if (r.preRequestScript || r.testScript)
          warn(`${name}: scripts were not translated; rewrite them for Postbox.`);
        if (r.requestVariables && list(r.requestVariables).length)
          throw new Error(
            "Request-scoped Hoppscotch variables are not supported; move them to a collection or environment before importing.",
          );
        if (r.settings && Object.keys(data(r.settings)).length)
          warn(`${name}: source request settings were not migrated.`);
        if (r.responses && Object.keys(data(r.responses)).length)
          warn(`${name}: saved source responses were not migrated.`);
        const graphql = typeof r.query === "string" && typeof r.url === "string" && !r.endpoint;
        let url = tx(r.endpoint ?? text(r.url) + text(r.path));
        if (!url) throw new Error("Hoppscotch request is missing its endpoint.");
        const params = pairs(r.params, tx);
        const active = params.filter((p) => p.enabled);
        if (active.length) {
          const hash = url.indexOf("#");
          if (hash >= 0) url = url.slice(0, hash);
          const encode = (s: string) =>
            s
              .split(/(\{\{[^{}]+\}\})/)
              .map((part) => (part.startsWith("{{") ? part : encodeURIComponent(part)))
              .join("");
          url +=
            (url.includes("?") ? "&" : "?") +
            active.map((p) => `${encode(p.key)}=${encode(p.value)}`).join("&");
        }
        const headers = pairs(r.headers, tx);
        const body = graphql
          ? {
              mode: "graphql" as const,
              graphql: { query: tx(r.query), variables: tx(r.variables), operationName: "" },
            }
          : requestBody(r, tx, warn);
        const bodyType =
          typeof r.body === "object" && r.body ? text(data(r.body).contentType) : text(r.contentType);
        if (body.mode === "raw" && bodyType && !headers.some((h) => h.key.toLowerCase() === "content-type"))
          headers.push({ key: "Content-Type", value: bodyType, enabled: true });
        const request: RequestNode = {
          kind: "request",
          id: `hopp-request-${id++}`,
          name,
          method: graphql
            ? "POST"
            : z
                .string()
                .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
                .parse(r.method),
          url,
          params,
          headers,
          auth: auth(r.auth, tx, warn, r),
          body,
          settings: { ...DEFAULT_SETTINGS, useCookieJar: false },
          description: text(r.description),
          preRequestScript: "",
          testScript: "",
          examples: [],
        };
        result.children.push(request);
      }
      return result;
    };
    const root = walk(source, new Map(), 0);
    return { kind: "collection", root, variables };
  });
  if (!items.length) throw new Error("Hoppscotch export is empty.");
  return { items, warnings };
}

function variable(v: Data, tx: (value: string) => string): Variable {
  return {
    key: z.string().parse(v.key),
    value: tx(text(v.currentValue) || text(v.initialValue) || text(v.value)),
    type: v.secret === true ? "secret" : "default",
    enabled: v.active !== false && v.enabled !== false,
  };
}
function pairs(value: unknown, tx: (value: unknown) => string): KeyValue[] {
  return list(value).map((raw) => {
    const p = data(raw);
    return {
      key: tx(z.string().parse(p.key)),
      value: tx(p.value),
      enabled: p.active !== false && p.enabled !== false,
      description: text(p.description),
    };
  });
}
function auth(
  value: unknown,
  tx: (v: unknown) => string,
  warn: (message: string) => void,
  legacy?: Data,
): AuthConfig {
  if (value === undefined) return { type: "inherit" };
  if (typeof value === "string") {
    if (value === "Basic Auth")
      return { type: "basic", basic: { username: tx(legacy?.httpUser), password: tx(legacy?.httpPassword) } };
    if (value === "Bearer Token") return { type: "bearer", bearer: { token: tx(legacy?.bearerToken) } };
    if (value === "None") return { type: "none" };
    warn("Unsupported legacy authentication was disabled.");
    return { type: "none" };
  }
  const a = data(value);
  if (a.authActive === false || a.authType === "none") return { type: "none" };
  if (a.authType === "inherit") return { type: "inherit" };
  if (a.authType === "basic" || a.authType === "digest")
    return a.authType === "basic"
      ? { type: "basic", basic: { username: tx(a.username), password: tx(a.password) } }
      : { type: "digest", digest: { username: tx(a.username), password: tx(a.password) } };
  if (a.authType === "bearer") return { type: "bearer", bearer: { token: tx(a.token) } };
  if (a.authType === "api-key")
    return {
      type: "apikey",
      apikey: { key: tx(a.key), value: tx(a.value), in: /query/i.test(text(a.addTo)) ? "query" : "header" },
    };
  if (a.authType === "oauth-2" && a.token) {
    warn("OAuth token imported as bearer; configure refresh/authorization separately.");
    return { type: "bearer", bearer: { token: tx(a.token) } };
  }
  warn("Unsupported authentication was disabled; configure it before execution.");
  return { type: "none" };
}
function requestBody(r: Data, tx: (v: unknown) => string, warn: (message: string) => void): BodyConfig {
  const b =
    r.body && typeof r.body === "object"
      ? data(r.body)
      : { contentType: r.contentType, body: r.rawParams ?? r.body };
  const type = text(b.contentType);
  if (!type) return { mode: "none" };
  if (type === "multipart/form-data")
    return {
      mode: "formdata",
      formdata: list(b.body).map((raw) => {
        const p = data(raw);
        if (p.isFile)
          throw new Error(
            "Hoppscotch file uploads do not retain file bytes; remove or replace the file field before import.",
          );
        return { type: "text", key: tx(p.key), value: tx(p.value), enabled: p.active !== false };
      }),
    };
  if (type === "application/octet-stream" || type === "binary") {
    warn("Binary upload was unavailable; select the file before sending.");
    return { mode: "binary", binary: null };
  }
  return {
    mode: "raw",
    raw: tx(b.body),
    language: /json/i.test(type) ? "json" : /xml/i.test(type) ? "xml" : /html/i.test(type) ? "html" : "text",
  };
}
