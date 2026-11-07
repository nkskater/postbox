import { describe, expect, it } from "vitest";
import {
  buildEnvironmentSnapshot,
  buildSnapshot,
  canonicalJson,
  diffSnapshots,
} from "@/core/dependencies/model";
import {
  RepositoryError,
  environmentToFiles,
  filesToEnvironment,
  filesToSnapshot,
  filesToSpecification,
  isRepositoryPath,
  repositoryKind,
  slugify,
  snapshotToFiles,
  specificationToFiles,
  stableJson,
  validatePath,
  type FileSet,
} from "@/core/repository/model";
import type { FolderNode, RequestNode, Variable } from "@/core/types";
import { newDraft } from "@/stores/app";

const request = (id: string, name: string, extra: Partial<RequestNode> = {}): RequestNode => {
  const { folderId: _f, ...def } = newDraft({ name, url: `{{base}}/${id}` });
  return { ...def, ...extra, id, name, kind: "request" } as RequestNode;
};
const folder = (
  id: string,
  name: string,
  children: FolderNode["children"],
  extra: Partial<FolderNode> = {},
): FolderNode => ({
  id,
  name,
  kind: "folder",
  description: "",
  auth: { type: "none" } as FolderNode["auth"],
  headers: [],
  preRequestScript: "",
  testScript: "",
  children,
  ...extra,
});
const vars: Variable[] = [
  { key: "base", value: "https://api.test", type: "default", enabled: true },
  { key: "token", value: "hunter2", type: "secret", enabled: true },
];
const sample = () =>
  buildSnapshot(
    folder(
      "root1",
      "Pet Store",
      [
        request("rq1", "List pets", {
          preRequestScript: "pm.variables.set('t', 1);",
          testScript: "pm.test('ok', () => pm.response.to.have.status(200));",
          headers: [
            { key: "Authorization", value: "Bearer real-secret", enabled: true },
            { key: "Accept", value: "application/json", enabled: true },
          ],
        }),
        folder(
          "fd1",
          "Admin tools",
          [request("rq2", "Delete pet"), folder("fd2", "Deep", [request("rq3", "Résumé & café ☕")])],
          { preRequestScript: "// folder script" },
        ),
        request("rq4", "Create pet"),
      ],
      { description: "All the pets" },
    ),
    vars,
  );

