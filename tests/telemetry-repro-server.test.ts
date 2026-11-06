import { afterAll, beforeAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attr, batch, span } from "./fixtures/telemetry/traffic";
import { telemetryConfig } from "@/core/telemetry/model";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-telemetry-repro-test-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { getDb, getSqlite, schema } = await import("@/server/db"),
  telemetry = await import("@/server/telemetry"),
  repro = await import("@/server/telemetry-repro"),
  { withCaller } = await import("@/server/access-context"),
  users = await import("@/server/users"),
  repo = await import("@/server/repo"),
  { setMember } = await import("@/server/authorize"),
  { REST_POLICIES, isReadOnlyTool } = await import("@/server/access-policy");
const now = Date.now(),
  config = telemetryConfig.parse({ name: "Checkout", serviceName: "checkout", enabled: true });
let owner: UserRow, viewer: UserRow, outsider: UserRow, ws: string, otherWs: string;
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
const asOwner = <T>(fn: () => T) => withCaller(caller(owner), fn);
const query = () => ({ from: now - 86400000, to: Date.now() + 120000 });
const withMethod = (s: ReturnType<typeof span>, method: string) => ({
  ...s,
  attributes: s.attributes.map((a) => (a.key === "http.request.method" ? attr(a.key, method) : a)),
});
let failedGet: string, failedPost: string, okId: string;
beforeAll(async () => {
  await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  ws = asOwner(() => repo.createWorkspace("Repro")).id;
  otherWs = withCaller(caller(outsider), () => repo.createWorkspace("Private")).id;
  asOwner(() => setMember(ws, viewer.username, "viewer"));
  const c = asOwner(() => telemetry.createTelemetrySource({ workspaceId: ws, config }));
  telemetry.ingestTelemetry(
    c.source.id,
    c.token,
    batch([
      span(1, now, 10, 200),
      span(2, now - 1000, 120, 401),
      withMethod(span(3, now - 2000, 90, 500, "/api/orders/{orderId}"), "POST"),
    ]),
  );
  const metrics = asOwner(() => telemetry.getTelemetryMetrics(ws, query()));
  const failed = metrics.endpoints.flatMap(
    (e) => asOwner(() => telemetry.getTelemetryEndpoint(ws, e.id, query())).failedSpans,
  );
  failedGet = failed.find((f) => f.method === "GET")!.id;
  failedPost = failed.find((f) => f.method === "POST")!.id;
  const all = metrics.endpoints.find((e) => e.method === "GET")!;
  expect(all.sampledRequests).toBe(2);
  okId = getDb()
    .select()
    .from(schema.telemetryObservations)
    .all()
    .find((o) => !o.error)!.id;
});
afterAll(() => {
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("telemetry reproduction automation", () => {
  it("plans a draft for a readable failure without exposing workspace identity", () => {
    const plan = withCaller(caller(viewer), () =>
      repro.planTelemetryRepro({
        workspaceId: ws,
        observationId: failedGet,
        mapping: { baseUrl: "https://staging.example.test", pathValues: ["{{userId}}"] },
      }),
    );
    expect(plan.ready).toBe(true);
    expect(plan.url).toBe("https://staging.example.test/api/users/{{userId}}");
    expect(plan.evidence).not.toHaveProperty("workspaceId");
    expect(plan.gaps.find((g) => g.field === "auth")).toMatchObject({ severity: "warning" });
    expect(JSON.stringify(plan)).not.toContain("SECRET");
  });

  it("requires acknowledgement for side-effectful production failures", () => {
    const input = {
      workspaceId: ws,
      observationId: failedPost,
      mapping: { baseUrl: "{{baseUrl}}", pathValues: ["42"] },
    };
    expect(asOwner(() => repro.planTelemetryRepro(input)).ready).toBe(false);
    const plan = asOwner(() =>
      repro.planTelemetryRepro({ ...input, mapping: { ...input.mapping, acknowledgeSideEffects: true } }),
    );
    expect(plan.draft).toMatchObject({ method: "POST", url: "{{baseUrl}}/api/orders/42" });
  });

  it("resolves target environment variables server-side and scopes them to the workspace", () => {
    const env = asOwner(() =>
      repo.createEnvironment(ws, "Staging", [
        { key: "baseUrl", value: "https://staging.example.test", type: "default", enabled: true },
      ]),
    );
    const plan = asOwner(() =>
      repro.planTelemetryRepro({
        workspaceId: ws,
        observationId: failedGet,
        mapping: { baseUrl: "{{baseUrl}}", pathValues: ["{{userId}}"], environmentId: env.id },
      }),
    );
    expect(plan.gaps.find((g) => g.field === "variables")?.message).toContain("{{userId}}");
    const foreign = withCaller(caller(outsider), () => repo.createEnvironment(otherWs, "Theirs"));
    expect(() =>
      asOwner(() =>
        repro.planTelemetryRepro({
          workspaceId: ws,
          observationId: failedGet,
          mapping: { baseUrl: "{{baseUrl}}", pathValues: ["1"], environmentId: foreign.id },
        }),
      ),
    ).toThrow(/Environment not found/);
  });

  it("enforces workspace access and only returns retained failures", () => {
    expect(() => withCaller(caller(outsider), () => repro.getTelemetryFailure(ws, failedGet))).toThrow();
    expect(() => withCaller(caller(outsider), () => repro.getTelemetryFailure(otherWs, failedGet))).toThrow(
      /not found/,
    );
    expect(() => asOwner(() => repro.getTelemetryFailure(ws, okId))).toThrow(/not found/);
    expect(() => asOwner(() => repro.getTelemetryFailure(ws, "missing"))).toThrow(/not found/);
  });

  it("registers read-only REST and MCP automation interfaces", () => {
    expect(REST_POLICIES["POST /api/telemetry/repro"]).toMatchObject({ source: "body", action: "read" });
    expect(isReadOnlyTool("plan_telemetry_repro")).toBe(true);
  });
});
