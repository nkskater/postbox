import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { getQuickJS } from "quickjs-emscripten";
import { runScript, type ScriptContext } from "@/core/scripts/sandbox";
import { emptyScopes } from "@/core/variables/resolver";

const context = (): ScriptContext => ({
  scopes: emptyScopes(),
  request: { url: "https://example.com/a", method: "GET", headers: [] },
  response: { code: 200, status: "OK", headers: [], body: '{"id":1}', responseTime: 1, responseSize: 8 },
  info: { eventName: "test", iteration: 0, iterationCount: 1, requestName: "lazy", requestId: "r1" },
});

async function loadedUnits(code: string) {
  const quickjs = await getQuickJS();
  const original = quickjs.newRuntime.bind(quickjs);
  const units: string[] = [];
  const spy = vi.spyOn(quickjs, "newRuntime").mockImplementation((...args) => {
    const runtime = original(...args);
    const newContext = runtime.newContext.bind(runtime);
    vi.spyOn(runtime, "newContext").mockImplementation((...options) => {
      const vm = newContext(...options);
      const evaluate = vm.evalCode.bind(vm);
      vi.spyOn(vm, "evalCode").mockImplementation((source, filename, flags) => {
        if (filename?.startsWith("postbox-library-")) units.push(filename.slice(16, -3));
        return evaluate(source, filename, flags);
      });
      return vm;
    });
    return runtime;
  });
  try {
    const result = await runScript(code, context());
    expect(result.error).toBeUndefined();
    expect(result.tests.every((test) => test.passed)).toBe(true);
    return units;
  } finally {
    spy.mockRestore();
  }
}

describe("lazy sandbox libraries", () => {
  it("evaluates only the core and Chai for scalar response assertions", async () => {
    expect(await loadedUnits("pm.test('ok', () => pm.expect(pm.response.code).to.eql(200));")).toEqual([
      "core",
      "chai",
    ]);
  });

  it("requiring lodash loads its Buffer dependency without the SDK or validators", async () => {
    expect(await loadedUnits("pm.expect(require('lodash').chunk([1,2],1)).to.have.length(2);")).toEqual([
      "core",
      "chai",
      "lodash",
      "buffer",
    ]);
  });

  it("loads approved packages once on demand and shares exports with pm.require", async () => {
    const units = await loadedUnits(`
      pm.expect(require('lodash')).to.equal(pm.require('npm:lodash@4.18.1'));
      pm.expect(require('lodash').chunk([1,2],1)).to.deep.equal([[1],[2]]);
      pm.expect(Buffer).to.equal(require('buffer').Buffer);
      pm.expect(require('buffer')).to.equal(pm.require('npm:buffer@6.0.3'));
      pm.expect(Buffer.from('hello').toString()).to.equal('hello');
    `);
    expect(units).toEqual(["core", "chai", "lodash", "buffer"]);
  });

  it("keeps package mutations within each fresh runtime", async () => {
    await loadedUnits("require('lodash').privateMarker = true;");
    const units = await loadedUnits("pm.expect(require('lodash').privateMarker).to.equal(undefined);");
    expect(units).not.toContain("postman-collection");
    expect(units).not.toContain("ajv");
  });

  it("preserves SDK identity, reflection, mutations and legacy snapshots", async () => {
    await loadedUnits(`
      const sdk = require('postman-collection');
      pm.expect(pm.request).to.be.instanceOf(sdk.Request);
      pm.expect(pm.response).to.be.instanceOf(sdk.Response);
      pm.expect(sdk.Response.isResponse(pm.response)).to.equal(true);
      pm.response.code = 201;
      pm.response.to.have.status(201);
      pm.expect(Object.keys(pm.response)).to.include('code');
      Object.defineProperty(pm.response, 'marker', { value: 42 });
      pm.expect(Object.getOwnPropertyDescriptor(pm.response, 'marker').configurable).to.equal(false);
      Object.preventExtensions(pm.response);
      pm.expect(Object.isExtensible(pm.response)).to.equal(false);
      pm.request.method = 'POST';
      pm.expect(request.method).to.equal('GET');
      pm.expect(responseCode.code).to.equal(200);
      pm.expect(responseBody).to.equal('{"id":1}');
      pm.expect(responseHeaders).to.deep.equal({});
    `);
  });

  it("interrupts a stuck lazy initializer and disposes its runtime", async () => {
    const { LIBRARY_UNITS } = await import("@/core/scripts/libraries.generated");
    const originalSource = LIBRARY_UNITS.lodash;
    const quickjs = await getQuickJS();
    const original = quickjs.newRuntime.bind(quickjs);
    const runtimes: ReturnType<typeof quickjs.newRuntime>[] = [];
    const spy = vi.spyOn(quickjs, "newRuntime").mockImplementation((...args) => {
      const runtime = original(...args);
      runtimes.push(runtime);
      return runtime;
    });
    try {
      LIBRARY_UNITS.lodash = "while (true) {}";
      const result = await runScript("require('lodash');", context(), { limits: { timeoutMs: 20 } });
      expect(result.error).toMatch(/time limit/);
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0].alive).toBe(false);
    } finally {
      LIBRARY_UNITS.lodash = originalSource;
      spy.mockRestore();
    }
  });

  it("keeps warmed core-only startup well below the old eager bundle cost", async () => {
    const code = "pm.test('ok', () => pm.expect(pm.response.code).to.eql(200));";
    for (let i = 0; i < 5; i++) await runScript(code, context());
    const samples: number[] = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      const result = await runScript(code, context());
      samples.push(performance.now() - start);
      expect(result.error).toBeUndefined();
      expect(result.tests).toMatchObject([{ passed: true }]);
    }
    const mean = samples.reduce((total, ms) => total + ms, 0) / samples.length;
    console.info(`Core-only sandbox startup: ${mean.toFixed(2)} ms mean (15 fresh runtimes)`);
    // Allow shared CI scheduling variance while rejecting the former ~190 ms startup.
    expect(mean).toBeLessThan(60);
  });
});