describe("writing files", () => {
  it("lays a collection out as one file per request with scripts beside them", () => {
    const files = snapshotToFiles(sample());
    expect(Object.keys(files).sort()).toEqual([
      "admin-tools--fd1/deep--fd2/folder.json",
      "admin-tools--fd1/deep--fd2/resume-cafe--rq3.request.json",
      "admin-tools--fd1/delete-pet--rq2.request.json",
      "admin-tools--fd1/folder.json",
      "admin-tools--fd1/folder.pre-request.js",
      "collection.json",
      "create-pet--rq4.request.json",
      "list-pets--rq1.pre-request.js",
      "list-pets--rq1.request.json",
      "list-pets--rq1.test.js",
      "variables.json",
    ]);
    expect(files["list-pets--rq1.pre-request.js"]).toBe("pm.variables.set('t', 1);\n");
    // Scripts live in their own files, not inside the JSON.
    expect(files["list-pets--rq1.request.json"]).not.toContain("pm.variables.set");
    expect(JSON.parse(files["collection.json"])).toMatchObject({
      id: "root1",
      name: "Pet Store",
      order: ["rq1", "fd1", "rq4"],
    });
  });

  it("keeps scripts exactly as written, including trailing newlines and CRLF-free text", () => {
    for (const script of ["x", "x\n", "x\n\n", "  indented\n  more"]) {
      const snap = buildSnapshot(folder("r", "C", [request("a1", "A", { testScript: script })]), []);
      const back = filesToSnapshot(snapshotToFiles(snap)).snapshot;
      expect(back.root.children[0].data.testScript).toBe(script);
    }
  });

  it("is byte-for-byte stable and independent of key order", () => {
    const a = snapshotToFiles(sample());
    expect(snapshotToFiles(sample())).toEqual(a);
    const shuffled = JSON.parse(JSON.stringify(sample()));
    shuffled.root.children[0].data = Object.fromEntries(
      Object.entries(shuffled.root.children[0].data).reverse(),
    );
    expect(snapshotToFiles(shuffled)).toEqual(a);
    for (const text of Object.values(a)) expect(text.endsWith("\n")).toBe(true);
    expect(stableJson({ b: 1, a: { d: 1, c: 2 } })).toBe(
      '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n',
    );
  });

  it("never writes credentials", () => {
    const text = Object.values(snapshotToFiles(sample())).join("\n");
    expect(text).not.toContain("real-secret");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("{{base}}");
    expect(
      JSON.parse(snapshotToFiles(sample())["variables.json"]).find((v: Variable) => v.key === "token").value,
    ).toBe("");
  });

  it("keeps siblings with the same name apart", () => {
    const snap = buildSnapshot(folder("r", "C", [request("a1", "Same"), request("b2", "Same")]), []);
    const names = Object.keys(snapshotToFiles(snap)).filter((p) => p.endsWith(".request.json"));
    expect(names.sort()).toEqual(["same--a1.request.json", "same--b2.request.json"]);
  });

  it("slugifies names safely", () => {
    expect(slugify("  Hello, Wörld! / ../x ")).toBe("hello-world-x");
    expect(slugify("☕☕")).toBe("untitled");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe("reading files", () => {
  it("round-trips: files → snapshot → files, and the snapshot equals the original", () => {
    const original = sample();
    const files = snapshotToFiles(original);
    const { snapshot, ignored } = filesToSnapshot(files);
    expect(ignored).toEqual([]);
    expect(canonicalJson(snapshot)).toBe(canonicalJson(original));
    expect(snapshotToFiles(snapshot)).toEqual(files);
    expect(diffSnapshots(original, snapshot).identical).toBe(true);
  });

  it("follows the recorded order and appends files added by hand", () => {
    const files = snapshotToFiles(sample());
    const collection = JSON.parse(files["collection.json"]);
    collection.order = ["rq4", "fd1", "rq1"];
    files["collection.json"] = JSON.stringify(collection);
    files["aaa-new.request.json"] = JSON.stringify({
      format: 1,
      name: "Added by hand",
      method: "GET",
      url: "x",
    });
    const { snapshot } = filesToSnapshot(files);
    expect(snapshot.root.children.map((c) => c.data.name)).toEqual([
      "Create pet",
      "Admin tools",
      "List pets",
      "Added by hand",
    ]);
    const added = snapshot.root.children.at(-1)!;
    expect(added.sid).toBe("new:aaa-new.request.json");
    expect(added.data.testScript).toBe("");
  });

  it("picks up a script file added beside a request", () => {
    const files = snapshotToFiles(sample());
    files["create-pet--rq4.test.js"] = "pm.test('x', () => {});\n";
    const create = filesToSnapshot(files).snapshot.root.children.find((c) => c.sid === "rq4")!;
    expect(create.data.testScript).toBe("pm.test('x', () => {});");
  });

  it("ignores unrelated files but refuses orphaned scripts", () => {
    const files: FileSet = { ...snapshotToFiles(sample()), "README.md": "# hi", ".gitignore": "x" };
    expect(filesToSnapshot(files).ignored).toEqual([".gitignore", "README.md"]);
    expect(() => filesToSnapshot({ ...files, "ghost--zz.test.js": "x" })).toThrow(/no request or folder/);
  });

  it("names the offending file for every kind of mistake", () => {
    const good = snapshotToFiles(sample());
    const fails = (mutate: (f: FileSet) => void, match: RegExp, where?: string) => {
      const f = { ...good };
      mutate(f);
      try {
        filesToSnapshot(f);
        throw new Error("should have failed");
      } catch (e) {
        expect(e).toBeInstanceOf(RepositoryError);
        expect((e as Error).message).toMatch(match);
        if (where) expect((e as RepositoryError).path).toBe(where);
      }
    };
    fails((f) => delete f["collection.json"], /collection\.json is missing/);
    fails(
      (f) => (f["create-pet--rq4.request.json"] = "{ nope"),
      /Not valid JSON/,
      "create-pet--rq4.request.json",
    );
    fails(
      (f) => (f["create-pet--rq4.request.json"] = JSON.stringify({ format: 2, name: "x" })),
      /Unsupported format/,
      "create-pet--rq4.request.json",
    );
    fails(
      (f) => (f["create-pet--rq4.request.json"] = JSON.stringify({ format: 1, id: "rq1", name: "dup" })),
      /Duplicate id/,
    );
    fails(
      (f) => (f["create-pet--rq4.request.json"] = JSON.stringify({ format: 1, id: "../x", name: "x" })),
      /Invalid id/,
    );
    fails(
      (f) => (f["create-pet--rq4.request.json"] = JSON.stringify({ format: 1, id: "ok1", url: "x" })),
      /needs a name/,
    );
    fails((f) => (f["variables.json"] = '[{"value":"x"}]'), /./, "variables.json");
    fails((f) => (f["collection.json"] = JSON.stringify({ format: 1, order: [] })), /./, "collection.json");
  });

  it("rejects unsafe paths and oversized input", () => {
    for (const bad of ["../x.json", "/etc/passwd", "a//b", "a\\b", "a/./b", ""])
      expect(() => validatePath(bad)).toThrow(RepositoryError);
    expect(() => filesToSnapshot({ ...snapshotToFiles(sample()), "../evil.json": "{}" })).toThrow(/Unsafe/);
    expect(() =>
      filesToSnapshot({ ...snapshotToFiles(sample()), "big.txt": "x".repeat(3 * 1024 * 1024) }),
    ).toThrow(/too large/);
  });
});

describe("environment files", () => {
  const env = () =>
    buildEnvironmentSnapshot({ id: "env1", name: "Staging" }, [
      { key: "host", value: "stg.test", type: "default", enabled: true },
      { key: "token", value: "hunter2", type: "secret", enabled: true },
    ]);

  it("writes two stable files without the secret and reads them back", () => {
    const files = environmentToFiles(env());
    expect(Object.keys(files).sort()).toEqual(["environment.json", "variables.json"]);
    expect(JSON.stringify(files)).not.toContain("hunter2");
    expect(environmentToFiles(env())).toEqual(files);
    const { snapshot, ignored } = filesToEnvironment({ ...files, "README.md": "x" });
    expect(ignored).toEqual(["README.md"]);
    expect(canonicalJson(snapshot)).toBe(canonicalJson(env()));
    expect(diffSnapshots(env(), snapshot).identical).toBe(true);
    expect(environmentToFiles(snapshot)).toEqual(files);
  });

  it("tells the two kinds apart and refuses ambiguity", () => {
    expect(repositoryKind(environmentToFiles(env()))).toBe("environment");
    expect(repositoryKind(snapshotToFiles(sample()))).toBe("collection");
    expect(() => repositoryKind({ "collection.json": "{}", "environment.json": "{}" })).toThrow(/one/);
    expect(() => repositoryKind({})).toThrow(/None of/);
    expect(isRepositoryPath("deep/dir/environment.json")).toBe(true);
    expect(isRepositoryPath("notes.md")).toBe(false);
  });

  it("gives a new id to an environment file without one and rejects mistakes by file", () => {
    const made = filesToEnvironment({ "environment.json": JSON.stringify({ format: 1, name: "Hand made" }) });
    expect(made.snapshot.root.sid).toBe("new:environment.json");
    expect(made.snapshot.variables).toEqual([]);
    const bad = (files: FileSet, where: string) => {
      try {
        filesToEnvironment(files);
        throw new Error("should fail");
      } catch (e) {
        expect((e as RepositoryError).path).toBe(where);
      }
    };
    bad({ "environment.json": "{ nope" }, "environment.json");
    bad({ "environment.json": JSON.stringify({ format: 1, name: "x", surprise: true }) }, "environment.json");
    bad({ "environment.json": JSON.stringify({ format: 2, name: "x" }) }, "environment.json");
    bad(
      { "environment.json": JSON.stringify({ format: 1, name: "x" }), "variables.json": '[{"value":"x"}]' },
      "variables.json",
    );
    expect(() => filesToEnvironment({ "variables.json": "[]" })).toThrow(/environment\.json is missing/);
  });
});

describe("specification files", () => {
  const spec = {
    id: "sp1",
    name: "Pets API",
    label: "draft",
    format: "openapi" as const,
    entrypoint: "openapi.yaml",
    files: [
      { path: "schemas/pet.yaml", content: "type: object\n" },
      { path: "openapi.yaml", content: "openapi: 3.0.0\ninfo: {title: Pets, version: '1'}\npaths: {}\n" },
    ],
  };

  it("writes the sources untouched under source/ and is stable", () => {
    const files = specificationToFiles(spec);
    expect(Object.keys(files).sort()).toEqual([
      "source/openapi.yaml",
      "source/schemas/pet.yaml",
      "specification.json",
    ]);
    expect(files["source/schemas/pet.yaml"]).toBe("type: object\n");
    expect(JSON.parse(files["specification.json"])).toMatchObject({
      id: "sp1",
      name: "Pets API",
      specification: "openapi",
      entrypoint: "openapi.yaml",
      label: "draft",
    });
    expect(specificationToFiles({ ...spec, files: [...spec.files].reverse() })).toEqual(files);
  });

  it("round-trips through files", () => {
    const parsed = filesToSpecification({ ...specificationToFiles(spec), "README.md": "x" });
    expect(parsed).toMatchObject({ id: "sp1", name: "Pets API", label: "draft", ignored: ["README.md"] });
    expect(parsed.source).toEqual({
      format: "openapi",
      entrypoint: "openapi.yaml",
      files: [...spec.files].sort((a, b) => a.path.localeCompare(b.path)),
    });
    expect(
      specificationToFiles({ ...spec, ...parsed.source, id: "sp1", name: parsed.name, label: parsed.label }),
    ).toEqual(specificationToFiles(spec));
  });

  it("recognises the kind and rejects mistakes by file", () => {
    expect(repositoryKind(specificationToFiles(spec))).toBe("specification");
    expect(isRepositoryPath("source/deep/x.yaml")).toBe(true);
    const base = specificationToFiles(spec);
    const bad = (files: FileSet, where: string, match: RegExp) => {
      try {
        filesToSpecification(files);
        throw new Error("should fail");
      } catch (e) {
        expect((e as RepositoryError).path).toBe(where);
        expect((e as Error).message).toMatch(match);
      }
    };
    bad({ ...base, "specification.json": "{ nope" }, "specification.json", /valid JSON/);
    bad(
      {
        ...base,
        "specification.json": JSON.stringify({
          format: 1,
          name: "x",
          specification: "wsdl",
          entrypoint: "a",
        }),
      },
      "specification.json",
      /./,
    );
    const noEntry = { ...base };
    delete noEntry["source/openapi.yaml"];
    bad(noEntry, "specification.json", /no file under source/);
    bad({ ...base, "source/../x.yaml": "x" }, "source/../x.yaml", /Unsafe/);
    expect(() => filesToSpecification({ "source/a.yaml": "x" })).toThrow(/specification\.json is missing/);
    expect(() => repositoryKind({ "collection.json": "{}", "specification.json": "{}" })).toThrow(
      /both present/,
    );
  });
});
