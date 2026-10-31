/**
 * OpenAPI 3.x / Swagger 2.0 (JSON or YAML) → collection tree.
 *
 * - Operations are grouped into folders by their first tag.
 * - Path parameters (`{id}`) become `{{id}}` variables.
 * - Server precedence follows the OpenAPI specification:
 *     `operation.servers` > `pathItem.servers` > `spec.servers`
 *   (and in Swagger 2.0, `operation.schemes` overrides root `spec.schemes`).
 * - When a `servers` list contains multiple entries, the first entry with a
 *   non-empty `url` is chosen deterministically.
 * - Server template variables (`{var}`) are populated from `server.variables[var].default`
 *   (falling back to the first `enum` value); any unresolved `{var}` placeholder is
 *   converted into a `{{var}}` collection variable without overwriting existing variables.
 * - Relative server URLs are resolved against `opts.sourceUrl` (or against the
 *   root server's origin when `sourceUrl` is omitted, falling back to `http://localhost`).
 * - The root server is stored in the `baseUrl` collection variable (`{{baseUrl}}`);
 *   distinct path/operation server overrides receive dedicated collection variables
 *   (`baseUrl_2`, `baseUrl_3`, …) so every request resolves to its intended host
 *   while remaining editable.
 */
import { parseSpec, isOpenApi } from "./openapi-document";
export { parseSpec, isOpenApi } from "./openapi-document";
import { localReferenceValue, documentSourceUrl, OPENAPI_LIMITS } from "./openapi-references";
import type { AuthConfig, BodyConfig, FolderNode, KeyValue, RequestNode, Variable } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import type { ImportedCollection } from "./postman";

type Obj = Record<string, unknown>;
const id = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Missing, external and reference-only cycles are explicit conversion errors. */
function deref(spec: Obj, value: unknown): Obj {
  const resolved = localReferenceValue(spec, value);
  if (resolved === undefined || resolved === null || resolved === true) return {};
  if (resolved === false) throw new Error("A false schema has no permitted sample values");
  if (typeof resolved !== "object" || Array.isArray(resolved))
    throw new Error("OpenAPI reference target must be an object");
  return resolved as Obj;
}

/** Build an example value from a schema (example > default > enum > generated). */
export function sampleFromSchema(spec: Obj, schemaIn: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 10_000) throw new Error("OpenAPI sample expansion exceeds 10,000 nodes");
  const resolved = localReferenceValue(spec, schemaIn);
  if (resolved === true) return null;
  if (resolved === false) throw new Error("A false schema has no permitted sample values");
  const schema = deref(spec, resolved);
  if (depth > 6) return null;
  if ("example" in schema) return schema.example;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.allOf)) {
    const samples = schema.allOf.map((s) => sampleFromSchema(spec, s, depth + 1, budget));
    const objects = samples.filter(
      (sample): sample is Obj => !!sample && typeof sample === "object" && !Array.isArray(sample),
    );
    if (objects.length) return Object.assign(Object.create(null), ...objects);
    return samples.find((sample) => sample !== "" && sample !== undefined) ?? samples[0] ?? null;
  }
  for (const k of ["oneOf", "anyOf"])
    if (Array.isArray(schema[k]) && (schema[k] as unknown[]).length)
      return sampleFromSchema(spec, (schema[k] as unknown[])[0], depth + 1, budget);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object":
    case undefined: {
      if (!schema.properties && type === undefined)
        return schema.items ? [sampleFromSchema(spec, schema.items, depth + 1, budget)] : "";
      const out: Obj = Object.create(null);
      for (const [k, v] of Object.entries((schema.properties as Obj) ?? {}))
        out[k] = sampleFromSchema(spec, v, depth + 1, budget);
      return out;
    }
    case "array":
      return [sampleFromSchema(spec, schema.items, depth + 1, budget)];
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return true;
    case "string":
      if (schema.format === "date-time") return new Date(0).toISOString();
      if (schema.format === "date") return "1970-01-01";
      if (schema.format === "uuid") return "00000000-0000-0000-0000-000000000000";
      if (schema.format === "email") return "user@example.com";
      return "string";
    default:
      return null;
  }
}

/**
 * Pick the first valid server object from a `servers` array.
 * Returns `null` when the list is absent, empty, or contains no usable `url`.
 */
