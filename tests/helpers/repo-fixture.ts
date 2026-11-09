import fs from "node:fs";
import path from "node:path";
import { buildEnvironmentSnapshot, buildSnapshot } from "../../src/core/dependencies/model";
import { environmentToFiles, snapshotToFiles } from "../../src/core/repository/model";
import type { FolderNode, Variable } from "../../src/core/types";

export function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

const request = (id: string, name: string, url: string, extra: Record<string, unknown> = {}) => ({
  kind: "request" as const,
  id,
  name,
  method: "GET",
  url,
  params: [],
  headers: [],
  body: { mode: "none" },
  auth: { type: "inherit" },
  preRequestScript: "",
  testScript: "",
  description: "",
  examples: [],
  ...extra,
});

/** A collection directory (Pets) and an environment directory (Staging) in repository format. */
export function writeWorkspaceFixture(root: string, base: string) {
  const tree = {
    kind: "folder",
    id: "col1",
    name: "Pets",
    description: "",
    auth: { type: "inherit" },
    headers: [],
    preRequestScript: "",
    testScript: "",
    children: [
      request("req1", "Get pet", "{{base}}/pets/1", {
        headers: [{ key: "X-Api-Key", value: "{{apiKey}}", enabled: true }],
        testScript:
          'pm.test("found", () => pm.response.to.have.status(200));\npm.test("is a pet", () => pm.expect(pm.response.json().name).to.eql("Rex"));',
      }),
      request("req2", "Missing pet", "{{base}}/pets/404", {
        testScript: 'pm.test("missing", () => pm.response.to.have.status(200));',
      }),
    ],
  } as unknown as FolderNode;
  writeFiles(path.join(root, "api", "pets"), snapshotToFiles(buildSnapshot(tree, [])));
  const variables: Variable[] = [
    { key: "base", value: base, type: "default", enabled: true },
    { key: "apiKey", value: "", type: "secret", enabled: true },
  ];
  writeFiles(
    path.join(root, "api", "staging"),
    environmentToFiles(buildEnvironmentSnapshot({ id: "env1", name: "Staging" }, variables, true)),
  );
}
