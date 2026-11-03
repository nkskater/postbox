import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { DEFAULT_SCORECARD } from "@/core/scorecards/model";
import { DEFAULT_GOVERNANCE } from "@/core/governance/model";
import type { UserRow } from "@/server/db/schema";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-scorecards-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const db = await import("@/server/db"),
  repo = await import("@/server/repo"),
  users = await import("@/server/users"),
  catalog = await import("@/server/catalog"),
  quality = await import("@/server/scorecards"),
  governance = await import("@/server/governance"),
  specs = await import("@/server/specifications"),
  monitors = await import("@/server/monitors"),
  backup = await import("@/server/backup");
const { withCaller } = await import("@/server/access-context"),
  { setMember } = await import("@/server/authorize");
let owner: UserRow, viewer: UserRow, outsider: UserRow, ws: string;
const tokens: Record<string, string> = {},
  caller = (user: UserRow) => ({ kind: "user" as const, user, via: "token" as const });
beforeAll(async () => {
  owner = await users.createUser({ username: "quality-owner", password: "password123" });
  viewer = await users.createUser({ username: "quality-viewer", password: "password123" });
  outsider = await users.createUser({ username: "quality-outsider", password: "password123" });
  for (const user of [owner, viewer, outsider]) tokens[user.id] = users.createToken(user.id, "tests").token;
  withCaller(caller(owner), () => {
    ws = repo.createWorkspace("Quality").id;
    setMember(ws, viewer.username, "viewer");
  });
});
afterAll(() => {
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const source = {
  format: "openapi" as const,
  entrypoint: "api.yaml",
  files: [
    {
      path: "api.yaml",
      content:
        "openapi: 3.0.3\ninfo: {title: API, version: '1', description: API description}\nservers: [{url: https://example.test}]\nsecurity: [{bearerAuth: []}]\ncomponents:\n  securitySchemes:\n    bearerAuth: {type: http, scheme: bearer}\npaths:\n  /health:\n    get:\n      operationId: health\n      summary: Check health\n      responses:\n        '200': {description: OK}\n",
    },
  ],
};
let serial = 0;
function fixture() {
  const n = ++serial,
    folder = repo.createFolder(ws, null, { name: `Service ${n}` }),
    entry = catalog.publishCatalog(folder.id, {
      title: `Service ${n}`,
      description: "Catalog description",
      tags: ["payments"],
      owners: ["team-api"],
      visibility: "team",
      expectedRevision: 0,
      label: "1.0.0",
    }),
    spec = specs.createSpecification({ workspaceId: ws, name: "API", ...source }),
    policy = governance.createRuleSet({ workspaceId: ws, config: DEFAULT_GOVERNANCE });
  governance.bindGovernance(spec.id, { ruleSetId: policy.id, expectedRevision: 0 });
  governance.saveGovernanceReport(spec.id);
  const monitor = monitors.createMonitor({
    workspaceId: ws,
    folderId: folder.id,
    name: `Monitor ${n}`,
    cron: "0 * * * *",
    enabled: false,
  });
  db.getDb()
    .insert(db.schema.monitorSamples)
    .values({
      id: `sample-${n}`,
      monitorId: monitor.id,
      runId: `run-${n}`,
      at: Date.now(),
      outcome: "passed",
      reasons: [],
      metrics: {
        requests: 1,
        available: 1,
        tests: 1,
        passedTests: 1,
        p95Ms: 100,
        availability: 100,
        assertions: 100,
        scriptErrors: 0,
      },
    })
    .run();
  const card = quality.createScorecard({ workspaceId: ws, config: DEFAULT_SCORECARD });
  const binding = quality.bindQualityService(card.id, {
    entryId: entry.id,
    specificationId: spec.id,
    monitorId: monitor.id,
    expectedRevision: 0,
  });
  return { folder, entry, spec, policy, monitor, card, binding };
}
async function request(method: string, suffix: string, id: string, user: UserRow, body?: unknown) {
  const mod =
    suffix === ""
      ? await import("@/app/api/scorecards/route")
      : suffix === "card"
        ? await import("@/app/api/scorecards/[id]/route")
        : suffix === "preview"
          ? await import("@/app/api/scorecards/[id]/preview/route")
          : suffix === "sources"
            ? await import("@/app/api/scorecards/[id]/sources/route")
            : suffix === "bindings"
              ? await import("@/app/api/scorecards/[id]/bindings/route")
              : await import("@/app/api/scorecards/[id]/reports/route");
  const url =
    suffix === ""
      ? `/api/scorecards?workspaceId=${ws}`
      : `/api/scorecards/${id}${suffix === "card" ? "" : "/" + suffix}`;
  return (
    mod as Record<string, (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>>
  )[method](
    new Request("http://localhost" + url, {
      method,
      headers: { Authorization: `Bearer ${tokens[user.id]}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
describe("quality scorecard integration", () => {
  it("consumes existing governance and monitor data, keeps policy history immutable and filters slices", () =>
    withCaller(caller(owner), () => {
      const f = fixture(),
        result = quality.previewScorecard(f.card.id);
      const saved = quality.saveQualityReport(f.card.id);
      const filtered = quality.getQualityReport(f.card.id, saved.id, { tag: "no-match" });
      expect(filtered.report.filters).toEqual({});
      expect(filtered.report.viewFilters).toEqual({ tag: "no-match" });
      expect(filtered.report.summary.services).toBe(0);
      expect(result.summary).toMatchObject({ score: 100, coverage: 100, status: "healthy", services: 1 });
      expect(result.services[0].evaluation.categories[0].metrics[0].source).toMatchObject({
        kind: "monitor",
        id: f.monitor.id,
      });
      expect(quality.previewScorecard(f.card.id, { filters: { tag: "other" } }).services).toHaveLength(0);
      expect(
        quality.previewScorecard(f.card.id, {
          filters: { owner: "team-api", tag: "payments", environmentId: "" },
        }).services,
      ).toHaveLength(1);
      quality.saveScorecard(f.card.id, {
        expectedRevision: 1,
        config: { ...DEFAULT_SCORECARD, name: "New quality" },
      });
      expect(quality.getScorecard(f.card.id, 1).config.name).toBe(DEFAULT_SCORECARD.name);
      expect(quality.getScorecard(f.card.id).version).toBe(2);
      expect(() =>
        quality.saveScorecard(f.card.id, { expectedRevision: 1, config: DEFAULT_SCORECARD }),
      ).toThrow("changed");
      expect(() =>
        quality.bindQualityService(f.card.id, { entryId: f.entry.id, expectedRevision: 0 }),
      ).toThrow("changed");
    }));
  it("enforces read/write boundaries and actual nested report ownership", async () => {
    const f = withCaller(caller(owner), fixture);
    expect((await request("GET", "card", f.card.id, outsider)).status).toBe(404);
    expect(
      (await request("POST", "", "", viewer, { workspaceId: ws, config: DEFAULT_SCORECARD })).status,
    ).toBe(403);
    expect((await request("POST", "preview", f.card.id, viewer, {})).status).toBe(200);
    expect((await request("POST", "reports", f.card.id, viewer, {})).status).toBe(403);
    expect(
      (await request("PUT", "bindings", f.card.id, viewer, { entryId: f.entry.id, expectedRevision: 1 }))
        .status,
    ).toBe(403);
    const saved = await (await request("POST", "reports", f.card.id, owner, {})).json(),
      other = withCaller(caller(owner), () =>
        quality.createScorecard({ workspaceId: ws, config: DEFAULT_SCORECARD }),
      );
    const detail = await import("@/app/api/scorecards/[id]/reports/[reportId]/route");
    for (const [user, cardId, status] of [
      [viewer, f.card.id, 200],
      [outsider, f.card.id, 404],
      [owner, other.id, 404],
    ] as const) {
      const res = await detail.GET(
        new Request(`http://localhost/api/scorecards/${cardId}/reports/${saved.id}`, {
          headers: { Authorization: `Bearer ${tokens[user.id]}` },
        }),
        { params: Promise.resolve({ id: cardId, reportId: saved.id, bindingId: "" }) },
      );
      expect(res.status, await res.clone().text()).toBe(status);
    }
  });
  it("does not disclose private, revoked or foreign catalog services through retained scores or comparisons", () => {
    const f = withCaller(caller(owner), fixture);
    const first = withCaller(caller(owner), () => quality.saveQualityReport(f.card.id));
    withCaller(caller(viewer), () =>
      expect(quality.getQualityReport(f.card.id, first.id).report.summary.services).toBe(1),
    );
    withCaller(caller(owner), () =>
      catalog.updateCatalog(f.folder.id, {
        title: f.entry.title,
        description: "Private",
        tags: ["payments"],
        owners: ["secret-owner"],
        visibility: "private",
        expectedRevision: 1,
      }),
    );
    withCaller(caller(viewer), () => {
      expect(quality.previewScorecard(f.card.id).services).toHaveLength(0);
      const hidden = quality.getQualityReport(f.card.id, first.id);
      expect(hidden.report.summary).toMatchObject({ services: 0, score: null, coverage: 0 });
      expect(
        quality.compareQualityReports(f.card.id, { beforeId: first.id, afterId: first.id }).services,
      ).toHaveLength(0);
      expect(quality.scorecardSources(f.card.id).bindings).toHaveLength(0);
    });
    withCaller(caller(owner), () => {
      catalog.revokeCatalog(f.folder.id);
      expect(quality.getQualityReport(f.card.id, first.id).report.services).toHaveLength(0);
    });
  });
  it("marks obsolete governance, old monitor samples and mismatched environments explicitly unavailable", () =>
    withCaller(caller(owner), () => {
      const f = fixture(),
        first = quality.saveQualityReport(f.card.id);
      const spec = specs.getSpecification(f.spec.id);
      specs.saveSpecification(spec.id, {
        expectedRevision: 1,
        entrypoint: spec.entrypoint,
        files: spec.files.map((file) => ({ ...file, content: file.content + "\n# revision\n" })),
      });
      db.getDb()
        .update(db.schema.monitorSamples)
        .set({ at: Date.now() - 48 * 3600000 })
        .where(eq(db.schema.monitorSamples.monitorId, f.monitor.id))
        .run();
      const stale = quality.saveQualityReport(f.card.id);
      const metrics = stale.report.services[0].evaluation.categories.flatMap((c) => c.metrics);
      expect(metrics.find((m) => m.measure === "governanceErrors")?.state).toBe("stale");
      expect(metrics.find((m) => m.measure === "availability")?.state).toBe("stale");
      expect(stale.report.summary.status).toBe("unknown");
      expect(
        quality.compareQualityReports(f.card.id, { beforeId: first.id, afterId: stale.id }).services[0]
          .comparison?.scoreDelta,
      ).toBeLessThan(0);
      const env = repo.createEnvironment(ws, "Production");
      expect(() =>
        quality.bindQualityService(f.card.id, {
          entryId: f.entry.id,
          environmentId: env.id,
          monitorId: f.monitor.id,
          expectedRevision: 0,
        }),
      ).toThrow("match");
      const assigned = quality.bindQualityService(f.card.id, {
        entryId: f.entry.id,
        environmentId: env.id,
        specificationId: spec.id,
        expectedRevision: 0,
      });
      expect(
        quality.previewScorecard(f.card.id, { filters: { environmentId: env.id } }).services,
      ).toHaveLength(1);
      quality.removeQualityService(f.card.id, assigned.id);
    }));
  it("rejects foreign sources and invalid policies without exposing another workspace", () =>
    withCaller(caller(owner), () => {
      const f = fixture(),
        otherWs = repo.createWorkspace("Other").id,
        foreignSpec = specs.createSpecification({ workspaceId: otherWs, name: "Foreign", ...source });
      expect(() =>
        quality.bindQualityService(f.card.id, {
          entryId: f.entry.id,
          specificationId: foreignSpec.id,
          expectedRevision: 1,
        }),
      ).toThrow("not found");
      const foreignFolder = repo.createFolder(otherWs, null, { name: "Foreign" }),
        foreignEntry = catalog.publishCatalog(foreignFolder.id, {
          title: "Foreign",
          owners: ["team"],
          visibility: "public",
          expectedRevision: 0,
          label: "1.0.0",
        });
      expect(() =>
        quality.bindQualityService(f.card.id, { entryId: foreignEntry.id, expectedRevision: 0 }),
      ).toThrow("not found");
      expect(() =>
        quality.createScorecard({ workspaceId: ws, config: { ...DEFAULT_SCORECARD, minimumCoverage: 101 } }),
      ).toThrow();
    }));
  it("does not count skipped samples or governance reports with zero evaluated targets as successful measurements", () =>
    withCaller(caller(owner), () => {
      const f = fixture();
      db.getDb()
        .update(db.schema.monitorSamples)
        .set({ outcome: "skipped" })
        .where(eq(db.schema.monitorSamples.monitorId, f.monitor.id))
        .run();
      governance.saveRuleSet(f.policy.id, {
        expectedRevision: 1,
        config: { ...DEFAULT_GOVERNANCE, rules: [] },
      });
      governance.saveGovernanceReport(f.spec.id);
      const report = quality.previewScorecard(f.card.id),
        metrics = report.services[0].evaluation.categories.flatMap((c) => c.metrics);
      expect(metrics.find((m) => m.measure === "availability")).toMatchObject({
        state: "unavailable",
        score: null,
      });
      expect(metrics.find((m) => m.measure === "governanceErrors")).toMatchObject({
        state: "unavailable",
        score: null,
      });
      expect(report.summary.status).toBe("unknown");
      expect(report.summary.coverage).toBe(20);
    }));
  it("caps retained reports and backs up configuration/assignments without carrying old measurements", () =>
    withCaller(caller(owner), () => {
      const f = fixture();
      for (let i = 0; i < 52; i++) quality.saveQualityReport(f.card.id);
      expect(quality.listQualityReports(f.card.id)).toHaveLength(50);
      const exported = backup.createBackup(db.getDb(), { includeSecrets: true }),
        target = db.openDatabase(path.join(dir, "restored.db"));
      try {
        const restored = backup.restoreBackup(target.db, target.sqlite, JSON.parse(JSON.stringify(exported)));
        expect(restored.qualityScorecards).toBeGreaterThan(0);
        expect(restored.qualityBindings).toBeGreaterThan(0);
        expect(target.sqlite.prepare("select count(*) as n from quality_reports").get()).toEqual({ n: 0 });
      } finally {
        target.sqlite.close();
      }
    }));
});
