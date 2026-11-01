import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import { importPostmanCollection, type PostmanCollection } from "@/core/convert/postman";
import { readCapture, captureSecrets, safeValue, type Observation } from "@/core/app-test/capture";
import { evaluateObservations } from "@/core/app-test/evaluate";
import { renderAppTestReport } from "@/core/app-test/report";
const collection = (items: PostmanCollection["item"], testScript = "") =>
  importPostmanCollection({
    info: {
      name: "Observed API",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    event: testScript ? [{ listen: "test", script: { exec: [testScript] } }] : [],
    item: items,
  });
const operation = (name: string, url: string, script = "", body?: string) =>
  ({
    name,
    request: { method: body ? "POST" : "GET", url, ...(body ? { body: { mode: "raw", raw: body } } : {}) },
    event: [
      { listen: "prerequest", script: { exec: ['throw new Error("pre-request must not execute")'] } },
      { listen: "test", script: { exec: [script] } },
    ],
  }) as PostmanCollection["item"][number];
const observed = (url = "https://api.test/pets/7", status = 200, body = '{"id":7}'): Observation => ({
  request: { method: "GET", url, headers: [] },
  response: {
    status,
    statusText: "OK",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body,
    timeMs: 12,
  },
});
describe("observation-only application assertions", () => {
  it("matches targets, path variables and query/body, runs inherited assertions and never replays or runs pre-request scripts", async () => {
    const requestSpy = vi.spyOn(http, "request");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const c = collection(
        [
          operation(
            "Read",
            "{{baseUrl}}/pets/{{id}}?expand=owner",
            'pm.test("path",()=>pm.expect(pm.variables.get("id")).to.equal("7")); pm.test("response",()=>pm.expect(pm.response.json().id).to.equal(7));',
          ),
        ],
        'pm.test("status",()=>pm.response.to.have.status(200));',
      );
      const report = await evaluateObservations(
        [c],
        [observed("http://127.0.0.1:45678/pets/7?expand=owner")],
        { target: "http://127.0.0.1:45678" },
      );
      expect(report.passed).toBe(true);
      expect(report.calls[0].tests).toHaveLength(3);
      expect(report.summary.passed).toBe(1);
      expect(requestSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      requestSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
  it("separates no assertions, unmatched, ambiguous, unexercised and missing responses from passes", async () => {
    const c = collection([
      operation("Pass", "https://api.test/pass", 'pm.test("ok",()=>pm.expect(true).to.be.true);'),
      operation("No tests", "https://api.test/none"),
      operation("Unseen", "https://api.test/unseen"),
      operation("Duplicate1", "https://api.test/dup"),
      operation("Duplicate2", "https://api.test/dup"),
      operation("Absent response", "https://api.test/absent"),
    ]);
    const noResponse = observed("https://api.test/absent");
    delete noResponse.response;
    const report = await evaluateObservations(
      [c],
      [
        observed("https://api.test/pass"),
        observed("https://api.test/none"),
        observed("https://api.test/unknown"),
        observed("https://api.test/dup"),
        noResponse,
      ],
    );
    expect(report.summary).toEqual({
      passed: 1,
      failed: 0,
      unmatched: 1,
      ambiguous: 1,
      noAssertions: 1,
      missingResponse: 1,
      unexercised: 3,
    });
    expect(report.passed).toBe(false);
    expect(renderAppTestReport(report, "junit")).toContain('<skipped message="no-assertions"/>');
  });
  it("enforces query values, JSON body equality, environment overrides, specific paths and filters", async () => {
    const c = collection([
      operation("General", "https://api.test/pets/{{id}}"),
      operation("Specific", "https://api.test/pets/latest", 'pm.test("yes",()=>{});'),
      operation(
        "Create",
        "{{base}}/pets?mode=save",
        'pm.test("saved",()=>{});',
        '{"name":"{{name}}","count":2}',
      ),
    ]);
    const e = observed("https://stage.test/pets?mode=save");
    e.request.method = "POST";
    e.request.body = '{"count":2,"name":"Fido"}';
    const report = await evaluateObservations([c], [observed("https://api.test/pets/latest"), e], {
      environment: [
        { key: "base", value: "https://stage.test", type: "default", enabled: true },
        { key: "name", value: "Fido", type: "default", enabled: true },
      ],
    });
    expect(report.summary.passed).toBe(2);
    expect(report.operations.find((o) => o.name === "General")?.matchedCalls).toBe(0);
    e.request.body = '{"name":"Other","count":2}';
    expect(
      (
        await evaluateObservations([c], [e], {
          target: "https://stage.test",
          environment: [{ key: "name", value: "Fido", enabled: true, type: "default" }],
        })
      ).summary.unmatched,
    ).toBe(1);
    const filtered = await evaluateObservations([c], [observed("https://api.test/pets/latest")], {
      filter: "Specific",
      strictCoverage: true,
    });
    expect(filtered.passed).toBe(true);
    expect(filtered.operations).toHaveLength(1);
  });
  it("blocks assertion network calls even when scripts catch errors, reports failed assertions and bounds infinite scripts", async () => {
    const c = collection([
      operation(
        "Network",
        "https://api.test/net",
        'try { await pm.sendRequest("http://127.0.0.1:1/write"); } catch {} pm.test("caught",()=>{});',
      ),
      operation("Failed", "https://api.test/fail", 'pm.test("wrong",()=>pm.expect(1).to.equal(2));'),
      operation("Loop", "https://api.test/loop", "while(true){}"),
    ]);
    const report = await evaluateObservations(
      [c],
      [
        observed("https://api.test/net"),
        observed("https://api.test/fail"),
        observed("https://api.test/loop"),
      ],
    );
    expect(report.summary.failed).toBe(3);
    expect(report.calls[0].errors.join(" ")).toContain("Network calls are disabled");
    expect(report.calls[1].tests[0].passed).toBe(false);
    expect(report.calls[2].errors.length).toBeGreaterThan(0);
  });
  it("redacts secret echoes and renders escaped reports, never counts no-assertion runs as success", async () => {
    const e = observed("https://api.test/pets/7?api_key=private-value", 200, '{"token":"private-value"}');
    e.request.headers = [{ name: "Authorization", value: "Bearer private-value" }];
    const c = collection([
      operation(
        "<img src=x onerror=alert(1)>",
        "https://api.test/pets/{{id}}",
        'pm.test("secret private-value",()=>pm.expect(pm.response.json().token).to.equal("wrong"));',
      ),
    ]);
    const report = await evaluateObservations([c], [e]);
    for (const format of ["json", "html", "junit"] as const) {
      const text = renderAppTestReport(report, format);
      expect(text).not.toContain("private-value");
      if (format !== "json") expect(text).not.toContain("<img");
    }
    const empty = await evaluateObservations(
      [collection([operation("No assertions", "https://api.test/pets/{{id}}")])],
      [observed()],
    );
    expect(empty.passed).toBe(false);
    const skipped = await evaluateObservations(
      [
        collection([
          operation("Skipped", "https://api.test/pets/{{id}}", 'pm.test.skip("not exercised",()=>{});'),
        ]),
      ],
      [observed()],
    );
    expect(skipped.passed).toBe(false);
    expect(skipped.summary.noAssertions).toBe(1);
    expect(skipped.operations[0].assertionCalls).toBe(0);
    expect(renderAppTestReport(empty, "junit")).toContain("<failure");
  });
});
describe("bounded offline capture formats", () => {
  it("reads full Playwright HAR including base64 response bodies, and native capture JSON deterministically", () => {
    const e = observed();
    const har = {
      log: {
        version: "1.2",
        entries: [
          {
            request: e.request,
            response: {
              status: 200,
              headers: [],
              content: { encoding: "base64", text: Buffer.from('{"ok":true}').toString("base64") },
            },
            time: 5,
          },
        ],
      },
    };
    const result = readCapture(JSON.stringify(har));
    expect(result[0].response?.body).toBe('{"ok":true}');
    expect(readCapture(JSON.stringify({ version: 1, entries: [e] }))).toEqual([e]);
  });
  it("rejects malformed, huge, unsupported and missing-body artifacts honestly", async () => {
    for (const value of [
      { version: 2, entries: [observed()] },
      { version: 1, entries: [] },
      { version: 1, entries: [observed("file:///secret")] },
      {
        version: 1,
        entries: [{ ...observed(), response: { ...observed().response, body: "x".repeat(1048577) } }],
      },
    ])
      expect(() => readCapture(JSON.stringify(value))).toThrow();
    const e = observed();
    delete e.response!.body;
    const result = await evaluateObservations(
      [collection([operation("Read", "https://api.test/pets/{{id}}", 'pm.test("ok",()=>{});')])],
      [e],
    );
    expect(result.calls[0].state).toBe("failed");
  });
  it("finds secrets across headers, query and nested bodies before redacting echoes", () => {
    const e = observed(
      "https://u:pass@api.test/pets?token=query-secret",
      200,
      '{"nested":{"password":"body-secret"}}',
    );
    e.request.headers = [{ name: "Cookie", value: "sid=cookie-secret" }];
    expect(safeValue("query-secret body-secret cookie-secret pass", captureSecrets([e]))).not.toMatch(
      /query-secret|body-secret|cookie-secret|pass/,
    );
  });
});
