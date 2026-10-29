import { describe, expect, it } from "vitest";
import { runScript, type ScriptContext } from "@/core/scripts/sandbox";
import { emptyScopes } from "@/core/variables/resolver";

function ctx(partial: Partial<ScriptContext> = {}): ScriptContext {
  return {
    scopes: { ...emptyScopes(), environment: { host: "example.com" } },
    request: { url: "https://{{host}}/a?x=1", method: "GET", headers: [{ key: "Accept", value: "*/*" }] },
    response: {
      code: 201,
      status: "Created",
      headers: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify({ id: 7, tags: ["a", "b"], nested: { ok: true } }),
      responseTime: 12,
      responseSize: 40,
    },
    info: { eventName: "test", iteration: 0, iterationCount: 1, requestName: "Create", requestId: "r1" },
    ...partial,
  };
}

describe("script sandbox", () => {
  it("records passing and failing tests", async () => {
    const r = await runScript(
      `pm.test("created", () => pm.response.to.have.status(201));
       pm.test("wrong", () => pm.expect(pm.response.code).to.eql(200));
       pm.test("json", () => {
         const j = pm.response.json();
         pm.expect(j).to.have.property("id", 7);
         pm.expect(j.tags).to.be.an("array").that.includes("a");
         pm.expect(j).to.have.nested.property("nested.ok", true);
         pm.expect(j).to.deep.include({ id: 7 });
         pm.expect(j).to.have.all.keys("id", "tags", "nested");
         pm.response.to.have.jsonBody("tags[1]", "b");
         pm.response.to.have.header("Content-Type", "application/json");
         pm.response.to.have.jsonSchema({ type: "object", required: ["id"], properties: { id: { type: "integer" } } });
       });`,
      ctx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ["created", true],
      ["wrong", false],
      ["json", true],
    ]);
    expect(r.tests[1].error).toBe("expected 201 to deeply equal 200");
  });

  it("reads and writes every variable scope", async () => {
    const r = await runScript(
      `pm.environment.set("token", "abc");
       pm.globals.set("g", 1);
       pm.collectionVariables.set("obj", { a: 1 });
       pm.variables.set("local", "L");
       pm.environment.unset("host");
       console.log(pm.variables.get("local"), pm.iterationData.get("row"));`,
      ctx({ scopes: { ...emptyScopes(), environment: { host: "h" }, data: { row: "r1" } } }),
    );
    expect(r.scopes.environment).toEqual({ token: "abc" });
    expect(r.scopes.globals).toEqual({ g: "1" });
    expect(r.scopes.collection).toEqual({ obj: '{"a":1}' });
    expect(r.scopes.local).toEqual({ local: "L" });
    expect(r.logs[0].message).toBe("L r1");
  });

  it("lets pre-request scripts mutate the request", async () => {
    const r = await runScript(
      `pm.request.headers.add({ key: "X-Trace", value: pm.variables.replaceIn("{{host}}") });
       pm.request.headers.remove("accept");
       pm.request.url.query.add({ key: "y", value: "2" });
       pm.request.method = "POST";
       pm.request.body.update(JSON.stringify({ a: 1 }));`,
      ctx({
        response: undefined,
        info: { eventName: "prerequest", iteration: 0, iterationCount: 1, requestName: "x", requestId: "x" },
      }),
    );
    expect(r.error).toBeUndefined();
    expect(r.request.method).toBe("POST");
    expect(r.request.url).toBe("https://{{host}}/a?x=1&y=2");
    expect(r.request.headers).toEqual([{ key: "X-Trace", value: "example.com", disabled: false }]);
    expect(r.request.body).toMatchObject({ mode: "raw", raw: '{"a":1}' });
  });

  it("supports async code, setTimeout and pm.sendRequest", async () => {
    const r = await runScript(
      `setTimeout(() => console.log("later"), 10);
       pm.sendRequest("https://x.test/ping", (err, res) => {
         pm.test("callback", () => pm.expect(res.json().pong).to.be.true);
       });
       const res = await pm.sendRequest({ url: "https://x.test/ping", method: "POST" });
       pm.environment.set("code", res.code);`,
      ctx(),
      {
        host: {
          sendRequest: async () => ({
            code: 200,
            status: "OK",
            headers: [],
            body: '{"pong":true}',
            responseTime: 1,
            responseSize: 13,
          }),
        },
      },
    );
    expect(r.error).toBeUndefined();
    expect(r.tests).toEqual([{ name: "callback", passed: true, skipped: false }]);
    expect(r.logs.map((l) => l.message)).toContain("later");
    expect(r.scopes.environment.code).toBe("200");
  });

  it("enforces time and memory limits", async () => {
    const t = await runScript("while (true) {}", ctx(), { limits: { timeoutMs: 200 } });
    expect(t.error).toMatch(/time limit/);
    const m = await runScript("const a = []; while (true) a.push(new Array(100000).fill(1));", ctx(), {
      limits: { memoryBytes: 8 * 1024 * 1024 },
    });
    expect(m.error).toMatch(/memory/);
  });

  it("has no access to host APIs", async () => {
    const r = await runScript(
      `pm.test("isolated", () => {
         pm.expect(typeof process).to.equal("undefined");
         pm.expect(typeof fetch).to.equal("undefined");
         pm.expect(() => require("fs")).to.throw(/not available/);
       });`,
      ctx(),
    );
    expect(r.tests[0]).toMatchObject({ passed: true });
  });

  it("reports syntax and runtime errors with redacted secrets", async () => {
    expect((await runScript("foo(", ctx())).error).toMatch(/SyntaxError/);
    const r = await runScript('throw new Error("bad token s3cr3t")', ctx(), { secrets: ["s3cr3t"] });
    expect(r.error).toBe("bad token ********");
    const l = await runScript('console.log("s3cr3t")', ctx(), { secrets: ["s3cr3t"] });
    expect(l.logs[0].message).toBe("********");
  });

  it("supports legacy tests[] and setNextRequest", async () => {
    const r = await runScript(
      'tests["legacy"] = responseCode.code === 201; postman.setNextRequest("Next");',
      ctx(),
    );
    expect(r.tests).toEqual([{ name: "legacy", passed: true, skipped: false }]);
    expect(r.nextRequest).toBe("Next");
  });
});
