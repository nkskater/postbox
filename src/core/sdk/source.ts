import { isPostmanV3, postmanV3ToV21 } from "../convert/postman-v3";
import { importPostmanCollection, isPostmanCollection } from "../convert/postman";
import { isOpenApi, parseSpec, type OpenApiObject } from "../convert/openapi-document";
import { localReferenceValue } from "../convert/openapi-references";
import { generateDocumentation } from "../documentation/generate";
import type { FolderNode, RequestNode, Variable } from "../types";
import { SDK_LIMITS, type SdkDefinition, type SdkOperation, type SdkType } from "./model";
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
export function structuralType(
  schema: unknown,
  root: Obj = object(schema),
  depth = 0,
  budget = { nodes: 0 },
): SdkType {
  if (depth > SDK_LIMITS.typeDepth || ++budget.nodes > SDK_LIMITS.typeNodes) return { kind: "json" };
  const value = object(localReferenceValue(root, schema));
  const project = (child: unknown) => structuralType(child, root, depth + 1, budget);
  if (Array.isArray(value.oneOf) || Array.isArray(value.anyOf))
    return { kind: "union", items: ((value.oneOf ?? value.anyOf) as unknown[]).slice(0, 20).map(project) };
  if (Array.isArray(value.type))
    return { kind: "union", items: value.type.slice(0, 10).map((type) => project({ ...value, type })) };
  if (Array.isArray(value.allOf)) {
    const parts = value.allOf.map(project);
    if (parts.every((p) => p.kind === "object")) {
      const properties = Object.assign(
        Object.create(null),
        ...parts.map((p) => (p.kind === "object" ? p.properties : {})),
      );
      return {
        kind: "object",
        properties,
        required: [...new Set(parts.flatMap((p) => (p.kind === "object" ? p.required : [])))].sort(),
      };
    }
    return { kind: "json" };
  }
  if (value.type === "object" || value.properties) {
    const properties: Record<string, SdkType> = Object.create(null);
    for (const key of Object.keys(object(value.properties)).sort())
      properties[key] = project(object(value.properties)[key]);
    return {
      kind: "object",
      properties,
      required: Array.isArray(value.required)
        ? value.required
            .filter((key): key is string => typeof key === "string" && Object.hasOwn(properties, key))
            .sort()
        : [],
    };
  }
  if (value.type === "array") return { kind: "array", items: project(value.items) };
  if (value.type === "integer" || value.type === "number") return { kind: "number" };
  if (value.type === "boolean") return { kind: "boolean" };
  if (value.type === "null") return { kind: "null" };
  if (value.type === "string") return { kind: "string" };
  return { kind: "json" };
}
function pathOf(url: string): string {
  let value = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value))
    throw new Error("SDKs support HTTP(S) requests only");
  value = value.replace(/^\{\{[^{}]+\}\}/, "");
  if (/^https?:\/\//i.test(value)) value = new URL(value).pathname;
  else value = value.split(/[?#]/)[0];
  if (!value.startsWith("/")) value = "/" + value.replace(/^[^/]+\//, "");
  value = value.replace(/%7b/gi, "{").replace(/%7d/gi, "}");
  value = value.replace(/\{\{([^{}]+)\}\}/g, "{$1}").replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
  if (!value || value.includes("[REDACTED]") || /[\r\n\\]/.test(value) || value.startsWith("//"))
    throw new Error("SDK path is invalid or contains a redacted credential; use path templates");
  return value;
}
const reserved = new Set([
  ...[
    "false",
    "none",
    "true",
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "try",
    "while",
    "with",
    "yield",
  ],
  "auth",
  "headers",
  "transport",
  "timeout",
  "base_url",
  "on_error",
  "constructor",
  "request",
  "pages",
  "close",
  "config",
  "default",
  "class",
  "from",
  "import",
  "async",
  "await",
  "def",
  "return",
  "self",
]);
function names(operations: SdkOperation[]) {
  const used = new Set<string>();
  for (const op of operations) {
    let name =
      op.name
        .replace(/[^A-Za-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase() || "operation";
    if (!/^[a-z_]/.test(name) || reserved.has(name)) name = "op_" + name;
    const base = name;
    let i = 2;
    while (used.has(name)) name = base + "_" + i++;
    used.add(name);
    op.name = name;
  }
  return operations;
}
function finish(operations: SdkOperation[], warnings: string[]): SdkDefinition {
  if (!operations.length) throw new Error("SDK definition contains no HTTP operations");
  if (operations.length > SDK_LIMITS.operations) throw new Error("SDK definition exceeds 500 operations");
  const queryType = (type: SdkType): boolean =>
    type.kind === "object"
      ? false
      : type.kind === "array"
        ? type.items.kind !== "array" && queryType(type.items)
        : type.kind === "union"
          ? type.items.every(queryType)
          : true;
  for (const operation of operations) {
    if (["GET", "HEAD"].includes(operation.method.toUpperCase()) && operation.bodyMode !== "none")
      throw new Error("GET/HEAD bodies are unsupported by the generated fetch client");
    if (Object.values(operation.query).some((parameter) => !queryType(parameter.type)))
      throw new Error(
        "Complex query serialization is unsupported; supply primitive/repeated primitive query parameters",
      );
  }
  return { operations: names(operations), warnings: [...new Set(warnings)].sort() };
}
export function sdkFromCollection(
  root: FolderNode,
  variables: Variable[] = [],
  authTypes?: Record<string, string>,
): SdkDefinition {
  const snapshot = generateDocumentation(root, variables);
  const original: RequestNode[] = [],
    safe: RequestNode[] = [];
  const flatten = (folder: FolderNode, target: RequestNode[]) =>
    folder.children.forEach((node) => (node.kind === "folder" ? flatten(node, target) : target.push(node)));
  flatten(root, original);
  flatten(snapshot.root, safe);
  const warnings = [
    "Credentials, query/body defaults, scripts and examples are not embedded. Configure runtime values explicitly.",
  ];
  const operations = safe.map((request, index): SdkOperation => {
    const source = original[index],
      contract = source.contract;
    const path = pathOf(request.url),
      pathParameters = [...path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
    if (pathParameters.some((key) => !key || key.length > 200)) throw new Error("Invalid SDK path parameter");
    const query: SdkOperation["query"] = Object.create(null);
    for (const parameter of request.params)
      if (parameter.key) query[parameter.key] = { type: { kind: "string" }, required: false };
    for (const parameter of contract?.parameters ?? [])
      if (parameter.in === "query")
        query[parameter.name] = { type: structuralType(parameter.schema), required: parameter.required };
    let bodyMode: SdkOperation["bodyMode"] = "none";
    if (request.body.mode === "raw") bodyMode = request.body.language === "json" ? "json" : "text";
    else if (request.body.mode === "urlencoded") bodyMode = "urlencoded";
    else if (request.body.mode === "graphql") bodyMode = "json";
    else if (source.body.mode !== "none")
      throw new Error(
        `SDK operation ${request.name} has an unsupported upload/body mode; use a custom transport outside this generated client`,
      );
    if (!contract?.responseBody)
      warnings.push(
        "Operations without a response schema return JsonValue; no response model is inferred from examples.",
      );
    return {
      name: request.name,
      method: request.method,
      path,
      pathParameters: [...new Set(pathParameters)],
      query,
      bodyMode,
      bodyType:
        contract?.requestBody !== undefined
          ? structuralType(contract.requestBody)
          : bodyMode === "text"
            ? { kind: "string" }
            : { kind: "json" },
      responseType:
        contract?.responseBody !== undefined ? structuralType(contract.responseBody) : { kind: "json" },
      authRequired: (authTypes?.[request.id] ?? snapshot.authTypes[request.id]) !== "none",
    };
  });
  return finish(operations, warnings);
}
export function sdkFromOpenApi(spec: OpenApiObject): SdkDefinition {
  const operations: SdkOperation[] = [];
  const deref = (v: unknown) => object(localReferenceValue(spec, v));
  for (const path of Object.keys(object(spec.paths)).sort()) {
    const item = deref(object(spec.paths)[path]);
    for (const method of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
      if (!item[method]) continue;
      const operation = deref(item[method]);
      const own = (Array.isArray(operation.parameters) ? operation.parameters : []).map(deref),
        shared = (Array.isArray(item.parameters) ? item.parameters : []).map(deref);
      const parameters = [
        ...shared.filter((p) => !own.some((o) => o.name === p.name && o.in === p.in)),
        ...own,
      ];
      const query: SdkOperation["query"] = Object.create(null);
      for (const p of parameters)
        if (p.in === "query" && typeof p.name === "string")
          query[p.name] = { type: structuralType(p.schema ?? p, spec), required: p.required === true };
      const request = deref(operation.requestBody),
        content = object(request.content);
      const jsonKey = Object.keys(content).find((key) =>
        /(?:^application\/json$|\+json$)/i.test(key.split(";")[0]),
      );
      const json = deref(content[jsonKey ?? "application/json"]);
      const form = deref(content["application/x-www-form-urlencoded"]),
        text = deref(
          content["text/plain"] ??
            Object.entries(content).find(
              ([key]) => !/json|x-www-form-urlencoded|multipart|octet-stream/i.test(key),
            )?.[1],
        );
      const swaggerBody = parameters.find((p) => p.in === "body");
      if (parameters.some((p) => p.in === "formData"))
        throw new Error(
          "Swagger formData serialization is unsupported; use an OpenAPI 3 JSON/form schema or a raw collection request",
        );
      if (
        Object.keys(content).some((k) => /multipart|octet-stream/.test(k)) &&
        !Object.keys(json).length &&
        !Object.keys(form).length &&
        !Object.keys(text).length
      )
        throw new Error(
          `SDK operation ${method.toUpperCase()} ${path} requires an unsupported binary/multipart body`,
        );
      const bodyMode: SdkOperation["bodyMode"] =
        Object.keys(json).length || swaggerBody
          ? "json"
          : Object.keys(form).length
            ? "urlencoded"
            : Object.keys(text).length
              ? "text"
              : "none";
      const responses = object(operation.responses),
        success =
          Object.keys(responses)
            .sort()
            .find((key) => /^2\d\d$/.test(key)) ?? "default",
        response = deref(responses[success]),
        responseContent = object(response.content),
        responseJson = deref(
          responseContent["application/json"] ??
            Object.entries(responseContent).find(([key]) => /json/i.test(key))?.[1],
        );
      const schema = responseJson.schema ?? response.schema;
      const security = operation.security ?? spec.security;
      operations.push({
        name: typeof operation.operationId === "string" ? operation.operationId : method + "_" + path,
        method: method.toUpperCase(),
        path: pathOf(path),
        pathParameters: [...new Set([...path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]))],
        query,
        bodyMode,
        bodyType:
          bodyMode === "text"
            ? { kind: "string" }
            : structuralType(json.schema ?? form.schema ?? text.schema ?? swaggerBody?.schema, spec),
        responseType: structuralType(schema, spec),
        authRequired: Array.isArray(security) && security.length > 0,
      });
    }
  }
  return finish(operations, [
    "Local schema references are supported. Remote references are rejected; no network requests are made.",
    "Credentials, examples, enum literals and defaults are not embedded.",
  ]);
}
export function readSdkDefinition(text: string): SdkDefinition {
  if (Buffer.byteLength(text) > SDK_LIMITS.sourceBytes) throw new Error("SDK definition exceeds 2 MiB");
  const value = parseSpec(text);
  if (isOpenApi(value)) return sdkFromOpenApi(value);
  if (isPostmanV3(value)) {
    const converted = postmanV3ToV21(value);
    if (converted.diagnostics.some((diagnostic) => diagnostic.level === "unsupported"))
      throw new Error(
        "Postman v3 contains unsupported features; review the import diagnostics before SDK generation",
      );
    const imported = importPostmanCollection(converted.collection);
    const definition = sdkFromCollection(imported.root, imported.variables);
    if (converted.diagnostics.length)
      definition.warnings.push(
        "Postman v3 conversion omitted features; review the source import before using the client.",
      );
    return definition;
  }
  if (isPostmanCollection(value)) {
    const imported = importPostmanCollection(value);
    return sdkFromCollection(imported.root, imported.variables);
  }
  throw new Error("Expected a Postman collection or OpenAPI/Swagger JSON/YAML document");
}
