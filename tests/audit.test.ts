import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserRow } from "@/server/db/schema";
import type { Caller } from "@/server/caller";
import { AUDIT_CSV_COLUMNS, actionOf, auditToCsv, describeChange, entityKindOf, safeUrl } from "@/core/audit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-audit-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { getSqlite } = await import("@/server/db");
const { queryAudit } = await import("@/server/audit");
const { pruneAuditIfDue } = await import("@/server/audit-settings");
const { pruneAudit } = await import("@/server/audit");
const settings = await import("@/server/settings");
const requestsRoute = await import("@/app/api/requests/route");
const requestRoute = await import("@/app/api/requests/[id]/route");
const workspaceRoute = await import("@/app/api/workspaces/[id]/route");
const workspacesRoute = await import("@/app/api/workspaces/route");
const membersRoute = await import("@/app/api/workspaces/[id]/members/route");
const userRoute = await import("@/app/api/admin/users/[id]/route");
const myTokensRoute = await import("@/app/api/me/tokens/route");
const myTokenRoute = await import("@/app/api/me/tokens/[id]/route");
const adminAudit = await import("@/app/api/admin/audit/route");
const workspaceAudit = await import("@/app/api/workspaces/[id]/audit/route");
const mcpRoute = await import("@/app/api/mcp/route");
const settingsRoute = await import("@/app/api/settings/route");
const loginRoute = await import("@/app/api/auth/login/route");

