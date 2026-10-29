/**
 * OpenAPI 3.x / Swagger 2.0 (JSON or YAML) → collection tree.
 * Operations are grouped into folders by their first tag; path parameters
 * become {{variables}} and the first server URL becomes the {{baseUrl}}
 * collection variable.
 */
import YAML from "yaml";
import type { AuthConfig, BodyConfig, FolderNode, KeyValue, RequestNode, Variable } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import type { ImportedCollection } from "./postman";

type Obj = Record<string, unknown>;
const id = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function parseSpec(text: string): Obj {
  const t = text.trim();
  return (t.startsWith("{") ? JSON.parse(t) : YAML.parse(t)) as Obj;
}

export function isOpenApi(data: unknown): data is Obj {
  const d = data as Obj;
  return (
    !!d &&
    typeof d === "object" &&
    (typeof d.openapi === "string" || typeof d.swagger === "string") &&
    !!d.paths
  );
}

/** Resolve local "#/..." JSON references (one level at a time, cycle-safe via depth). */
function deref(spec: Obj, value: unknown, depth = 0): Obj {
  let v = value as Obj;
  let guard = 0;
  while (v && typeof v === "object" && typeof v.$ref === "string" && guard++ < 20) {
    const ref = v.$ref as string;
    if (!ref.startsWith("#/")) return {};
    v = ref
      .slice(2)
      .split("/")
      .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce<unknown>((acc, key) => (acc as Obj | undefined)?.[key], spec) as Obj;
  }
  return depth > 50 ? {} : (v ?? {});
}

/** Build an example value from a schema (example > default > enum > generated). */
export function sampleFromSchema(spec: Obj, schemaIn: unknown, depth = 0): unknown {
  const schema = deref(spec, schemaIn);
  if (depth > 6) return null;
  if ("example" in schema) return schema.example;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((s) => sampleFromSchema(spec, s, depth + 1) as Obj));
  }
  for (const k of ["oneOf", "anyOf"])
    if (Array.isArray(schema[k]) && (schema[k] as unknown[]).length)
      return sampleFromSchema(spec, (schema[k] as unknown[])[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object":
    case undefined: {
      if (!schema.properties && type === undefined)
        return schema.items ? [sampleFromSchema(spec, schema.items, depth + 1)] : "";
      const out: Obj = {};
      for (const [k, v] of Object.entries((schema.properties as Obj) ?? {}))
        out[k] = sampleFromSchema(spec, v, depth + 1);
      return out;
    }
    case "array":
      return [sampleFromSchema(spec, schema.items, depth + 1)];
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

function baseUrlOf(spec: Obj, sourceUrl?: string): string {
  if (spec.swagger) {
    const scheme = (spec.schemes as string[] | undefined)?.[0] ?? "https";
    return `${scheme}://${spec.host ?? "localhost"}${spec.basePath ?? ""}`.replace(/\/$/, "");
  }
  const server = (spec.servers as Obj[] | undefined)?.[0];
  if (!server) return "http://localhost";
  let url = String(server.url ?? "");
  for (const [k, v] of Object.entries((server.variables as Record<string, Obj>) ?? {}))
    url = url.replace(`{${k}}`, String(v.default ?? ""));
  // Relative server URLs ("/api/v3") are relative to where the spec was loaded from.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      url = new URL(url || "/", sourceUrl ?? "http://localhost").toString();
    } catch {
      url = `http://localhost${url.startsWith("/") ? "" : "/"}${url}`;
    }
  }
  return url.replace(/\/$/, "");
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

function buildBody(spec: Obj, op: Obj, params: Obj[]): { body: BodyConfig; contentType?: string } {
  // Swagger 2: body / formData parameters
  const bodyParam = params.find((p) => p.in === "body");
  if (bodyParam)
    return {
      body: {
        mode: "raw",
        language: "json",
        raw: JSON.stringify(sampleFromSchema(spec, bodyParam.schema), null, 2),
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
  const example =
    media.example ??
    (examples ? deref(spec, Object.values(examples)[0]).value : undefined) ??
    sampleFromSchema(spec, media.schema);
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
        raw: typeof example === "string" ? example : JSON.stringify(example, null, 2),
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
      const qs = query.filter((q) => q.enabled).map((q) => `${q.key}=${q.value}`);
      const url = `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, "{{$1}}")}${qs.length ? `?${qs.join("&")}` : ""}`;
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
      folderFor((op.tags as string[] | undefined)?.[0]).children.push(req);
    }
  }

  const variables: Variable[] = [
    { key: "baseUrl", value: baseUrlOf(spec, opts.sourceUrl), type: "default", enabled: true },
  ];
  return { root, variables };
}
