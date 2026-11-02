import { afterAll, beforeAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserRow } from "@/server/db/schema";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-sync-api-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const users = await import("@/server/users"),
  repo = await import("@/server/repo"),
  specs = await import("@/server/specifications"),
  db = await import("@/server/db");
const { withCaller } = await import("@/server/access-context"),
  { setMember } = await import("@/server/authorize");
let owner: UserRow, viewer: UserRow, outsider: UserRow, ws: string;
const tokens: Record<string, string> = {};
const caller = (user: UserRow) => ({ kind: "user" as const, user, via: "token" as const });
beforeAll(async () => {
  owner = await users.createUser({ username: "sync-owner", password: "password123" });
  viewer = await users.createUser({ username: "sync-viewer", password: "password123" });
  outsider = await users.createUser({ username: "sync-outsider", password: "password123" });
  for (const user of [owner, viewer, outsider]) tokens[user.id] = users.createToken(user.id, "test").token;
  withCaller(caller(owner), () => {
    ws = repo.createWorkspace("Sync access").id;
    setMember(ws, viewer.username, "viewer");
  });
});
afterAll(() => {
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function request(
  method: string,
  service: "folder" | "collections" | "preview" | "apply",
  id: string,
  user: UserRow,
  body?: unknown,
) {
  const mod =
    service === "folder"
      ? await import("@/app/api/folders/[id]/specification/route")
      : service === "collections"
        ? await import("@/app/api/specifications/[id]/collections/route")
        : service === "preview"
          ? await import("@/app/api/specifications/[id]/sync/preview/route")
          : await import("@/app/api/specifications/[id]/sync/apply/route");
  const url =
    service === "folder"
      ? `/api/folders/${id}/specification`
      : service === "collections"
        ? `/api/specifications/${id}/collections`
        : `/api/specifications/${id}/sync/${service}`;
  return (
    mod as Record<string, (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>>
  )[method](
    new Request("http://localhost" + url, {
      method,
      headers: { authorization: `Bearer ${tokens[user.id]}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
describe("synchronization REST authorization", () => {
  it("allows read-only previews but requires write scope for creation, application and unlink", async () => {
    const spec = withCaller(caller(owner), () =>
      specs.createSpecification({
        workspaceId: ws,
        name: "API",
        format: "openapi",
        entrypoint: "api.json",
        files: [
          {
            path: "api.json",
            content: JSON.stringify({
              openapi: "3.0.3",
              info: { title: "API", version: "1" },
              paths: { "/health": { get: { responses: { "200": { description: "OK" } } } } },
            }),
          },
        ],
      }),
    );
    expect((await request("POST", "collections", spec.id, viewer, {})).status).toBe(403);
    expect((await request("POST", "collections", spec.id, outsider, {})).status).toBe(404);
    const response = await request("POST", "collections", spec.id, owner, {});
    expect(response.status, await response.clone().text()).toBe(201);
    const col = await response.json();
    expect((await request("GET", "folder", col.id, viewer)).status).toBe(200);
    const preview = await request("POST", "preview", spec.id, viewer, {
      folderId: col.id,
      direction: "collection",
    });
    expect(preview.status).toBe(200);
    const p = await preview.json();
    expect(
      (
        await request("POST", "apply", spec.id, viewer, {
          folderId: col.id,
          direction: "collection",
          token: p.token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("POST", "apply", spec.id, owner, {
          folderId: col.id,
          direction: "collection",
          token: p.token,
        })
      ).status,
    ).toBe(200);
    expect((await request("DELETE", "folder", col.id, viewer)).status).toBe(403);
    expect((await request("DELETE", "folder", col.id, owner)).status).toBe(200);
    expect(await (await request("GET", "folder", col.id, owner)).json()).toBeNull();
  });
  it("rejects linking non-HTTP specifications and unrelated collections, and validates tokens", async () => {
    const spec = withCaller(caller(owner), () =>
      specs.createSpecification({
        workspaceId: ws,
        name: "GraphQL",
        format: "graphql",
        entrypoint: "schema.graphql",
        files: [{ path: "schema.graphql", content: "type Query { health: String }" }],
      }),
    );
    expect((await request("POST", "collections", spec.id, owner, {})).status).toBe(400);
    const folder = withCaller(caller(owner), () => repo.createFolder(ws, null, { name: "Generated" }));
    withCaller(caller(owner), () =>
      repo.createRequest(ws, folder.id, { name: "Health", url: "https://example.test/health" }),
    );
    expect((await request("POST", "folder", folder.id, viewer, {})).status).toBe(403);
    const generated = await request("POST", "folder", folder.id, owner, {});
    expect(generated.status, await generated.clone().text()).toBe(201);
    const doc = await generated.json();
    expect((await request("POST", "folder", folder.id, owner, {})).status).toBe(409);
    const unrelated = withCaller(caller(owner), () => repo.createFolder(ws, null));
    expect(
      (await request("POST", "preview", doc.id, owner, { folderId: unrelated.id, direction: "collection" }))
        .status,
    ).toBe(404);
    expect(
      (
        await request("POST", "apply", doc.id, owner, {
          folderId: folder.id,
          direction: "collection",
          token: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
  });
});
