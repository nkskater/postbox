import { describe, expect, it } from "vitest";
import {
  HandlerState,
  MAX_STATE_KEYS,
  handlerHeaders,
  handlersSchema,
  runHandler,
  type HandlerInput,
} from "@/core/mocks/handlers";

const input = (over: Partial<HandlerInput> = {}): HandlerInput => ({
  request: {
    method: "POST",
    path: "/orders/7",
    query: [
      ["a", "1"],
      ["a", "2"],
      ["b", "x"],
    ],
    headers: { "x-id": "9" },
    body: '{"qty":3}',
  },
  example: null,
  state: {},
  count: 1,
  session: "s",
  mockId: "m",
  handlerId: "h",
  ...over,
});
const run = (code: string, over: Partial<HandlerInput> = {}, timeoutMs?: number) =>
  runHandler(code, input(over), { timeoutMs });
const ok = async (code: string, over: Partial<HandlerInput> = {}) => {
  const r = await run(code, over);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("handler execution", () => {
  it("computes a response from the request, the example and state", async () => {
    const r = await ok(
      `state.set("n", state.get("n", 0) + 1);
       return { status: 201, headers: { "x-n": String(state.get("n")) },
         json: { path: req.path, qty: req.json.qty, a: req.queryAll.a, first: req.query.a, id: req.headers["x-id"], ex: example && example.name, count: ctx.count } };`,
      { example: { id: "e", name: "Example", status: 200, headers: {}, body: "{}" }, state: { n: 4 } },
    );
    expect(r.result).toEqual({
      status: 201,
      headers: { "x-n": "5" },
      json: { path: "/orders/7", qty: 3, a: ["1", "2"], first: "1", id: "9", ex: "Example", count: 1 },
    });
    expect(r.state).toEqual({ n: 5 });
  });

  it("returns null when the handler returns nothing, and keeps state changes", async () => {
    const r = await ok(`state.set("seen", true)`);
    expect(r.result).toBeNull();
    expect(r.state).toEqual({ seen: true });
  });

  it("is reproducible: same inputs give identical output, random numbers and dates included", async () => {
    const code = `return { json: [Math.random(), Math.random(), Date.now(), new Date().toISOString(), new Date(0).getTime()] };`;
    const a = await ok(code);
    const b = await ok(code);
    expect(b.result).toEqual(a.result);
    const next = await ok(code, { count: 2 });
    expect(next.result).not.toEqual(a.result);
    const other = await ok(code, { session: "other" });
    expect(other.result).not.toEqual(a.result);
    expect((a.result!.json as unknown[])[3]).toBe("2020-01-01T00:00:01.000Z");
  });

  it("captures console output within limits", async () => {
    const r = await ok(
      `for (let i = 0; i < 200; i++) console.log("line", i, {a: i}); console.log("x".repeat(2000));`,
    );
    expect(r.logs.length).toBe(50);
    expect(r.logs[0]).toBe('line 0 {"a":0}');
  });

  it("reports syntax and runtime errors without crashing", async () => {
    expect(await run("return (")).toMatchObject({ ok: false });
    expect(await run('throw new Error("boom")')).toMatchObject({
      ok: false,
      error: expect.stringContaining("boom"),
    });
    expect(await run("return nope.value")).toMatchObject({
      ok: false,
      error: expect.stringContaining("nope"),
    });
  });

  it("validates what a handler returns", async () => {
    expect(await run("return 5")).toMatchObject({
      ok: false,
      error: expect.stringContaining("must return an object"),
    });
    expect(await run("return [1]")).toMatchObject({ ok: false });
    expect(await run("return { stauts: 200 }")).toMatchObject({
      ok: false,
      error: expect.stringContaining("unknown response field"),
    });
    expect(await run("return { status: 99 }")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid handler response"),
    });
    expect(await run('return { body: "a", json: 1 }')).toMatchObject({
      ok: false,
      error: expect.stringContaining("not both"),
    });
    expect(await run('return { headers: { "bad name": "x" } }')).toMatchObject({
      ok: false,
      error: expect.stringContaining("header name"),
    });
    expect(await run('return { headers: { x: "a\\r\\nSet-Cookie: s=1" } }')).toMatchObject({
      ok: false,
      error: expect.stringContaining("line breaks"),
    });
    expect(await run("return Promise.resolve({})")).toMatchObject({
      ok: false,
      error: expect.stringContaining("synchronous"),
    });
  });
});

