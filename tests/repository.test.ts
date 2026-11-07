import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-repo-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const svc = await import("@/server/repository");
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "session" });
const as = <T>(u: UserRow, fn: () => T) => withCaller(caller(u), fn);

let owner: UserRow, viewer: UserRow, outsider: UserRow;
let ws: string, ws2: string;

beforeAll(async () => {
  repo.createWorkspace("Before accounts");
  await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  ws = as(owner, () => repo.createWorkspace("Repo team")).id;
  ws2 = as(owner, () => repo.createWorkspace("Elsewhere")).id;
  as(owner, () => setMember(ws, viewer.username, "viewer"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(name: string) {
  const root = as(owner, () => repo.createFolder(ws, null, { name })).id;
  const list = as(owner, () =>
    repo.createRequest(ws, root, {
      name: "List",
      url: "{{base}}/items",
      testScript: "pm.test('a', () => {});",
      headers: [{ key: "Authorization", value: "Bearer local-secret", enabled: true }],
    }),
  ).id;
  const sub = as(owner, () => repo.createFolder(ws, root, { name: "Admin" })).id;
  const drop = as(owner, () => repo.createRequest(ws, sub, { name: "Drop", url: "{{base}}/drop" })).id;
  as(owner, () =>
    repo.replaceVariables(ws, "collection", root, [
      { key: "base", value: "https://api.test", type: "default", enabled: true },
      { key: "token", value: "tok", type: "secret", enabled: true },
    ]),
  );
  return { root, list, sub, drop };
}
const pull = (root: string) => as(owner, () => svc.exportFiles(root));
const push = (
  root: string,
  files: Record<string, string>,
  extra: Partial<Parameters<typeof svc.pushFiles>[1]> = {},
  who = owner,
) => as(who, () => svc.pushFiles(root, { files, prune: false, force: false, dryRun: false, ...extra }));
const edit = (files: Record<string, string>, file: string, change: (o: Record<string, unknown>) => void) => {
  const o = JSON.parse(files[file]);
  change(o);
  return { ...files, [file]: JSON.stringify(o, null, 2) };
};
const names = (n: ReturnType<typeof repo.getFolderTree>): string[] =>
  n
    ? n.children.flatMap((c) =>
        c.kind === "folder" ? [`${c.name}/`, ...names(c).map((x) => `  ${x}`)] : [c.name],
      )
    : [];

describe("pulling", () => {
  it("gives stable files and a checksum that changes only when the collection does", () => {
    const { root, list } = setup("Pull");
    const a = pull(root);
    expect(pull(root)).toEqual(a);
    expect(a.files["collection.json"]).toContain('"name": "Pull"');
    expect(Object.keys(a.files).some((f) => f.endsWith(".test.js"))).toBe(true);
    const text = JSON.stringify(a.files);
    expect(text).not.toContain("local-secret");
    expect(text).not.toContain('"tok"');
    as(owner, () => repo.updateRequest(list, { description: "changed" }));
    expect(pull(root).checksum).not.toBe(a.checksum);
  });

  it("is refused for people who cannot read it", () => {
    const { root } = setup("PullAccess");
    expect(() => as(outsider, () => svc.exportFiles(root))).toThrow(/not found/i);
    expect(as(viewer, () => svc.exportFiles(root)).files["collection.json"]).toBeTruthy();
  });
});

describe("pushing", () => {
  it("changes nothing when the files were not edited", () => {
    const { root } = setup("Noop");
    const p = pull(root);
    const r = push(root, p.files, { baseChecksum: p.checksum });
    expect(r).toMatchObject({ dryRun: false, applied: { added: 0, updated: 0, removed: 0 } });
    expect(r.dryRun === false && r.checksum).toBe(p.checksum);
  });

  it("applies edits to requests and scripts while keeping local credentials", () => {
    const { root, list } = setup("Edit");
    const p = pull(root);
    const requestFile = Object.keys(p.files).find(
      (f) => f.startsWith("list--") && f.endsWith(".request.json"),
    )!;
    const scriptFile = requestFile.replace(".request.json", ".test.js");
    let files = edit(p.files, requestFile, (o) => {
      o.url = "{{base}}/items?page=2";
      o.name = "List items";
    });
    files = { ...files, [scriptFile]: "pm.test('edited', () => {});\n" };
    const r = push(root, files, { baseChecksum: p.checksum });
    expect(r.dryRun === false && r.applied.updated).toBe(1);
    const stored = repo.getRequest(list)!;
    expect(stored).toMatchObject({
      name: "List items",
      url: "{{base}}/items?page=2",
      testScript: "pm.test('edited', () => {});",
    });
    expect(stored.headers[0].value).toBe("Bearer local-secret");
    expect(repo.listVariables(ws, "collection", root).find((v) => v.key === "token")?.value).toBe("tok");
    // The checksum it returns is the new state: pulling again matches it.
    expect(r.dryRun === false && r.checksum).toBe(pull(root).checksum);
  });

  it("refuses when the collection changed since the pull, unless forced", () => {
    const { root, list } = setup("Stale");
    const p = pull(root);
    as(owner, () => repo.updateRequest(list, { description: "someone else" }));
    const files = edit(
      p.files,
      Object.keys(p.files).find((f) => f.endsWith(".request.json"))!,
      (o) => (o.description = "mine"),
    );
    expect(() => push(root, files, { baseChecksum: p.checksum })).toThrow(/changed since/);
    expect(() => push(root, files)).toThrow(/baseChecksum is required/);
    expect(repo.getRequest(list)?.description).toBe("someone else");
    push(root, files, { force: true });
    expect(repo.getRequest(list)?.description).toBe("mine");
  });

  it("creates requests and folders added as files, then gives them ids", () => {
    const { root } = setup("Add");
    const p = pull(root);
    const files = {
      ...p.files,
      "zzz-new.request.json": JSON.stringify({
        format: 1,
        name: "Fresh",
        method: "POST",
        url: "{{base}}/fresh",
      }),
      "fresh-folder/folder.json": JSON.stringify({ format: 1, name: "Fresh folder" }),
      "fresh-folder/inside.request.json": JSON.stringify({
        format: 1,
        name: "Inside",
        method: "GET",
        url: "x",
      }),
      "zzz-new.test.js": "pm.test('new', () => {});\n",
    };
    const r = push(root, files, { baseChecksum: p.checksum });
    expect(r.dryRun === false && r.applied.added).toBe(3);
    expect(names(repo.getFolderTree(root))).toEqual(
      expect.arrayContaining(["Fresh", "Fresh folder/", "  Inside"]),
    );
    const fresh = repo.getFolderTree(root)!.children.find((c) => c.name === "Fresh")!;
    expect((fresh as { testScript: string }).testScript).toBe("pm.test('new', () => {});");
    // Now the new nodes carry ids, so pushing the re-pulled files is a no-op.
    const again = pull(root);
    expect(Object.keys(again.files).some((f) => f.startsWith("fresh--") && f.endsWith(".request.json"))).toBe(
      true,
    );
    expect(push(root, again.files, { baseChecksum: again.checksum }).dryRun === false).toBe(true);
    expect(pull(root).checksum).toBe(again.checksum);
  });

  it("leaves what is missing alone unless asked to prune", () => {
    const { root, list, sub } = setup("Prune");
    const p = pull(root);
    const without = Object.fromEntries(
      Object.entries(p.files).filter(([f]) => !f.startsWith("list--") && !f.startsWith("admin--")),
    );
    const kept = push(root, without, { baseChecksum: p.checksum });
    expect(kept.dryRun === false && kept.applied.removed).toBe(0);
    expect(repo.getRequest(list)).toBeTruthy();
    expect(repo.getFolder(sub)).toBeTruthy();

    const pruned = push(root, without, { baseChecksum: p.checksum, prune: true });
    expect(pruned.dryRun === false && pruned.applied.removed).toBeGreaterThanOrEqual(2);
    expect(repo.getRequest(list)).toBeNull();
    expect(repo.getFolder(sub)).toBeNull();
  });

  it("applies the recorded order, a rename and variable changes", () => {
    const { root } = setup("Order");
    const p = pull(root);
    let files = edit(p.files, "collection.json", (o) => {
      o.order = [...(o.order as string[])].reverse();
      o.name = "Renamed collection";
    });
    files = {
      ...files,
      "variables.json": JSON.stringify([
        { key: "base", value: "https://v2.test", type: "default", enabled: true },
      ]),
    };
    const r = push(root, files, { baseChecksum: p.checksum, prune: true });
    expect(r.dryRun === false).toBe(true);
    const tree = repo.getFolderTree(root)!;
    expect(tree.name).toBe("Renamed collection");
    expect(tree.children.map((c) => c.name)).toEqual(["Admin", "List"]);
    expect(repo.listVariables(ws, "collection", root).map((v) => [v.key, v.value])).toEqual([
      ["base", "https://v2.test"],
    ]);
  });

  it("previews with a dry run and changes nothing", () => {
    const { root, list } = setup("Dry");
    const p = pull(root);
    const files = edit(
      p.files,
      Object.keys(p.files).find((f) => f.endsWith(".request.json") && f.startsWith("list--"))!,
      (o) => (o.description = "preview"),
    );
    const r = push(root, files, { baseChecksum: p.checksum, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.dryRun && r.diff.changed.map((c) => c.path)).toEqual(["List"]);
    expect(repo.getRequest(list)?.description).toBe("");
  });

  it("rejects files for another collection, bad files, and unauthorized pushes", () => {
    const a = setup("A");
    const b = setup("B");
    const pa = pull(a.root);
    expect(() => push(b.root, pa.files, { force: true })).toThrow(/different collection/);
    expect(() =>
      push(a.root, { ...pa.files, "x.request.json": "{ nope" }, { baseChecksum: pa.checksum }),
    ).toThrow(/x\.request\.json/);
    expect(() => push(a.root, { ...pa.files, "../evil.json": "{}" }, { baseChecksum: pa.checksum })).toThrow(
      /Unsafe/,
    );
    expect(() => push(a.root, pa.files, { baseChecksum: pa.checksum }, viewer)).toThrow(/Insufficient/);
    expect(() => push(a.root, pa.files, { baseChecksum: pa.checksum }, outsider)).toThrow(/not found/i);
    const ignored = push(a.root, { ...pa.files, "README.md": "# docs" }, { baseChecksum: pa.checksum });
    expect(ignored.dryRun === false && ignored.ignored).toEqual(["README.md"]);
  });
});

describe("importing", () => {
  it("creates a new collection from files, secret-free, with its structure", () => {
    const { root } = setup("Source");
    const p = pull(root);
    const made = as(owner, () => svc.importFiles({ workspaceId: ws2, files: p.files })) as Extract<
      ReturnType<typeof svc.importFiles>,
      { kind: "collection" }
    >;
    expect(made).toMatchObject({ name: "Source", folders: 1, requests: 2, ignored: [] });
    expect(made.collectionId).not.toBe(root);
    const copy = repo.getFolderTree(made.collectionId)!;
    expect(names(copy)).toEqual(["List", "Admin/", "  Drop"]);
    expect(
      repo.listVariables(ws2, "collection", made.collectionId).find((v) => v.key === "base")?.value,
    ).toBe("https://api.test");
    // The copy exports the same content under its own ids.
    const exported = as(owner, () => svc.exportFiles(made.collectionId));
    expect(Object.values(exported.files).join("")).not.toContain("local-secret");
    expect(() => as(viewer, () => svc.importFiles({ workspaceId: ws, files: p.files }))).toThrow(
      /Insufficient/,
    );
    expect(() =>
      as(owner, () => svc.importFiles({ workspaceId: ws2, files: { "collection.json": "{}" } })),
    ).toThrow();
  });
});

describe("environments as repository files", () => {
  const makeEnv = (name: string) =>
    as(owner, () =>
      repo.createEnvironment(ws, name, [
        { key: "host", value: "stg.test", type: "default", enabled: true },
        { key: "token", value: "env-secret", type: "secret", enabled: true },
      ]),
    ).id;
  const pullEnv = (id: string) => as(owner, () => svc.exportEnvironmentFiles(id));
  const pushEnv = (
    id: string,
    files: Record<string, string>,
    extra: Partial<Parameters<typeof svc.pushEnvironmentFiles>[1]> = {},
    who = owner,
  ) =>
    as(who, () =>
      svc.pushEnvironmentFiles(id, { files, prune: false, force: false, dryRun: false, ...extra }),
    );
  const values = (id: string) =>
    Object.fromEntries(repo.getEnvironment(id)!.variables.map((v) => [v.key, v.value]));

  it("writes two stable, secret-free files", () => {
    const id = makeEnv("Staging");
    const a = pullEnv(id);
    expect(Object.keys(a.files).sort()).toEqual(["environment.json", "variables.json"]);
    expect(JSON.stringify(a.files)).not.toContain("env-secret");
    expect(pullEnv(id)).toEqual(a);
    expect(JSON.parse(a.files["environment.json"])).toMatchObject({ id, name: "Staging", format: 1 });
  });

  it("applies edited variables and a rename, keeping the stored secret", () => {
    const id = makeEnv("Edit env");
    const p = pullEnv(id);
    const files = {
      "environment.json": JSON.stringify({ format: 1, id, name: "Edit env (renamed)" }),
      "variables.json": JSON.stringify([
        { key: "host", value: "prod.test", type: "default", enabled: true },
        { key: "token", value: "", type: "secret", enabled: true },
        { key: "region", value: "eu", type: "default", enabled: true },
      ]),
    };
    const r = pushEnv(id, files, { baseChecksum: p.checksum });
    expect(r.dryRun).toBe(false);
    expect(repo.getEnvironment(id)?.name).toBe("Edit env (renamed)");
    expect(values(id)).toEqual({ host: "prod.test", token: "env-secret", region: "eu" });
    expect(r.dryRun === false && r.checksum).toBe(pullEnv(id).checksum);
  });

  it("refuses stale pushes, keeps missing variables unless pruning, and previews with a dry run", () => {
    const id = makeEnv("Stale env");
    const p = pullEnv(id);
    const only = {
      ...p.files,
      "variables.json": JSON.stringify([{ key: "host", value: "x", type: "default", enabled: true }]),
    };
    const dry = pushEnv(id, only, { baseChecksum: p.checksum, dryRun: true });
    expect(dry.dryRun && dry.diff.variables.map((v) => `${v.key}:${v.change}`)).toEqual([
      "host:changed",
      "token:removed",
    ]);
    expect(values(id).host).toBe("stg.test");
    pushEnv(id, only, { baseChecksum: p.checksum });
    expect(values(id)).toEqual({ host: "x", token: "env-secret" });
    expect(() => pushEnv(id, only, { baseChecksum: p.checksum })).toThrow(/changed since/);
    pushEnv(id, only, { force: true, prune: true });
    expect(values(id)).toEqual({ host: "x" });
  });

  it("rejects collection files, other environments, bad files and unauthorized pushes", () => {
    const a = makeEnv("A env");
    const b = makeEnv("B env");
    const pa = pullEnv(a);
    const col = setup("Not an env").root;
    expect(() => pushEnv(a, pull(col).files, { force: true })).toThrow(/collection, not an environment/);
    expect(() => pushEnv(b, pa.files, { force: true })).toThrow(/different environment/);
    expect(() =>
      pushEnv(a, { ...pa.files, "variables.json": "{ nope" }, { baseChecksum: pa.checksum }),
    ).toThrow(/variables\.json/);
    expect(() => pushEnv(a, pa.files, { baseChecksum: pa.checksum }, viewer)).toThrow(/Insufficient/);
    expect(() => as(outsider, () => svc.exportEnvironmentFiles(a))).toThrow(/not found/i);
    expect(() => pushEnv(a, { ...pa.files, "collection.json": "{}" }, { baseChecksum: pa.checksum })).toThrow(
      /one/,
    );
  });

  it("imports an environment, and tells a collection from an environment by its files", () => {
    const id = makeEnv("Source env");
    const p = pullEnv(id);
    const made = as(owner, () => svc.importFiles({ workspaceId: ws2, files: p.files })) as Extract<
      ReturnType<typeof svc.importFiles>,
      { kind: "environment" }
    >;
    expect(made).toMatchObject({ kind: "environment", name: "Source env", variables: 2 });
    expect(made.environmentId).not.toBe(id);
    expect(
      Object.fromEntries(repo.getEnvironment(made.environmentId)!.variables.map((v) => [v.key, v.value])),
    ).toEqual({ host: "stg.test", token: "" });
    expect(() =>
      as(owner, () => svc.importFiles({ workspaceId: ws2, files: { "variables.json": "[]" } })),
    ).toThrow(/Neither/);
  });
});
