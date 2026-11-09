import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  checksumOf,
  countNodes,
  diffSnapshots,
  planMerge,
  resolveConflicts,
  restoreLocalSecrets,
  stripSecrets,
} from "@/core/dependencies/model";
import type { FolderNode, RequestNode, Variable } from "@/core/types";
import { newDraft } from "@/stores/app";

const request = (id: string, name: string, extra: Partial<RequestNode> = {}): RequestNode => {
  const { folderId: _f, ...def } = newDraft({ name, url: `https://api.test/${id}` });
  return { ...def, ...extra, id, name, kind: "request" } as RequestNode;
};
const folder = (id: string, name: string, children: FolderNode["children"]): FolderNode => ({
  id,
  name,
  kind: "folder",
  description: "",
  auth: { type: "none" } as FolderNode["auth"],
  headers: [],
  preRequestScript: "",
  testScript: "",
  children,
});
const vars = (...pairs: ([string, string] | [string, string, "default" | "secret"])[]): Variable[] =>
  pairs.map((pair) => ({ key: pair[0], value: pair[1], type: pair[2] ?? "default", enabled: true }));

const v1 = () =>
  buildSnapshot(
    folder("root", "Pets", [
      request("r1", "List pets"),
      folder("f1", "Admin", [request("r2", "Delete pet")]),
    ]),
    vars(["baseUrl", "https://api.test"], ["token", "s3cret", "secret"]),
  );
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("snapshots", () => {
  it("never carry credentials, but keep variable references", () => {
    const req = request("r1", "Login", {
      headers: [
        { key: "Authorization", value: "Bearer real-token", enabled: true },
        { key: "X-Api-Key", value: "{{vault:key}}", enabled: true },
        { key: "Accept", value: "application/json", enabled: true },
      ],
      auth: { ...newDraft().auth, type: "bearer", bearer: { token: "real-token" } } as RequestNode["auth"],
      body: { mode: "raw", raw: '{"password":"hunter2","user":"ann"}' } as RequestNode["body"],
    });
    const snap = buildSnapshot(folder("root", "C", [req]), vars(["k", "v"], ["tok", "abc", "secret"]));
    const text = JSON.stringify(snap);
    expect(text).not.toContain("real-token");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abc");
    expect(text).toContain("{{vault:key}}");
    expect(text).toContain("application/json");
    expect(snap.variables.find((v) => v.key === "tok")?.value).toBe("");
  });

  it("have a checksum that depends on content, not key order", () => {
    expect(checksumOf({ a: 1, b: [1, 2] })).toBe(checksumOf({ b: [1, 2], a: 1 }));
    expect(checksumOf(v1())).toBe(checksumOf(clone(v1())));
    const changed = clone(v1());
    changed.root.children[0].data.name = "Renamed";
    expect(checksumOf(changed)).not.toBe(checksumOf(v1()));
  });

  it("count folders and requests", () => {
    expect(countNodes(v1())).toEqual({ folders: 1, requests: 2 });
  });
});

describe("diff", () => {
  it("reports added, removed, changed nodes and variables", () => {
    const next = clone(v1());
    next.root.children[0].data.name = "List all pets";
    next.root.children[1].children = [];
    next.root.children.push({ sid: "r3", kind: "request", data: { name: "Get pet" }, children: [] });
    next.variables = vars(["baseUrl", "https://api.test/v2"], ["extra", "1"]);
    const d = diffSnapshots(v1(), next);
    expect(d.added.map((n) => n.path)).toEqual(["Get pet"]);
    expect(d.removed.map((n) => n.path)).toEqual(["Admin / Delete pet"]);
    expect(d.changed.map((n) => [n.path, n.fields])).toEqual([["List all pets", ["name"]]]);
    expect(d.variables).toEqual([
      { key: "baseUrl", change: "changed" },
      { key: "extra", change: "added" },
      { key: "token", change: "removed" },
    ]);
    expect(diffSnapshots(v1(), v1()).identical).toBe(true);
  });
});

