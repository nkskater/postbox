import type { FolderNode, RequestDef, Variable, AuthConfig, KeyValue } from "../types";
import { redactSensitiveFields, authCredentialValues, sensitiveFieldValues } from "../retention";
import { redactStoredValue } from "../variables/resolver";
import type { JsonSchema } from "../contracts/model";
export type OpenApiDocument = Record<string, unknown>;
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => (!!v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
export function flattenRequests(root: FolderNode): RequestDef[] {
  const out: RequestDef[] = [];
  const walk = (folder: FolderNode, depth = 0) => {
    if (depth > 60) throw Error("Collection nesting exceeds 60 levels");
    for (const child of folder.children) {
      if (child.kind === "request") out.push(child);
      else walk(child, depth + 1);
      if (out.length > 1000) throw Error("OpenAPI generation supports at most 1,000 requests");
    }
  };
  walk(root);
  return out;
}
export function inferSchema(value: unknown, depth = 0): JsonSchema {
  if (depth > 30) throw Error("Example schema exceeds 30 levels");
  if (value === null) return { nullable: true };
  if (Array.isArray(value))
    return { type: "array", items: value.length ? inferSchema(value[0], depth + 1) : {} };
  if (typeof value === "object") {
    const entries = Object.entries(value as Obj);
    return {
      type: "object",
      properties: Object.fromEntries(entries.map(([k, v]) => [k, inferSchema(v, depth + 1)])),
    };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  return { type: typeof value === "boolean" ? "boolean" : "string" };
}
const parseExample = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};
export interface GeneratedOpenApi {
  document: OpenApiDocument;
  warnings: string[];
}
export function generateOpenApi(
  root: FolderNode,
  variables: Variable[] = [],
  options: {
    operationIds?: Record<string, string | undefined>;
    secrets?: string[];
    apiVersion?: string;
  } = {},
): GeneratedOpenApi {
  const paths: Obj = Object.create(null),
    securitySchemes: Obj = Object.create(null),
    warnings: string[] = [],
    usedOperations = new Set<string>();
  const values = new Map(
    variables.filter((v) => v.enabled && v.type !== "secret").map((v) => [v.key, v.value]),
  );
  const contexts = new Map<string, { auth: AuthConfig; headers: KeyValue[] }>();
  const gather = (folder: FolderNode, auth: AuthConfig, headers: KeyValue[], depth = 0) => {
    if (depth > 60) throw Error("Collection nesting exceeds 60 levels");
    const currentAuth = folder.auth.type === "inherit" ? auth : folder.auth;
    const ownHeaders = new Map(headers.map((h) => [h.key.toLowerCase(), h]));
    for (const h of folder.headers) ownHeaders.set(h.key.toLowerCase(), h);
    for (const child of folder.children)
      if (child.kind === "folder") gather(child, currentAuth, [...ownHeaders.values()], depth + 1);
      else {
        const finalHeaders = new Map(ownHeaders);
        for (const h of child.headers) finalHeaders.set(h.key.toLowerCase(), h);
        contexts.set(child.id, {
          auth: child.auth.type === "inherit" ? currentAuth : child.auth,
          headers: [...finalHeaders.values()],
        });
      }
  };
  gather(root, { type: "none" }, []);
  const requests = flattenRequests(root);
  const secrets = [
    ...authCredentialValues(root.auth),
    ...requests.flatMap((r) => [
      ...authCredentialValues(contexts.get(r.id)!.auth),
      ...Array.from(new URLSearchParams(r.url.split("?")[1] ?? ""))
        .filter(([key]) => /token|password|secret|api[-_]?key|session|credential/i.test(key))
        .map(([, value]) => value),
      ...sensitiveFieldValues(r.body),
      ...sensitiveFieldValues(r.params),
      ...sensitiveFieldValues(contexts.get(r.id)!.headers),
      ...(r.examples ?? []).flatMap((e) => sensitiveFieldValues(e.body)),
    ]),
    ...variables
      .filter(
        (v) => v.type === "secret" || /token|password|secret|api[-_]?key|session|credential/i.test(v.key),
      )
      .map((v) => v.value),
    ...variables.flatMap((v) =>
      Array.from(new URLSearchParams(v.value.split("?")[1] ?? ""))
        .filter(([key]) => /token|password|secret|api[-_]?key|session|credential/i.test(key))
        .map(([, value]) => value),
    ),
    ...(options.secrets ?? []),
  ].filter(Boolean);
  const clean = (v: unknown) => redactStoredValue(redactSensitiveFields(v), secrets);
  const security = (auth: AuthConfig, requestId: string): unknown[] | undefined => {
    if (auth.type === "inherit") return undefined;
    if (auth.type === "none") return [];
    const name = "auth_" + requestId.replace(/[^a-zA-Z0-9_]/g, "_");
    if (auth.type === "bearer" || auth.type === "basic" || auth.type === "digest")
      securitySchemes[name] = { type: "http", scheme: auth.type };
    else if (auth.type === "apikey")
      securitySchemes[name] = { type: "apiKey", in: auth.apikey.in, name: auth.apikey.key };
    else {
      warnings.push(`Authentication ${auth.type} is not represented for ${requestId}`);
      return undefined;
    }
    return [{ [name]: [] }];
  };
  const rootSecurity = security(root.auth, "collection");
  for (const req of requests) {
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)$/.test(req.method)) {
      warnings.push(`Skipped non-HTTP method ${req.method}: ${req.name}`);
      continue;
    }
    const raw = req.url.split(/[?#]/)[0];
    let server = "",
      route = "";
    const variable = raw.match(/^\{\{([^}]+)\}\}(.*)$/);
    if (variable) {
      server = values.get(variable[1]) ?? `{${variable[1]}}`;
      route = variable[2] || "/";
    } else {
      const absolute = raw.match(/^(https?:\/\/[^/]+)(.*)$/i);
      if (absolute) {
        server = absolute[1];
        route = absolute[2] || "/";
      } else route = raw.startsWith("/") ? raw : "/" + raw;
    }
    server = server.replace(/\{\{([^}]+)\}\}/g, "{$1}");
    route = req.contract?.pathTemplate ?? route.replace(/\{\{([^}]+)\}\}/g, "{$1}");
    if (!route.startsWith("/")) route = "/" + route;
    const method = req.method.toLowerCase(),
      item = object(paths[route]);
    paths[route] = item;
    if (item[method])
      throw Error(`Multiple requests use ${req.method} ${route}; choose a unique typed path template`);
    const op: Obj = {
      summary: clean(req.name),
      description: clean(req.description ?? ""),
      "x-postbox-request-id": req.id,
    };
    const opId = Object.hasOwn(options.operationIds ?? {}, req.id)
      ? options.operationIds![req.id]
      : "postbox_" + req.id.replace(/[^a-zA-Z0-9_]/g, "_");
    if (opId) {
      if (usedOperations.has(opId)) throw Error("Duplicate operationId " + opId);
      usedOperations.add(opId);
      op.operationId = opId;
    }
    if (server) {
      if (server.includes("@"))
        throw Error("Remove credentials from the request URL before generating OpenAPI");
      const serverVariables: Obj = Object.create(null);
      for (const match of server.matchAll(/\{([^{}]+)\}/g))
        serverVariables[match[1]] = { default: clean(values.get(match[1]) ?? "") };
      op.servers = [
        { url: clean(server), ...(Object.keys(serverVariables).length ? { variables: serverVariables } : {}) },
      ];
    }
    const parameters = new Map<string, Obj>();
    for (const p of req.contract?.parameters ?? [])
      parameters.set(p.in + ":" + p.name, { ...p, schema: p.schema });
    for (const match of route.matchAll(/\{([^}]+)\}/g)) {
      const name = match[1],
        key = "path:" + name;
      parameters.set(key, {
        ...parameters.get(key),
        name,
        in: "path",
        required: true,
        schema: parameters.get(key)?.schema ?? { type: "string" },
      });
    }
    const params: KeyValue[] = req.params.length
      ? req.params
      : Array.from(new URLSearchParams(req.url.split("?")[1] ?? "")).map(([key, value]) => ({
          key,
          value,
          enabled: true,
        }));
    for (const [location, rows] of [
      ["query", params],
      ["header", contexts.get(req.id)!.headers],
    ] as const)
      for (const row of rows) {
        if (!row.key || /^(authorization|cookie|proxy-authorization|content-type|x-api-key)$/i.test(row.key))
          continue;
        const key = location + ":" + row.key;
        if (!parameters.has(key))
          parameters.set(key, {
            name: row.key,
            in: location,
            required: row.enabled,
            description: row.description ?? "",
            schema: { type: "string" },
            example: clean(row.value),
          });
        else parameters.get(key)!.example = clean(row.value);
        if (/token|password|secret|api[-_]?key|session|credential/i.test(row.key))
          parameters.get(key)!.example = "[REDACTED]";
      }
    if (parameters.size) op.parameters = [...parameters.values()].map(clean);
    const contentType = contexts
      .get(req.id)!
      .headers.find((h) => h.enabled && h.key.toLowerCase() === "content-type")?.value;
    if (req.body.mode === "raw") {
      const example = clean(parseExample(req.body.raw)),
        type =
          contentType ??
          (req.body.language === "json"
            ? "application/json"
            : req.body.language === "xml"
              ? "application/xml"
              : "text/plain");
      op.requestBody = {
        content: { [type]: { schema: clean(req.contract?.requestBody ?? inferSchema(example)), example } },
      };
    } else if (req.body.mode === "urlencoded" || req.body.mode === "formdata") {
      const rows = req.body.mode === "urlencoded" ? req.body.urlencoded : req.body.formdata,
        properties: Obj = Object.create(null),
        example: Obj = Object.create(null);
      for (const field of rows) {
        if (!field.enabled) continue;
        properties[field.key] = {
          type: "string",
          ...("type" in field && field.type === "file" ? { format: "binary" } : {}),
        };
        example[field.key] = "type" in field && field.type === "file" ? "" : clean(field.value);
      }
      op.requestBody = {
        content: {
          [contentType ??
          (req.body.mode === "formdata" ? "multipart/form-data" : "application/x-www-form-urlencoded")]: {
            schema: clean(req.contract?.requestBody ?? { type: "object", properties }),
            example,
          },
        },
      };
    } else if (req.contract?.requestBody)
      op.requestBody = {
        content: { [contentType ?? "application/json"]: { schema: clean(req.contract.requestBody) } },
      };
    const responses: Obj = Object.create(null);
    for (const status of req.contract?.responseStatus ?? [])
      responses[String(status)] = {
        description: "Response",
        ...(req.contract?.responseBody
          ? { content: { "application/json": { schema: clean(req.contract.responseBody) } } }
          : {}),
      };
    for (const example of req.examples ?? []) {
      if (example.bodyOmitted || example.truncated || example.bodyEncoding === "base64") {
        warnings.push(`Omitted incomplete/binary response example ${example.name}`);
        continue;
      }
      const status = String(example.status),
        response = object(responses[status]);
      responses[status] = response;
      response.description = clean(example.statusText || example.name || "Response");
      const type =
          example.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "application/json",
        body = clean(parseExample(example.body)),
        content = object(response.content),
        media = object(content[type]);
      response.content = content;
      content[type] = media;
      media.schema = clean(req.contract?.responseBody ?? inferSchema(body));
      if (example.id.startsWith("openapi-example:") && !media.examples) media.example = body;
      else {
        const key = example.id.startsWith("openapi:")
          ? Buffer.from(example.id.split(":").at(-1)!, "base64url").toString()
          : "example_" + example.id.replace(/[^a-zA-Z0-9_]/g, "_");
        media.examples = { ...object(media.examples), [key]: { summary: clean(example.name), value: body } };
        delete media.example;
      }
      const responseHeaders = object(response.headers);
      for (const header of example.headers) {
        if (!header.enabled || /content-type|authorization|cookie|token|secret|api[-_]?key/i.test(header.key))
          continue;
        responseHeaders[header.key] = { schema: { type: "string" }, example: clean(header.value) };
      }
      if (Object.keys(responseHeaders).length) response.headers = responseHeaders;
    }
    if (!Object.keys(responses).length)
      responses.default = {
        description: "Response",
        ...(req.contract?.responseBody
          ? { content: { "application/json": { schema: clean(req.contract.responseBody) } } }
          : {}),
      };
    op.responses = responses;
    const auth = security(contexts.get(req.id)!.auth, req.id);
    if (auth !== undefined) op.security = auth;
    item[method] = op;
  }
  const document: Obj = {
    openapi: "3.0.3",
    info: {
      title: clean(root.name),
      version: options.apiVersion ?? "1.0.0",
      description: clean(root.description ?? ""),
    },
    paths,
  };
  if (rootSecurity !== undefined) document.security = rootSecurity;
  if (Object.keys(securitySchemes).length) document.components = { securitySchemes };
  const serialized = JSON.stringify(document);
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw Error("Generated OpenAPI exceeds 1 MiB");
  return { document: JSON.parse(serialized) as Obj, warnings };
}
