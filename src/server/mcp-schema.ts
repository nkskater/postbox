/** Compact discovery schemas only. The original Zod schemas still validate every invocation. */
type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const ARRAYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const CHILDREN = new Set([
  "items",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "additionalItems",
  "unevaluatedItems",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

/** Visit schema nodes, never data in enum, const, defaults or examples, or property-name maps. */
function children(schema: Schema, visit: (schema: Schema, property?: string) => Schema): Schema {
  const out: Schema = {};
  for (const [name, value] of Object.entries(schema)) {
    if (MAPS.has(name) && object(value))
      out[name] = Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          object(item) ? visit(item, name === "properties" ? key : undefined) : item,
        ]),
      );
    else if ((ARRAYS.has(name) || name === "items") && Array.isArray(value))
      out[name] = value.map((item) => (object(item) ? visit(item) : item));
    else if (CHILDREN.has(name) && object(value)) out[name] = visit(value);
    else out[name] = value;
  }
  return out;
}
function discriminators(schema: Schema, name: string): string[] {
  const values = new Set<string>();
  const scan = (node: Schema): Schema => {
    const field = object(node.properties) ? node.properties[name] : undefined;
    if (object(field)) {
      if (typeof field.const === "string") values.add(field.const);
      if (Array.isArray(field.enum))
        for (const value of field.enum) if (typeof value === "string") values.add(value);
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(node[key])) for (const item of node[key]) if (object(item)) scan(item);
    }
    return node;
  };
  scan(schema);
  return [...values];
}
function slim(schema: Schema, property = ""): Schema {
  if (property === "auth" || property === "body") {
    const field = property === "auth" ? "type" : "mode";
    const choices = discriminators(schema, field);
    if (choices.length)
      return {
        type: "object",
        properties: { [field]: { type: "string", enum: choices } },
        required: [field],
        additionalProperties: true,
        description:
          property === "auth"
            ? "Authentication type plus provider fields; validated server-side."
            : "Body mode plus fields: raw/language, urlencoded/formdata rows, graphql query/variables/operationName, or protocol-specific fields; validated server-side.",
      };
  }
  const out = children(schema, slim);
  if (
    typeof out.description === "string" &&
    out.description.toLowerCase().replace(/[^a-z0-9]/g, "") ===
      property.toLowerCase().replace(/[^a-z0-9]/g, "")
  )
    delete out.description;
  return out;
}

// MCP's implicit dialect is 2020-12. Normalize the SDK's draft-07 tuple/dependency
// keywords before omitting its repeated dialect declaration.
function modern(schema: Schema): Schema {
  const out = children(schema, modern);
  if (Array.isArray(out.items)) {
    out.prefixItems = out.items;
    out.items = out.additionalItems ?? true;
    delete out.additionalItems;
  }
  if (object(out.dependencies)) {
    const required: Schema = {},
      dependent: Schema = {};
    for (const [key, value] of Object.entries(out.dependencies)) {
      if (Array.isArray(value)) required[key] = value;
      else dependent[key] = object(value) ? modern(value) : value;
    }
    if (Object.keys(required).length) out.dependentRequired = required;
    if (Object.keys(dependent).length) out.dependentSchemas = dependent;
    delete out.dependencies;
  }
  delete out.title;
  return out;
}

export function compactMcpSchema(input: Schema): Schema {
  const root = modern(slim(input));
  if (
    root.$schema === "http://json-schema.org/draft-07/schema#" ||
    root.$schema === "https://json-schema.org/draft/2020-12/schema"
  )
    delete root.$schema;
  const counts = new Map<string, number>();
  const collect = (node: Schema): Schema => {
    const key = JSON.stringify(node);
    if (key.length >= 180) counts.set(key, (counts.get(key) ?? 0) + 1);
    children(node, collect);
    return node;
  };
  collect(root);
  const definitions: Schema = {};
  const existing = object(root.$defs) ? root.$defs : {};
  const references = new Map<string, string>();
  const visit = (node: Schema): Schema => {
    const key = JSON.stringify(node);
    if ((counts.get(key) ?? 0) > 1) {
      let name = references.get(key);
      if (!name) {
        let suffix = references.size;
        while (Object.hasOwn(existing, `s${suffix}`) || Object.hasOwn(definitions, `s${suffix}`)) suffix++;
        name = `s${suffix}`;
        references.set(key, name);
        definitions[name] = children(node, visit);
      }
      return { $ref: `#/$defs/${name}` };
    }
    return children(node, visit);
  };
  const result = children(root, visit);
  if (Object.keys(definitions).length) result.$defs = { ...existing, ...definitions };
  return result;
}
