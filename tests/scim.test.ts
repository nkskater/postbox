import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, count, eq } from "drizzle-orm";
import { actionOf } from "@/core/audit";
import type { Caller } from "@/server/caller";
import type { ScimRecord } from "@/core/scim/model";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-scim-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const users = await import("@/server/users");
const auth = await import("@/server/auth");
const repo = await import("@/server/repo");
const audit = await import("@/server/audit");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { getDb, getSqlite, schema } = await import("@/server/db");
const model = await import("@/core/scim/model");
const roles = await import("@/core/scim/roles");
const filter = await import("@/core/scim/filter");
const usersRoute = await import("@/app/api/scim/Users/route");
const userRoute = await import("@/app/api/scim/Users/[id]/route");
const groupsRoute = await import("@/app/api/scim/Groups/route");
const groupRoute = await import("@/app/api/scim/Groups/[id]/route");

let admin: UserRow;
let member: UserRow;
let workspaceId: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const callerOf = (user: UserRow): Caller => ({ kind: "user", user: users.getUser(user.id)!, via: "token" });
const jsonOf = async (response: Response) => (await response.json()) as ScimRecord;
const resources = (list: ScimRecord) => (list.Resources as ScimRecord[]) ?? [];
const namesOf = (list: ScimRecord) => resources(list).map((r) => String(r.userName ?? r.name));
const roleOf = (userId: string) =>
  getDb()
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)),
    )
    .get()?.role ?? null;
const memberCount = () =>
  getDb()
    .select({ n: count() })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
    .get()!.n;

type Route = Record<string, (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>>;

/** Call a SCIM endpoint with a bearer key, or anonymously when the key is undefined. */
const call = async (
  method: string,
  url: string,
  key: string | undefined,
  body?: unknown,
): Promise<Response> => {
  const urlObject = new URL(`http://localhost${url}`);
  const [, , , resource, id] = urlObject.pathname.split("/");
  const route = (
    resource === "Users" ? (id ? userRoute : usersRoute) : id ? groupRoute : groupsRoute
  ) as Route;
  return route[method](
    new Request(urlObject.toString(), {
      method,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: id ?? "" }) },
  );
};

const root = () => `?workspaceId=${workspaceId}`;
const post = (resource: "Users" | "Groups", body: unknown) =>
  call("POST", `/api/scim/${resource}${root()}`, tokens[admin.id], body);
const list = (resource: "Users" | "Groups", query: string) =>
  call("GET", `/api/scim/${resource}${root()}&${query}`, tokens[admin.id]);

