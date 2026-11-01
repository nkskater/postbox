/** Build the OpenAPI 3.1 document of the management API from the operation registry. */
import { z, type ZodType } from "zod";
import { OPERATIONS, policyKey, type Access, type Operation } from "./operations";

/** Major version, part of the compatibility contract (see docs/management-api.md). */
export const API_VERSION = 1;
/** Document version: minor for additive changes, patch for documentation-only fixes. */
export const SPEC_VERSION = "1.0.0";
export const API_VERSION_HEADER = "Postbox-API-Version";

type Json = Record<string, unknown>;
const REF = "#/components/schemas/";

/** Smallest API-key scope that satisfies an operation (account routes document their own rule). */
const KEY_SCOPE: Record<Access, string> = {
  public: "none",
  account: "read for GET, write for settings and workspace creation, full for keys and invites",
  admin: "full",
  read: "read",
  run: "run",
  write: "write",
  manage: "full",
};

function clean(value: unknown, keepClosed: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => clean(item, keepClosed));
  if (!value || typeof value !== "object") return value;
  const out: Json = {};
  for (const [key, inner] of Object.entries(value as Json)) {
    if (key === "$schema" || key === "$id") continue;
    if (key === "additionalProperties" && inner === false && !keepClosed) continue;
    out[key] = clean(inner, keepClosed);
  }
  return out;
}

function rewriteRefs(value: unknown, rename: (name: string) => string): unknown {
  return JSON.parse(
    JSON.stringify(value).replace(/#\/\$defs\/([A-Za-z0-9_]+)/g, (_m, name: string) => REF + rename(name)),
  );
}

export function buildOpenApi(operations: Operation[] = OPERATIONS): Json {
  // Named schemas are written as responses see them: complete objects that may grow new fields.
  const registry = z.toJSONSchema(z.globalRegistry, { uri: (id) => REF + id, io: "output" }) as {
    schemas: Record<string, unknown>;
  };
  const schemas: Record<string, Json> = {};
  for (const [name, schema] of Object.entries(registry.schemas)) schemas[name] = clean(schema, false) as Json;

  /** Convert a body/query schema; its named parts join `components`, renamed on a clash. */
  function convert(schema: ZodType, io: "input" | "output"): Json {
    const raw = z.toJSONSchema(schema, { io }) as Json & { $defs?: Record<string, Json> };
    const { $defs = {}, ...rest } = raw;
    const names = new Map<string, string>();
    for (const [name, def] of Object.entries($defs)) {
      const closed = rewriteRefs(clean(def, io === "input"), (ref) => ref) as Json;
      const open = rewriteRefs(clean(def, false), (ref) => ref) as Json;
      // Reuse the registered schema when the body form is the same apart from strictness.
      const same = JSON.stringify(schemas[name]) === JSON.stringify(open);
      const target = !schemas[name] || same || io === "output" ? name : `${name}Body`;
      names.set(name, target);
      schemas[target] ??= closed;
    }
    return rewriteRefs(clean(rest, io === "input"), (name) => names.get(name) ?? name) as Json;
  }

  const paths: Record<string, Record<string, Json>> = {};
  for (const operation of operations) {
    const hasId = operation.path.includes("{id}");
    const parameters: Json[] = [];
    if (hasId) parameters.push({ name: "id", in: "path", required: true, schema: { type: "string" } });
    for (const [name, query] of Object.entries(operation.query ?? {})) {
      parameters.push({
        name,
        in: "query",
        required: query.required ?? false,
        ...(query.description ? { description: query.description } : {}),
        schema: convert(query.schema, "input"),
      });
    }
    const responses: Record<string, Json> = {};
    responses[String(operation.status)] = {
      description: "Success.",
      content: operation.contentType
        ? { [operation.contentType]: { schema: { type: "string" } } }
        : operation.response
          ? { "application/json": { schema: convert(operation.response, "output") } }
          : undefined,
    };
    const failure = (description: string) => ({
      description,
      content: { "application/json": { schema: { $ref: `${REF}Error` } } },
    });
    if (operation.body || operation.query) responses["400"] = failure("Invalid input.");
    if (operation.access !== "public") {
      responses["401"] = failure("Missing or invalid credentials.");
      responses["403"] = failure("The credentials lack the required permission or key scope.");
    }
    if (hasId || operation.access === "read" || operation.access === "write" || operation.access === "manage")
      responses["404"] = failure("Not found, or not visible to the caller.");
    if (operation.id === "startRun") responses["429"] = failure("The run queue is full.");

    (paths[operation.path] ??= {})[operation.method.toLowerCase()] = {
      operationId: operation.id,
      tags: [operation.tag],
      summary: operation.summary,
      ...(operation.description ? { description: operation.description } : {}),
      parameters: parameters.length ? parameters : undefined,
      requestBody: operation.body
        ? {
            required: true,
            content: {
              "application/json": {
                schema: convert(operation.body, "input"),
                ...(operation.example === undefined ? {} : { example: operation.example }),
              },
            },
          }
        : undefined,
      responses,
      security: operation.access === "public" ? [] : undefined,
      "x-postbox-access": operation.access,
      "x-postbox-key-scope": KEY_SCOPE[operation.access],
      "x-postbox-idempotent": operation.idempotent,
      "x-postbox-policy": policyKey(operation),
    };
  }

  return JSON.parse(
    JSON.stringify({
      openapi: "3.1.0",
      info: {
        title: "Postbox management API",
        version: SPEC_VERSION,
        description:
          "Manage workspaces, collections, requests, environments, runs, schedules, webhooks and settings. " +
          `This is API version ${API_VERSION}; see the compatibility policy in docs/management-api.md. ` +
          "Clients must ignore response fields they do not know.",
        license: { name: "Same license as Postbox" },
      },
      servers: [{ url: "/" }],
      tags: [...new Set(operations.map((operation) => operation.tag))].map((name) => ({ name })),
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      paths,
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "A personal or service-account token (`pbx_…`) created in Settings.",
          },
          sessionCookie: { type: "apiKey", in: "cookie", name: "postbox_session" },
        },
        schemas,
      },
    }),
  ) as Json;
}
