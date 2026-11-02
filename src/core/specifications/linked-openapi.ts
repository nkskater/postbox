import type { RequestDef, Variable, FolderNode } from "../types";
import { importOpenApi } from "../convert/openapi";
import { localReferenceValue } from "../convert/openapi-references";
import type { RequestContract } from "../contracts/model";
import { parseContract } from "../contracts/validate";
export type RequestProjection = Pick<
  RequestDef,
  "name" | "method" | "url" | "params" | "headers" | "body" | "auth" | "description" | "contract" | "examples"
>;
export interface LinkedOperation {
  key: string;
  operationId?: string;
  sourceRequestId?: string;
  path: string;
  method: string;
  request: RequestProjection;
}
export interface LinkedOpenApi {
  root: FolderNode;
  variables: Variable[];
  operations: LinkedOperation[];
  warnings: string[];
}
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => (!!v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
export const projectRequest = (r: RequestDef): RequestProjection => ({
  name: r.name,
  method: r.method,
  url: r.url,
  params: r.params,
  headers: r.headers,
  body: r.body,
  auth: r.auth,
  description: r.description ?? "",
  contract: r.contract ?? null,
  examples: r.examples ?? [],
});
function inlineSchema(
  spec: Obj,
  value: unknown,
  seen = new Set<unknown>(),
  depth = 0,
  warnings: string[] = [],
): unknown {
  if (depth > 30) {
    warnings.push(
      "Contract schema expansion was bounded at 30 levels; complete schemas remain in the source.",
    );
    return {};
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) {
    warnings.push(
      "Recursive schema branch is represented by an unconstrained contract node; complete references remain in the source.",
    );
    return {};
  }
  const resolved = localReferenceValue(spec, value);
  if (resolved !== value) return inlineSchema(spec, resolved, new Set([...seen, value]), depth + 1, warnings);
  if (Array.isArray(value))
    return value.map((v) => inlineSchema(spec, v, new Set([...seen, value]), depth + 1, warnings));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      inlineSchema(spec, v, new Set([...seen, value]), depth + 1, warnings),
    ]),
  );
}
export function importLinkedOpenApi(spec: Obj, sourceUrl?: string): LinkedOpenApi {
  const operations: LinkedOperation[] = [],
    keys = new Set<string>(),
    warnings: string[] = [];
  const supported = new Set(
    "$ref $defs definitions $schema title description type properties required additionalProperties items enum const minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minLength maxLength minItems maxItems minProperties maxProperties allOf anyOf oneOf not".split(
      " ",
    ),
  );
  const projectSchema = (input: unknown): unknown => {
    if (!input || typeof input !== "object") return input;
    const value = object(input),
      out: Obj = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      if (!supported.has(key)) {
        if (
          !["example", "examples", "default", "nullable", "readOnly", "writeOnly", "deprecated"].includes(
            key,
          ) &&
          warnings.length < 100
        )
          warnings.push(
            `Contract projection omits ${key}; its original definition remains in the specification.`,
          );
        continue;
      }
      if (["properties", "$defs", "definitions"].includes(key))
        out[key] = Object.fromEntries(
          Object.entries(object(child)).map(([name, schema]) => [name, projectSchema(schema)]),
        );
      else if (["items", "additionalProperties", "not"].includes(key)) out[key] = projectSchema(child);
      else if (["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(child))
        out[key] = child.map(projectSchema);
      else out[key] = child;
    }
    if (value.nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
    return out;
  };
  const schema = (value: unknown) => projectSchema(inlineSchema(spec, value, new Set(), 0, warnings));
  const collection = importOpenApi(spec, {
    sourceUrl,
    onOperation: (request, { method, path, value: operation }) => {
      const operationId = typeof operation.operationId === "string" ? operation.operationId : undefined,
        sourceRequestId =
          typeof operation["x-postbox-request-id"] === "string"
            ? (operation["x-postbox-request-id"] as string)
            : undefined;
      const key = sourceRequestId
        ? "request:" + sourceRequestId
        : operationId
          ? "operation:" + operationId
          : method.toUpperCase() + " " + path;
      if (keys.has(key)) throw Error("Duplicate operation identity " + key);
      keys.add(key);
      const item = object(object(spec.paths)[path]),
        deref = (v: unknown) => object(localReferenceValue(spec, v)),
        shared = (Array.isArray(item.parameters) ? item.parameters : []).map(deref),
        own = (Array.isArray(operation.parameters) ? operation.parameters : []).map(deref),
        parameters = [...shared.filter((p) => !own.some((o) => o.in === p.in && o.name === p.name)), ...own];
      const contract: RequestContract = {
        pathTemplate: path,
        parameters: parameters
          .filter((p) => ["query", "header", "path"].includes(String(p.in)))
          .map((p) => ({
            in: p.in as "path" | "query" | "header",
            name: String(p.name),
            required: !!p.required || p.in === "path",
            description: String(p.description ?? ""),
            schema: object(schema(p.schema ?? { type: p.type ?? "string" })),
          })),
        responseStatus: Object.keys(object(operation.responses))
          .filter((s) => /^\d{3}$/.test(s))
          .map(Number),
      };
      const body = deref(operation.requestBody),
        media = Object.values(object(body.content))[0];
      if (media && object(media).schema)
        contract.requestBody = schema(object(media).schema) as RequestContract["requestBody"];
      const bodyParameter = parameters.find((p) => p.in === "body");
      if (bodyParameter)
        contract.requestBody = schema(bodyParameter.schema) as RequestContract["requestBody"];
      for (const rawResponse of Object.values(object(operation.responses))) {
        const response = deref(rawResponse),
          responseMedia = Object.values(object(response.content))[0];
        const responseSchema = object(responseMedia).schema ?? response.schema;
        if (responseSchema) {
          contract.responseBody = schema(responseSchema) as RequestContract["responseBody"];
          break;
        }
      }
      request.examples = [];
      for (const [status, rawResponse] of Object.entries(object(operation.responses))) {
        if (!/^[1-5]\d\d$/.test(status)) continue;
        const response = deref(rawResponse);
        for (const [type, rawMedia] of Object.entries(object(response.content))) {
          const media = object(rawMedia);
          const examples = Object.entries(object(media.examples));
          if (Object.hasOwn(media, "example")) examples.push(["", { value: media.example }]);
          for (const [name, rawExample] of examples) {
            const example = deref(rawExample);
            if (!Object.hasOwn(example, "value")) continue;
            if (request.examples.length >= 100) throw Error("At most 100 response examples per request");
            const value = example.value,
              body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
            if (Buffer.byteLength(body) > 1024 * 1024) throw Error("Response example exceeds 1 MiB");
            request.examples.push({
              id: `${name ? "openapi" : "openapi-example"}:${status}:${Buffer.from(type).toString("base64url")}:${Buffer.from(name).toString("base64url")}`,
              name: String(example.summary ?? name ?? "Response").slice(0, 300) || "Response",
              status: Number(status),
              statusText: String(response.description ?? "")
                .replace(/[\r\n\0]/g, " ")
                .slice(0, 300),
              headers: [{ key: "Content-Type", value: type, enabled: true }],
              body,
              createdAt: 0,
            });
          }
        }
      }
      try {
        request.contract = parseContract(contract);
      } catch {
        warnings.push(
          `Contract projection for ${key} exceeds supported constraints; source definitions remain authoritative.`,
        );
        request.contract = parseContract({
          pathTemplate: path,
          parameters: [],
          responseStatus: contract.responseStatus,
        });
      }
      operations.push({
        key,
        operationId,
        sourceRequestId,
        path,
        method: method.toUpperCase(),
        request: projectRequest(request),
      });
    },
  });
  if (operations.length > 1000) throw Error("Linking supports at most 1,000 operations");
  return { ...collection, operations, warnings: [...new Set(warnings)].slice(0, 100) };
}