function pickFirstServer(spec: Obj, serversIn: unknown): Obj | null {
  if (!Array.isArray(serversIn) || serversIn.length === 0) return null;
  for (const raw of serversIn) {
    const s = deref(spec, raw);
    if (s && typeof s === "object" && typeof s.url === "string" && s.url.trim() !== "") {
      return s;
    }
  }
  return null;
}

interface ResolvedServer {
  url: string;
  extraVariables: Variable[];
}

/**
 * Resolve a single OpenAPI 3.x Server object into a normalized base URL
 * (without trailing slash), substituting `server.variables` defaults and
 * resolving relative URLs against `baseDocUrl`.
 */
function resolveOpenApiServer(server: Obj | null, baseDocUrl?: string): ResolvedServer {
  baseDocUrl = documentSourceUrl(server, baseDocUrl);
  if (!server) {
    const fallback = resolveRelativeServerUrl("/", baseDocUrl);
    return { url: fallback, extraVariables: [] };
  }
  let rawUrl = String(server.url ?? "").trim() || "/";
  const serverVars = ((server.variables as Record<string, Obj>) ?? {}) as Record<string, Obj>;
  const extraVariables: Variable[] = [];

  // Substitute `{var}` placeholders in `server.url` while leaving `{{var}}` intact.
  const placeholders: { token: string; expr: string }[] = [];
  let tokenIdx = 0;
  const protect = (expr: string) => {
    const token = `__ postbox_tpl_${tokenIdx++}__`.replace(/\s+/g, "");
    placeholders.push({ token, expr });
    return token;
  };

  // Preserve any pre-existing `{{var}}` expressions.
  rawUrl = rawUrl.replace(/\{\{([^{}]+)\}\}/g, (match) => protect(match));

  // Resolve `{var}` template variables from `server.variables`.
  rawUrl = rawUrl.replace(/\{([^{}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    const defObj = serverVars[name];
    if (defObj && typeof defObj === "object") {
      if (defObj.default !== undefined && defObj.default !== null && String(defObj.default) !== "") {
        return String(defObj.default);
      }
      if (Array.isArray(defObj.enum) && defObj.enum.length > 0 && defObj.enum[0] !== undefined) {
        return String(defObj.enum[0]);
      }
      if (defObj.default === "") {
        return "";
      }
    }
    // Unresolved server template variable: preserve as an editable `{{name}}` variable.
    extraVariables.push({ key: name, value: "", type: "default", enabled: true });
    return protect(`{{${name}}}`);
  });

  let resolved = resolveRelativeServerUrl(rawUrl, baseDocUrl);
  for (const { token, expr } of placeholders) {
    resolved = resolved.replaceAll(token, expr);
  }
  return { url: resolved.replace(/\/+$/, ""), extraVariables };
}

function resolveRelativeServerUrl(url: string, baseDocUrl?: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url.replace(/\/+$/, "");
  }
  const base = baseDocUrl ?? "http://localhost";
  try {
    return new URL(url || "/", base).toString().replace(/\/+$/, "");
  } catch {
    return `http://localhost${url.startsWith("/") ? "" : "/"}${url}`.replace(/\/+$/, "");
  }
}

function resolveSwaggerBaseUrl(spec: Obj, op: Obj | undefined, sourceUrl?: string): string {
  let parsedSource: URL | null = null;
  if (sourceUrl) {
    try {
      parsedSource = new URL(sourceUrl);
    } catch {
      parsedSource = null;
    }
  }
  const opSchemes = Array.isArray(op?.schemes) ? (op.schemes as string[]).filter(Boolean) : [];
  const rootSchemes = Array.isArray(spec.schemes) ? (spec.schemes as string[]).filter(Boolean) : [];
  const scheme =
    opSchemes[0] ??
    rootSchemes[0] ??
    (parsedSource ? parsedSource.protocol.replace(/:$/, "") : undefined) ??
    "https";
  const host =
    typeof spec.host === "string" && spec.host.trim() !== ""
      ? spec.host.trim()
      : (parsedSource?.host ?? "localhost");
  const basePath = typeof spec.basePath === "string" ? spec.basePath : "";
  return `${scheme}://${host}${basePath}`.replace(/\/+$/, "");
}

function effectiveServerForOperation(
  spec: Obj,
  item: Obj,
  op: Obj,
  sourceUrl: string | undefined,
  rootBaseUrl: string,
): ResolvedServer {
  if (spec.swagger) {
    return {
      url: resolveSwaggerBaseUrl(spec, op, sourceUrl),
      extraVariables: [],
    };
  }
  const opServer = pickFirstServer(spec, op.servers);
  const pathServer = pickFirstServer(spec, item.servers);
  const chosen = opServer ?? pathServer;
  if (!chosen) {
    return { url: rootBaseUrl, extraVariables: [] };
  }

  // Relative server overrides resolve against `sourceUrl` when provided;
  // otherwise against the root server's URL if absolute, or `http://localhost`.
  const fallbackBase =
    sourceUrl ?? (/^[a-z][a-z0-9+.-]*:\/\//i.test(rootBaseUrl) ? `${rootBaseUrl}/` : "http://localhost");
  return resolveOpenApiServer(chosen, fallbackBase);
}

function securityToAuth(spec: Obj, requirement: unknown): AuthConfig | null {
  const reqs = requirement as Obj[] | undefined;
  const name = reqs?.[0] ? Object.keys(reqs[0])[0] : undefined;
  if (!name) return null;
  const schemes = ((spec.components as Obj)?.securitySchemes ?? spec.securityDefinitions ?? {}) as Record<
    string,
    Obj
  >;
  const s = deref(spec, schemes[name]);
  if (!s.type) return null;
  if (s.type === "http" && String(s.scheme).toLowerCase() === "bearer")
    return { type: "bearer", bearer: { token: "{{token}}" } };
  if ((s.type === "http" && String(s.scheme).toLowerCase() === "basic") || s.type === "basic")
    return { type: "basic", basic: { username: "{{username}}", password: "{{password}}" } };
  if (s.type === "http" && String(s.scheme).toLowerCase() === "digest")
    return { type: "digest", digest: { username: "{{username}}", password: "{{password}}" } };
  if (s.type === "apiKey")
    return {
      type: "apikey",
      apikey: {
        key: String(s.name ?? "X-API-Key"),
        value: "{{apiKey}}",
        in: s.in === "query" ? "query" : "header",
      },
    };
  if (s.type === "oauth2") {
    const flows = (s.flows ?? {}) as Record<string, Obj>;
    const flow = flows.clientCredentials ?? flows.password ?? (s.flow ? s : undefined);
    return {
      type: "oauth2",
      oauth2: {
        grantType: flows.password && !flows.clientCredentials ? "password" : "client_credentials",
        accessTokenUrl: String(flow?.tokenUrl ?? ""),
        clientId: "{{clientId}}",
        clientSecret: "{{clientSecret}}",
        scope: Object.keys((flow?.scopes as Obj) ?? {}).join(" "),
        clientAuthentication: "header",
        accessToken: "",
        headerPrefix: "Bearer",
      },
    };
  }
  return null;
}

function serializeSample(
  value: unknown,
  maxBytes: number = OPENAPI_LIMITS.maxDocumentBytes,
  label = "generated body",
): string {
  let bytes = 0,
    nodes = 0;
  const json = JSON.stringify(
    value,
    (key, child: unknown) => {
      bytes +=
        Buffer.byteLength(key, "utf8") + (typeof child === "string" ? Buffer.byteLength(child, "utf8") : 16);
      if (++nodes > 200_000 || bytes > maxBytes) throw new Error(`OpenAPI sample exceeds the ${label} limit`);
      return child;
    },
    2,
  );
  if (Buffer.byteLength(json, "utf8") > maxBytes)
    throw new Error(`OpenAPI sample exceeds the ${label} limit`);
  return json;
}

function buildBody(spec: Obj, op: Obj, params: Obj[]): { body: BodyConfig; contentType?: string } {
  // Swagger 2: body / formData parameters
  const bodyParam = params.find((p) => p.in === "body");
  if (bodyParam)
    return {
      body: {
        mode: "raw",
        language: "json",
        raw: serializeSample(sampleFromSchema(spec, bodyParam.schema)),
      },
      contentType: "application/json",
    };
  const formParams = params.filter((p) => p.in === "formData");
  if (formParams.length) {
    const consumes = (op.consumes as string[] | undefined) ?? (spec.consumes as string[] | undefined) ?? [];
    if (consumes.includes("multipart/form-data") || formParams.some((p) => p.type === "file"))
      return {
        body: {
          mode: "formdata",
          formdata: formParams.map((p) => ({
            key: String(p.name),
            value: "",
            enabled: true,
            type: p.type === "file" ? "file" : "text",
          })),
        },
      };
    return {
      body: {
        mode: "urlencoded",
        urlencoded: formParams.map((p) => ({ key: String(p.name), value: "", enabled: true })),
      },
    };
  }
  const rb = deref(spec, op.requestBody);
  const content = (rb.content ?? {}) as Record<string, Obj>;
  const types = Object.keys(content);
  if (!types.length) return { body: { mode: "none" } };
  const json = types.find((t) => t.includes("json"));
  const pick = json ?? types[0];
  const media = content[pick];
  const examples = media.examples as Record<string, Obj> | undefined;
  const firstExample = examples ? deref(spec, Object.values(examples)[0]) : undefined;
  const example = Object.hasOwn(media, "example")
    ? media.example
    : firstExample && Object.hasOwn(firstExample, "value")
      ? firstExample.value
      : sampleFromSchema(spec, media.schema);
  if (pick.includes("x-www-form-urlencoded") || pick.includes("multipart/form-data")) {
    const props = (deref(spec, media.schema).properties ?? {}) as Record<string, Obj>;
    const fields = Object.entries(props).map(([k, v]) => ({
      key: k,
      value: "",
      enabled: true,
      isFile: deref(spec, v).format === "binary",
    }));
    if (pick.includes("multipart"))
      return {
        body: {
          mode: "formdata",
          formdata: fields.map((f) => ({
            key: f.key,
            value: "",
            enabled: true,
            type: f.isFile ? "file" : "text",
          })),
        },
      };
    return {
      body: {
        mode: "urlencoded",
        urlencoded: fields.map(({ key, value, enabled }) => ({ key, value, enabled })),
      },
    };
  }
  if (pick.includes("xml"))
    return {
      body: { mode: "raw", language: "xml", raw: typeof example === "string" ? example : "" },
      contentType: pick,
    };
  if (pick.includes("json"))
    return {
      body: {
        mode: "raw",
        language: "json",
        raw: serializeSample(example),
      },
      contentType: pick,
    };
  if (pick.includes("octet-stream")) return { body: { mode: "binary", binary: null } };
  return {
    body: { mode: "raw", language: "text", raw: typeof example === "string" ? example : "" },
    contentType: pick,
  };
}

export function importOpenApi(input: string | Obj, opts: { sourceUrl?: string } = {}): ImportedCollection {
  const spec = typeof input === "string" ? parseSpec(input) : input;
  if (!isOpenApi(spec)) throw new Error("Not an OpenAPI/Swagger document");
  const info = (spec.info ?? {}) as Obj;
  const rootAuth = securityToAuth(spec, spec.security);
  const root: FolderNode = {
    kind: "folder",
    id: id(),
    name: String(info.title ?? "Imported API"),
    description: String(info.description ?? ""),
    auth: rootAuth ?? { type: "none" },
    headers: [],
    preRequestScript: "",
    testScript: "",
    children: [],
  };
  const folders = new Map<string, FolderNode>();
  const folderFor = (tag: string | undefined): FolderNode => {
    if (!tag) return root;
    let f = folders.get(tag);
    if (!f) {
      f = {
        kind: "folder",
        id: id(),
        name: tag,
        description: "",
        auth: { type: "inherit" },
        headers: [],
        preRequestScript: "",
        testScript: "",
        children: [],
      };
      folders.set(tag, f);
      root.children.push(f);
    }
    return f;
  };

  // Resolve the root-level server first so `baseUrl` is always the primary collection variable.
  const rootResolved: ResolvedServer = spec.swagger
    ? { url: resolveSwaggerBaseUrl(spec, undefined, opts.sourceUrl), extraVariables: [] }
    : resolveOpenApiServer(pickFirstServer(spec, spec.servers), opts.sourceUrl);

  const variables: Variable[] = [{ key: "baseUrl", value: rootResolved.url, type: "default", enabled: true }];
  const usedVarKeys = new Set<string>(["baseUrl"]);

  // Reserve path parameter names so generated server variable keys never collide with them.
  const reservedKeys = new Set<string>([
    "baseUrl",
    "token",
    "username",
    "password",
    "apiKey",
    "clientId",
    "clientSecret",
  ]);
  for (const rawPath of Object.keys((spec.paths as Obj) ?? {})) {
    for (const m of rawPath.matchAll(/\{([^}]+)\}/g)) {
      reservedKeys.add(m[1].trim());
    }
  }

  const addExtraVariables = (extras: Variable[]) => {
    for (const v of extras) {
      if (!usedVarKeys.has(v.key)) {
        usedVarKeys.add(v.key);
        reservedKeys.add(v.key);
        variables.push(v);
      }
    }
  };
  addExtraVariables(rootResolved.extraVariables);

  const serverVarByUrl = new Map<string, string>([[rootResolved.url, "baseUrl"]]);
  let nextServerIndex = 2;

  const variableKeyForServerUrl = (serverUrl: string): string => {
    const existing = serverVarByUrl.get(serverUrl);
    if (existing) return existing;
    let candidate = `baseUrl_${nextServerIndex++}`;
    while (reservedKeys.has(candidate) || usedVarKeys.has(candidate)) {
      candidate = `baseUrl_${nextServerIndex++}`;
    }
    usedVarKeys.add(candidate);
    reservedKeys.add(candidate);
    serverVarByUrl.set(serverUrl, candidate);
    variables.push({ key: candidate, value: serverUrl, type: "default", enabled: true });
    return candidate;
  };

  let convertedBytes = 0;
  for (const [path, itemIn] of Object.entries(spec.paths as Obj)) {
    const item = deref(spec, itemIn);
    const shared = ((item.parameters as unknown[]) ?? []).map((p) => deref(spec, p));
    for (const method of METHODS) {
      const op = item[method] as Obj | undefined;
      if (!op) continue;
      const own = ((op.parameters as unknown[]) ?? []).map((p) => deref(spec, p));
      // Operation parameters override path-level ones with the same name+location.
      const params = [...shared.filter((s) => !own.some((o) => o.name === s.name && o.in === s.in)), ...own];
      const example = (p: Obj) => {
        const v = p.example ?? deref(spec, p.schema).example ?? deref(spec, p.schema).default ?? p.default;
        return v === undefined ? "" : String(v);
      };
      for (const parameter of params.filter((p) => p.in === "path")) {
        const key = String(parameter.name);
        if (!usedVarKeys.has(key)) {
          usedVarKeys.add(key);
          variables.push({ key, value: example(parameter), enabled: true, type: "default" });
        }
      }
      const query: KeyValue[] = params
        .filter((p) => p.in === "query")
        .map((p) => ({
          key: String(p.name),
          value: example(p),
          enabled: !!p.required,
          description: (p.description as string) || undefined,
        }));
      const headers: KeyValue[] = params
        .filter((p) => p.in === "header")
        .map((p) => ({
          key: String(p.name),
          value: example(p),
          enabled: !!p.required,
          description: (p.description as string) || undefined,
        }));
      const { body, contentType } = buildBody(spec, op, params);
      if (contentType && !headers.some((h) => h.key.toLowerCase() === "content-type"))
        headers.push({ key: "Content-Type", value: contentType, enabled: true });

      const resolvedServer = effectiveServerForOperation(spec, item, op, opts.sourceUrl, rootResolved.url);
      addExtraVariables(resolvedServer.extraVariables);
      const serverVarKey = variableKeyForServerUrl(resolvedServer.url);

      const qs = query.filter((q) => q.enabled).map((q) => `${q.key}=${q.value}`);
      const normPath = path.startsWith("/") ? path : `/${path}`;
      const url = `{{${serverVarKey}}}${normPath.replace(/\{([^}]+)\}/g, "{{$1}}")}${qs.length ? `?${qs.join("&")}` : ""}`;
      const opAuth =
        op.security !== undefined
          ? (op.security as unknown[]).length === 0
            ? ({ type: "none" } as AuthConfig)
            : securityToAuth(spec, op.security)
          : null;
      const req: RequestNode = {
        kind: "request",
        id: id(),
        name: String(op.summary ?? op.operationId ?? `${method.toUpperCase()} ${path}`),
        method: method.toUpperCase(),
        url,
        params: query,
        headers,
        body,
        auth: opAuth ?? { type: "inherit" },
        preRequestScript: "",
        testScript: "",
        settings: { ...DEFAULT_SETTINGS },
        description: String(op.description ?? ""),
        examples: [],
      };
      convertedBytes += Buffer.byteLength(
        serializeSample(req, OPENAPI_LIMITS.maxTotalBytes, "converted request content"),
        "utf8",
      );
      if (convertedBytes > OPENAPI_LIMITS.maxTotalBytes)
        throw new Error("OpenAPI converted request content exceeds 20 MiB");
      folderFor((op.tags as string[] | undefined)?.[0]).children.push(req);
    }
  }

  return { root, variables };
}
