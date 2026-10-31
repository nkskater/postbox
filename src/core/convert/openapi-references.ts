/** Bounded reference bundling; network access is supplied by the caller. */
import { isOpenApi, parseSpec, type OpenApiObject } from "./openapi-document";

export const OPENAPI_LIMITS = {
  maxFiles: 100,
  maxDocumentBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxFetches: 20,
  maxDepth: 80,
  maxReferenceDepth: 64,
  maxReferences: 2000,
  maxNodes: 200_000,
  maxDiagnostics: 200,
  timeoutMs: 15_000,
} as const;
export interface OpenApiFile {
  path: string;
  content: string;
}
export interface ReferenceDiagnostic {
  severity: "error" | "warning";
  code: string;
  source: string;
  path: string;
  message: string;
  target?: string;
  origin?: string;
}
export interface ReferenceSummary {
  documents: number;
  references: number;
  remoteFetches: number;
  cycles: number;
  providedFiles: number;
}
const RESOLUTION_ERROR = Symbol.for("postbox.openapi-resolution-error");
export class OpenApiResolutionError extends Error {
  constructor(public diagnostics: ReferenceDiagnostic[]) {
    super(
      diagnostics.find((d) => d.severity === "error")?.message ?? "OpenAPI references could not be resolved",
    );
    this.diagnostics = diagnostics.map((d) => ({
      ...d,
      source: displayReferenceUri(d.source),
      ...(d.target ? { target: displayReferenceUri(d.target) } : {}),
    }));
    this.name = "OpenApiResolutionError";
    Object.defineProperty(this, RESOLUTION_ERROR, { value: true });
  }
}
export function isOpenApiResolutionError(value: unknown): value is OpenApiResolutionError {
  return (
    !!value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[RESOLUTION_ERROR] === true
  );
}
export const OPENAPI_SOURCE = Symbol.for("postbox.openapi-source-uri");
export function documentSourceUrl(value: unknown, fallback?: string): string | undefined {
  const source =
    value && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[OPENAPI_SOURCE] : undefined;
  return typeof source === "string" && /^https?:\/\//.test(source) ? source : fallback;
}
export function displayReferenceUri(input: string): string {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    if (url.search) url.search = "?[query omitted]";
    return url.href;
  } catch {
    return input.slice(0, 500);
  }
}
export function normalizeBundlePath(path: string): string {
  const value = path.replaceAll("\\", "/");
  if (
    !value ||
    value.length > 2048 ||
    value.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    /[\x00-\x1f]/.test(value)
  )
    throw new Error("Bundle paths must be relative file paths");
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".."))
    throw new Error("Bundle paths cannot contain parent directory segments");
  return parts.join("/");
}
const pointerToken = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
function pointerParts(fragment: string): string[] {
  if (!fragment) return [];
  if (!fragment.startsWith("/")) throw new Error("Reference fragment is not a JSON pointer");
  return fragment
    .slice(1)
    .split("/")
    .map((part) => {
      if (/~(?![01])/g.test(part)) throw new Error("Invalid JSON pointer escape");
      return part.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}
/** Used by the synchronous converter: unresolved/missing/cyclic chains fail explicitly. */
export function localReferenceValue(spec: OpenApiObject, input: unknown): unknown {
  let value = input;
  const seen = new Set<string>();
  let count = 0;
  const annotations: OpenApiObject = Object.create(null);
  while (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "$ref")) {
    const node = value as OpenApiObject,
      ref = node.$ref;
    if (typeof ref !== "string") throw new Error("OpenAPI $ref must be a string");
    if (!ref.startsWith("#"))
      throw new Error(
        `External OpenAPI reference requires a file bundle or approved remote loading: ${displayReferenceUri(ref)}`,
      );
    if (seen.has(ref)) throw new Error(`Cyclic OpenAPI reference chain cannot be converted: ${ref}`);
    if (++count > OPENAPI_LIMITS.maxReferenceDepth)
      throw new Error("OpenAPI reference chain exceeds the depth limit");
    seen.add(ref);
    for (const [key, child] of Object.entries(node))
      if (key !== "$ref" && !Object.hasOwn(annotations, key))
        Object.defineProperty(annotations, key, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    let fragment: string;
    try {
      fragment = decodeURIComponent(ref.slice(1));
    } catch {
      throw new Error("Invalid percent encoding in OpenAPI reference");
    }
    let target: unknown = spec;
    for (const key of pointerParts(fragment)) {
      if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
        throw new Error(`Missing OpenAPI reference: ${ref}`);
      target = (target as OpenApiObject)[key];
    }
    value = target;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(annotations).length) {
    const merged = Object.assign(Object.create(null), value, annotations);
    const source = (value as Record<PropertyKey, unknown>)[OPENAPI_SOURCE];
    if (source) Object.defineProperty(merged, OPENAPI_SOURCE, { value: source });
    return merged;
  }
  return value;
}

type Mode = "api" | "schema" | "mapApi" | "mapSchema" | "unknown" | "data";
const schemaMaps = new Set(["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]);
const schemaChildren = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "contentSchema",
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
const apiMaps = new Set([
  "paths",
  "responses",
  "headers",
  "requestBodies",
  "securitySchemes",
  "securityDefinitions",
  "links",
  "callbacks",
  "pathItems",
  "content",
  "encoding",
]);
const dataFields = new Set(["example", "default", "enum", "const", "value", "security"]);
function childMode(mode: Mode, key: string, value: unknown): Mode {
  if (mode === "data") return "data";
  if (mode === "mapApi") return "api";
  if (mode === "mapSchema") return "schema";
  if (mode === "schema")
    return schemaMaps.has(key) ? "mapSchema" : schemaChildren.has(key) ? "schema" : "data";
  if (key.startsWith("x-") || dataFields.has(key)) return "data";
  if (key === "examples") return Array.isArray(value) ? "data" : "mapApi";
  if (key === "schema") return "schema";
  if (key === "schemas" || key === "definitions") return "mapSchema";
  if (key === "parameters") return Array.isArray(value) ? "api" : "mapApi";
  if (apiMaps.has(key)) return "mapApi";
  if (mode === "unknown")
    return schemaMaps.has(key) ? "mapSchema" : schemaChildren.has(key) ? "schema" : "unknown";
  return "api";
}
interface Location {
  value: unknown;
  doc: string;
  path: string;
  base: string;
  parentBase: string;
  mode: Mode;
}
interface Resource {
  uri: string;
  location: Location;
}
interface ReferenceOptions {
  content?: string;
  files?: OpenApiFile[];
  entrypoint?: string;
  sourceUrl?: string;
  allowedRefOrigins?: string[];
  loadRemote?: (uri: string, signal: AbortSignal) => Promise<{ content: string; sourceUrl?: string }>;
  signal?: AbortSignal;
  limits?: Partial<Record<keyof typeof OPENAPI_LIMITS, number>>;
}

export async function bundleOpenApiReferences(options: ReferenceOptions): Promise<{
  document: OpenApiObject;
  sourceUrl?: string;
  diagnostics: ReferenceDiagnostic[];
  summary: ReferenceSummary;
}> {
  const limits: Record<keyof typeof OPENAPI_LIMITS, number> = { ...OPENAPI_LIMITS };
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    const name = key as keyof typeof OPENAPI_LIMITS;
    if (!(name in limits) || !Number.isSafeInteger(value) || value! < 1 || value! > limits[name])
      throw new Error("Reference limits may only be reduced from the defaults");
    limits[name] = value!;
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(limits.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const diagnostics: ReferenceDiagnostic[] = [],
    diagnosticKeys = new Set<string>();
  let truncated = false,
    nodes = 0,
    totalBytes = 0,
    remoteFetches = 0,
    references = 0,
    cycles = 0;
  const record = (diagnostic: ReferenceDiagnostic) => {
    const item = {
      ...diagnostic,
      source: displayReferenceUri(diagnostic.source),
      path: diagnostic.path.slice(0, 1000),
      ...(diagnostic.target ? { target: displayReferenceUri(diagnostic.target) } : {}),
    };
    const key = JSON.stringify(item);
    if (diagnosticKeys.has(key)) return;
    if (diagnostics.length >= limits.maxDiagnostics) {
      truncated = true;
      return;
    }
    diagnosticKeys.add(key);
    diagnostics.push(item);
  };
  const fail = (
    code: string,
    message: string,
    location?: Location,
    target?: string,
    origin?: string,
  ): never => {
    throw new OpenApiResolutionError([
      {
        severity: "error",
        code,
        message,
        source: location?.doc ?? options.sourceUrl ?? "postbox-bundle:///openapi.yaml",
        path: location?.path ?? "",
        ...(target ? { target } : {}),
        ...(origin ? { origin } : {}),
      },
    ]);
  };
  const deadline = Date.now() + limits.timeoutMs;
  const budget = () => {
    if (signal.aborted || Date.now() >= deadline)
      fail("time-limit", "OpenAPI reference resolution was cancelled or exceeded its time limit");
    if (++nodes > limits.maxNodes) fail("node-limit", "OpenAPI reference graph exceeds the node limit");
  };
  const allowed = new Set<string>();
  for (const input of options.allowedRefOrigins ?? []) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      fail("invalid-origin", "Approved reference origins must be HTTP(S) origins");
    }
    if (
      !["http:", "https:"].includes(url!.protocol) ||
      url!.username ||
      url!.password ||
      url!.pathname !== "/" ||
      url!.search ||
      url!.hash
    )
      fail("invalid-origin", "Approved reference origins must contain only scheme, host and optional port");
    allowed.add(url!.origin);
  }
  const uri = (value: string, base?: string) => {
    try {
      const url = new URL(value, base);
      if (url.username || url.password)
        fail("url-credentials", "Credentials in reference URLs are not allowed", undefined, url.href);
      return url;
    } catch (error) {
      if (isOpenApiResolutionError(error)) throw error;
      return fail("invalid-reference", "Invalid reference URI", undefined, value);
    }
  };
  const withoutFragment = (url: URL) => {
    const copy = new URL(url);
    copy.hash = "";
    return copy.href;
  };
  const supplied = new Map<string, string>(),
    documents = new Map<string, unknown>(),
    resources = new Map<string, Resource>(),
    anchors = new Map<string, Location>(),
    locations = new WeakMap<object, Location>();
  const entry = options.entrypoint ? normalizeBundlePath(options.entrypoint) : "openapi.yaml";
  const files = options.files ?? [];
  if (files.length > limits.maxFiles) fail("file-limit", `OpenAPI bundle exceeds ${limits.maxFiles} files`);
  const normalized = new Map<string, string>();
  for (const file of files) {
    const path = normalizeBundlePath(file.path);
    if (normalized.has(path)) fail("duplicate-file", `Duplicate bundle path: ${path}`);
    normalized.set(path, file.content);
  }
  if (files.length && !normalized.has(entry))
    fail("missing-entrypoint", "Choose an entrypoint present in the uploaded bundle");
  const source = options.sourceUrl
    ? uri(options.sourceUrl).href
    : `postbox-bundle:///${entry.split("/").map(encodeURIComponent).join("/")}`;
  if (!["http:", "https:", "postbox-bundle:"].includes(new URL(source).protocol))
    fail("unsupported-source", "Source URL must be an HTTP(S) URL");
  const rootUri = withoutFragment(new URL(source));
  const relativePath = (path: string) => {
    const from = entry.split("/").slice(0, -1),
      to = path.split("/");
    while (from.length && to.length && from[0] === to[0]) {
      from.shift();
      to.shift();
    }
    return [...from.map(() => ".."), ...to.map(encodeURIComponent)].join("/");
  };
  const charge = (content: string, where: string) => {
    const size = Buffer.byteLength(content, "utf8");
    if (size > limits.maxDocumentBytes)
      fail("document-size", `OpenAPI document exceeds ${limits.maxDocumentBytes} bytes`, undefined, where);
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) fail("total-size", "OpenAPI bundle exceeds the total byte limit");
  };
  if (files.length)
    for (const [path, content] of normalized) {
      const location =
        path === entry
          ? rootUri
          : options.sourceUrl
            ? uri(relativePath(path), rootUri).href
            : `postbox-bundle:///${path.split("/").map(encodeURIComponent).join("/")}`;
      charge(content, location);
      if (supplied.has(location))
        fail("duplicate-source", "Bundle files map to the same source URI", undefined, location);
      supplied.set(location, content);
    }
  else {
    if (options.content === undefined) fail("missing-source", "OpenAPI content or files are required");
    charge(options.content!, rootUri);
    supplied.set(rootUri, options.content!);
  }
  const safeClone = (value: unknown, depth = 0, parents = new Set<object>()): unknown => {
    budget();
    if (depth > limits.maxDepth) fail("depth-limit", "OpenAPI document exceeds the nesting limit");
    if (!value || typeof value !== "object") return value;
    if (parents.has(value))
      fail("yaml-cycle", "YAML object cycles are not supported; use explicit $ref references");
    const next = new Set(parents);
    next.add(value);
    if (Array.isArray(value)) return value.map((child) => safeClone(child, depth + 1, next));
    const result: OpenApiObject = Object.create(null);
    for (const [key, child] of Object.entries(value)) result[key] = safeClone(child, depth + 1, next);
    return result;
  };
  let schemaIds = true;
  const register = (address: string, location: Location) => {
    const prior = resources.get(address);
    if (prior && prior.location.value !== location.value)
      fail("duplicate-id", "Multiple schemas declare the same resource identifier", location, address);
    const resource = { uri: address, location };
    resources.set(address, resource);
    return resource;
  };
  const index = (
    value: unknown,
    doc: string,
    parentBase: string,
    path: string,
    mode: Mode,
    depth = 0,
  ): void => {
    budget();
    if (depth > limits.maxDepth) fail("depth-limit", "OpenAPI document exceeds the nesting limit");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child, i) => index(child, doc, parentBase, `${path}/${i}`, mode, depth + 1));
      return;
    }
    const object = value as OpenApiObject;
    let base = parentBase;
    if (mode !== "data" && (mode === "schema" || mode === "unknown") && typeof object.$id === "string") {
      if (schemaIds) {
        const identifier = uri(object.$id, parentBase);
        if (identifier.hash)
          fail(
            "invalid-id",
            "Schema $id must not have a non-empty fragment",
            { value, doc, path, base, parentBase, mode },
            identifier.href,
          );
        base = withoutFragment(identifier);
      } else
        record({
          severity: "warning",
          code: "schema-id-ignored",
          source: doc,
          path,
          message:
            "$id is not a schema base URI in this OpenAPI version; document-relative references are used.",
        });
    }
    const location: Location = { value, doc, path, base, parentBase, mode };
    locations.set(value, location);
    if (base !== parentBase) register(base, location);
    if (mode !== "data" && (mode === "schema" || mode === "unknown") && typeof object.$anchor === "string") {
      const address = `${withoutFragment(uri(base))}#${object.$anchor}`;
      if (anchors.has(address) && anchors.get(address)!.value !== value)
        fail("duplicate-anchor", "Multiple schemas declare the same anchor", location, address);
      anchors.set(address, location);
    }
    for (const [key, child] of Object.entries(object)) {
      const next = childMode(mode, key, child);
      if (next !== "data") index(child, doc, base, `${path}/${pointerToken(key)}`, next, depth + 1);
    }
  };
  const parse = (content: string, address: string): unknown => {
    try {
      return safeClone(parseSpec(content));
    } catch (error) {
      if (isOpenApiResolutionError(error)) throw error;
      fail("invalid-document", "Cannot parse the referenced JSON/YAML document", undefined, address);
    }
  };
  const root = parse(supplied.get(rootUri)!, rootUri);
  if (!isOpenApi(root)) fail("not-openapi", "The entrypoint is not an OpenAPI/Swagger document");
  schemaIds = /^3\.[1-9]/.test(String((root as OpenApiObject).openapi));
  const addDocument = (address: string, data: unknown) => {
    if (documents.size >= limits.maxFiles)
      fail("document-limit", "OpenAPI reference graph exceeds the document limit");
    documents.set(address, data);
    const location: Location = {
      value: data,
      doc: address,
      path: "",
      base: address,
      parentBase: address,
      mode: isOpenApi(data) ? "api" : "unknown",
    };
    register(address, location);
    index(data, address, address, "", location.mode);
  };
  addDocument(rootUri, root);
  const load = async (address: string, from: Location) => {
    if (resources.has(address)) return resources.get(address)!;
    if (documents.has(address)) return resources.get(address)!;
    let content = supplied.get(address),
      final = address;
    if (content === undefined) {
      const target = uri(address);
      if (!["http:", "https:"].includes(target.protocol))
        fail(
          "missing-file",
          "Reference was not found in the supplied bundle; local filesystem access is disabled",
          from,
          address,
        );
      if (!allowed.has(target.origin))
        fail(
          "origin-not-approved",
          `Reference origin ${target.origin} is not approved`,
          from,
          address,
          target.origin,
        );
      if (!options.loadRemote)
        fail("remote-unavailable", "Remote reference loading is unavailable", from, address);
      if (remoteFetches >= limits.maxFetches)
        fail("fetch-limit", "OpenAPI reference loading exceeds the fetch limit", from, address);
      remoteFetches++;
      try {
        const loaded = await options.loadRemote!(address, signal);
        content = loaded.content;
        final = withoutFragment(uri(loaded.sourceUrl ?? address));
        const finalOrigin = new URL(final).origin;
        if (!allowed.has(finalOrigin))
          fail(
            "origin-not-approved",
            `Redirect origin ${finalOrigin} is not approved`,
            from,
            final,
            finalOrigin,
          );
      } catch (error) {
        if (isOpenApiResolutionError(error))
          throw new OpenApiResolutionError(
            error.diagnostics.map((d) => ({ ...d, source: from.doc, path: from.path })),
          );
        fail("reference-fetch", "The reference document could not be fetched", from, address);
      }
      charge(content!, final);
    }
    if (resources.has(final)) {
      const resource = resources.get(final)!;
      resources.set(address, resource);
      return resource;
    }
    const data = parse(content!, final);
    addDocument(final, data);
    const resource = resources.get(final)!;
    if (address !== final) resources.set(address, resource);
    return resource;
  };
  let namespace = "x-postbox-reference-bundle",
    suffix = 1;
  while (Object.hasOwn(root as object, namespace)) namespace = `x-postbox-reference-bundle-${++suffix}`;
  const registry: OpenApiObject = Object.create(null),
    cached = new Map<string, { name: string; state: "visiting" | "done" }>(),
    identities = new WeakMap<object, number>();
  let identity = 0;
  const locate = async (ref: string, location: Location, mode: Mode): Promise<Location> => {
    const base = mode === "schema" ? location.base : location.doc;
    const target = uri(ref, base),
      address = withoutFragment(target);
    const resource = await load(address, location);
    let fragment: string;
    try {
      fragment = decodeURIComponent(target.hash.slice(1));
    } catch {
      fail("invalid-fragment", "Reference has invalid percent encoding", location, target.href);
    }
    if (fragment! && !fragment!.startsWith("/")) {
      const anchored = anchors.get(`${resource.uri}#${fragment!}`);
      if (!anchored) fail("missing-anchor", "Reference anchor was not found", location, target.href);
      return anchored!;
    }
    let value = resource.location.value,
      currentBase = resource.location.base,
      currentPath = resource.location.path;
    let parts: string[];
    try {
      parts = pointerParts(fragment!);
    } catch {
      fail("invalid-pointer", "Reference has an invalid JSON pointer", location, target.href);
    }
    for (const key of parts!) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
        fail("missing-reference", "Reference JSON pointer was not found", location, target.href);
      currentBase = locations.get(value as object)?.base ?? currentBase;
      value = (value as OpenApiObject)[key];
      currentPath += `/${pointerToken(key)}`;
    }
    const known = value && typeof value === "object" ? locations.get(value) : undefined;
    if (value && typeof value === "object" && (!known || known.mode === "data"))
      index(value, resource.location.doc, currentBase, currentPath, mode);
    return (
      (value && typeof value === "object" ? locations.get(value) : undefined) ?? {
        value,
        doc: resource.location.doc,
        path: currentPath,
        base: currentBase,
        parentBase: currentBase,
        mode,
      }
    );
  };
  const walk = async (
    value: unknown,
    location: Location,
    mode: Mode,
    depth = 0,
    refDepth = 0,
  ): Promise<unknown> => {
    budget();
    if (depth > limits.maxDepth)
      fail("depth-limit", "OpenAPI reference graph exceeds the nesting limit", location);
    if (!value || typeof value !== "object") return value;
    if (mode === "data") return value;
    if (Array.isArray(value)) {
      const result = [];
      for (let i = 0; i < value.length; i++)
        result.push(
          await walk(value[i], { ...location, path: `${location.path}/${i}` }, mode, depth + 1, refDepth),
        );
      return result;
    }
    const node = value as OpenApiObject;
    location = locations.get(value) ?? location;
    const result: OpenApiObject = Object.create(null);
    Object.defineProperty(result, OPENAPI_SOURCE, { value: location.doc });
    for (const [key, child] of Object.entries(node))
      if (key !== "$ref" || mode === "mapApi" || mode === "mapSchema")
        result[key] = await walk(
          child,
          { ...location, path: `${location.path}/${pointerToken(key)}` },
          childMode(mode, key, child),
          depth + 1,
          refDepth,
        );
    if (mode === "mapApi" || mode === "mapSchema") return result;
    if (Object.hasOwn(node, "$dynamicRef"))
      fail(
        "unsupported-dynamic-reference",
        "Dynamic schema references require explicit static references for collection import",
        location,
      );
    if (!Object.hasOwn(node, "$ref")) return result;
    try {
      if (typeof node.$ref !== "string") fail("invalid-reference", "$ref must be a string", location);
      if (++references > limits.maxReferences)
        fail("reference-limit", "OpenAPI reference graph exceeds the reference limit", location);
      if (refDepth >= limits.maxReferenceDepth)
        fail("reference-depth", "OpenAPI references exceed the chain depth limit", location);
      const target = await locate(node.$ref as string, location, mode);
      if (
        target.value === null ||
        (typeof target.value !== "object" && typeof target.value !== "boolean") ||
        Array.isArray(target.value) ||
        (typeof target.value === "boolean" && mode !== "schema")
      )
        fail("invalid-target", "Reference target has the wrong shape for this object", location);
      const object = target.value && typeof target.value === "object" ? target.value : undefined;
      if (object && !identities.has(object)) identities.set(object, ++identity);
      const key = object ? `${identities.get(object)}:${mode}` : `${target.doc}#${target.path}:${mode}`;
      let entry = cached.get(key);
      if (entry?.state === "visiting") {
        cycles++;
        record({
          severity: "warning",
          code: "cyclic-reference",
          source: location.doc,
          path: location.path,
          target: `${target.doc}#${target.path}`,
          message: "A reference cycle was preserved. Generated request samples are depth-limited.",
        });
      }
      if (!entry) {
        entry = { name: `ref_${cached.size + 1}`, state: "visiting" };
        cached.set(key, entry);
        registry[entry.name] = null;
        registry[entry.name] = await walk(target.value, target, mode, depth + 1, refDepth + 1);
        entry.state = "done";
      }
      const rewritten = `#/${pointerToken(namespace)}/${entry.name}`;
      if (
        mode === "schema" &&
        Object.keys(result).some((k) => !["$id", "$anchor", "description", "title", "summary"].includes(k))
      ) {
        if (schemaIds) {
          const wrapper: OpenApiObject = { allOf: [{ $ref: rewritten }, result] };
          for (const k of ["example", "default", "description", "title"])
            if (Object.hasOwn(result, k)) wrapper[k] = result[k];
          return wrapper;
        }
        record({
          severity: "warning",
          code: "reference-siblings-ignored",
          source: location.doc,
          path: location.path,
          message: "Reference siblings are ignored by this OpenAPI version.",
        });
        return { $ref: rewritten };
      }
      result.$ref = rewritten;
      return result;
    } catch (error) {
      if (!isOpenApiResolutionError(error)) throw error;
      error.diagnostics.forEach(record);
      result.$ref = node.$ref;
      return result;
    }
  };
  let document: OpenApiObject;
  try {
    document = (await walk(root, resources.get(rootUri)!.location, "api")) as OpenApiObject;
  } catch (error) {
    if (!isOpenApiResolutionError(error)) throw error;
    error.diagnostics.forEach(record);
    document = Object.create(null);
  }
  if (truncated)
    diagnostics[limits.maxDiagnostics - 1] = {
      severity: "error",
      code: "diagnostics-truncated",
      source: displayReferenceUri(rootUri),
      path: "",
      message: "Additional diagnostics were omitted; resolve the reported errors before retrying.",
    };
  if (diagnostics.some((d) => d.severity === "error")) throw new OpenApiResolutionError(diagnostics);
  if (Object.keys(registry).length) document[namespace] = registry;
  return {
    document,
    sourceUrl: /^https?:/.test(rootUri) ? rootUri : undefined,
    diagnostics,
    summary: {
      documents: documents.size,
      references,
      remoteFetches,
      cycles,
      providedFiles: files.length || 1,
    },
  };
}