describe("SCIM provisioning", () => {
  beforeAll(async () => {
    admin = await users.createUser({ username: "root", password: "password123", isAdmin: true });
    member = await users.createUser({ username: "ada", password: "password123" });
    for (const user of [admin, member]) tokens[user.id] = users.createToken(user.id, "testing").token;
    workspaceId = withCaller(callerOf(admin), () => repo.createWorkspace("SCIM provisioning")).id;
    withCaller(callerOf(admin), () => setMember(workspaceId, member.username, "viewer"));
  });
  afterAll(() => {
    getSqlite().close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is an administrator API: refused before anything is provisioned", async () => {
    expect((await call("GET", `/api/scim/Users${root()}`, undefined)).status).toBe(401);
    expect((await call("GET", `/api/scim/Users${root()}`, tokens[member.id])).status).toBe(403);

    const refused = await call("POST", `/api/scim/Users${root()}`, tokens[member.id], {
      userName: "never-created",
    });
    expect(refused.status).toBe(403);
    expect((await jsonOf(refused)).schemas).toEqual([model.SCIM_ERROR_SCHEMA]);

    // A provisioning key narrower than the API cannot provision, even for an administrator.
    const readKey = users.createToken(admin.id, "read-only", null, { scope: "read" }).token;
    expect(
      (await call("POST", `/api/scim/Users${root()}`, readKey, { userName: "also-not-created" })).status,
    ).toBe(403);
    for (const name of ["never-created", "also-not-created"])
      expect(users.getUserByUsername(name)).toBeUndefined();

    const denied = audit.queryAudit({ action: "scim", result: "denied" });
    expect(denied.events.length).toBe(2);
    expect(denied.events.map((event) => event.actorName).sort()).toEqual(["ada", "root"]);
    for (const event of denied.events) {
      expect(event.action).toBe(actionOf("POST", "/api/scim/Users"));
      expect(event.changes).toEqual([]);
    }
  });

  it("provisions in the SCIM shape and keeps secrets out of the answer", async () => {
    const response = await post("Users", {
      userName: "Grace",
      externalId: "idp-42",
      name: { givenName: "Grace", familyName: "Hopper" },
      emails: [{ value: "grace@example.com", type: "work", primary: true }],
      phoneNumbers: [{ value: "+1 555 0100", type: "work" }],
      password: "provisioned123",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe(model.SCIM_CONTENT_TYPE);
    const grace = await jsonOf(response);
    ids.grace = String(grace.id);

    expect(grace.schemas).toEqual([model.SCIM_USER_SCHEMA]);
    expect(grace.userName).toBe("grace"); // usernames are normalised like every other account
    expect(grace.externalId).toBe("idp-42");
    expect((grace.name as ScimRecord).familyName).toBe("Hopper");
    expect((grace.emails as ScimRecord[])[0].value).toBe("grace@example.com");
    expect(grace.active).toBe(true);
    expect((grace.meta as ScimRecord).resourceType).toBe("User");
    expect((grace.meta as ScimRecord).location).toBe(`/api/scim/Users/${ids.grace}`);
    expect(JSON.stringify(grace)).not.toMatch(/passwordHash|sessionVersion|password|isAdmin/);

    const row = users.getUser(ids.grace)!;
    expect(row.displayName).toBe("Grace Hopper");
    expect(await users.verifyPassword("provisioned123", row.passwordHash)).toBe(true);
    expect(roleOf(ids.grace)).toBe("viewer"); // a new account starts as a viewer of its workspace

    const event = audit.queryAudit({ action: "scim.user.create", entityId: ids.grace }).events[0];
    expect(event.entityName).toBe("grace");
    expect(event.changes.find((c) => c.field === "password")).toEqual({ field: "password", redacted: true });

    for (const bad of [
      { userName: "a" },
      { userName: "Grace", password: "short" },
      { userName: "grace", emails: "nope" },
    ])
      expect((await post("Users", bad)).status).toBe(400);
  });

  it("pages lists and reports the page it returned", async () => {
    for (const name of ["bob", "carol", "dave"]) {
      const created = await jsonOf(await post("Users", { userName: name }));
      ids[name] = String(created.id);
    }
    const total = memberCount();
    expect(total).toBe(6); // root, ada and the four provisioned accounts

    const first = await jsonOf(await list("Users", "count=2"));
    const second = await jsonOf(await list("Users", "count=2&startIndex=3"));
    const third = await jsonOf(await list("Users", "count=2&startIndex=5"));
    expect(first.schemas).toEqual([model.SCIM_LIST_SCHEMA]);
    expect(first.totalResults).toBe(total);
    expect(first.startIndex).toBe(1);
    expect(first.itemsPerPage).toBe(2);
    expect(second.startIndex).toBe(3);
    expect(third.itemsPerPage).toBe(2);
    const seen = new Set([first, second, third].flatMap((page) => resources(page).map((r) => r.id)));
    expect(seen.size).toBe(total);

    // A list of what a resource is a member of: the groups say the same thing back.
    const graceGroups = await jsonOf(
      await call("GET", `/api/scim/Users/${ids.grace}${root()}`, tokens[admin.id]),
    );
    expect(((graceGroups.groups as ScimRecord[]) ?? []).length).toBe(0);

    for (const bad of ["startIndex=0", "count=1001", "sortOrder=sideways", "sortBy=1bad"])
      expect((await list("Users", bad)).status).toBe(400);
  });

  it("filters, searches and sorts, and answers a malformed filter with 400", async () => {
    const names = async (query: string) => namesOf(await jsonOf(await list("Users", query))).sort();
    const eq = (value: string) => encodeURIComponent(`userName eq "${value}"`);

    expect(await names(`filter=${eq("grace")}`)).toEqual(["grace"]);
    expect(await names("filter=" + encodeURIComponent('name.givenName sw "Gr"'))).toEqual(["grace"]);
    expect(await names(`filter=${eq("bob")} or ${eq("carol")}`)).toEqual(["bob", "carol"]);
    expect(await names("filter=" + encodeURIComponent("emails pr"))).toEqual(["grace"]);
    expect(await names("filter=" + encodeURIComponent('userName eq "bob" and active eq true'))).toEqual([
      "bob",
    ]);
    expect(await names("search=hopper")).toEqual(["grace"]);
    expect(await names("search=" + eq("bob"))).toEqual(["bob"]); // search is accepted as a filter

    const sorted = namesOf(await jsonOf(await list("Users", "sortBy=userName&sortOrder=desc")));
    expect(sorted).toEqual(["root", "grace", "dave", "carol", "bob", "ada"]);

    for (const bad of ["userName eq", '"unterminated', "and", "eq bob"])
      expect((await list("Users", "filter=" + encodeURIComponent(bad))).status).toBe(400);

    // The grammar itself, as the endpoints use it.
    const node = filter.parseFilter('name.givenName sw "Gr" and active eq true');
    expect(node).toMatchObject({ kind: "logic", op: "and" });
    expect(filter.matchFilter(node, { name: { givenName: "Grace" }, active: true })).toBe(true);
    expect(filter.matchFilter(node, { name: { givenName: "Ada" }, active: true })).toBe(false);
    expect(filter.matchSearch({ name: { familyName: "Hopper" } }, "hopper")).toBe(true);
  });

  it("applies PATCH operations and treats PUT as a whole replacement", async () => {
    const key = users.createToken(ids.grace, "grace key").token;
    const patched = await jsonOf(
      await call("PATCH", `/api/scim/Users/${ids.grace}${root()}`, tokens[admin.id], {
        schema: model.SCIM_PATCH_SCHEMA,
        Operations: [
          { op: "add", path: "emails", value: [{ value: "grace2@example.com", type: "work" }] },
          { op: "replace", path: "name.givenName", value: "Grace Brewster" },
          { op: "remove", path: "phoneNumbers" },
        ],
      }),
    );
    expect((patched.name as ScimRecord).givenName).toBe("Grace Brewster");
    // "grace2" sorts before "grace" (`2` < `@`), which is what `sort()` gives.
    expect((patched.emails as ScimRecord[]).map((e) => e.value).sort()).toEqual([
      "grace2@example.com",
      "grace@example.com",
    ]);
    expect(patched.phoneNumbers).toBeUndefined();

    const replaced = await jsonOf(
      await call("PUT", `/api/scim/Users/${ids.grace}${root()}`, tokens[admin.id], { userName: "grace" }),
    );
    expect(replaced.name).toBeUndefined(); // what a PUT does not carry is gone
    expect(replaced.emails).toBeUndefined();

    expect(
      (
        await call("PATCH", `/api/scim/Users/nope${root()}`, tokens[admin.id], {
          Operations: [{ op: "replace", path: "active", value: false }],
        })
      ).status,
    ).toBe(404);
    expect((await post("Users", { userName: "ada" })).status).toBe(409); // usernames cannot be reused

    const deactivated = await jsonOf(
      await call("PATCH", `/api/scim/Users/${ids.grace}${root()}`, tokens[admin.id], {
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
    );
    expect(deactivated.active).toBe(false);
    const row = users.getUser(ids.grace)!;
    expect(row.disabled).toBe(true);
    expect(row.sessionVersion).toBe(3); // disabled, then access revoked: sessions end at once
    expect(users.resolveToken(key)).toBeNull();
    // The keys are revoked, not just ignored: reactivating does not bring them back.
    await call("PATCH", `/api/scim/Users/${ids.grace}${root()}`, tokens[admin.id], {
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(users.getUser(ids.grace)!.disabled).toBe(false);
    expect(users.resolveToken(key)).toBeNull();
  });

  it("maps group names to workspace roles for their members", async () => {
    expect(roles.roleForGroupName("Editors")).toBe("editor");
    expect(roles.roleForGroupName("editors")).toBe("editor");
    expect(roles.groupNameForRole("owner")).toBe("Owners");
    expect(roles.roleForGroupName("Marketing")).toBeNull();

    const editors = await jsonOf(
      await post("Groups", { name: "Editors", displayName: "Editor group", members: [{ value: member.id }] }),
    );
    ids.editors = String(editors.id);
    expect((editors.meta as ScimRecord).resourceType).toBe("Group");
    expect((editors.meta as ScimRecord).location).toBe(`/api/scim/Groups/${ids.editors}`);
    expect((editors.members as ScimRecord[]).map((m) => m.value)).toEqual([member.id]);
    expect(roleOf(member.id)).toBe("editor");

    const marketing = await jsonOf(
      await post("Groups", { name: "Marketing", members: [{ value: member.id }] }),
    );
    ids.marketing = String(marketing.id);
    expect(roleOf(member.id)).toBe("editor"); // an unmapped group name records membership only

    expect((await post("Groups", { name: "Sales", members: [{ value: "not-a-user" }] })).status).toBe(400);
    expect((await post("Groups", { name: "Editors" })).status).toBe(409);

    // A mapped group grants its role, but never by leaving a workspace without an owner.
    const refused = await call("PATCH", `/api/scim/Groups/${ids.editors}${root()}`, tokens[admin.id], {
      Operations: [{ op: "add", path: "members", value: [{ value: admin.id }] }],
    });
    expect(refused.status).toBe(409);
    expect((await jsonOf(refused)).detail).toMatch(/owner/);
    expect(roleOf(admin.id)).toBe("owner");

    // PUT replaces the whole resource, membership included.
    const replacedGroup = await jsonOf(
      await call("PUT", `/api/scim/Groups/${ids.marketing}${root()}`, tokens[admin.id], {
        name: "Marketing",
        externalId: "idp-7",
      }),
    );
    expect((replacedGroup.members as ScimRecord[]).length).toBe(0);
    expect(replacedGroup.displayName).toBe("Marketing"); // the default follows the name again
    expect(replacedGroup.externalId).toBe("idp-7");

    const owners = await jsonOf(await post("Groups", { name: "Owners", members: [{ value: ids.bob }] }));
    ids.owners = String(owners.id);
    expect(roleOf(ids.bob)).toBe("owner");

    const granted = await jsonOf(
      await call("PATCH", `/api/scim/Groups/${ids.editors}${root()}`, tokens[admin.id], {
        Operations: [{ op: "add", path: "members", value: [{ value: admin.id }] }],
      }),
    );
    expect((granted.members as ScimRecord[]).map((m) => m.value)).toEqual([member.id, admin.id]);
    expect(roleOf(admin.id)).toBe("editor"); // with a second owner the demotion is allowed

    const left = await jsonOf(
      await call("PATCH", `/api/scim/Groups/${ids.editors}${root()}`, tokens[admin.id], {
        Operations: [{ op: "remove", path: `members[value eq "${admin.id}"]` }],
      }),
    );
    expect((left.members as ScimRecord[]).map((m) => m.value)).toEqual([member.id]);
    expect(roleOf(admin.id)).toBeNull(); // the role goes back with the membership

    const renamed = await jsonOf(
      await call("PATCH", `/api/scim/Groups/${ids.marketing}${root()}`, tokens[admin.id], {
        Operations: [
          { op: "add", path: "members", value: [{ value: member.id }] },
          { op: "replace", path: "name", value: "Viewers" },
        ],
      }),
    );
    expect((renamed.members as ScimRecord[]).map((m) => m.value)).toEqual([member.id]);
    expect(roleOf(member.id)).toBe("viewer"); // the group carries the role its name maps to
  });

  it("rolls back failed multi-member group changes and releases renamed roles", async () => {
    const first = await jsonOf(await post("Users", { userName: "atomic-first" }));
    withCaller(callerOf(admin), () => setMember(workspaceId, "atomic-first", "editor"));
    const owner = users.getUser(ids.bob)!;
    const failed = await post("Groups", {
      displayName: "viewers",
      members: [{ value: String(first.id) }, { value: owner.id }],
    });
    expect(failed.status).toBe(409);
    expect(roleOf(String(first.id))).toBe("editor");
    expect(
      getDb().select().from(schema.scimGroups).where(eq(schema.scimGroups.name, "viewers")).all(),
    ).toHaveLength(0);
    const renamed = await post("Groups", { displayName: "editors", members: [{ value: String(first.id) }] });
    expect(renamed.status).toBe(201);
    const group = await jsonOf(renamed);
    expect(group.schemas).toEqual([model.SCIM_GROUP_SCHEMA]);
    expect(roleOf(String(first.id))).toBe("editor");
    const changed = await call("PATCH", `/api/scim/Groups/${group.id}${root()}`, tokens[admin.id], {
      Operations: [{ op: "Replace", value: { name: "No role" } }],
    });
    expect(changed.status).toBe(200);
    expect(roleOf(String(first.id))).toBeNull();
    withCaller(callerOf(admin), () => setMember(workspaceId, "atomic-first", "viewer"));
    const invalid = await call("PATCH", `/api/scim/Users/${first.id}${root()}`, tokens[admin.id], {
      Operations: [{ op: "replace", path: "active", value: "false" }],
    });
    expect(invalid.status).toBe(400);
    expect(users.getUser(String(first.id))!.disabled).toBe(false);
  });

  it("answers 404 for unknown resources and 410 for tombstones, without erasing the trail", async () => {
    expect((await call("GET", `/api/scim/Users/nope${root()}`, tokens[admin.id])).status).toBe(404);
    expect((await call("GET", `/api/scim/Groups/nope${root()}`, tokens[admin.id])).status).toBe(404);

    const erin = await jsonOf(await post("Users", { userName: "erin" }));
    ids.erin = String(erin.id);
    const key = users.createToken(ids.erin, "erin key").token;
    expect(users.resolveToken(key)).not.toBeNull();

    expect((await call("DELETE", `/api/scim/Users/${ids.erin}${root()}`, tokens[admin.id])).status).toBe(204);
    const tombstone = users.getUser(ids.erin)!;
    expect(tombstone.disabled).toBe(true);
    expect(tombstone.deletedAt).not.toBeNull();
    expect(users.listTokens(ids.erin)).toEqual([]); // access ends with the account
    expect(users.resolveToken(key)).toBeNull();

    const gone = await jsonOf(await call("GET", `/api/scim/Users/${ids.erin}${root()}`, tokens[admin.id]));
    expect(gone.status).toBe("410");
    expect(gone.schemas).toEqual([model.SCIM_ERROR_SCHEMA]);
    expect(
      (await call("PUT", `/api/scim/Users/${ids.erin}${root()}`, tokens[admin.id], { userName: "erin" }))
        .status,
    ).toBe(410);

    // Deleting a mapped group takes back the role it granted, then keeps its name.
    expect(
      (await call("DELETE", `/api/scim/Groups/${ids.marketing}${root()}`, tokens[admin.id])).status,
    ).toBe(204);
    expect((await call("GET", `/api/scim/Groups/${ids.marketing}${root()}`, tokens[admin.id])).status).toBe(
      410,
    );
    expect(roleOf(member.id)).toBeNull();
    expect((await post("Groups", { name: "Viewers" })).status).toBe(409);
    expect((await post("Users", { userName: "erin" })).status).toBe(409); // tombstones keep their names too

    // A group belongs to its own workspace.
    const other = withCaller(callerOf(admin), () => repo.createWorkspace("Other workspace")).id;
    expect(
      (await call("GET", `/api/scim/Groups/${ids.editors}?workspaceId=${other}`, tokens[admin.id])).status,
    ).toBe(404);
  });

  it("rejects unsafe or unsupported PATCH paths without mutating resources", async () => {
    const { applyOperations } = await import("@/core/scim/patch");
    expect(() => applyOperations({}, [{ op: "add", path: "__proto__.scimPolluted", value: true }])).toThrow();
    expect(({} as Record<string, unknown>).scimPolluted).toBeUndefined();
    const record = { members: [{ value: "one" }, { value: "two" }] };
    expect(() =>
      applyOperations(record, [{ op: "replace", path: 'members[value eq "one"]', value: [] }]),
    ).toThrow();
    expect(record.members).toHaveLength(2);
  });

  it("records every provisioning decision, with values redacted where they must be", async () => {
    const trail = audit.queryAudit({ workspaceId });
    for (const action of [
      "scim.user.create",
      "scim.user.patch",
      "scim.user.replace",
      "scim.user.delete",
      "scim.group.create",
      "scim.group.patch",
      "scim.group.replace",
      "scim.group.delete",
    ])
      expect(
        trail.events.some((event) => event.action === action),
        action,
      ).toBe(true);

    const deleted = trail.events.find(
      (event) => event.action === "scim.user.delete" && event.entityId === ids.erin,
    )!;
    expect(deleted.actorName).toBe("root");
    expect(deleted.entityKind).toBe("user");
    expect(deleted.changes.length).toBe(1);
    expect(typeof deleted.changes[0].after).toBe("string");
    expect(JSON.stringify(trail.events)).not.toMatch(/passwordHash|sessionVersion/);
  });

  it("keeps every SCIM route classified as administrator access", async () => {
    const policies = await import("@/server/access-policy");
    const scim = Object.keys(policies.REST_POLICIES).filter((key) => key.includes("/api/scim/"));
    expect(scim.length).toBe(12);
    for (const key of scim) expect(policies.REST_POLICIES[key].source).toBe("admin");
    expect(auth.isPublicPath("/api/scim/Users")).toBe(false);
  });
});
