import { describe, expect, it, vi } from "vitest";
import { getQuickJS } from "quickjs-emscripten";
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
  it("limits host requests and timer creation before allocating more work", async () => {
    const sendRequest = vi.fn(async () => ({
      code: 200,
      status: "OK",
      headers: [],
      body: "{}",
      responseTime: 1,
      responseSize: 2,
    }));
    const requests = await runScript(
      'for (let i = 0; i < 10; i++) pm.sendRequest("https://example.com");',
      ctx(),
      { host: { sendRequest }, limits: { maxHostRequests: 2 } },
    );
    expect(requests.error).toMatch(/pm.sendRequest quota/);
    expect(sendRequest).toHaveBeenCalledTimes(2);
    const timers = await runScript("for (let i = 0; i < 10; i++) setTimeout(() => {}, 0);", ctx(), {
      limits: { maxTimers: 3 },
    });
    expect(timers.error).toMatch(/setTimeout quota/);
  });

  it("aborts pending host work when the script times out", async () => {
    let signal: AbortSignal | undefined;
    const result = await runScript('await pm.sendRequest("https://example.com");', ctx(), {
      limits: { timeoutMs: 20 },
      host: {
        sendRequest: async (_spec, currentSignal) => {
          signal = currentSignal;
          return new Promise((_resolve, reject) =>
            currentSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
          );
        },
      },
    });
    expect(result.error).toMatch(/time limit/);
    expect(signal?.aborted).toBe(true);
  });

  it("disposes runtimes and cancels every host timer during repeated interrupted scripts", async () => {
    const quickjs = await getQuickJS();
    const original = quickjs.newRuntime.bind(quickjs);
    const runtimes: ReturnType<typeof quickjs.newRuntime>[] = [];
    const runtimeSpy = vi.spyOn(quickjs, "newRuntime").mockImplementation((...args) => {
      const runtime = original(...args);
      runtimes.push(runtime);
      return runtime;
    });
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      for (let i = 0; i < 25; i++) {
        const result = await runScript("setTimeout(() => {}, 60000); while (true) {}", ctx(), {
          limits: { timeoutMs: 5 },
        });
        expect(result.error).toMatch(/time limit/);
      }
      for (const result of timers.mock.results) {
        if (result.type === "return")
          expect(clear.mock.calls.some(([handle]) => handle === result.value)).toBe(true);
      }
      expect(runtimes).toHaveLength(25);
      expect(runtimes.every((runtime) => !runtime.alive)).toBe(true);
    } finally {
      runtimeSpy.mockRestore();
      timers.mockRestore();
      clear.mockRestore();
    }
  });

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

  it("does not run callbacks for cleared timers", async () => {
    const r = await runScript(
      `let fired = false;
       const timer = setTimeout(() => { fired = true; }, 1);
       clearTimeout(timer);
       await new Promise((resolve) => setTimeout(resolve, 5));
       pm.test("cleared", () => pm.expect(fired).to.be.false);`,
      ctx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.tests).toEqual([{ name: "cleared", passed: true, skipped: false }]);
  });

  it("supports callback-style async tests and test indexing", async () => {
    const r = await runScript(
      `await new Promise((resolve) => {
         pm.test("callback", (done) => setTimeout(() => {
           pm.expect(pm.response.code).to.equal(201);
           done();
           resolve();
         }, 1));
       });
       pm.test("index", () => pm.expect(pm.test.index()).to.equal(1));
       pm.test("callback error", (done) => done(new Error("expected failure")));
       pm.test("async assertion error", (done) => setTimeout(() => {
         pm.expect(false).to.be.true;
         done();
       }, 1));`,
      ctx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.tests).toEqual([
      { name: "callback", passed: true, skipped: false },
      { name: "index", passed: true, skipped: false },
      { name: "callback error", passed: false, error: "expected failure", skipped: false },
      {
        name: "async assertion error",
        passed: false,
        error: "expected false to be true",
        skipped: false,
      },
    ]);
  });

  it("resolves pm.execution.runRequest through its bounded host capability", async () => {
    const runRequest = vi.fn(async () => ({
      code: 202,
      status: "Accepted",
      headers: [],
      body: '{"queued":true}',
      responseTime: 3,
      responseSize: 15,
    }));
    const r = await runScript(
      `const response = await pm.execution.runRequest("saved-request", { variables: { id: 7 } });
       pm.test("referenced response", () => pm.expect(response.json().queued).to.be.true);`,
      ctx(),
      { host: { runRequest } },
    );
    expect(r.error).toBeUndefined();
    expect(r.tests[0]).toMatchObject({ name: "referenced response", passed: true });
    expect(runRequest).toHaveBeenCalledWith(
      "saved-request",
      { variables: { id: 7 } },
      expect.any(AbortSignal),
    );
  });

  it("enforces the Postman runRequest limit and reports missing host support", async () => {
    const runRequest = vi.fn(async () => null);
    const limited = await runScript(
      `for (let i = 0; i < 11; i++) await pm.execution.runRequest("saved-request");`,
      ctx(),
      { host: { runRequest } },
    );
    expect(limited.error).toMatch(/runRequest quota of 10/);
    expect(runRequest).toHaveBeenCalledTimes(10);

    const unavailable = await runScript(`await pm.execution.runRequest("saved-request");`, ctx());
    expect(unavailable.error).toMatch(/runRequest is not available/);
  });

  it("reports clear errors for documented APIs that Postbox does not support", async () => {
    const r = await runScript(
      `pm.test("vault", () => pm.expect(() => pm.vault.get("key")).to.throw(/pm.vault is not supported/));
       pm.test("visualizer", () => pm.expect(() => pm.visualizer.set("view", "<p>hi</p>")).to.throw(/pm.visualizer is not supported/));
       pm.test("packages", () => pm.expect(() => pm.require("package")).to.throw(/pm.require is not supported/));
       pm.test("datasets", () => pm.expect(() => pm.datasets("select 1")).to.throw(/pm.datasets is not supported/));
       pm.test("state", () => pm.expect(() => pm.state.get("key")).to.throw(/pm.state is not supported/));
       pm.test("mock", () => pm.expect(() => pm.mock.create({})).to.throw(/pm.mock is not supported/));`,
      ctx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.tests).toHaveLength(6);
    expect(r.tests.every((test) => test.passed)).toBe(true);
  });

  it("compares Chai members as multisets and honors ordered members", async () => {
    const r = await runScript(
      `pm.test("members", () => {
         pm.expect([1, 1, 2]).to.have.members([1, 2, 1]);
         pm.expect([1, 1, 2]).to.include.members([1, 1]);
         pm.expect(() => pm.expect([1, 1]).to.have.members([1, 2])).to.throw(/same members/);
       });
       pm.test("ordered", () => {
         pm.expect([1, 2, 3]).to.have.ordered.members([1, 2, 3]);
         pm.expect([1, 2, 3]).to.include.ordered.members([1, 3]);
         pm.expect(() => pm.expect([1, 2, 3]).to.have.ordered.members([2, 1, 3])).to.throw(/same members/);
       });`,
      ctx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.tests.map((test) => test.passed)).toEqual([true, true]);
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
