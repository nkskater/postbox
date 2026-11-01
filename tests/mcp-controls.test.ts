import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserRow } from "@/server/db/schema";
import pkg from "../package.json";
import { setupSnippets } from "@/lib/mcp-setup";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-mcp-controls-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const settings = await import("@/server/settings");
const users = await import("@/server/users");
const { MCP_POLICIES, isReadOnlyTool } = await import("@/server/access-policy");
const mcpRoute = await import("@/app/api/mcp/route");
const securityRoute = await import("@/app/api/admin/security/route");
const revokeRoute = await import("@/app/api/admin/sessions/revoke/route");
const caller = await import("@/server/caller");
const auth = await import("@/server/auth");
const sessions = await import("@/server/session-settings");
const { getSqlite } = await import("@/server/db");

const rpc = (method: string, params?: unknown, headers: Record<string, string> = {}) =>
  mcpRoute.POST(
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
const init = () =>
  rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
const toolNames = async () => {
  const res = await rpc("tools/list", {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
};
const callTool = async (name: string, args: object = {}) => {
  const res = await rpc("tools/call", { name, arguments: args });
  return {
    status: res.status,
    body: (await res.json()) as {
      result?: { isError?: boolean; content: { text: string }[] };
      error?: { message: string };
    },
  };
};

afterAll(() => {
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("MCP controls", () => {
  it("classifies every registered tool, so read-only mode never hides one by accident", async () => {
    const names = await toolNames();
    expect(names.length).toBeGreaterThan(30);
    expect(names.filter((n) => !(n in MCP_POLICIES))).toEqual([]);
    expect(Object.keys(MCP_POLICIES).filter((n) => !names.includes(n))).toEqual([]);
  });

  it("can be switched off", async () => {
    settings.patchSettings({ "mcp.enabled": false });
    try {
      const res = await init();
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/disabled/);
      expect((await mcpRoute.GET()).status).toBe(405);
    } finally {
      settings.patchSettings({ "mcp.enabled": null });
    }
    expect((await init()).status).toBe(200);
  });

  it("hides and blocks tools that change data in read-only mode", async () => {
    const all = await toolNames();
    settings.patchSettings({ "mcp.readOnly": true });
    try {
      const visible = await toolNames();
      expect(visible.sort()).toEqual(all.filter(isReadOnlyTool).sort());
      for (const name of [
        "list_workspaces",
        "get_workspace_tree",
        "send_request",
        "run_collection",
        "whoami",
      ])
        expect(visible, name).toContain(name);
      for (const name of [
        "create_workspace",
        "delete_workspace",
        "update_request",
        "set_variables",
        "clear_history",
        "import_spec",
      ])
        expect(visible, name).not.toContain(name);

      // A client that calls a hidden tool anyway gets an explanation, and nothing happens.
      const blocked = await callTool("create_workspace", { name: "should not exist" });
      expect(blocked.status).toBe(200);
      expect(blocked.body.result!.isError).toBe(true);
      expect(blocked.body.result!.content[0].text).toMatch(/read-only/);
      const repo = await import("@/server/repo");
      expect(repo.listWorkspaces().some((w) => w.name === "should not exist")).toBe(false);

      const allowed = await callTool("list_workspaces");
      expect(allowed.body.result!.isError).not.toBe(true);
    } finally {
      settings.patchSettings({ "mcp.readOnly": null });
    }
    expect(await toolNames()).toHaveLength(all.length);
    const created = await callTool("create_workspace", { name: "now allowed" });
    expect(created.body.result!.isError).not.toBe(true);
  });

  it("takes extra allowed origins from settings", async () => {
    const call = (origin: string) => init2(origin);
    const init2 = (origin: string) =>
      rpc(
        "initialize",
        { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        { Origin: origin },
      );
    expect((await call("https://webui.example")).status).toBe(403);
    settings.patchSettings({ "mcp.allowedOrigins": "https://webui.example/, https://other.example" });
    try {
      expect((await call("https://webui.example")).status).toBe(200);
      expect((await call("https://other.example")).status).toBe(200);
      expect((await call("https://evil.example")).status).toBe(403);
    } finally {
      settings.patchSettings({ "mcp.allowedOrigins": null });
    }
    expect((await call("https://webui.example")).status).toBe(403);
  });
});

describe("sessions and security info", () => {
  let admin: UserRow;
  let member: UserRow;
  const bearer = new Map<string, string>();
  const request = (method: string, url: string, user: UserRow) =>
    new Request(`http://localhost${url}`, {
      method,
      headers: { authorization: `Bearer ${bearer.get(user.id)}`, "content-type": "application/json" },
    });
  const call = (handler: unknown, req: Request) => (handler as (r: Request) => Promise<Response>)(req);

  beforeAll(async () => {
    admin = await users.createUser({ username: "root", password: "password123", isAdmin: true });
    member = await users.createUser({ username: "member", password: "password123" });
    for (const u of [admin, member]) bearer.set(u.id, users.createToken(u.id, "t").token);
  });

  it("uses the configured session length, which an environment variable pins", () => {
    const day = 86_400_000;
    expect(sessions.sessionTtl({} as unknown as NodeJS.ProcessEnv)).toBe(30 * day);
    settings.patchSettings({ "security.sessionDays": 7 });
    try {
      expect(sessions.sessionTtl({} as unknown as NodeJS.ProcessEnv)).toBe(7 * day);
      expect(sessions.sessionTtl({ POSTBOX_SESSION_DAYS: "3" } as unknown as NodeJS.ProcessEnv)).toBe(
        3 * day,
      );
    } finally {
      settings.patchSettings({ "security.sessionDays": null });
    }
  });

  it("signs out account sessions and the single-user password session, but not API tokens", () => {
    const accountCookie = auth.createUserSession(
      caller.sessionSecret(),
      users.getUser(member.id)!,
      sessions.sessionTtl(),
    ).value;
    const headers = new Headers();
    expect(caller.getCaller(headers, accountCookie)?.kind).toBe("user");

    process.env.POSTBOX_PASSWORD = "single-user-pass";
    try {
      const before = caller.getAuthState().cfg!;
      const passwordCookie = auth.createSession(before).value;
      expect(auth.verifySession(before, passwordCookie)).toBe(true);

      const { users: signedOut } = sessions.signOutEveryone();
      expect(signedOut).toBe(2);

      expect(caller.getCaller(headers, accountCookie)).toBeNull();
      expect(auth.verifySession(caller.getAuthState().cfg!, passwordCookie)).toBe(false);
      // A new sign-in works, and API tokens were never affected.
      const fresh = auth.createUserSession(
        caller.sessionSecret(),
        users.getUser(member.id)!,
        sessions.sessionTtl(),
      ).value;
      expect(caller.getCaller(headers, fresh)?.kind).toBe("user");
      const tokenHeaders = new Headers({ authorization: `Bearer ${bearer.get(member.id)}` });
      expect(caller.getCaller(tokenHeaders, undefined)?.kind).toBe("user");
    } finally {
      delete process.env.POSTBOX_PASSWORD;
    }
  });

  it("serves security info and the sign-out route to administrators only", async () => {
    for (const [name, handler, method, url] of [
      ["info", securityRoute.GET, "GET", "/api/admin/security"],
      ["revoke", revokeRoute.POST, "POST", "/api/admin/sessions/revoke"],
    ] as const)
      expect((await call(handler, request(method, url, member))).status, name).toBe(403);

    const info = await (await call(securityRoute.GET, request("GET", "/api/admin/security", admin))).json();
    expect(info).toMatchObject({
      version: pkg.version,
      auth: { mode: "accounts", passwordConfigured: false, tokenConfigured: false },
      sessionDays: 30,
    });
    expect(JSON.stringify(info)).not.toMatch(/single-user-pass/);

    const res = await call(revokeRoute.POST, request("POST", "/api/admin/sessions/revoke", admin));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { users: number }).users).toBe(2);
    expect(res.headers.get("set-cookie")).toMatch(/postbox_session=;.*Expires=Thu, 01 Jan 1970/i);
  });
});

describe("MCP client setup snippets", () => {
  it("include the bearer header only when sign-in is on, and valid JSON for Cursor", () => {
    const url = "https://postbox.example/api/mcp";
    const withAuth = setupSnippets(url, true);
    expect(withAuth.claudeCode).toBe(
      `claude mcp add --transport http postbox ${url} --header "Authorization: Bearer YOUR_TOKEN"`,
    );
    expect(JSON.parse(withAuth.cursor)).toEqual({
      mcpServers: { postbox: { url, headers: { Authorization: "Bearer YOUR_TOKEN" } } },
    });
    expect(withAuth.openWebUi).toContain(`URL: ${url}`);
    expect(withAuth.openWebUi).toContain("YOUR_TOKEN");

    const open = setupSnippets(url, false);
    expect(open.claudeCode).toBe(`claude mcp add --transport http postbox ${url}`);
    expect(JSON.parse(open.cursor).mcpServers.postbox).toEqual({ url });
    expect(open.openWebUi).not.toContain("Bearer");
  });
});
