/**
 * GraphQL schema helpers shared by the server (introspection) and the editor
 * (browsing, validation, operation selection). No network access here.
 */
import {
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  GraphQLError,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  parse,
  validate,
  type GraphQLSchema,
  type IntrospectionQuery,
  Kind,
} from "graphql";

export const INTROSPECTION_QUERY = getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true });

/** Build a schema from an introspection result (`{ data }` or the bare data) or from SDL text. */
export function schemaFromSource(source: string | object): GraphQLSchema {
  if (typeof source === "string") {
    const text = source.trim();
    if (text.startsWith("{")) return schemaFromSource(JSON.parse(text) as object);
    return buildSchema(text);
  }
  const value = source as { data?: IntrospectionQuery; __schema?: unknown };
  const data = (value.data ?? value) as IntrospectionQuery;
  if (!data || typeof data !== "object" || !("__schema" in data))
    throw new Error("Not a GraphQL introspection result (missing __schema)");
  return buildClientSchema(data);
}

/** Explain a failed introspection response; servers often disable it in production. */
export function introspectionFailure(status: number, body: string): string {
  let messages: string[] = [];
  try {
    const parsed = JSON.parse(body) as { errors?: { message?: string }[] };
    messages = (parsed.errors ?? []).map((e) => String(e.message ?? "")).filter(Boolean);
  } catch {
    // Non-JSON responses are described by status below.
  }
  const joined = messages.join("; ");
  if (/introspection/i.test(joined))
    return `Introspection is disabled on this server (${joined}). Load the schema from an SDL or JSON file instead.`;
  if (joined) return `Introspection failed: ${joined}`;
  return `Introspection failed (HTTP ${status})${status === 401 || status === 403 ? "; check the request's authorization" : ""}`;
}

export interface QueryProblem {
  message: string;
  line?: number;
  column?: number;
}

/** Syntax errors always; schema validation errors when a schema is known. */
export function validateQuery(query: string, schema?: GraphQLSchema | null): QueryProblem[] {
  if (!query.trim()) return [];
  const toProblem = (e: GraphQLError): QueryProblem => ({
    message: e.message,
    ...(e.locations?.[0] ? { line: e.locations[0].line, column: e.locations[0].column } : {}),
  });
  let doc;
  try {
    doc = parse(query);
  } catch (err) {
    return [toProblem(err as GraphQLError)];
  }
  return schema ? validate(schema, doc).map(toProblem) : [];
}

export interface OperationInfo {
  name: string | null;
  type: "query" | "mutation" | "subscription";
}

/** Operations in a document, in order; unparseable documents have none. */
export function listOperations(query: string): OperationInfo[] {
  try {
    return parse(query).definitions.flatMap((d) =>
      d.kind === Kind.OPERATION_DEFINITION ? [{ name: d.name?.value ?? null, type: d.operation }] : [],
    );
  } catch {
    return [];
  }
}

export interface TypeSummary {
  name: string;
  kind: "object" | "interface" | "input" | "enum" | "scalar" | "union";
  description?: string;
  fields: { name: string; type: string; args: string[]; description?: string; deprecated?: string }[];
  values?: string[];
  members?: string[];
}

/** Flatten a schema for browsing: root types first, then user types alphabetically; built-ins hidden. */
export function summarizeSchema(schema: GraphQLSchema): {
  roots: Record<string, string>;
  types: TypeSummary[];
} {
  const roots: Record<string, string> = {};
  const q = schema.getQueryType();
  const m = schema.getMutationType();
  const s = schema.getSubscriptionType();
  if (q) roots.query = q.name;
  if (m) roots.mutation = m.name;
  if (s) roots.subscription = s.name;
  const rootNames = Object.values(roots);
  const types = Object.values(schema.getTypeMap())
    .filter((t) => !t.name.startsWith("__"))
    .map((t): TypeSummary => {
      const base = { name: t.name, ...(t.description ? { description: t.description } : {}) };
      if (isObjectType(t) || isInterfaceType(t) || isInputObjectType(t)) {
        const fields = Object.values(t.getFields()).map((f) => ({
          name: f.name,
          type: String(f.type),
          args:
            "args" in f
              ? f.args.map((a: { name: string; type: unknown }) => `${a.name}: ${String(a.type)}`)
              : [],
          ...(f.description ? { description: f.description } : {}),
          ...("deprecationReason" in f && f.deprecationReason ? { deprecated: f.deprecationReason } : {}),
        }));
        return {
          ...base,
          kind: isObjectType(t) ? "object" : isInterfaceType(t) ? "interface" : "input",
          fields,
        };
      }
      if ("getValues" in t)
        return { ...base, kind: "enum", fields: [], values: t.getValues().map((v) => v.name) };
      if ("getTypes" in t)
        return { ...base, kind: "union", fields: [], members: t.getTypes().map((u) => u.name) };
      return { ...base, kind: "scalar", fields: [] };
    })
    .filter((t) => t.kind !== "scalar" || !["String", "Int", "Float", "Boolean", "ID"].includes(t.name))
    .sort((a, b) => {
      const ra = rootNames.indexOf(a.name);
      const rb = rootNames.indexOf(b.name);
      if (ra !== -1 || rb !== -1) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
      return a.name.localeCompare(b.name);
    });
  return { roots, types };
}
