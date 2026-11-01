/**
 * Postman collection format v3 (single-document JSON, schema v3.0.0) converted to and from
 * the v2.1 shape the shared Postman importer and exporter already handle.
 *
 * v3 -> v2.1 feeds `importPostmanCollection`; v2.1 -> v3 turns what `exportPostmanCollection` writes
 * into a v3 document. Nothing is guessed: anything v3 can express that Postbox does not model, and
 * anything v3 cannot hold, is reported as a diagnostic instead of being dropped silently.
 */
import type { PostmanCollection } from "./postman";

export const V3_SCHEMA_URL = "https://schema.postman.com/collection/json/v3.0.0/draft-07/collection.json";
const V21_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

export interface V3Diagnostic {
  level: "unsupported" | "lossy";
  /** Where, for example `Orders / Create order`. */
  path: string;
  message: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** A v3 collection document: `$kind: "collection"`, a name and no v2 `info` block. */
export function isPostmanV3(data: unknown): data is Json {
  return isObject(data) && data.$kind === "collection" && typeof data.name === "string" && !("info" in data);
}

const V3_AUTH_TYPES = new Set([
  "basic",
  "bearer",
  "apikey",
  "oauth1",
  "oauth2",
  "jwt",
  "ntlm",
  "digest",
  "edgegrid",
  "hawk",
  "asap",
  "awsv4",
]);
const REQUEST_KINDS: Record<string, string> = {
  "graphql-request": "GraphQL request",
  "grpc-request": "gRPC request",
  "websocket-request": "WebSocket request",
  "socketio-request": "Socket.IO request",
  "mqtt-request": "MQTT request",
  "kafka-request": "Kafka request",
  "mcp-request": "MCP request",
  "llm-request": "AI request",
  "data-request": "Data request",
};

// ------------------------------------------------------------------ v3 -> v2.1

class Collector {
  diagnostics: V3Diagnostic[] = [];
  note(level: V3Diagnostic["level"], path: string[], message: string) {
    this.diagnostics.push({ level, path: path.join(" / "), message });
  }
}

function scriptsToEvents(scripts: unknown, path: string[], out: Collector): Json[] {
  const events: Json[] = [];
  for (const script of list(scripts)) {
    const type = text(script.type).replace(/^http:/, "");
    const listen = type === "beforeRequest" ? "prerequest" : type === "afterResponse" ? "test" : null;
    if (!listen) {
      out.note("unsupported", path, `Script type "${text(script.type)}" is not supported and was skipped`);
      continue;
    }
    if (script.packages && Object.keys(script.packages as Json).length)
      out.note("lossy", path, "Script package references are not imported");
    events.push({ listen, script: { type: "text/javascript", exec: text(script.code).split("\n") } });
  }
  return events;
}

function authFromV3(auth: unknown, path: string[], out: Collector): Json | undefined {
  const sets = Array.isArray(auth) ? list(auth) : isObject(auth) ? [auth] : [];
  if (!sets.length) return undefined;
  if (Array.isArray(auth) && auth.length > 1)
    out.note(
      "lossy",
      path,
      "Several credential sets with URL rules are not supported; the first one is used",
    );
  const set = sets[0];
  const type = text(set.type);
  if (type === "inherit") return undefined;
  if (type === "noauth") return { type: "noauth" };
  if (!V3_AUTH_TYPES.has(type)) {
    out.note(
      "unsupported",
      path,
      `Authentication type "${type}" is not supported; the request keeps no auth`,
    );
    return { type: "noauth" };
  }
  return {
    type,
    [type]: list(set.credentials).map((entry) => ({
      key: text(entry.key),
      value: entry.value,
      type: "string",
    })),
  };
}

function variablesFromV3(variables: unknown, path: string[], out: Collector): Json[] {
  return list(variables).map((entry) => {
    if (entry.secret === true) {
      const source = isObject(entry.source) ? text(entry.source.provider) : "";
      out.note(
        "lossy",
        path,
        `Secret variable "${text(entry.key)}"${source ? ` (from ${source})` : ""} has no value in the file; it is imported empty`,
      );
      return {
        key: text(entry.key),
        value: "",
        type: "secret",
        ...(entry.disabled ? { disabled: true } : {}),
      };
    }
    return {
      key: text(entry.key),
      value: text(entry.value),
      type: "string",
      ...(entry.disabled ? { disabled: true } : {}),
    };
  });
}

function bodyFromV3(body: unknown): Json | undefined {
  if (!isObject(body)) return undefined;
  const type = text(body.type);
  switch (type) {
    case "none":
      return undefined;
    case "text":
    case "json":
    case "xml":
    case "html":
    case "javascript":
      return { mode: "raw", raw: text(body.content), options: { raw: { language: type } } };
    case "urlencoded":
      return {
        mode: "urlencoded",
        urlencoded: list(body.content).map((field) => ({
          key: text(field.key),
          value: text(field.value),
          ...(field.disabled ? { disabled: true } : {}),
        })),
      };
    case "formdata":
      return {
        mode: "formdata",
        formdata: list(body.content).map((field) => ({
          key: text(field.key),
          type: field.type === "file" ? "file" : "text",
          ...(field.type === "file" ? { src: field.src } : { value: text(field.value) }),
          ...(field.contentType ? { contentType: field.contentType } : {}),
          ...(field.disabled ? { disabled: true } : {}),
        })),
      };
    case "file":
      return { mode: "file", file: { src: isObject(body.content) ? text(body.content.src) : "" } };
    case "graphql": {
      const content = isObject(body.content) ? body.content : {};
      return {
        mode: "graphql",
        graphql: {
          query: text(content.query),
          variables: text(content.variables),
          ...(content.operationName ? { operationName: text(content.operationName) } : {}),
        },
      };
    }
    default:
      return undefined;
  }
}

function requestParts(source: Json) {
  const query = list(source.queryParams)
    .filter((param) => param.key)
    .map((param) => ({
      key: text(param.key),
      value: text(param.value),
      ...(param.disabled ? { disabled: true } : {}),
    }));
  const base = text(source.url);
  const enabled = query.filter((param) => !param.disabled).map((param) => `${param.key}=${param.value}`);
  const raw = enabled.length ? `${base}${base.includes("?") ? "&" : "?"}${enabled.join("&")}` : base;
  const variable = list(source.pathVariables).map((entry) => ({
    key: text(entry.key),
    value: text(entry.value),
  }));
  return {
    method: text(source.method) || "GET",
    url: { raw, query, ...(variable.length ? { variable } : {}) },
    header: list(source.headers).map((header) => ({
      key: text(header.key),
      value: text(header.value),
      ...(header.$type ? { type: text(header.$type) } : {}),
      ...(header.disabled ? { disabled: true } : {}),
    })),
    body: bodyFromV3(source.body),
  };
}

function itemFromV3(item: Json, parents: string[], out: Collector): Json | null {
  const name = text(item.name) || "Untitled";
  const path = [...parents, name];
  const kind = text(item.$kind);
  if (kind === "collection") {
    const folderAuth = authFromV3(item.auth, path, out);
    return {
      name,
      item: list(item.items)
        .map((child) => itemFromV3(child, path, out))
        .filter((child): child is Json => child !== null),
      event: scriptsToEvents(item.scripts, path, out),
      ...(folderAuth ? { auth: folderAuth } : {}),
    };
  }
  if (kind !== "http-request") {
    out.note(
      "unsupported",
      path,
      `${REQUEST_KINDS[kind] ?? `Item of kind "${kind}"`} is not supported and was skipped`,
    );
    return null;
  }
  const settings = isObject(item.settings) ? Object.keys(item.settings) : [];
  if (settings.length)
    out.note(
      "lossy",
      path,
      `Request settings are not imported (${settings.slice(0, 6).join(", ")}${settings.length > 6 ? ", …" : ""})`,
    );
  const requestAuth = authFromV3(item.auth, path, out);
  const parts = requestParts(item);
  return {
    name,
    event: scriptsToEvents(item.scripts, path, out),
    request: {
      method: parts.method,
      url: parts.url,
      header: parts.header,
      ...(parts.body ? { body: parts.body } : {}),
      ...(requestAuth ? { auth: requestAuth } : {}),
    },
    response: list(item.examples).map((example) => {
      const response = isObject(example.response) ? example.response : {};
      const body = isObject(response.body) ? response.body : {};
      const original = isObject(example.request) ? requestParts(example.request) : null;
      return {
        name: text(example.name),
        code: typeof response.statusCode === "number" ? response.statusCode : 200,
        status: text(response.statusText),
        header: list(response.headers).map((header) => ({
          key: text(header.key),
          value: text(header.value),
          ...(header.disabled ? { disabled: true } : {}),
        })),
        body: text(body.content),
        ...(original
          ? {
              originalRequest: {
                method: original.method,
                url: original.url,
                header: original.header,
                ...(original.body ? { body: original.body } : {}),
              },
            }
          : {}),
      };
    }),
  };
}

export interface V3Import {
  collection: PostmanCollection;
  diagnostics: V3Diagnostic[];
}

/** Convert a v3 collection to the v2.1 structure the shared importer reads. */
export function postmanV3ToV21(data: unknown): V3Import {
  if (!isPostmanV3(data))
    throw new Error('Not a Postman v3 collection (needs $kind "collection" and a name)');
  const out = new Collector();
  const root = [text(data.name)];
  if (isObject(data.uses) && Array.isArray(data.uses.environment) && data.uses.environment.length)
    out.note(
      "lossy",
      root,
      "Environment references (uses) are not imported; import the environments separately",
    );
  const auth = authFromV3(data.auth, root, out);
  const collection = {
    info: {
      name: text(data.name),
      ...(data.id ? { _postman_id: text(data.id) } : {}),
      ...(data.description ? { description: text(data.description) } : {}),
      schema: V21_SCHEMA,
    },
    item: list(data.items)
      .map((child) => itemFromV3(child, root, out))
      .filter((child): child is Json => child !== null),
    event: scriptsToEvents(data.scripts, root, out),
    ...(auth ? { auth } : {}),
    variable: variablesFromV3(data.variables, root, out),
  } as unknown as PostmanCollection;
  return { collection, diagnostics: out.diagnostics };
}

// ------------------------------------------------------------------ v2.1 -> v3

function eventsToScripts(events: unknown, folder: boolean): Json[] {
  const scripts: Json[] = [];
  for (const event of list(events)) {
    const exec = isObject(event.script) ? event.script.exec : undefined;
    const code = Array.isArray(exec) ? exec.map(text).join("\n") : text(exec);
    if (!code) continue;
    const type =
      event.listen === "prerequest" ? "beforeRequest" : event.listen === "test" ? "afterResponse" : null;
    if (!type) continue;
    scripts.push({ type: folder ? `http:${type}` : type, code, language: "text/javascript" });
  }
  return scripts;
}

function credentialsOf(raw: unknown): Json[] {
  if (Array.isArray(raw))
    return list(raw).map((entry) => ({ key: text(entry.key), value: entry.value ?? "" }));
  if (isObject(raw)) return Object.entries(raw).map(([key, value]) => ({ key, value: value ?? "" }));
  return [];
}

function authToV3(auth: unknown, path: string[], out: Collector): Json | undefined {
  if (!isObject(auth)) return undefined;
  const type = text(auth.type);
  if (type === "noauth") return { type: "noauth" };
  if (!V3_AUTH_TYPES.has(type)) {
    out.note("unsupported", path, `Authentication type "${type}" cannot be written in v3 and was left out`);
    return undefined;
  }
  return { type, credentials: credentialsOf(auth[type]) };
}

function bodyToV3(body: unknown): Json | undefined {
  if (!isObject(body)) return undefined;
  switch (body.mode) {
    case "raw": {
      const options = isObject(body.options) && isObject(body.options.raw) ? body.options.raw : {};
      const language = text(options.language);
      return {
        type: ["json", "xml", "html", "javascript"].includes(language) ? language : "text",
        content: text(body.raw),
      };
    }
    case "urlencoded":
      return {
        type: "urlencoded",
        content: list(body.urlencoded).map((field) => ({
          key: text(field.key),
          value: text(field.value),
          ...(field.disabled ? { disabled: true } : {}),
        })),
      };
    case "formdata":
      return {
        type: "formdata",
        content: list(body.formdata).map((field) =>
          field.type === "file"
            ? {
                type: "file",
                key: text(field.key),
                src: Array.isArray(field.src) ? field.src.map(text) : text(field.src),
                ...(field.contentType ? { contentType: text(field.contentType) } : {}),
                ...(field.disabled ? { disabled: true } : {}),
              }
            : {
                type: "text",
                key: text(field.key),
                value: text(field.value),
                ...(field.contentType ? { contentType: text(field.contentType) } : {}),
                ...(field.disabled ? { disabled: true } : {}),
              },
        ),
      };
    case "file":
      return { type: "file", content: { src: isObject(body.file) ? text(body.file.src) : "" } };
    case "graphql": {
      const graphql = isObject(body.graphql) ? body.graphql : {};
      return {
        type: "graphql",
        content: {
          query: text(graphql.query),
          ...(graphql.variables
            ? {
                variables:
                  typeof graphql.variables === "string"
                    ? graphql.variables
                    : JSON.stringify(graphql.variables),
              }
            : {}),
          ...(graphql.operationName ? { operationName: text(graphql.operationName) } : {}),
        },
      };
    }
    default:
      return undefined;
  }
}

function urlToV3(url: unknown) {
  const raw = typeof url === "string" ? url : isObject(url) ? text(url.raw) : "";
  const query = isObject(url) ? list(url.query) : [];
  const variables = isObject(url) ? list(url.variable) : [];
  const question = raw.indexOf("?");
  return {
    url: question >= 0 ? raw.slice(0, question) : raw,
    queryParams: query.map((param) => ({
      key: text(param.key),
      value: text(param.value),
      ...(param.disabled ? { disabled: true } : {}),
    })),
    pathVariables: variables.map((entry) => ({ key: text(entry.key), value: text(entry.value) })),
  };
}

function headersToV3(headers: unknown) {
  return list(headers).map((header) => ({
    key: text(header.key),
    value: text(header.value),
    ...(header.type ? { $type: text(header.type) } : {}),
    ...(header.disabled ? { disabled: true } : {}),
  }));
}

function itemToV3(item: Json, parents: string[], out: Collector): Json {
  const name = text(item.name) || "Untitled";
  const path = [...parents, name];
  if (Array.isArray(item.item)) {
    const auth = authToV3(item.auth, path, out);
    const scripts = eventsToScripts(item.event, true);
    return {
      $kind: "collection",
      name,
      ...(scripts.length ? { scripts } : {}),
      ...(auth ? { auth } : {}),
      items: list(item.item).map((child) => itemToV3(child, path, out)),
    };
  }
  const request = isObject(item.request) ? item.request : {};
  const url = urlToV3(request.url);
  const auth = authToV3(request.auth, path, out);
  const body = bodyToV3(request.body);
  const scripts = eventsToScripts(item.event, false);
  const examples = list(item.response).map((response) => {
    const original = isObject(response.originalRequest) ? response.originalRequest : null;
    const originalUrl = original ? urlToV3(original.url) : null;
    const originalBody = original ? bodyToV3(original.body) : undefined;
    return {
      $kind: "http-example",
      name: text(response.name) || "Example",
      ...(original && originalUrl
        ? {
            request: {
              url: originalUrl.url,
              method: text(original.method) || "GET",
              headers: list(original.header).map((header) => ({
                key: text(header.key),
                value: text(header.value),
                ...(header.disabled ? { disabled: true } : {}),
              })),
              ...(originalUrl.queryParams.length ? { queryParams: originalUrl.queryParams } : {}),
              ...(originalBody ? { body: originalBody } : {}),
            },
          }
        : {}),
      response: {
        statusCode: typeof response.code === "number" ? response.code : 200,
        statusText: text(response.status),
        headers: headersToV3(response.header),
        body: { type: guessBodyType(response), content: text(response.body) },
      },
    };
  });
  if (item._postbox)
    out.note("lossy", path, "Postbox contract metadata has no v3 equivalent and was left out");
  return {
    $kind: "http-request",
    name,
    url: url.url,
    method: text(request.method) || "GET",
    ...(list(request.header).length ? { headers: headersToV3(request.header) } : {}),
    ...(url.queryParams.length ? { queryParams: url.queryParams } : {}),
    ...(url.pathVariables.length ? { pathVariables: url.pathVariables } : {}),
    ...(body ? { body } : {}),
    ...(auth ? { auth } : {}),
    ...(scripts.length ? { scripts } : {}),
    ...(examples.length ? { examples } : {}),
  };
}

/** Pick the example body type from its Content-Type; v3 allows text, json, xml, html, javascript and yaml. */
function guessBodyType(response: Json): string {
  const contentType = list(response.header).find(
    (header) => text(header.key).toLowerCase() === "content-type",
  );
  const value = text(contentType?.value).toLowerCase();
  if (value.includes("json")) return "json";
  if (value.includes("xml")) return "xml";
  if (value.includes("html")) return "html";
  if (value.includes("javascript")) return "javascript";
  if (value.includes("yaml")) return "yaml";
  return "text";
}

export interface V3Export {
  collection: Json;
  diagnostics: V3Diagnostic[];
}

/** Convert what `exportPostmanCollection` produces into a v3 document. */
export function postmanV21ToV3(data: PostmanCollection): V3Export {
  const out = new Collector();
  const source = data as unknown as Json;
  const info = isObject(source.info) ? source.info : {};
  const name = text(info.name) || "Collection";
  const root = [name];
  const variables = list(source.variable).map((variable) => {
    if (variable.type === "secret") {
      out.note(
        "lossy",
        root,
        `Secret variable "${text(variable.key)}" is exported without a value, as v3 cannot hold one`,
      );
      return { key: text(variable.key), secret: true, ...(variable.disabled ? { disabled: true } : {}) };
    }
    return {
      key: text(variable.key),
      value: text(variable.value),
      ...(variable.disabled ? { disabled: true } : {}),
    };
  });
  const scripts = eventsToScripts(source.event, true);
  const auth = authToV3(source.auth, root, out);
  const description =
    typeof info.description === "string"
      ? info.description
      : isObject(info.description)
        ? text(info.description.content)
        : "";
  const collection: Json = {
    $kind: "collection",
    name,
    ...(info._postman_id ? { id: text(info._postman_id) } : {}),
    ...(description ? { description } : {}),
    ...(variables.length ? { variables } : {}),
    ...(scripts.length ? { scripts } : {}),
    ...(auth ? { auth } : {}),
    items: list(source.item).map((item) => itemToV3(item, root, out)),
  };
  return { collection, diagnostics: out.diagnostics };
}