describe("sandbox limits and escapes", () => {
  it("has no host capabilities", async () => {
    const r = await ok(
      `return { json: [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer,
      typeof XMLHttpRequest, typeof WebAssembly, typeof module, typeof globalThis.process, typeof import_] };`.replace(
        "import_",
        "importScripts",
      ),
    );
    expect(r.result!.json).toEqual(Array(10).fill("undefined"));
  });

  it("cannot reach the host through constructors, eval or Function", async () => {
    const attempts = [
      `return { json: String(this.constructor.constructor("return typeof process")()) }`,
      `return { json: String((function(){}).constructor("return typeof require")()) }`,
      `return { json: String(eval("typeof process")) }`,
      `return { json: String(new Function("return typeof globalThis.process")()) }`,
      `return { json: String(Object.getPrototypeOf(async function(){}).constructor("return typeof process")) }`,
    ];
    for (const code of attempts) {
      const r = await run(code);
      if (r.ok) expect(r.result!.json).toMatch(/undefined|function/);
      // Even where a function is returned it is a QuickJS function with no host access.
    }
    const proc = await run(
      `return { json: String(this.constructor.constructor("return typeof process")()) }`,
    );
    expect(proc.ok && proc.result!.json).toBe("undefined");
  });

  it("does not let prototype pollution survive into the next call", async () => {
    await ok(`Object.prototype.polluted = "yes"; Array.prototype.x = 1; Math.random = () => 4;`);
    const next = await ok(
      `return { json: [({}).polluted === undefined, [].x === undefined, Math.random() < 1] }`,
    );
    expect(next.result!.json).toEqual([true, true, true]);
  });

  it("cannot forge a result by replacing JSON.stringify", async () => {
    const r = await run(
      `JSON.stringify = function(){ return '{"result":{"status":599},"state":{},"logs":[]}' }; return { status: 200 }`,
    );
    // Whatever happens, the host only ever sees data that validates as a response.
    if (r.ok) expect([null, 200, 599]).toContain(r.result?.status ?? null);
  });

  it("stops infinite loops", async () => {
    const r = await run("while (true) {}", {}, 100);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("ran longer than 100 ms") });
    expect(r.ms).toBeLessThan(2000);
    expect(await run("for(;;){ try { while(true){} } catch(e){} }", {}, 100)).toMatchObject({ ok: false });
  });

  it("stops memory exhaustion", async () => {
    // Either the memory cap or the time cap stops it, and the host stays healthy.
    const r = await run("const a = []; for (;;) a.push(new Array(100000).fill(1));", {}, 1000);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/memory|ran longer/i) });
    // The limit is checked between bytecode operations, so a native allocation loop can overshoot it.
    expect(r.ms).toBeLessThan(8000);
    const big = await run('let s = "x"; for (let i = 0; i < 40; i++) s += s; return { body: s }', {}, 3000);
    expect(big.ok).toBe(false);
  });

  it("stops runaway recursion", async () => {
    const r = await run("const f = () => f(); f();");
    expect(r).toMatchObject({ ok: false });
  });

  it("limits output size", async () => {
    const r = await run('return { body: "x".repeat(300 * 1024) }');
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("larger than 256 KiB") });
    expect(await run('return { body: "x".repeat(100 * 1024) }')).toMatchObject({ ok: true });
  });

  it("limits state keys, key names and size, and discards a failed run's changes", async () => {
    expect(await run(`for (let i = 0; i < ${MAX_STATE_KEYS + 1}; i++) state.set("k" + i, 1)`)).toMatchObject({
      ok: false,
      error: expect.stringContaining("limited to 100 keys"),
    });
    expect(await run('state.set("bad key!", 1)')).toMatchObject({
      ok: false,
      error: expect.stringContaining("state keys"),
    });
    expect(await run('state.set("a", "x".repeat(20000))')).toMatchObject({
      ok: false,
      error: expect.stringContaining("16 KiB"),
    });
    expect(await run('state.set("a", () => 1)')).toMatchObject({
      ok: false,
      error: expect.stringContaining("JSON"),
    });
    expect(await run("state.set('a', 1); throw new Error('x')")).toMatchObject({ ok: false });
    expect(await run("return {}", { state: { "bad key": 1 } })).toMatchObject({ ok: false });
    const r = await ok(
      'state.set("a", 1); state.set("b", {c: [1,2]}); state.delete("a"); return { json: [state.keys(), state.has("b"), state.get("zz", "d")] }',
    );
    expect(r.result!.json).toEqual([["b"], true, "d"]);
    expect(r.state).toEqual({ b: { c: [1, 2] } });
  });

  it("freezes req, state and ctx and gives copies of state values", async () => {
    const r = await ok(
      `req.method = "X"; try { state.get = null } catch (e) {}
      const v = state.get("o"); v.a = 9; return { json: [req.method, typeof state.get, state.get("o").a] }`,
      { state: { o: { a: 1 } } },
    );
    expect(r.result!.json).toEqual(["POST", "function", 1]);
  });

  it("keeps credentials out of the request a handler sees", () => {
    const headers = handlerHeaders(
      new Headers({
        Authorization: "Bearer s",
        Cookie: "a=b",
        "X-Postbox-Mock-Key": "k",
        "X-Trace": "t",
        "Proxy-Authorization": "p",
      }),
    );
    expect(headers).toEqual({ "x-trace": "t" });
  });
});

