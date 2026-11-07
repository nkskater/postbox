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
