import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_GOVERNANCE } from "@/core/governance/model";
import type { UserRow } from "@/server/db/schema";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-governance-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const repo = await import("@/server/repo"),
  users = await import("@/server/users"),
  governance = await import("@/server/governance"),
  specs = await import("@/server/specifications"),
  db = await import("@/server/db"),
  backup = await import("@/server/backup");
const { withCaller } = await import("@/server/access-context"),
  { setMember } = await import("@/server/authorize");
let owner: UserRow, viewer: UserRow, outsider: UserRow, ws: string, specId: string;
const tokens: Record<string, string> = {};
const caller = (user: UserRow) => ({ kind: "user" as const, user, via: "token" as const });
beforeAll(async () => {
  owner = await users.createUser({ username: "gov-owner", password: "password123" });
  viewer = await users.createUser({ username: "gov-viewer", password: "password123" });
  outsider = await users.createUser({ username: "gov-outsider", password: "password123" });
  for (const user of [owner, viewer, outsider]) tokens[user.id] = users.createToken(user.id, "test").token;
  withCaller(caller(owner), () => {
    ws = repo.createWorkspace("Governance").id;
    setMember(ws, viewer.username, "viewer");
    specId = specs.createSpecification({
      workspaceId: ws,
      name: "API",
      format: "openapi",
      entrypoint: "api.yaml",
      files: [
        {
          path: "api.yaml",
          content:
            'openapi: 3.0.3\ninfo: {title: API, version: "1"}\npaths:\n  /health:\n    get:\n      responses:\n        "200": {description: OK}\n',
        },
      ],
    }).id;
  });
});
afterAll(() => {
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function request(
  method: string,
  kind: "sets" | "set" | "binding" | "lint" | "reports",
  id: string,
  user: UserRow,
  body?: unknown,
) {
  const mod =
    kind === "sets"
      ? await import("@/app/api/governance/rulesets/route")
      : kind === "set"
        ? await import("@/app/api/governance/rulesets/[id]/route")
        : kind === "binding"
          ? await import("@/app/api/specifications/[id]/governance/route")
          : kind === "lint"
            ? await import("@/app/api/specifications/[id]/governance/lint/route")
            : await import("@/app/api/specifications/[id]/governance/reports/route");
  const url =
    kind === "sets"
      ? `/api/governance/rulesets?workspaceId=${ws}`
      : kind === "set"
        ? `/api/governance/rulesets/${id}`
        : `/api/specifications/${id}/governance${kind === "binding" ? "" : kind === "lint" ? "/lint" : "/reports"}`;
  return (mod as Record<string, (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>>)[
    method
  ](
    new Request("http://localhost" + url, {
      method,
      headers: { authorization: `Bearer ${tokens[user.id]}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
describe("governance versions, assignments, reports and workspace access", () => {
  it("enforces read/write boundaries for policies, previews, report persistence and bindings", async () => {
    expect(
      (await request("POST", "sets", "", viewer, { workspaceId: ws, config: DEFAULT_GOVERNANCE })).status,
    ).toBe(403);
    const response = await request("POST", "sets", "", owner, {
      workspaceId: ws,
      config: DEFAULT_GOVERNANCE,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const policy = await response.json();
    expect((await request("GET", "set", policy.id, outsider)).status).toBe(404);
    expect((await request("GET", "set", policy.id, viewer)).status).toBe(200);
    expect(
      (await request("PUT", "binding", specId, viewer, { ruleSetId: policy.id, expectedRevision: 0 })).status,
    ).toBe(403);
    expect(
      (await request("PUT", "binding", specId, owner, { ruleSetId: policy.id, expectedRevision: 0 })).status,
    ).toBe(200);
    expect(
      (await request("PUT", "binding", specId, owner, { ruleSetId: policy.id, expectedRevision: 0 })).status,
    ).toBe(409);
    expect((await request("POST", "lint", specId, viewer, {})).status).toBe(200);
    expect((await request("POST", "reports", specId, viewer, {})).status).toBe(403);
    const report = await request("POST", "reports", specId, owner, {});
    expect(report.status).toBe(201);
    const saved = await report.json();
    expect(saved.report.summary.errors).toBeGreaterThan(0);
    const detail = await import("@/app/api/specifications/[id]/governance/reports/[reportId]/route");
    for (const [user, status] of [
      [viewer, 200],
      [outsider, 404],
    ] as const) {
      const result = await detail.GET(
        new Request(`http://localhost/api/specifications/${specId}/governance/reports/${saved.id}`, {
          headers: { authorization: `Bearer ${tokens[user.id]}` },
        }),
        { params: Promise.resolve({ id: specId, reportId: saved.id }) },
      );
      expect(result.status).toBe(status);
    }

    expect((await request("GET", "reports", specId, outsider)).status).toBe(404);
    expect((await request("DELETE", "binding", specId, viewer)).status).toBe(403);
  });
  it("marks retained reports stale after removing and recreating an assignment with changed overrides", () =>
    withCaller(caller(owner), () => {
      const original = specs.getSpecification(specId);
      const separate = specs.createSpecification({
        workspaceId: ws,
        name: "Reassigned",
        format: original.format,
        entrypoint: original.entrypoint,
        files: original.files,
      });
      const policy = governance.createRuleSet({ workspaceId: ws, config: DEFAULT_GOVERNANCE });
      governance.bindGovernance(separate.id, { ruleSetId: policy.id, expectedRevision: 0 });
      governance.saveGovernanceReport(separate.id);
      expect(governance.getSpecificationGovernance(separate.id).stale).toBe(false);
      governance.unbindGovernance(separate.id);
      governance.bindGovernance(separate.id, {
        ruleSetId: policy.id,
        expectedRevision: 0,
        overrides: { "operation-security": "off" },
      });
      expect(governance.getSpecificationGovernance(separate.id).stale).toBe(true);
      governance.saveGovernanceReport(separate.id);
      expect(governance.getSpecificationGovernance(separate.id).stale).toBe(false);
      specs.deleteSpecification(separate.id);
      governance.deleteRuleSet(policy.id);
    }));
  it("retains immutable policies, supports version pinning and reports freshness for source/policy changes", () =>
    withCaller(caller(owner), () => {
      const policy = governance.createRuleSet({ workspaceId: ws, config: DEFAULT_GOVERNANCE }),
        previous = governance.getSpecificationGovernance(specId);
      governance.bindGovernance(specId, {
        ruleSetId: policy.id,
        ruleVersion: 1,
        expectedRevision: previous.binding?.revision ?? 0,
      });
      const first = governance.saveGovernanceReport(specId);
      expect(governance.getSpecificationGovernance(specId).stale).toBe(false);
      const config = {
        ...DEFAULT_GOVERNANCE,
        name: "Warnings only",
        overrides: { "operation-id": "warning" as const, "operation-security": "off" as const },
      };
      governance.saveRuleSet(policy.id, { expectedRevision: 1, config });
      expect(governance.getRuleSet(policy.id, 1).config.name).toBe(DEFAULT_GOVERNANCE.name);
      expect(governance.getSpecificationGovernance(specId).stale).toBe(false);
      const binding = governance.getSpecificationGovernance(specId).binding!;
      governance.bindGovernance(specId, {
        ruleSetId: policy.id,
        ruleVersion: null,
        expectedRevision: binding.revision,
      });
      expect(governance.getSpecificationGovernance(specId).stale).toBe(true);
      const second = governance.saveGovernanceReport(specId);
      expect(second.ruleVersion).toBe(2);
      expect(first.report.rulesHash).not.toBe(second.report.rulesHash);
      expect(() => governance.saveRuleSet(policy.id, { expectedRevision: 1, config })).toThrow("changed");
      const spec = specs.getSpecification(specId);
      specs.saveSpecification(specId, {
        expectedRevision: spec.revision,
        entrypoint: spec.entrypoint,
        files: spec.files.map((f) => ({ ...f, content: f.content + "\n# change\n" })),
      });
      expect(governance.getSpecificationGovernance(specId).stale).toBe(true);
    }));
  it("rejects foreign rule assignments and invalid rules/overrides without storing them", () =>
    withCaller(caller(owner), () => {
      const other = repo.createWorkspace("Other").id,
        policy = governance.createRuleSet({ workspaceId: other, config: DEFAULT_GOVERNANCE }),
        state = governance.getSpecificationGovernance(specId);
      expect(() =>
        governance.bindGovernance(specId, {
          ruleSetId: policy.id,
          expectedRevision: state.binding!.revision,
        }),
      ).toThrow("not found");
      const active = state.rule!;
      expect(() =>
        governance.bindGovernance(specId, {
          ruleSetId: active.id,
          expectedRevision: state.binding!.revision,
          overrides: { missing: "off" },
        }),
      ).toThrow();
      expect(() =>
        governance.saveRuleSet(active.id, {
          expectedRevision: active.revision,
          config: {
            ...DEFAULT_GOVERNANCE,
            rules: [...DEFAULT_GOVERNANCE.rules, ...DEFAULT_GOVERNANCE.rules],
          },
        }),
      ).toThrow();
    }));
  it("keeps invalid latest-version assignments editable when an overridden rule is removed", () =>
    withCaller(caller(owner), () => {
      const policy = governance.createRuleSet({ workspaceId: ws, config: DEFAULT_GOVERNANCE }),
        state = governance.getSpecificationGovernance(specId);
      governance.bindGovernance(specId, {
        ruleSetId: policy.id,
        expectedRevision: state.binding!.revision,
        overrides: { "api-description": "off" },
      });
      governance.saveRuleSet(policy.id, {
        expectedRevision: 1,
        config: {
          ...DEFAULT_GOVERNANCE,
          rules: DEFAULT_GOVERNANCE.rules.filter((r) => r.id !== "api-description"),
        },
      });
      const invalid = governance.getSpecificationGovernance(specId);
      expect(invalid.config).toBeNull();
      expect(invalid.stale).toBe(true);
      expect(invalid.binding?.ruleSetId).toBe(policy.id);
      governance.bindGovernance(specId, {
        ruleSetId: policy.id,
        expectedRevision: invalid.binding!.revision,
      });
      expect(governance.getSpecificationGovernance(specId).config).not.toBeNull();
    }));
  it("retains bounded reports and restores policy configuration without old report history", () =>
    withCaller(caller(owner), () => {
      for (let i = 0; i < 52; i++) governance.saveGovernanceReport(specId);
      expect(governance.listGovernanceReports(specId)).toHaveLength(50);
      const exported = backup.createBackup(db.getDb(), { includeSecrets: true }),
        target = db.openDatabase(path.join(dir, "restored.db"));
      try {
        const restored = backup.restoreBackup(target.db, target.sqlite, JSON.parse(JSON.stringify(exported)));
        expect(restored.governanceRuleSets).toBeGreaterThan(0);
        expect(restored.governanceBindings).toBe(1);
        expect(target.sqlite.prepare("select count(*) as n from governance_reports").get()).toEqual({ n: 0 });
      } finally {
        target.sqlite.close();
      }
    }));
});