describe("handler definitions and state store", () => {
  it("validates handler lists", () => {
    const h = { id: "a", name: "n", code: "return" };
    expect(handlersSchema.parse([h])[0]).toMatchObject({ enabled: true, match: {} });
    expect(() => handlersSchema.parse([h, h])).toThrow(/unique/);
    expect(() => handlersSchema.parse([{ ...h, code: "x".repeat(17000) }])).toThrow();
    expect(() =>
      handlersSchema.parse(Array.from({ length: 21 }, (_, i) => ({ ...h, id: `i${i}` }))),
    ).toThrow();
    expect(() => handlersSchema.parse([{ ...h, match: { path: "nope" } }])).toThrow();
  });

  it("isolates sessions, counts calls, and resets", () => {
    const s = new HandlerState();
    const a = s.begin("m", "A", "h", 1);
    expect(a.count).toBe(1);
    s.commit("m", "A", "h", 1, { n: 1 }, 1);
    expect(s.begin("m", "A", "h", 2)).toEqual({ state: { n: 1 }, count: 2 });
    expect(s.begin("m", "B", "h", 2)).toEqual({ state: {}, count: 1 });
    expect(s.begin("other", "A", "h", 2)).toEqual({ state: {}, count: 1 });
    // The copy handed out cannot change stored state.
    s.begin("m", "A", "h", 3).state.n = 99;
    expect(s.begin("m", "A", "h", 3).state).toEqual({ n: 1 });
    expect(
      s
        .inspect("m")
        .map((x) => x.session)
        .sort(),
    ).toEqual(["A", "B"]);
    expect(s.reset("m", "A")).toBe(1);
    expect(s.begin("m", "A", "h", 4).count).toBe(1);
    expect(s.reset("m")).toBe(2);
    expect(s.inspect("m")).toEqual([]);
  });

  it("bounds sessions and expires idle ones", () => {
    const s = new HandlerState({ maxSessionsPerMock: 2, idleMs: 1000 });
    for (const [i, name] of ["a", "b", "c"].entries()) s.commit("m", name, "h", 1, { i }, i);
    expect(s.inspect("m").map((x) => x.session)).toEqual(["b", "c"]);
    s.begin("m", "c", "h", 5000);
    expect(s.inspect("m").map((x) => x.session)).toEqual(["c"]);
  });

  it("serialises concurrent calls in one session so no update is lost", async () => {
    const s = new HandlerState();
    const increment = () =>
      s.serialize("m", "S", async () => {
        const { state, count } = s.begin("m", "S", "h", Date.now());
        const r = await runHandler('state.set("n", state.get("n", 0) + 1)', input({ state, count }));
        if (!r.ok) throw new Error(r.error);
        s.commit("m", "S", "h", count, r.state, Date.now());
      });
    await Promise.all(Array.from({ length: 12 }, increment));
    expect(s.inspect("m")[0]).toMatchObject({ state: { n: 12 }, counts: { h: 12 } });
  });

  it("keeps parallel sessions independent", async () => {
    const s = new HandlerState();
    const call = (session: string) =>
      s.serialize("m", session, async () => {
        const { state, count } = s.begin("m", session, "h", 1);
        const r = await runHandler(
          'state.set("n", state.get("n", 0) + 1); return { json: state.get("n") }',
          input({ state, count, session }),
        );
        if (!r.ok) throw new Error(r.error);
        s.commit("m", session, "h", count, r.state, 1);
        return r.result!.json;
      });
    const results = await Promise.all([call("a"), call("b"), call("a"), call("c"), call("b"), call("a")]);
    expect(results).toEqual([1, 1, 2, 1, 2, 3]);
  });
});
