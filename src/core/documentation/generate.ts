import type { AuthConfig, BodyConfig, FolderNode, KeyValue, RequestNode, Variable } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import {
  authCredentialValues,
  credentialRedactionValues,
  redactSensitiveFields,
  sensitiveFieldValues,
} from "../retention";
import { redactStoredValue } from "../variables/resolver";
import { DOCUMENTATION_LIMITS as limits, type DocumentationSnapshot } from "./model";

const sensitiveName = /authorization|cookie|token|password|secret|api[-_]?key|credential/i;

/** Known values for sanitizing publication metadata with the same rules as its snapshot. */
export function documentationRedactions(
  root: FolderNode,
  variables: Variable[],
  additionalSecrets: string[] = [],
): string[] {
  const allSecrets = [
    ...additionalSecrets,
    ...variables.filter((v) => v.type === "secret").map((v) => v.value),
  ];
  let gathered = 0;
  const gather = (node: FolderNode | RequestNode, depth = 0) => {
    if (depth > limits.depth) throw new Error("Documentation exceeds folder depth 32");
    if (node.kind === "request" && ++gathered > limits.requests)
      throw new Error("Documentation exceeds 500 requests");
    allSecrets.push(...authCredentialValues(node.auth));
    if (node.kind === "request")
      for (const [key, value] of new URLSearchParams(node.url.split("?")[1]?.split("#")[0] ?? ""))
        if (sensitiveName.test(key)) allSecrets.push(value);
    if (node.kind === "folder") node.children.forEach((child) => gather(child, depth + 1));
  };
  gather(root);
  allSecrets.push(...sensitiveFieldValues(root));
  return credentialRedactionValues(allSecrets);
}

/** Build a whitelist snapshot. No scripts, credentials, uploads, settings or original example requests survive. */
export function generateDocumentation(
  root: FolderNode,
  variables: Variable[],
  additionalSecrets: string[] = [],
): DocumentationSnapshot {
  const secrets = documentationRedactions(root, variables, additionalSecrets);
  const omissions = new Set<string>([
    "Credentials, variable values, scripts, request settings and upload bytes are omitted. Descriptions are displayed as text.",
  ]);
  const clean = (value: string, max = limits.text) => {
    const safe = redactStoredValue(redactSensitiveFields(value), secrets);
    if (safe.length > max) {
      omissions.add("Long descriptions/values and bodies were truncated for documentation.");
      return safe.slice(0, max) + "\n[TRUNCATED]";
    }
    return safe;
  };
  const safeUrl = (url: string) => {
    let value = url.replace(/(\/\/)[^/@\s]+@/g, "$1[REDACTED]@");
    const index = value.indexOf("?");
    if (index >= 0) {
      const tail = value.slice(index + 1);
      const hash = tail.indexOf("#");
      const query = new URLSearchParams(hash >= 0 ? tail.slice(0, hash) : tail);
      for (const key of [...query.keys()]) if (sensitiveName.test(key)) query.set(key, "[REDACTED]");
      value =
        value.slice(0, index + 1) +
        query
          .toString()
          .replace(/%7B%7B/gi, "{{")
          .replace(/%7D%7D/gi, "}}") +
        (hash >= 0 ? tail.slice(hash) : "");
    }
    return clean(value, 8192);
  };
  const kv = (rows: KeyValue[]) => {
    if (rows.length > 200) omissions.add("Parameter/header lists are limited to their first 200 fields.");
    return rows.slice(0, 200).map((row) => ({
      key: clean(row.key, 300),
      value: sensitiveName.test(row.key) ? "[REDACTED]" : clean(row.value, 4096),
      enabled: row.enabled,
      ...(row.description ? { description: clean(row.description) } : {}),
    }));
  };
  const body = (value: BodyConfig): BodyConfig => {
    switch (value.mode) {
      case "raw":
        return { mode: "raw", raw: clean(value.raw, limits.body), language: value.language };
      case "urlencoded":
        return { mode: "urlencoded", urlencoded: kv(value.urlencoded) };
      case "graphql":
        return {
          mode: "graphql",
          graphql: {
            query: clean(value.graphql.query, limits.body),
            variables: clean(value.graphql.variables, limits.body),
            operationName: clean(value.graphql.operationName ?? ""),
          },
        };
      case "formdata":
        return {
          mode: "formdata",
          formdata: kv(value.formdata.filter((field) => field.type !== "file")).map((field) => ({
            ...field,
            type: "text" as const,
          })),
        };
      default:
        return { mode: "none" };
    }
  };
  const authTypes: Record<string, string> = Object.create(null);
  let requests = 0;
  const copy = (
    node: FolderNode | RequestNode,
    inheritedAuth = "none",
    inheritedHeaders: KeyValue[] = [],
  ): FolderNode | RequestNode => {
    const auth = node.auth.type === "inherit" ? inheritedAuth : node.auth.type;
    const fields = {
      id: node.id,
      name: clean(node.name, 300),
      description: clean(node.description ?? ""),
      auth: { type: "none" } as AuthConfig,
      headers: kv(node.headers),
      preRequestScript: "",
      testScript: "",
    };
    const merged = new Map(inheritedHeaders.map((header) => [header.key.toLowerCase(), header]));
    for (const header of fields.headers) merged.set(header.key.toLowerCase(), header);
    if (node.kind === "folder")
      return {
        ...fields,
        kind: "folder",
        headers: [],
        children: node.children.map((child) => copy(child, auth, [...merged.values()])),
      };
    if (++requests > limits.requests) throw new Error("Documentation exceeds 500 requests");
    authTypes[node.id] = auth;
    if ((node.examples?.length ?? 0) > 5)
      omissions.add("Only the first five examples per request are included.");
    return {
      ...fields,
      kind: "request",
      headers: [...merged.values()],
      method: node.method,
      url: safeUrl(node.url),
      params: kv(node.params),
      body: body(node.body),
      settings: { ...DEFAULT_SETTINGS },
      examples: (node.examples ?? []).slice(0, 5).map((example) => {
        const omitted = example.bodyOmitted || example.bodyEncoding === "base64";
        const content = omitted ? "" : clean(example.body, limits.body);
        return {
          id: example.id,
          name: clean(example.name, 300),
          status: example.status,
          statusText: clean(example.statusText, 300),
          headers: kv(example.headers),
          body: content,
          createdAt: example.createdAt,
          ...(omitted ? { bodyOmitted: true } : {}),
          ...(example.truncated || example.body.length > limits.body ? { truncated: true } : {}),
        };
      }),
    };
  };
  const snapshot: DocumentationSnapshot = {
    root: copy(root) as FolderNode,
    variables: variables
      .filter((v) => v.key)
      .map((v) => ({ key: clean(v.key, 300), type: v.type, enabled: v.enabled })),
    authTypes,
    omissions: [...omissions],
  };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > limits.bytes)
    throw new Error("Documentation exceeds 2 MiB; reduce the collection or large examples");
  return snapshot;
}
