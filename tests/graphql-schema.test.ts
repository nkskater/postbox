import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildSchema, graphqlSync, introspectionFromSchema } from "graphql";
import {
  introspectionFailure,
  listOperations,
  schemaFromSource,
  summarizeSchema,
  validateQuery,
} from "@/core/graphql/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-graphql-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

const SDL = `
  "A user" type User { id: ID!, name: String, legacy: String @deprecated(reason: "use name") }
  enum Role { ADMIN, MEMBER }
  input NewUser { name: String! }
  union Result = User
  type Query { user(id: ID!): User, users(role: Role): [User!]! }
  type Mutation { createUser(input: NewUser!): User }
`;

describe("GraphQL schema helpers", () => {
  it("builds schemas from SDL, introspection JSON and { data } envelopes", () => {
    const fromSdl = schemaFromSource(SDL);
    const introspection = introspectionFromSchema(fromSdl);
    for (const source of [introspection, { data: introspection }, JSON.stringify({ data: introspection })])
      expect(schemaFromSource(source).getQueryType()?.name).toBe("Query");
    expect(() => schemaFromSource({ nope: true })).toThrow(/__schema/);
  });

  it("validates syntax always and fields when a schema is known", () => {
    const schema = schemaFromSource(SDL);
    expect(validateQuery("{ user(id: 1) { name } }", schema)).toEqual([]);
    expect(validateQuery("{ user(id: 1) { nmae } }", schema)[0]).toMatchObject({
      message: expect.stringMatching(/Cannot query field "nmae"/),
      line: 1,
    });
    expect(validateQuery("{ user(id: 1) { nmae } }")).toEqual([]);
    expect(validateQuery("{ user(", null)[0].message).toMatch(/Syntax Error/);
  });

  it("lists operations and summarizes types for browsing", () => {
    expect(
      listOperations(
        'query A { users { id } } mutation B { createUser(input: {name: "x"}) { id } } { users { id } }',
      ),
    ).toEqual([
      { name: "A", type: "query" },
      { name: "B", type: "mutation" },
      { name: null, type: "query" },
    ]);
    expect(listOperations("{ broken")).toEqual([]);
    const { roots, types } = summarizeSchema(schemaFromSource(SDL));
    expect(roots).toEqual({ query: "Query", mutation: "Mutation" });
    expect(types.slice(0, 2).map((t) => t.name)).toEqual(["Query", "Mutation"]);
    const user = types.find((t) => t.name === "User")!;
    expect(user).toMatchObject({ kind: "object", description: "A user" });
    expect(user.fields.find((f) => f.name === "legacy")).toMatchObject({ deprecated: "use name" });
    expect(types.find((t) => t.name === "Query")!.fields[0]).toMatchObject({
      name: "user",
      args: ["id: ID!"],
      type: "User",
    });
    expect(types.find((t) => t.name === "Role")!.values).toEqual(["ADMIN", "MEMBER"]);
    expect(types.find((t) => t.name === "Result")!.members).toEqual(["User"]);
    expect(types.some((t) => t.name === "String" || t.name.startsWith("__"))).toBe(false);
  });

  it("explains disabled introspection and auth failures", () => {
    expect(
      introspectionFailure(
        400,
        JSON.stringify({ errors: [{ message: "GraphQL introspection is not allowed" }] }),
      ),
    ).toMatch(/Introspection is disabled.*Load the schema from an SDL or JSON file/);
    expect(introspectionFailure(401, "nope")).toMatch(/HTTP 401.*authorization/);
  });
});

let schemaSdl = SDL;
let disabled = false;
const auths: (string | undefined)[] = [];
let base = "";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    auths.push(req.headers.authorization);
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer gql-secret") return res.writeHead(401).end("{}");
    if (disabled)
      return res.end(JSON.stringify({ errors: [{ message: "GraphQL introspection has been disabled" }] }));
    const { query } = JSON.parse(body);
    res.end(JSON.stringify(graphqlSync({ schema: buildSchema(schemaSdl), source: query })));
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  (await import("@/server/db")).getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/graphql/schema", () => {
  async function introspect(folderAuth = true) {
    const repo = await import("@/server/repo");
    const { POST } = await import("@/app/api/graphql/schema/route");
    const ws = repo.createWorkspace("GraphQL");
    const folder = repo.createFolder(ws.id, null, {
      name: "API",
      auth: folderAuth ? { type: "bearer", bearer: { token: "{{token}}" } } : { type: "none" },
    });
    repo.replaceVariables(ws.id, "collection", folder.id, [
      { key: "token", value: "gql-secret", type: "secret", enabled: true },
      { key: "host", value: base, type: "default", enabled: true },
    ]);
    const res = await POST(
      new Request("http://localhost/api/graphql/schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: ws.id,
          folderId: folder.id,
          request: { url: "{{host}}/graphql", method: "GET" },
        }),
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  it("introspects with the request's inherited auth and variables, and refreshes", async () => {
    const first = await introspect();
    expect(first.status).toBe(200);
    expect(auths.at(-1)).toBe("Bearer gql-secret");
    expect(schemaFromSource(first.body.introspection).getMutationType()?.name).toBe("Mutation");
    schemaSdl = SDL.replace("type Query {", "type Query { health: String,");
    const refreshed = await introspect();
    expect(Object.keys(schemaFromSource(refreshed.body.introspection).getQueryType()!.getFields())).toContain(
      "health",
    );
  });

  it("reports disabled introspection and missing auth", async () => {
    disabled = true;
    const off = await introspect();
    disabled = false;
    expect(off.status).toBe(502);
    expect(off.body.error).toMatch(/Introspection is disabled/);
    const unauth = await introspect(false);
    expect(unauth.status).toBe(502);
    expect(unauth.body.error).toMatch(/HTTP 401.*authorization/);
  });
});
