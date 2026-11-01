import Ajv, { type ValidateFunction } from "ajv";
import type { RequestDef, ResponseExample } from "../types";
import { contractSchema, type ContractDiagnostic, type JsonSchema, type RequestContract } from "./model";

// No remote resolution, custom code, formats or regular expressions. Local references are allowed.
const keywords = new Set([
  "$ref",
  "$defs",
  "definitions",
  "$schema",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
]);
function inspect(schema: unknown, depth = 0, budget = { left: 512 }): void {
  if (depth > 32 || --budget.left < 0) throw new Error("Schema exceeds depth or node limit");
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("Expected a JSON Schema object or boolean");
  for (const [key, value] of Object.entries(schema)) {
    if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    if (key === "$ref" && (typeof value !== "string" || !value.startsWith("#/")))
      throw new Error("Only local #/ schema references are supported");
    if (["properties", "$defs", "definitions"].includes(key)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${key}`);
      for (const child of Object.values(value)) inspect(child, depth + 1, budget);
    } else if (["items", "additionalProperties", "not"].includes(key)) inspect(value, depth + 1, budget);
    else if (["allOf", "anyOf", "oneOf"].includes(key)) {
      if (!Array.isArray(value) || value.length > 32) throw new Error(`Invalid ${key}`);
      value.forEach((child) => inspect(child, depth + 1, budget));
    }
  }
}
const cache = new Map<string, ValidateFunction>();
function compile(schema: JsonSchema, coerce = false): ValidateFunction {
  const key = `${coerce}:${JSON.stringify(schema)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  inspect(schema);
  const ajv = new Ajv({
    strict: false,
    allErrors: false,
    coerceTypes: coerce,
    ownProperties: true,
    validateFormats: false,
    addUsedSchema: false,
  });
  const validate = ajv.compile(schema);
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, validate);
  return validate;
}
export function parseContract(value: unknown): RequestContract {
  const contract = contractSchema.parse(value);
  for (const parameter of contract.parameters) compile(parameter.schema, true);
  if (contract.requestBody !== undefined) compile(contract.requestBody);
  if (contract.responseBody !== undefined) compile(contract.responseBody);
  return contract;
}
const templates = (value: string) => /\{\{[^{}]+\}\}/.test(value);
const diagnostic = (
  location: string,
  status: ContractDiagnostic["status"],
  message: string,
): ContractDiagnostic => ({ location, status, message });
function check(location: string, schema: JsonSchema, value: unknown, coerce = false): ContractDiagnostic {
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).length > 1024 * 1024)
      return diagnostic(location, "deferred", "Value exceeds the 1 MiB validation limit");
    // Bound nested input before handing it to a potentially recursive schema.
    const bounded = (v: unknown, depth = 0): boolean =>
      depth <= 64 &&
      (!v || typeof v !== "object" || Object.values(v).every((child) => bounded(child, depth + 1)));
    if (!bounded(value)) return diagnostic(location, "deferred", "Value exceeds the validation depth limit");
    const validate = compile(schema, coerce);
    if (validate(value)) return diagnostic(location, "passed", "Matches schema");
    const error = validate.errors?.[0];
    // No observed values or enum literals are included in diagnostics.
    return diagnostic(
      location +
        (error?.instancePath ?? "") +
        (error?.keyword === "required"
          ? `/${error.params.missingProperty}`
          : error?.keyword === "additionalProperties"
            ? `/${error.params.additionalProperty}`
            : ""),
      "error",
      `Must satisfy ${error?.keyword ?? "schema"}; review this field's declared constraints`,
    );
  } catch {
    return diagnostic(
      location,
      "error",
      "Invalid schema; review its local references and supported keywords",
    );
  }
}
function jsonBody(location: string, schema: JsonSchema, body: string | undefined): ContractDiagnostic {
  if (body && templates(body))
    return diagnostic(location, "deferred", "Unresolved template; validate after variable resolution");
  if (!body) return diagnostic(location, "error", "A JSON body is required by this schema");
  if (new TextEncoder().encode(body).length > 1024 * 1024)
    return diagnostic(location, "deferred", "Body exceeds the 1 MiB validation limit");
  try {
    return check(location, schema, JSON.parse(body));
  } catch {
    return diagnostic(location, "error", "Body must be valid JSON");
  }
}
export interface ContractRequest {
  url: string;
  headers: [string, string][];
  body?: string;
}
export function validateContractRequest(
  contract: RequestContract,
  request: ContractRequest,
): ContractDiagnostic[] {
  const output: ContractDiagnostic[] = [];
  let url: URL | undefined;
  try {
    url = new URL(request.url.replace(/\{\{[^{}]+\}\}/g, "__UNRESOLVED__"));
  } catch {
    /* Draft URL may be incomplete. */
  }
  const pathValues: Record<string, string> = Object.create(null);
  if (contract.pathTemplate && url) {
    const pattern = contract.pathTemplate.split("/");
    const actual = url.pathname.split("/");
    const matches =
      pattern.length === actual.length &&
      pattern.every((part, i) => /^\{[^{}]+\}$/.test(part) || part === actual[i]);
    if (!matches && templates(request.url))
      output.push(
        diagnostic("request.path", "deferred", "Unresolved URL; validate after variable resolution"),
      );
    else if (!matches) output.push(diagnostic("request.path", "error", "Path must match pathTemplate"));
    else
      pattern.forEach((part, i) => {
        if (/^\{[^{}]+\}$/.test(part)) {
          try {
            pathValues[part.slice(1, -1)] = decodeURIComponent(actual[i]);
          } catch {
            pathValues[part.slice(1, -1)] = actual[i];
          }
        }
      });
  }
  for (const parameter of contract.parameters) {
    const location = `request.${parameter.in}.${parameter.name}`;
    const values =
      parameter.in === "header"
        ? request.headers
            .filter(([name]) => name.toLowerCase() === parameter.name.toLowerCase())
            .map(([, value]) => value)
        : parameter.in === "query"
          ? (url?.searchParams.getAll(parameter.name) ?? [])
          : Object.hasOwn(pathValues, parameter.name)
            ? [pathValues[parameter.name]]
            : [];
    const unknownUrl = parameter.in !== "header" && (!url || templates(request.url));
    if (
      (unknownUrl && !values.length) ||
      values.some((value) => templates(value) || value.includes("__UNRESOLVED__"))
    )
      output.push(
        diagnostic(location, "deferred", "Unresolved URL or template; validate after variable resolution"),
      );
    else if (!values.length) {
      if (parameter.required) output.push(diagnostic(location, "error", "Required parameter is missing"));
    } else {
      const array = typeof parameter.schema === "object" && parameter.schema.type === "array";
      if (array) output.push(check(location, parameter.schema, values, true));
      else for (const value of values) output.push(check(location, parameter.schema, value, true));
    }
  }
  if (contract.requestBody !== undefined)
    output.push(jsonBody("request.body", contract.requestBody, request.body));
  return output;
}
export function validateContractResponse(
  contract: RequestContract,
  response: { status: number; body?: string; incomplete?: boolean },
): ContractDiagnostic[] {
  const output: ContractDiagnostic[] = [];
  if (contract.responseStatus?.length)
    output.push(
      diagnostic(
        "response.status",
        contract.responseStatus.includes(response.status) ? "passed" : "error",
        contract.responseStatus.includes(response.status)
          ? "Status is allowed"
          : "Status is outside the declared allowed statuses",
      ),
    );
  if (contract.responseBody !== undefined)
    output.push(
      response.incomplete
        ? diagnostic(
            "response.body",
            "deferred",
            "Body is omitted, binary or truncated; full JSON is required",
          )
        : jsonBody("response.body", contract.responseBody, response.body),
    );
  return output;
}
export function validateDraft(request: RequestDef): ContractDiagnostic[] {
  if (!request.contract) return [];
  const contract = parseContract(request.contract);
  let url = request.url;
  try {
    const parsed = new URL(url);
    if (request.params.length) {
      parsed.search = "";
      request.params
        .filter((p) => p.enabled && p.key)
        .forEach((p) => parsed.searchParams.append(p.key, p.value));
    }
    url = parsed.toString();
  } catch {
    /* Validation reports unresolved/incomplete URLs. */
  }
  return validateContractRequest(contract, {
    url,
    headers: request.headers.filter((h) => h.enabled).map((h) => [h.key, h.value]),
    body: request.body.mode === "raw" ? request.body.raw : undefined,
  });
}
export function validateExample(contract: RequestContract, example: ResponseExample): ContractDiagnostic[] {
  return validateContractResponse(parseContract(contract), {
    status: example.status,
    body: example.body,
    incomplete: example.bodyEncoding === "base64" || example.bodyOmitted || example.truncated,
  });
}