const keys: Record<string, string> = {};
let admin: UserRow, owner: UserRow, viewer: UserRow, stranger: UserRow;
let workspaceId: string, folderId: string;
const caller = (u: UserRow): Caller => ({ kind: "user", user: u, via: "token" });
const req = (method: string, url: string, user: UserRow, body?: unknown) =>
  new Request("http://localhost" + url, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${keys[user.id]}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const events = (filter = {}) => queryAudit({ limit: 1000, ...filter }).events;

beforeAll(async () => {
  admin = await users.createUser({ username: "root", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  stranger = await users.createUser({ username: "stranger", password: "password123" });
  for (const u of [admin, owner, viewer, stranger]) keys[u.id] = users.createToken(u.id, "t").token;
  workspaceId = withCaller(caller(owner), () => repo.createWorkspace("Payments")).id;
  folderId = repo.createFolder(workspaceId, null).id;
  withCaller(caller(owner), () => setMember(workspaceId, "viewer", "viewer"));
});
afterAll(() => {
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("audit helpers", () => {
  it("shows only allowlisted values and withholds the rest by name", () => {
    const changes = describeChange(
      "request",
      {
        name: "Old",
        url: "https://a.test/x",
        headers: '[{"key":"Authorization","value":"Bearer s3cret"}]',
        auth: "old",
      },
      {
        name: "New",
        url: "https://a.test/x",
        headers: '[{"key":"Authorization","value":"Bearer other"}]',
        auth: "old",
      },
    );
    expect(changes).toEqual([
      { field: "headers", redacted: true },
      { field: "name", before: "Old", after: "New" },
    ]);
    expect(JSON.stringify(changes)).not.toContain("s3cret");
  });

  it("drops credentials and query values from URLs", () => {
    expect(safeUrl("https://user:pw@api.test/v1?api_key=abc&x=1")).toBe(
      "https://***@api.test/v1?api_key=***&x=***",
    );
    expect(safeUrl("https://api.test/v1")).toBe("https://api.test/v1");
    const [c] = describeChange(
      "request",
      { url: "https://a.test/?token=zzz" },
      { url: "https://a.test/?token=yyy&k=1" },
    );
    expect(JSON.stringify(c)).not.toMatch(/zzz|yyy/);
  });

  it("describes creations and deletions, and ignores timestamps", () => {
    expect(
      describeChange("folder", null, {
        name: "F",
        description: "",
        headers: "[]",
        sort: 0,
        workspace_id: "w",
        updated_at: 1,
      }),
    ).toEqual([{ field: "name", after: "F" }]);
    expect(describeChange("folder", { name: "F", updated_at: 1 }, null)).toEqual([
      { field: "name", before: "F" },
    ]);
  });

  it("names actions and entities from route patterns", () => {
    expect(actionOf("POST", "/api/requests")).toBe("request.create");
    expect(actionOf("PATCH", "/api/folders/[id]")).toBe("folder.update");
    expect(actionOf("DELETE", "/api/workspaces/[id]")).toBe("workspace.delete");
    expect(actionOf("POST", "/api/mocks/[id]/reset")).toBe("mock.reset");
    expect(entityKindOf("/api/environments/[id]")).toBe("environment");
    expect(entityKindOf("/api/unknown")).toBe("other");
  });

  it("exports CSV that cannot run as a spreadsheet formula", () => {
    const csv = auditToCsv([
      {
        at: 0,
        actorName: "=cmd|' /C calc'!A0",
        actorKind: "user",
        workspaceId: "w",
        action: "request.update",
        entityKind: "request",
        entityId: "r",
        entityName: 'He said "hi", ok',
        revision: 2,
        result: "ok",
        changes: [{ field: "name", before: "a", after: "b" }],
      },
    ]);
    const [header, row] = csv.trim().split("\r\n");
    expect(header.split(",")).toEqual([...AUDIT_CSV_COLUMNS]);
    expect(row).toContain("'=cmd");
    expect(row).toContain('"He said ""hi"", ok"');
  });
});

describe("recording changes", () => {
  let requestId: string;

  it("attributes a creation to its actor and workspace", async () => {
    const res = await requestsRoute.POST(
      req("POST", "/api/requests", owner, {
        workspaceId,
        folderId,
        request: { name: "List invoices", method: "GET", url: "https://api.test/invoices?key=topsecret" },
      }),
    );
    requestId = ((await res.json()) as { id: string }).id;
    const [event] = events({ entityId: requestId });
    expect(event).toMatchObject({
      action: "request.create",
      actorName: "owner",
      actorKind: "user",
      via: "token",
      workspaceId,
      entityKind: "request",
      entityName: "List invoices",
      revision: 1,
      result: "ok",
    });
    expect(event.keyId).toBeTruthy();
    expect(JSON.stringify(event)).not.toContain("topsecret");
  });

  it("records before and after for safe fields and only names for the rest", async () => {
    await requestRoute.PATCH(
      req("PATCH", `/api/requests/${requestId}`, owner, {
        name: "List all invoices",
        headers: [{ key: "Authorization", value: "Bearer hunter2-secret", enabled: true }],
      }),
      ctx(requestId),
    );
    const [event] = events({ entityId: requestId });
    expect(event).toMatchObject({ action: "request.update", revision: 2 });
    expect(event.changes).toEqual(
      expect.arrayContaining([
        { field: "name", before: "List invoices", after: "List all invoices" },
        { field: "headers", redacted: true },
      ]),
    );
    expect(JSON.stringify(events())).not.toContain("hunter2-secret");
  });

  it("keeps the name of something that was deleted", async () => {
    await requestRoute.DELETE(req("DELETE", `/api/requests/${requestId}`, owner), ctx(requestId));
    const [event] = events({ entityId: requestId });
    expect(event).toMatchObject({ action: "request.delete", entityName: "List all invoices", revision: 3 });
  });

  it("records workspace creation and deletion", async () => {
    const res = await workspacesRoute.POST(req("POST", "/api/workspaces", stranger, { name: "Scratch" }));
    const id = ((await res.json()) as { id: string }).id;
    await workspaceRoute.DELETE(req("DELETE", `/api/workspaces/${id}`, stranger), ctx(id));
    expect(events({ entityId: id }).map((e) => e.action)).toEqual(["workspace.delete", "workspace.create"]);
    expect(events({ entityId: id })[0].entityName).toBe("Scratch");
  });

  it("records role changes with the previous role", async () => {
    await membersRoute.PUT(
      req("PUT", `/api/workspaces/${workspaceId}/members`, owner, { username: "stranger", role: "viewer" }),
      ctx(workspaceId),
    );
    await membersRoute.PUT(
      req("PUT", `/api/workspaces/${workspaceId}/members`, owner, { username: "stranger", role: "editor" }),
      ctx(workspaceId),
    );
    await membersRoute.DELETE(
      req("DELETE", `/api/workspaces/${workspaceId}/members`, owner, { username: "stranger" }),
      ctx(workspaceId),
    );
    const trail = events({ workspaceId, entityKind: "member" }).filter((e) => e.entityName === "stranger");
    expect(trail.map((e) => [e.action, e.changes])).toEqual([
      ["member.remove", [{ field: "role", before: "editor", after: null }]],
      ["member.role_change", [{ field: "role", before: "viewer", after: "editor" }]],
      ["member.add", [{ field: "role", before: null, after: "viewer" }]],
    ]);
  });

  it("records account changes without password values", async () => {
    await userRoute.PATCH(
      req("PATCH", `/api/admin/users/${viewer.id}`, admin, { password: "brand-new-pass-1" }),
      ctx(viewer.id),
    );
    await userRoute.PATCH(
      req("PATCH", `/api/admin/users/${viewer.id}`, admin, { disabled: true }),
      ctx(viewer.id),
    );
    await userRoute.PATCH(
      req("PATCH", `/api/admin/users/${viewer.id}`, admin, { disabled: false, isAdmin: true }),
      ctx(viewer.id),
    );
    const trail = events({ entityId: viewer.id });
    expect(trail.map((e) => e.action).slice(0, 3)).toEqual(["user.enable", "user.disable", "user.update"]);
    expect(trail[2].changes).toEqual([{ field: "password", redacted: true }]);
    expect(trail[0].changes).toEqual(
      expect.arrayContaining([
        { field: "disabled", before: true, after: false },
        { field: "is_admin", before: false, after: true },
      ]),
    );
    expect(JSON.stringify(events())).not.toContain("brand-new-pass");
    await userRoute.PATCH(
      req("PATCH", `/api/admin/users/${viewer.id}`, admin, { isAdmin: false }),
      ctx(viewer.id),
    );
  });

  it("records key creation and revocation without the key", async () => {
    const res = await myTokensRoute.POST(
      req("POST", "/api/me/tokens", owner, { name: "ci", scope: "run", rateLimitPerMinute: 10 }),
    );
    const made = (await res.json()) as { id: string; token: string };
    await myTokenRoute.DELETE(req("DELETE", `/api/me/tokens/${made.id}`, owner), ctx(made.id));
    const [revoked, created] = events({ entityId: made.id });
    expect(created).toMatchObject({
      action: "key.create",
      entityKind: "key",
      entityName: "ci",
      meta: expect.objectContaining({ owner: "owner" }),
    });
    expect(created.changes).toEqual(
      expect.arrayContaining([
        { field: "scope", after: "run" },
        { field: "rate_limit_per_minute", after: 10 },
      ]),
    );
    expect(revoked.action).toBe("key.revoke");
    expect(JSON.stringify(events())).not.toContain(made.token);
    expect(JSON.stringify(events())).not.toMatch(/pbx_[A-Za-z0-9_-]{20}/);
  });

  it("records settings changes and withholds nothing but text values", async () => {
    await settingsRoute.PATCH(
      req("PATCH", "/api/settings", admin, { values: { "audit.retentionDays": 30 } }),
    );
    const [event] = events({ action: "settings.update" });
    expect(event.changes).toEqual([{ field: "audit.retentionDays", before: 365, after: 30 }]);
    settings.patchSettings({ "audit.retentionDays": null });
  });

  it("records refused changes", async () => {
    const res = await workspaceRoute.PATCH(
      req("PATCH", `/api/workspaces/${workspaceId}`, stranger, { name: "hijack" }),
      ctx(workspaceId),
    );
    expect([403, 404]).toContain(res.status);
    const denied = events({ result: "denied", actor: "stranger" });
    // A stranger gets 404 (existence is hidden), so only role-limited callers leave a denied event.
    const viewerAttempt = await workspaceRoute.PATCH(
      req("PATCH", `/api/workspaces/${workspaceId}`, viewer, { name: "no" }),
      ctx(workspaceId),
    );
    expect(viewerAttempt.status).toBe(403);
    const after = events({ result: "denied", actor: "viewer" });
    expect(after[0]).toMatchObject({ action: "workspace.update", workspaceId, actorName: "viewer" });
    expect(denied.length).toBe(0);
    expect(events({ entityId: workspaceId }).some((e) => e.entityName === "hijack")).toBe(false);
  });

  it("records failed and successful sign-ins", async () => {
    const attempt = (password: string) =>
      loginRoute.POST(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "owner", password }),
        }),
      );
    expect((await attempt("wrong-password")).status).toBe(401);
    expect((await attempt("password123")).status).toBe(200);
    const trail = events({ action: "auth" });
    expect(trail.map((e) => [e.action, e.result])).toEqual([
      ["auth.login", "ok"],
      ["auth.login_failed", "denied"],
    ]);
    expect(JSON.stringify(trail)).not.toContain("wrong-password");
  });

  it("records mutating MCP tool calls, not reads", async () => {
    const call = (name: string, args: object) =>
      mcpRoute.POST(
        new Request("http://localhost/api/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${keys[owner.id]}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
      );
    await (await call("list_workspaces", {})).text();
    await (await call("create_workspace", { name: "From MCP" })).text();
    await new Promise((r) => setTimeout(r, 50));
    const trail = events({ action: "mcp" });
    expect(trail.map((e) => e.action)).toEqual(["mcp.create_workspace"]);
    expect(trail[0]).toMatchObject({ actorName: "owner", via: "mcp" });
    expect(JSON.stringify(trail[0].meta)).not.toContain("From MCP");
  });
});

describe("reading the log", () => {
  it("filters, pages and orders newest first", () => {
    const all = events();
    expect(all.length).toBeGreaterThan(15);
    expect(all.map((e) => e.at)).toEqual([...all.map((e) => e.at)].sort((a, b) => b - a));
    const seen: string[] = [];
    let cursor: { at: number; id: string } | undefined;
    for (;;) {
      const page = queryAudit({ limit: 4, cursor });
      seen.push(...page.events.map((e) => e.id));
      if (!page.next) break;
      const [at, id] = [Number(page.next.split(":")[0]), page.next.split(":").slice(1).join(":")];
      cursor = { at, id };
    }
    expect(seen).toEqual(all.map((e) => e.id));
    expect(events({ action: "request" }).every((e) => e.action.startsWith("request."))).toBe(true);
    expect(events({ q: "invoices" }).length).toBeGreaterThan(0);
    expect(events({ q: "%" }).length).toBe(0);
    expect(events({ from: Date.now() + 10_000 })).toEqual([]);
  });

  it("lets administrators read everything and export it", async () => {
    const res = await adminAudit.GET(req("GET", "/api/admin/audit?limit=5", admin));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; next: string | null };
    expect(body.events).toHaveLength(5);
    expect(body.next).toBeTruthy();
    const csv = await adminAudit.GET(req("GET", "/api/admin/audit?export=csv&action=request", admin));
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/postbox-audit-.*\.csv/);
    expect((await csv.text()).split("\r\n")[0]).toBe(AUDIT_CSV_COLUMNS.join(","));
    expect(events({ action: "audit.export" })).toHaveLength(1);
    expect((await adminAudit.GET(req("GET", "/api/admin/audit?export=xml", admin))).status).toBe(400);
    expect((await adminAudit.GET(req("GET", "/api/admin/audit?from=yesterday-ish", admin))).status).toBe(400);
  });

  it("keeps the whole log from everyone but administrators", async () => {
    expect((await adminAudit.GET(req("GET", "/api/admin/audit", owner))).status).toBe(403);
  });

  it("shows a workspace's changes to its owner only", async () => {
    const res = await workspaceAudit.GET(
      req("GET", `/api/workspaces/${workspaceId}/audit`, owner),
      ctx(workspaceId),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { workspaceId: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.workspaceId === workspaceId)).toBe(true);
    expect(
      (await workspaceAudit.GET(req("GET", `/api/workspaces/${workspaceId}/audit`, viewer), ctx(workspaceId)))
        .status,
    ).toBe(403);
    expect(
      (
        await workspaceAudit.GET(
          req("GET", `/api/workspaces/${workspaceId}/audit`, stranger),
          ctx(workspaceId),
        )
      ).status,
    ).toBe(404);
  });
});

describe("retention", () => {
  it("removes events older than the retention period, and keeps everything at 0", () => {
    const before = events().length;
    const day = 86_400_000;
    getSqlite()
      .prepare("UPDATE audit_events SET at = ? WHERE id IN (SELECT id FROM audit_events ORDER BY at LIMIT 3)")
      .run(Date.now() - 40 * day);
    expect(pruneAudit(0)).toBe(0);
    expect(pruneAudit(30)).toBe(3);
    expect(events().length).toBe(before - 3);
    expect(pruneAuditIfDue(Date.now())).toBeGreaterThanOrEqual(0);
  });
});
