import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-deps-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { getDb, schema } = await import("@/server/db");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const deps = await import("@/server/dependencies");
const mocks = await import("@/server/mocks");
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "session" });
const as = <T>(u: UserRow, fn: () => T) => withCaller(caller(u), fn);

let author: UserRow, dev: UserRow, stranger: UserRow;
let wsA: string, wsB: string, source: string;
let listPets: string, deletePet: string, adminFolder: string;

beforeAll(async () => {
  repo.createWorkspace("Before accounts");
  await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  author = await users.createUser({ username: "author", password: "password123" });
  dev = await users.createUser({ username: "dev", password: "password123" });
  stranger = await users.createUser({ username: "stranger", password: "password123" });
  wsA = as(author, () => repo.createWorkspace("Platform")).id;
  as(author, () => setMember(wsA, dev.username, "editor"));
  wsB = as(dev, () => repo.createWorkspace("Product")).id;
  as(author, () => {
    source = repo.createFolder(wsA, null, { name: "Pets API" }).id;
    listPets = repo.createRequest(wsA, source, {
      name: "List pets",
      url: "{{baseUrl}}/pets",
      headers: [{ key: "Authorization", value: "Bearer author-secret", enabled: true }],
    }).id;
    adminFolder = repo.createFolder(wsA, source, { name: "Admin" }).id;
    deletePet = repo.createRequest(wsA, adminFolder, { name: "Delete pet", url: "{{baseUrl}}/pets/1" }).id;
    repo.replaceVariables(wsA, "collection", source, [
      { key: "baseUrl", value: "https://pets.test", type: "default", enabled: true },
      { key: "apiKey", value: "author-key", type: "secret", enabled: true },
    ]);
  });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const publish = (version: string, visibility: "workspace" | "instance" = "workspace", who = author) =>
  as(who, () => deps.publishRelease(source, { version, notes: "", visibility }));
const release = (version: string) =>
  as(author, () => deps.listReleases(source)).find((r) => r.version === version)!;
const treeOf = (folderId: string) => repo.getFolderTree(folderId)!;
const names = (n: ReturnType<typeof treeOf>): string[] =>
  n.children.flatMap((c) =>
    c.kind === "folder" ? [`${c.name}/`, ...names(c).map((x) => `  ${x}`)] : [c.name],
  );
const install = (releaseId: string, workspaceId = wsB) =>
  as(dev, () => deps.installRelease({ workspaceId, releaseId }));
const find = (folderId: string, name: string) => {
  const walk = (
    n: ReturnType<typeof treeOf> | ReturnType<typeof treeOf>["children"][number],
  ): string | null => {
    if (n.kind === "request") return n.name === name ? n.id : null;
    for (const c of n.children) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(treeOf(folderId));
};

describe("publishing", () => {
  it("publishes an immutable, secret-free version", () => {
    const v1 = publish("1.0.0");
    expect(v1).toMatchObject({ version: "1.0.0", seq: 1, folderCount: 1, requestCount: 2, revokedAt: null });
    const stored = getDb()
      .select()
      .from(schema.dependencyReleases)
      .where(eq(schema.dependencyReleases.id, v1.id))
      .get()!;
    const text = JSON.stringify(stored.snapshot);
    expect(text).not.toContain("author-secret");
    expect(text).not.toContain("author-key");
    expect(text).toContain("{{baseUrl}}/pets");
  });

  it("refuses repeats, unchanged content, folders, and people without the right role", () => {
    expect(() => publish("1.0.0")).toThrow(/already published/);
    expect(() => publish("1.0.1")).toThrow(/Nothing has changed/);
    expect(() =>
      as(author, () =>
        deps.publishRelease(adminFolder, { version: "1", notes: "", visibility: "workspace" }),
      ),
    ).toThrow(/whole collection/);
    expect(() =>
      as(stranger, () => deps.publishRelease(source, { version: "9", notes: "", visibility: "workspace" })),
    ).toThrow(/not found/i);
    // An editor may publish to their workspace, but instance-wide needs the manage role.
    expect(() => publish("2.0.0", "instance", dev)).toThrow(/Insufficient/);
  });

  it("only lets members see a workspace-visible release", () => {
    const v1 = release("1.0.0");
    expect(as(dev, () => deps.getRelease(v1.id)).version).toBe("1.0.0");
    expect(() => as(stranger, () => deps.getRelease(v1.id))).toThrow(/not found/i);
    expect(as(dev, () => deps.browseReleases(wsB)).map((r) => r.id)).toContain(v1.id);
    expect(as(stranger, () => repo.createWorkspace("Elsewhere")).id).toBeTruthy();
  });
});

describe("installing", () => {
  it("copies the collection pinned to the version, with secrets left blank", () => {
    const v1 = release("1.0.0");
    const inst = install(v1.id);
    expect(inst).toMatchObject({ version: "1.0.0", status: "current", modified: false, name: "Pets API" });
    const tree = treeOf(inst.folderId);
    expect(names(tree)).toEqual(["List pets", "Admin/", "  Delete pet"]);
    const req = repo.getRequest(find(inst.folderId, "List pets")!)!;
    expect(req.headers[0].value).toBe("");
    const vars = repo.listVariables(wsB, "collection", inst.folderId);
    expect(vars.find((v) => v.key === "baseUrl")?.value).toBe("https://pets.test");
    expect(vars.find((v) => v.key === "apiKey")?.value).toBe("");
    expect(as(dev, () => deps.listInstalls(wsB)).map((i) => i.id)).toContain(inst.id);
  });

  it("will not install into the source workspace, without access, or a withdrawn version", () => {
    const v1 = release("1.0.0");
    expect(() => install(v1.id, wsA)).toThrow(/different one|another one/);
    expect(() => as(stranger, () => deps.installRelease({ workspaceId: wsB, releaseId: v1.id }))).toThrow();
  });
});

describe("updating", () => {
  let inst: ReturnType<typeof deps.installRelease>;
  let v2: ReturnType<typeof publish>;
  beforeAll(() => {
    // Fresh install for this scenario, then the author changes things upstream.
    inst = install(release("1.0.0").id);
    // Local work: a credential, an edit to one request, and a request of their own.
    const list = find(inst.folderId, "List pets")!;
    repo.updateRequest(list, {
      headers: [{ key: "Authorization", value: "Bearer my-own-token", enabled: true }],
    });
    repo.createRequest(wsB, inst.folderId, { name: "My extra" });
    as(author, () => {
      repo.updateRequest(deletePet, { name: "Remove pet" });
      repo.createRequest(wsA, source, { name: "Get pet" });
      repo.updateRequest(listPets, { description: "All pets, paged" });
      repo.replaceVariables(wsA, "collection", source, [
        { key: "baseUrl", value: "https://pets.test/v2", type: "default", enabled: true },
        { key: "apiKey", value: "author-key", type: "secret", enabled: true },
        { key: "region", value: "eu", type: "default", enabled: true },
      ]);
    });
    v2 = publish("1.1.0");
  });

  it("reports the new version and what would change", () => {
    const view = as(dev, () => deps.getInstall(inst.id));
    expect(view).toMatchObject({ status: "update-available", latestVersion: "1.1.0", modified: true });
    const preview = as(dev, () => deps.previewUpdate(inst.id));
    expect(preview.diff.added.map((n) => n.path)).toEqual(["Get pet"]);
    expect(preview.diff.changed.map((n) => n.path).sort()).toEqual(["Admin / Remove pet", "List pets"]);
    expect(preview.diff.variables.map((v) => `${v.key}:${v.change}`)).toEqual([
      "baseUrl:changed",
      "region:added",
    ]);
    expect(preview.plan.conflicts).toBe(0);
  });

  it("applies upstream changes and keeps local credentials, edits and additions", () => {
    const result = as(dev, () => deps.updateInstall(inst.id, { releaseId: v2.id, strategy: "abort" }));
    expect(result.applied).toMatchObject({ added: 1, updated: 2, removed: 0 });
    expect(result.dependency).toMatchObject({ version: "1.1.0", status: "current" });
    expect(names(treeOf(inst.folderId)).sort()).toEqual(
      ["  Remove pet", "Admin/", "Get pet", "List pets", "My extra"].sort(),
    );
    const list = repo.getRequest(find(inst.folderId, "List pets")!)!;
    expect(list.description).toBe("All pets, paged");
    // The local credential survived an update that touched the same request.
    expect(list.headers[0].value).toBe("Bearer my-own-token");
    const vars = Object.fromEntries(
      repo.listVariables(wsB, "collection", inst.folderId).map((v) => [v.key, v.value]),
    );
    expect(vars).toMatchObject({ baseUrl: "https://pets.test/v2", region: "eu" });
  });

  it("refuses to move to the version it is already on", () => {
    expect(() => as(dev, () => deps.updateInstall(inst.id, { releaseId: v2.id, strategy: "abort" }))).toThrow(
      /Already on/,
    );
  });
});

describe("conflicts", () => {
  it("stops on a node both sides changed, then settles it either way", () => {
    const tag = (n: number) => `Conflict ${n}`;
    const make = () => {
      const inst = install(as(author, () => deps.listReleases(source))[0].id);
      return inst;
    };
    // Two installs of the latest release, so each strategy starts from the same place.
    const a = make();
    const b = make();
    as(author, () => repo.updateRequest(listPets, { name: tag(0) }));
    const next = publish("1.2.0");
    for (const inst of [a, b])
      repo.updateRequest(find(inst.folderId, "List pets")!, { name: "Local rename" });

    expect(as(dev, () => deps.previewUpdate(a.id)).plan.conflicts).toBe(1);
    expect(() => as(dev, () => deps.updateInstall(a.id, { releaseId: next.id, strategy: "abort" }))).toThrow(
      /conflict/,
    );
    // Nothing was applied by the failed attempt.
    expect(find(a.folderId, "Local rename")).toBeTruthy();

    as(dev, () => deps.updateInstall(a.id, { releaseId: next.id, strategy: "keep-local" }));
    expect(find(a.folderId, "Local rename")).toBeTruthy();
    expect(as(dev, () => deps.getInstall(a.id)).version).toBe("1.2.0");

    as(dev, () => deps.updateInstall(b.id, { releaseId: next.id, strategy: "take-incoming" }));
    expect(find(b.folderId, tag(0))).toBeTruthy();
    expect(find(b.folderId, "Local rename")).toBeNull();
  });

  it("removes what upstream removed, unless it was changed or you added to it", () => {
    const base = as(author, () => deps.listReleases(source))[0];
    const clean = install(base.id);
    const dirty = install(base.id);
    repo.updateRequest(find(dirty.folderId, "Remove pet")!, { description: "mine" });
    as(author, () => repo.deleteRequest(deletePet));
    const gone = publish("1.3.0");
    expect(
      as(dev, () => deps.updateInstall(clean.id, { releaseId: gone.id, strategy: "abort" })).applied.removed,
    ).toBe(1);
    expect(find(clean.folderId, "Remove pet")).toBeNull();
    expect(() =>
      as(dev, () => deps.updateInstall(dirty.id, { releaseId: gone.id, strategy: "abort" })),
    ).toThrow(/conflict/);
    expect(find(dirty.folderId, "Remove pet")).toBeTruthy();
  });
});

describe("withdrawal and availability", () => {
  it("flags installs of a withdrawn version and refuses to install or update to it", () => {
    const latest = as(author, () => deps.listReleases(source))[0];
    const inst = install(latest.id);
    const next = (() => {
      as(author, () => repo.updateRequest(listPets, { description: "next" }));
      return publish("2.0.0");
    })();
    as(author, () => deps.revokeRelease(next.id, "Broke the auth flow"));
    expect(() => install(next.id)).toThrow(/withdrawn/);
    expect(() =>
      as(dev, () => deps.updateInstall(inst.id, { releaseId: next.id, strategy: "abort" })),
    ).toThrow(/withdrawn/);
    // The installed (older) version is still fine, and the withdrawn one is not offered as the newest.
    expect(as(dev, () => deps.getInstall(inst.id)).latestVersion).not.toBe("2.0.0");
    as(author, () => deps.revokeRelease(latest.id, "Also bad"));
    expect(as(dev, () => deps.getInstall(inst.id))).toMatchObject({
      status: "withdrawn",
      withdrawnReason: "Also bad",
    });
    expect(() => as(dev, () => deps.revokeRelease(latest.id, "x"))).toThrow(/Insufficient/);
  });

  it("reports an unavailable source once access is removed or the source is deleted", () => {
    const wsC = as(author, () => repo.createWorkspace("Temporary")).id;
    as(author, () => setMember(wsC, dev.username, "editor"));
    const tmpSource = as(author, () => repo.createFolder(wsC, null, { name: "Temp API" })).id;
    as(author, () => repo.createRequest(wsC, tmpSource, { name: "Ping" }));
    const rel = as(author, () =>
      deps.publishRelease(tmpSource, { version: "1", notes: "", visibility: "workspace" }),
    );
    const inst = install(rel.id);
    expect(as(dev, () => deps.getInstall(inst.id)).status).toBe("current");

    // Access removed: the release can no longer be seen, so the dependency cannot be updated.
    as(author, () => setMember(wsC, dev.username, null));
    expect(as(dev, () => deps.getInstall(inst.id)).status).toBe("source-unavailable");
    expect(() => as(dev, () => deps.previewUpdate(inst.id))).toThrow(/no longer available/);
    // The local copy is untouched and still works.
    expect(find(inst.folderId, "Ping")).toBeTruthy();

    // Source gone entirely.
    as(author, () => setMember(wsC, dev.username, "editor"));
    as(author, () => repo.deleteWorkspace(wsC));
    expect(as(dev, () => deps.getInstall(inst.id)).status).toBe("source-unavailable");
    expect(find(inst.folderId, "Ping")).toBeTruthy();
  });

  it("unlinks without touching the copy, or deletes it on request; deleting the collection unlinks it", () => {
    const rel = as(author, () => deps.listReleases(source)).find((r) => !r.revokedAt)!;
    const keep = install(rel.id);
    as(dev, () => deps.removeInstall(keep.id, false));
    expect(repo.getFolder(keep.folderId)).toBeTruthy();
    expect(() => as(dev, () => deps.getInstall(keep.id))).toThrow(/not found/i);

    const drop = install(rel.id);
    as(dev, () => deps.removeInstall(drop.id, true));
    expect(repo.getFolder(drop.folderId)).toBeNull();

    const gone = install(rel.id);
    repo.deleteFolder(gone.folderId);
    expect(() => as(dev, () => deps.getInstall(gone.id))).toThrow(/not found/i);
  });

  it("serves instance-wide releases to people outside the source workspace", () => {
    const tmp = as(author, () => repo.createFolder(wsA, null, { name: "Public API" })).id;
    as(author, () => repo.createRequest(wsA, tmp, { name: "Health" }));
    const rel = as(author, () =>
      deps.publishRelease(tmp, { version: "1", notes: "", visibility: "instance" }),
    );
    expect(as(stranger, () => deps.getRelease(rel.id)).version).toBe("1");
    const strangerWs = as(stranger, () => repo.createWorkspace("Mine")).id;
    const got = as(stranger, () => deps.installRelease({ workspaceId: strangerWs, releaseId: rel.id }));
    expect(got.status).toBe("current");
  });
});

describe("environments as dependencies", () => {
  let env: string;
  const envVars = (...pairs: [string, string, ("default" | "secret")?][]) =>
    pairs.map(([key, value, type]) => ({ key, value, type: type ?? ("default" as const), enabled: true }));
  const publishEnv = (version: string, who = author) =>
    as(who, () => deps.publishEnvironmentRelease(env, { version, notes: "", visibility: "workspace" }));
  const envRelease = (version: string) =>
    as(author, () => deps.listReleases(env, "environment")).find((r) => r.version === version)!;
  const envInstall = (releaseId: string) =>
    as(dev, () => deps.installRelease({ workspaceId: wsB, releaseId }));
  const valuesOf = (id: string) =>
    Object.fromEntries(repo.getEnvironment(id)!.variables.map((v) => [v.key, v.value]));

  beforeAll(() => {
    env = as(author, () =>
      repo.createEnvironment(
        wsA,
        "Staging",
        envVars(["host", "stg.test"], ["token", "author-secret", "secret"]),
      ),
    ).id;
  });

  it("publishes variables with secret values blanked, and refuses repeats", () => {
    const v1 = publishEnv("1.0.0");
    expect(v1).toMatchObject({ kind: "environment", version: "1.0.0", name: "Staging" });
    const stored = getDb()
      .select()
      .from(schema.dependencyReleases)
      .where(eq(schema.dependencyReleases.id, v1.id))
      .get()!;
    expect(JSON.stringify(stored.snapshot)).not.toContain("author-secret");
    expect(() => publishEnv("1.0.1")).toThrow(/Nothing has changed/);
    expect(() => publishEnv("1.0.0")).toThrow(/already published/);
    expect(() => as(stranger, () => deps.listReleases(env, "environment"))).toThrow(/not found/i);
    // Releases are listed per kind: the collection's list does not include environment versions.
    expect(as(author, () => deps.listReleases(source)).every((r) => r.kind === "collection")).toBe(true);
  });

  it("installs as a new environment and shows up beside collection dependencies", () => {
    const inst = envInstall(envRelease("1.0.0").id);
    expect(inst).toMatchObject({ kind: "environment", status: "current", modified: false, name: "Staging" });
    expect(repo.getEnvironment(inst.folderId)?.name).toBe("Staging");
    expect(valuesOf(inst.folderId)).toEqual({ host: "stg.test", token: "" });
    const kinds = as(dev, () => deps.listInstalls(wsB)).map((i) => i.kind);
    expect(kinds).toContain("environment");
    expect(kinds).toContain("collection");
  });

  it("updates variables and the name, keeping the user's own secret and additions", () => {
    const inst = envInstall(envRelease("1.0.0").id);
    // Local: fill the secret in, add a variable of their own.
    const local = repo.getEnvironment(inst.folderId)!;
    repo.replaceVariables(wsB, "environment", inst.folderId, [
      ...local.variables.map((v) => (v.key === "token" ? { ...v, value: "my-token" } : v)),
      { key: "mine", value: "1", type: "default", enabled: true },
    ]);
    expect(as(dev, () => deps.getInstall(inst.id)).modified).toBe(true);
    as(author, () => {
      repo.renameEnvironment(env, "Staging (EU)");
      repo.replaceVariables(
        wsA,
        "environment",
        env,
        envVars(["host", "eu.stg.test"], ["token", "author-secret", "secret"], ["region", "eu"]),
      );
    });
    const v2 = publishEnv("1.1.0");
    const preview = as(dev, () => deps.previewUpdate(inst.id));
    expect(preview.diff.variables.map((v) => `${v.key}:${v.change}`)).toEqual([
      "host:changed",
      "region:added",
    ]);
    expect(preview.plan.conflicts).toBe(0);
    const result = as(dev, () => deps.updateInstall(inst.id, { releaseId: v2.id, strategy: "abort" }));
    expect(result.dependency).toMatchObject({ version: "1.1.0", status: "current" });
    expect(repo.getEnvironment(inst.folderId)?.name).toBe("Staging (EU)");
    expect(valuesOf(inst.folderId)).toEqual({
      host: "eu.stg.test",
      token: "my-token",
      region: "eu",
      mine: "1",
    });
  });

  it("stops when a variable was changed on both sides, then settles it either way", () => {
    const latest = as(author, () => deps.listReleases(env, "environment"))[0];
    const a = envInstall(latest.id);
    const b = envInstall(latest.id);
    as(author, () =>
      repo.replaceVariables(
        wsA,
        "environment",
        env,
        envVars(["host", "up.stg.test"], ["token", "", "secret"], ["region", "eu"]),
      ),
    );
    const next = publishEnv("1.2.0");
    for (const inst of [a, b])
      repo.replaceVariables(
        wsB,
        "environment",
        inst.folderId,
        envVars(["host", "local.test"], ["token", "", "secret"], ["region", "eu"]),
      );
    expect(as(dev, () => deps.previewUpdate(a.id)).plan.conflicts).toBe(1);
    expect(() => as(dev, () => deps.updateInstall(a.id, { releaseId: next.id, strategy: "abort" }))).toThrow(
      /conflict/,
    );
    expect(valuesOf(a.folderId).host).toBe("local.test");
    as(dev, () => deps.updateInstall(a.id, { releaseId: next.id, strategy: "keep-local" }));
    expect(valuesOf(a.folderId).host).toBe("local.test");
    as(dev, () => deps.updateInstall(b.id, { releaseId: next.id, strategy: "take-incoming" }));
    expect(valuesOf(b.folderId).host).toBe("up.stg.test");
  });

  it("flags withdrawn versions and unlinks or deletes cleanly", () => {
    const latest = as(author, () => deps.listReleases(env, "environment"))[0];
    const inst = envInstall(latest.id);
    as(author, () => deps.revokeRelease(latest.id, "wrong host"));
    expect(as(dev, () => deps.getInstall(inst.id))).toMatchObject({
      status: "withdrawn",
      withdrawnReason: "wrong host",
    });
    as(dev, () => deps.removeInstall(inst.id, true));
    expect(repo.getEnvironment(inst.folderId)).toBeNull();

    const other = envInstall(envRelease("1.0.0").id);
    repo.deleteEnvironment(other.folderId);
    expect(() => as(dev, () => deps.getInstall(other.id))).toThrow(/not found/i);
  });

  it("will not mix kinds when updating", () => {
    const inst = envInstall(envRelease("1.0.0").id);
    const collectionRelease = as(author, () => deps.listReleases(source)).find((r) => !r.revokedAt)!;
    expect(() =>
      as(dev, () => deps.updateInstall(inst.id, { releaseId: collectionRelease.id, strategy: "abort" })),
    ).toThrow(/something else/);
  });
});

describe("mock servers as dependencies", () => {
  const example = (n: string) => ({
    id: `ex-${n}`,
    name: "ok",
    status: 200,
    statusText: "OK",
    headers: [],
    body: '{"ok":true}',
    createdAt: Date.now(),
  });
  /** A collection with one saved example, so a mock has routes to serve. */
  const collectionWithExample = (workspaceId: string, who: UserRow, name: string) =>
    as(who, () => {
      const folder = repo.createFolder(workspaceId, null, { name });
      repo.createRequest(workspaceId, folder.id, {
        name: "Get",
        method: "GET",
        url: "https://x.test/get",
        examples: [example(name)],
      });
      return folder.id;
    });
  const scenario = (id: string, ms: number) => ({
    id,
    name: `delay ${id}`,
    enabled: true,
    kind: "delay" as const,
    ms,
    match: {},
  });
  const handler = (id: string, code: string) => ({
    id,
    name: `handler ${id}`,
    enabled: true,
    match: {},
    code,
  });
  let mockId: string;
  let srcCollection: string;
  let dstCollection: string;
  const mockRelease = (version: string) =>
    as(author, () => deps.listReleases(mockId, "mock")).find((r) => r.version === version)!;
  const publishMock = (version: string) =>
    as(author, () => deps.publishMockRelease(mockId, { version, notes: "", visibility: "workspace" }));
  const installMock = (releaseId: string, collectionId = dstCollection) =>
    as(dev, () => deps.installRelease({ workspaceId: wsB, releaseId, collectionId }));
  const stored = (id: string) => as(dev, () => mocks.getMock(id));

  beforeAll(() => {
    srcCollection = collectionWithExample(wsA, author, "Mock source");
    dstCollection = collectionWithExample(wsB, dev, "Mock target");
    mockId = as(author, () =>
      mocks.createMock({
        workspaceId: wsA,
        folderId: srcCollection,
        name: "Shared mock",
        public: true,
        delayMs: 5,
        headers: [
          { key: "X-Mode", value: "stub", enabled: true },
          { key: "Authorization", value: "Bearer author-mock-secret", enabled: true },
        ],
        scenarios: [scenario("slow", 100)],
        handlers: [
          handler("greet", "return { json: { hi: 1 } };"),
          handler("other", "return { json: { n: 2 } };"),
        ],
      }),
    ).id;
  });

  it("publishes settings, scenarios and handlers, but not the key, the public flag or credentials", () => {
    const v1 = publishMock("1.0.0");
    expect(v1).toMatchObject({ kind: "mock", version: "1.0.0", name: "Shared mock", requestCount: 3 });
    const stored = getDb()
      .select()
      .from(schema.dependencyReleases)
      .where(eq(schema.dependencyReleases.id, v1.id))
      .get()!;
    const text = JSON.stringify(stored.snapshot);
    expect(text).not.toContain("author-mock-secret");
    expect(text).not.toContain("keyHash");
    expect(text).not.toContain('"public"');
    expect(text).toContain("X-Mode");
    expect(() => publishMock("1.0.1")).toThrow(/Nothing has changed/);
    expect(() => as(stranger, () => deps.listReleases(mockId, "mock"))).toThrow(/not found/i);
    expect(as(author, () => deps.listReleases(srcCollection)).every((r) => r.kind === "collection")).toBe(
      true,
    );
  });

  it("installs bound to a chosen collection, private, with its own key", () => {
    const rel = mockRelease("1.0.0");
    expect(() => as(dev, () => deps.installRelease({ workspaceId: wsB, releaseId: rel.id }))).toThrow(
      /Choose the collection/,
    );
    expect(() => installMock(rel.id, srcCollection)).toThrow(/not found/i);
    const inst = installMock(rel.id);
    expect(inst).toMatchObject({ kind: "mock", status: "current", modified: false, name: "Shared mock" });
    expect(typeof inst.mockKey).toBe("string");
    const copy = stored(inst.folderId);
    expect(copy).toMatchObject({
      workspaceId: wsB,
      folderId: dstCollection,
      public: false,
      delayMs: 5,
      routeCount: 1,
    });
    expect(copy.scenarios.map((x) => x.id)).toEqual(["slow"]);
    expect(copy.handlers.map((x) => x.id)).toEqual(["greet", "other"]);
    expect(JSON.stringify(copy.headers)).not.toContain("author-mock-secret");
    expect(as(dev, () => deps.listInstalls(wsB)).map((i) => i.kind)).toContain("mock");
  });

  it("updates changed scenarios and handlers, keeping the copy's edits and public flag", () => {
    const inst = installMock(mockRelease("1.0.0").id);
    // Local: edit one handler and make the copy public.
    as(dev, () =>
      mocks.updateMock(inst.folderId, {
        public: true,
        handlers: [
          handler("greet", "return { json: { hi: 1 } };"),
          handler("other", "return { json: { mine: true } };"),
        ],
      }),
    );
    expect(as(dev, () => deps.getInstall(inst.id)).modified).toBe(true);
    // Upstream: retune the delay, edit a different handler, add a scenario, change settings.
    as(author, () =>
      mocks.updateMock(mockId, {
        delayMs: 50,
        scenarios: [scenario("slow", 100), scenario("slower", 900)],
        handlers: [
          handler("greet", "return { json: { hi: 2 } };"),
          handler("other", "return { json: { n: 2 } };"),
        ],
      }),
    );
    const v2 = publishMock("1.1.0");
    const preview = as(dev, () => deps.previewUpdate(inst.id));
    expect(preview.plan.conflicts).toBe(0);
    const result = as(dev, () => deps.updateInstall(inst.id, { releaseId: v2.id, strategy: "abort" }));
    expect(result.applied).toMatchObject({ added: 1, updated: 2 });
    const copy = stored(inst.folderId);
    expect(copy.delayMs).toBe(50);
    expect(copy.public).toBe(true);
    expect(copy.scenarios.map((x) => x.id)).toEqual(["slow", "slower"]);
    expect(copy.handlers.find((h) => h.id === "greet")?.code).toContain("hi: 2");
    expect(copy.handlers.find((h) => h.id === "other")?.code).toContain("mine: true");
    const raw = getDb()
      .select()
      .from(schema.mockServers)
      .where(eq(schema.mockServers.id, inst.folderId))
      .get()!;
    // A mock never stores credential-looking header values (its own rule), and none travelled either way.
    expect(JSON.stringify(raw.headers)).not.toContain("author-mock-secret");
    expect(raw.headers.find((h) => h.key === "X-Mode")?.value).toBe("stub");
    expect(as(dev, () => deps.getInstall(inst.id))).toMatchObject({ version: "1.1.0", status: "current" });
  });

  it("stops when the same handler changed on both sides, then settles it either way", () => {
    const latest = as(author, () => deps.listReleases(mockId, "mock"))[0];
    const a = installMock(latest.id);
    const b = installMock(latest.id);
    as(author, () =>
      mocks.updateMock(mockId, {
        handlers: [
          handler("greet", "return { json: { hi: 'upstream' } };"),
          handler("other", "return { json: { n: 2 } };"),
        ],
      }),
    );
    const next = publishMock("1.2.0");
    for (const inst of [a, b])
      as(dev, () =>
        mocks.updateMock(inst.folderId, {
          handlers: [
            handler("greet", "return { json: { hi: 'local' } };"),
            handler("other", "return { json: { n: 2 } };"),
          ],
        }),
      );
    expect(as(dev, () => deps.previewUpdate(a.id)).plan.conflicts).toBe(1);
    expect(() => as(dev, () => deps.updateInstall(a.id, { releaseId: next.id, strategy: "abort" }))).toThrow(
      /conflict/,
    );
    expect(stored(a.folderId).handlers[0].code).toContain("local");
    as(dev, () => deps.updateInstall(a.id, { releaseId: next.id, strategy: "keep-local" }));
    expect(stored(a.folderId).handlers[0].code).toContain("local");
    as(dev, () => deps.updateInstall(b.id, { releaseId: next.id, strategy: "take-incoming" }));
    expect(stored(b.folderId).handlers[0].code).toContain("upstream");
  });

  it("flags withdrawn versions, and unlinks or deletes cleanly", () => {
    const latest = as(author, () => deps.listReleases(mockId, "mock"))[0];
    const inst = installMock(latest.id);
    as(author, () => deps.revokeRelease(latest.id, "bad handler"));
    expect(as(dev, () => deps.getInstall(inst.id))).toMatchObject({
      status: "withdrawn",
      withdrawnReason: "bad handler",
    });
    as(dev, () => deps.removeInstall(inst.id, true));
    expect(() => stored(inst.folderId)).toThrow(/not found/i);

    const ok = mockRelease("1.0.0");
    const other = installMock(ok.id);
    as(dev, () => mocks.deleteMock(other.folderId));
    expect(() => as(dev, () => deps.getInstall(other.id))).toThrow(/not found/i);
  });

  it("will not mix kinds when updating", () => {
    const inst = installMock(mockRelease("1.0.0").id);
    const collectionRelease = as(author, () => deps.listReleases(source)).find((r) => !r.revokedAt)!;
    expect(() =>
      as(dev, () => deps.updateInstall(inst.id, { releaseId: collectionRelease.id, strategy: "abort" })),
    ).toThrow(/something else/);
  });
});
