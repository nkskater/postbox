import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { UserRow } from "@/server/db/schema";
import type { Caller } from "@/server/caller";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-svc-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { getSqlite } = await import("@/server/db");
const { proxy, keyLimiter } = await import("@/proxy");
const workspacesRoute = await import("@/app/api/workspaces/route");
const workspaceRoute = await import("@/app/api/workspaces/[id]/route");
const accountsRoute = await import("@/app/api/admin/service-accounts/route");
const accountTokensRoute = await import("@/app/api/admin/service-accounts/[id]/tokens/route");
const adminTokenRoute = await import("@/app/api/admin/tokens/[id]/route");
const adminRotateRoute = await import("@/app/api/admin/tokens/[id]/rotate/route");
const myTokensRoute = await import("@/app/api/me/tokens/route");
const myRotateRoute = await import("@/app/api/me/tokens/[id]/rotate/route");
const adminUsersRoute = await import("@/app/api/admin/users/route");
const loginRoute = await import("@/app/api/auth/login/route");
const mcpRoute = await import("@/app/api/mcp/route");

let admin: UserRow, owner: UserRow;
let workspaceId: string;
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, url: string, token?: string, body?: unknown) =>
  new Request("http://localhost" + url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const mcp = async (token: string, name: string, args: object = {}) => {
  const res = await mcpRoute.POST(
    req("POST", "/api/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
  const body = (await res.json()) as { result?: { isError?: boolean; content: { text: string }[] } };
  return {
    status: res.status,
    error: body.result?.isError === true,
    text: body.result?.content?.[0]?.text ?? "",
  };
};
const issue = async (accountId: string, body: object, token: string) => {
  const res = await accountTokensRoute.POST(
    req("POST", `/api/admin/service-accounts/${accountId}/tokens`, token, body),
    ctx(accountId),
  );
  return { status: res.status, body: (await res.json()) as { id: string; token: string; scope: string } };
};

let adminKey: string;
let service: { id: string; username: string };

beforeAll(async () => {
  admin = await users.createUser({ username: "root", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  adminKey = users.createToken(admin.id, "admin").token;
  workspaceId = withCaller(caller(owner), () => repo.createWorkspace("Pipeline")).id;
  const res = await accountsRoute.POST(
    req("POST", "/api/admin/service-accounts", adminKey, { username: "ci-bot", displayName: "CI" }),
  );
  expect(res.status).toBe(201);
  service = (await res.json()) as typeof service;
  withCaller(caller(owner), () => setMember(workspaceId, "ci-bot", "editor"));
});

afterAll(() => {
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("service accounts", () => {
  it("cannot sign in or take a password", async () => {
    expect(users.getUser(service.id)!.isService).toBe(true);
    const res = await loginRoute.POST(
      req("POST", "/api/auth/login", undefined, { username: "ci-bot", password: "!" }) as never,
    );
    expect(res.status).toBe(401);
    await expect(users.setPassword(service.id, "password123")).rejects.toThrow(/Service accounts/);
  });

  it("is administrator-only to manage", async () => {
    const memberKey = users.createToken(owner.id, "member").token;
    expect((await accountsRoute.GET(req("GET", "/api/admin/service-accounts", memberKey))).status).toBe(403);
    expect(
      (await accountsRoute.POST(req("POST", "/api/admin/service-accounts", memberKey, { username: "x-bot" })))
        .status,
    ).toBe(403);
    const list = (await (
      await accountsRoute.GET(req("GET", "/api/admin/service-accounts", adminKey))
    ).json()) as {
      username: string;
    }[];
    expect(list.map((a) => a.username)).toEqual(["ci-bot"]);
  });

  it("does not appear with a private workspace", () => {
    expect(repo.listWorkspaces().filter((w) => w.name.includes("ci-bot"))).toEqual([]);
  });
});

describe("scoped keys", () => {
  it("lets a read key look but not change anything", async () => {
    const { body } = await issue(service.id, { name: "reader", scope: "read" }, adminKey);
    expect(body.scope).toBe("read");
    const list = await workspacesRoute.GET(req("GET", "/api/workspaces", body.token));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { id: string }[]).map((w) => w.id)).toContain(workspaceId);
    const rename = await workspaceRoute.PATCH(
      req("PATCH", `/api/workspaces/${workspaceId}`, body.token, { name: "renamed" }),
      ctx(workspaceId),
    );
    expect(rename.status).toBe(403);
    expect(
      (await workspacesRoute.POST(req("POST", "/api/workspaces", body.token, { name: "nope" }))).status,
    ).toBe(403);
    expect((await mcp(body.token, "list_workspaces")).error).toBe(false);
    const create = await mcp(body.token, "create_workspace", { name: "nope" });
    expect(create.error).toBe(true);
    expect(repo.listWorkspaces().some((w) => w.name === "nope")).toBe(false);
  });

  it("lets a write key edit with the account's role, and nothing more", async () => {
    const { body } = await issue(service.id, { name: "writer", scope: "write" }, adminKey);
    const rename = await workspaceRoute.PATCH(
      req("PATCH", `/api/workspaces/${workspaceId}`, body.token, { name: "Pipeline v2" }),
      ctx(workspaceId),
    );
    expect(rename.status).toBe(200);
    // The account is an editor, so even a full key cannot manage members or delete the workspace.
    const full = await issue(service.id, { name: "everything", scope: "full" }, adminKey);
    expect(
      (
        await workspaceRoute.DELETE(
          req("DELETE", `/api/workspaces/${workspaceId}`, full.body.token),
          ctx(workspaceId),
        )
      ).status,
    ).toBe(403);
    expect((await accountsRoute.GET(req("GET", "/api/admin/service-accounts", full.body.token))).status).toBe(
      403,
    );
  });

  it("needs a full key to manage keys, and a personal key defaults to full", async () => {
    const run = await issue(service.id, { name: "runner", scope: "run" }, adminKey);
    expect(
      (await myTokensRoute.POST(req("POST", "/api/me/tokens", run.body.token, { name: "escalate" }))).status,
    ).toBe(403);
    const mine = await myTokensRoute.POST(req("POST", "/api/me/tokens", adminKey, { name: "plain" }));
    expect(((await mine.json()) as { scope: string }).scope).toBe("full");
    const limited = await myTokensRoute.POST(
      req("POST", "/api/me/tokens", adminKey, { name: "ro", scope: "read", rateLimitPerMinute: 5 }),
    );
    const info = (await limited.json()) as { scope: string; rateLimitPerMinute: number };
    expect(info).toMatchObject({ scope: "read", rateLimitPerMinute: 5 });
  });

  it("rejects an unknown scope", async () => {
    expect((await issue(service.id, { name: "bad", scope: "root" }, adminKey)).status).toBe(400);
  });

  it("stops every key of a disabled account", async () => {
    const { body } = await issue(service.id, { name: "temp", scope: "read" }, adminKey);
    expect((await workspacesRoute.GET(req("GET", "/api/workspaces", body.token))).status).toBe(200);
    users.setDisabled(service.id, true);
    expect((await workspacesRoute.GET(req("GET", "/api/workspaces", body.token))).status).toBe(401);
    expect((await issue(service.id, { name: "late" }, adminKey)).status).toBe(409);
    users.setDisabled(service.id, false);
  });

  it("treats a key stored before scopes existed as full", () => {
    const { info } = users.createToken(owner.id, "legacy");
    expect(info.scope).toBe("full");
    expect(info.rateLimitPerMinute).toBeNull();
  });
});

describe("revoking and rotating", () => {
  it("lets an administrator revoke any key at once", async () => {
    const { body } = await issue(service.id, { name: "leaked", scope: "read" }, adminKey);
    expect((await workspacesRoute.GET(req("GET", "/api/workspaces", body.token))).status).toBe(200);
    expect(
      (await adminTokenRoute.DELETE(req("DELETE", `/api/admin/tokens/${body.id}`, adminKey), ctx(body.id)))
        .status,
    ).toBe(200);
    expect((await workspacesRoute.GET(req("GET", "/api/workspaces", body.token))).status).toBe(401);
    expect(
      (await adminTokenRoute.DELETE(req("DELETE", `/api/admin/tokens/${body.id}`, adminKey), ctx(body.id)))
        .status,
    ).toBe(404);
  });

  it("rotates with a grace period for the old key", async () => {
    const old = await issue(service.id, { name: "rotating", scope: "run", rateLimitPerMinute: 30 }, adminKey);
    const res = await adminRotateRoute.POST(
      req("POST", `/api/admin/tokens/${old.body.id}/rotate`, adminKey, { graceMinutes: 10 }),
      ctx(old.body.id),
    );
    expect(res.status).toBe(201);
    const fresh = (await res.json()) as {
      token: string;
      scope: string;
      rateLimitPerMinute: number;
      previousKeyEndsAt: number;
    };
    expect(fresh).toMatchObject({ scope: "run", rateLimitPerMinute: 30 });
    expect(fresh.previousKeyEndsAt).toBeGreaterThan(Date.now());
    expect(fresh.token).not.toBe(old.body.token);
    // Both work during the grace period; the old one stops when it ends.
    expect((await workspacesRoute.GET(req("GET", "/api/workspaces", old.body.token))).status).toBe(200);
    expect((await workspacesRoute.GET(req("GET", "/api/workspaces", fresh.token))).status).toBe(200);
    expect(users.resolveToken(old.body.token, fresh.previousKeyEndsAt + 1)).toBeNull();
  });

  it("revokes the old key immediately without a grace period", async () => {
    const old = await issue(service.id, { name: "swap", scope: "read" }, adminKey);
    await adminRotateRoute.POST(
      req("POST", `/api/admin/tokens/${old.body.id}/rotate`, adminKey, {}),
      ctx(old.body.id),
    );
    expect((await workspacesRoute.GET(req("GET", "/api/workspaces", old.body.token))).status).toBe(401);
  });

  it("only lets people rotate their own keys", async () => {
    const mine = users.createToken(owner.id, "mine");
    const theirs = users.createToken(admin.id, "theirs");
    expect(
      (
        await myRotateRoute.POST(
          req("POST", `/api/me/tokens/${theirs.info.id}/rotate`, mine.token, {}),
          ctx(theirs.info.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await myRotateRoute.POST(
          req("POST", `/api/me/tokens/${mine.info.id}/rotate`, mine.token, {}),
          ctx(mine.info.id),
        )
      ).status,
    ).toBe(201);
  });
});

describe("rate limits", () => {
  const gate = (token: string) =>
    proxy(
      new NextRequest("http://localhost/api/workspaces", { headers: { authorization: `Bearer ${token}` } }),
    );

  it("returns 429 with Retry-After once a key exceeds its limit, and counts each request once", async () => {
    const { body } = await issue(
      service.id,
      { name: "limited", scope: "read", rateLimitPerMinute: 3 },
      adminKey,
    );
    keyLimiter.forget(body.id);
    for (const remaining of ["2", "1", "0"]) {
      const res = gate(body.token);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("x-ratelimit-remaining")).toBe(remaining);
    }
    const limited = gate(body.token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await limited.json()) as { error: string }).error).toMatch(/3 requests per minute/);
  });

  it("does not limit other keys or unlimited keys", async () => {
    const { body } = await issue(service.id, { name: "free", scope: "read" }, adminKey);
    for (let i = 0; i < 20; i++) expect(gate(body.token).status).toBe(200);
  });
});

describe("listing", () => {
  it("flags service accounts in the user list and shows keys without secrets", async () => {
    const list = (await (await adminUsersRoute.GET(req("GET", "/api/admin/users", adminKey))).json()) as {
      username: string;
      isService: boolean;
    }[];
    expect(list.find((u) => u.username === "ci-bot")!.isService).toBe(true);
    expect(list.find((u) => u.username === "root")!.isService).toBe(false);
    const accounts = (await (
      await accountsRoute.GET(req("GET", "/api/admin/service-accounts", adminKey))
    ).json()) as {
      tokens: Record<string, unknown>[];
    }[];
    expect(accounts[0].tokens.length).toBeGreaterThan(0);
    for (const t of accounts[0].tokens) {
      expect(t).not.toHaveProperty("token");
      expect(t).not.toHaveProperty("hash");
      expect(t).toHaveProperty("scope");
    }
  });
});
