import { describe, it, expect } from "vitest";
import {
  captureEvidence,
  isSideEffectful,
  planRepro,
  referencedVariables,
  routePlaceholders,
  type FailureEvidence,
} from "@/core/telemetry/repro";

const failure = (extra: Partial<FailureEvidence> = {}): FailureEvidence => ({
  id: "obs-1",
  sourceId: "source-1",
  sourceRevision: 3,
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  method: "GET",
  route: "/api/orders/:id/items/:segment",
  routeSource: "template",
  status: 503,
  error: true,
  durationMs: 812.456,
  at: Date.UTC(2026, 10, 6, 12, 0, 0),
  service: "checkout",
  environment: "production",
  sampleRate: 0.5,
  ...extra,
});
const mapping = { baseUrl: "{{baseUrl}}", pathValues: ["{{orderId}}", "gift card"] };
const gap = (plan: ReturnType<typeof planRepro>, field: string) => plan.gaps.filter((g) => g.field === field);

describe("telemetry failure reproduction", () => {
  it("lists route placeholders in order and classifies identifiers vs redacted words", () => {
    expect(routePlaceholders("/api/orders/:id/items/:segment")).toEqual([
      { index: 0, segment: 2, kind: "id" },
      { index: 1, segment: 4, kind: "segment" },
    ]);
    expect(routePlaceholders("/[unmapped]")).toEqual([]);
    expect(referencedVariables("{{a}}/x/{{ b }}/{{a}}")).toEqual(["a", "b"]);
  });

  it("builds an unsent draft with mapped host, encoded values and variable references", () => {
    const plan = planRepro(failure(), mapping);
    expect(plan.ready).toBe(true);
    expect(plan.url).toBe("{{baseUrl}}/api/orders/{{orderId}}/items/gift%20card");
    expect(plan.draft).toMatchObject({
      method: "GET",
      url: plan.url,
      headers: [],
      params: [],
      body: { mode: "none" },
      auth: { type: "inherit" },
    });
    expect(plan.draft!.name).toBe("Repro: GET /api/orders/:id/items/:segment (HTTP 503)");
    expect(plan.draft!.description).toContain("Nothing has been sent");
    expect(plan.draft!.description).toContain(failure().traceId);
    expect(plan.draft!.description).toContain("2026-11-06T12:00:00.000Z");
  });

  it("accepts http(s) base URLs and rejects unsafe or ambiguous ones", () => {
    expect(planRepro(failure(), { ...mapping, baseUrl: "https://staging.example.test/v2/" }).url).toBe(
      "https://staging.example.test/v2/api/orders/{{orderId}}/items/gift%20card",
    );
    for (const baseUrl of [
      "",
      "javascript:alert(1)",
      "ftp://example.test",
      "https://user:pw@example.test",
      "https://example.test?token=1",
      "staging.example.test",
      "{{baseUrl}}?x=1",
    ]) {
      const plan = planRepro(failure(), { ...mapping, baseUrl });
      expect(plan.ready, baseUrl).toBe(false);
      expect(plan.draft).toBeNull();
      expect(gap(plan, "host")[0].severity).toBe("blocking");
    }
  });

  it("blocks until every redacted placeholder is mapped", () => {
    const plan = planRepro(failure(), { ...mapping, pathValues: ["42"] });
    expect(plan.ready).toBe(false);
    expect(gap(plan, "path")[0]).toMatchObject({ severity: "blocking" });
    expect(gap(plan, "path")[0].message).toMatch(/1 route placeholder needs/);
  });

  it("requires an explicit path for unmapped routes", () => {
    const unmapped = failure({ route: "/[unmapped]", routeSource: "unknown" });
    expect(planRepro(unmapped, { baseUrl: "{{baseUrl}}" }).ready).toBe(false);
    expect(planRepro(unmapped, { baseUrl: "{{baseUrl}}", path: "orders?x=1" }).ready).toBe(false);
    expect(planRepro(unmapped, { baseUrl: "{{baseUrl}}", path: "/orders/{{id}}" }).url).toBe(
      "{{baseUrl}}/orders/{{id}}",
    );
  });

  it("always reports redacted context that production never revealed", () => {
    const plan = planRepro(failure(), mapping);
    for (const field of ["host", "query", "headers", "cookies", "body", "auth", "errorMessage"])
      expect(gap(plan, field), field).toHaveLength(1);
    for (const field of ["query", "headers", "cookies", "errorMessage"])
      expect(plan.draft!.description).toContain(`${field}:`);
  });

  it("flags auth gaps, escalating when production failed with 401 or 403", () => {
    expect(gap(planRepro(failure(), mapping), "auth")[0].severity).toBe("info");
    for (const status of [401, 403]) {
      const auth = gap(planRepro(failure({ status }), mapping), "auth")[0];
      expect(auth.severity).toBe("warning");
      expect(auth.message).toContain(`HTTP ${status}`);
      expect(auth.message).toMatch(/never captured/);
    }
  });

  it("requires acknowledgement before drafting side-effectful methods", () => {
    for (const method of ["POST", "put", "PATCH", "DELETE", "PURGE"]) {
      expect(isSideEffectful(method)).toBe(true);
      const blocked = planRepro(failure({ method }), mapping);
      expect(blocked.sideEffectful).toBe(true);
      expect(blocked.ready).toBe(false);
      expect(gap(blocked, "method")[0].severity).toBe("blocking");
      const allowed = planRepro(failure({ method }), { ...mapping, acknowledgeSideEffects: true });
      expect(allowed.ready).toBe(true);
      expect(allowed.draft!.method).toBe(method.toUpperCase());
      expect(gap(allowed, "method")[0].severity).toBe("warning");
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isSideEffectful(method)).toBe(false);
      expect(gap(planRepro(failure({ method }), mapping), "method")).toHaveLength(0);
    }
    expect(
      gap(planRepro(failure({ method: "POST" }), { ...mapping, acknowledgeSideEffects: true }), "body")[0],
    ).toMatchObject({ severity: "warning" });
  });

  it("reports variables the target environment does not define", () => {
    const plan = planRepro(failure(), {
      ...mapping,
      environmentId: "env-1",
      environmentVariables: ["baseUrl"],
    });
    expect(plan.ready).toBe(true);
    expect(plan.environmentId).toBe("env-1");
    expect(gap(plan, "variables")[0]).toMatchObject({ severity: "warning" });
    expect(gap(plan, "variables")[0].message).toContain("{{orderId}}");
    expect(
      gap(planRepro(failure(), { ...mapping, environmentVariables: ["baseUrl", "orderId"] }), "variables"),
    ).toHaveLength(0);
  });

  it("preserves the original evidence and is deterministic", () => {
    const source = { ...failure(), extra: "not evidence" } as FailureEvidence;
    const before = JSON.stringify(source);
    const a = planRepro(source, mapping),
      b = planRepro(source, mapping);
    expect(JSON.stringify(source)).toBe(before);
    expect(a).toEqual(b);
    expect(Object.isFrozen(a.evidence)).toBe(true);
    expect(a.evidence).not.toHaveProperty("extra");
    expect(a.evidence).toEqual(captureEvidence(failure()));
    expect(() => {
      (a.evidence as { status: number | null }).status = 200;
    }).toThrow();
  });
});