describe("three-way merge", () => {
  const base = v1();
  const action = (plan: ReturnType<typeof planMerge>, sid: string) =>
    plan.entries.find((e) => e.sid === sid)?.action;

  it("takes upstream changes to nodes you did not touch", () => {
    const incoming = clone(base);
    incoming.root.children[0].data.name = "Upstream name";
    const plan = planMerge(base, incoming, clone(base));
    expect(action(plan, "r1")).toBe("update");
    expect(action(plan, "r2")).toBe("keep");
    expect(plan.conflicts).toBe(0);
  });

  it("keeps your edits when upstream left the node alone", () => {
    const local = clone(base);
    local.root.children[0].data.name = "My name";
    const plan = planMerge(base, clone(base), local);
    expect(action(plan, "r1")).toBe("keep");
  });

  it("flags a node both sides changed differently, and resolves it either way", () => {
    const incoming = clone(base);
    incoming.root.children[0].data.name = "Upstream";
    const local = clone(base);
    local.root.children[0].data.name = "Mine";
    const plan = planMerge(base, incoming, local);
    expect(action(plan, "r1")).toBe("conflict");
    expect(plan.conflicts).toBe(1);
    expect(action(resolveConflicts(plan, "keep-local"), "r1")).toBe("keep");
    expect(action(resolveConflicts(plan, "take-incoming"), "r1")).toBe("update");
    // Identical edits on both sides are not a conflict.
    const alike = clone(base);
    alike.root.children[0].data.name = "Upstream";
    expect(action(planMerge(base, incoming, alike), "r1")).toBe("keep");
  });

  it("adds new upstream nodes and removes ones deleted upstream when unchanged here", () => {
    const incoming = clone(base);
    incoming.root.children.push({ sid: "r9", kind: "request", data: { name: "New" }, children: [] });
    incoming.root.children[1].children = [];
    const plan = planMerge(base, incoming, clone(base));
    expect(action(plan, "r9")).toBe("add");
    expect(action(plan, "r2")).toBe("remove");
  });

  it("will not delete a node you changed, or a folder you added to", () => {
    const incoming = clone(base);
    incoming.root.children[1].children = [];
    const edited = clone(base);
    edited.root.children[1].children[0].data.name = "Edited here";
    expect(action(planMerge(base, incoming, edited), "r2")).toBe("conflict");

    const gone = clone(base);
    gone.root.children.splice(1, 1);
    const extra = clone(base);
    extra.root.children[1].children.push({
      sid: "local-1",
      kind: "request",
      data: { name: "Mine" },
      children: [],
    });
    const plan = planMerge(base, gone, extra);
    expect(action(plan, "f1")).toBe("conflict");
    expect(plan.entries.find((e) => e.sid === "f1")?.reason).toContain("you added items");
  });

  it("merges variables by key", () => {
    const incoming = clone(base);
    incoming.variables = vars(["baseUrl", "https://api.test/v2"], ["token", "", "secret"], ["fresh", "1"]);
    const local = clone(base);
    const plan = planMerge(base, incoming, local);
    const byKey = Object.fromEntries(plan.variables.map((v) => [v.key, v.action]));
    expect(byKey).toEqual({ baseUrl: "update", token: "keep", fresh: "add" });
    local.variables = vars(["baseUrl", "https://mine"], ["token", "", "secret"]);
    expect(planMerge(base, incoming, local).variables.find((v) => v.key === "baseUrl")?.action).toBe(
      "conflict",
    );
  });
});

describe("local secrets survive an update", () => {
  it("puts your credentials back where upstream sends blanks", () => {
    const incoming = {
      auth: { type: "bearer", bearer: { token: "" } },
      headers: [{ key: "Authorization", value: "", enabled: true }],
    };
    const local = {
      auth: { type: "bearer", bearer: { token: "mine" } },
      headers: [{ key: "Authorization", value: "Bearer mine", enabled: true }],
    };
    const merged = restoreLocalSecrets(incoming, local) as typeof incoming;
    expect(merged.auth.bearer.token).toBe("mine");
    expect(merged.headers[0].value).toBe("Bearer mine");
    // Upstream values that are not blank win.
    expect(
      (
        restoreLocalSecrets(
          { headers: [{ key: "Authorization", value: "{{vault:t}}", enabled: true }] },
          local,
        ) as typeof incoming
      ).headers[0].value,
    ).toBe("{{vault:t}}");
  });

  it("stripSecrets leaves non-sensitive rows alone", () => {
    expect(stripSecrets([{ key: "Accept", value: "x" }])).toEqual([{ key: "Accept", value: "x" }]);
  });
});
