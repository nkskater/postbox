import { describe, it, expect } from "vitest";
import { runScript } from "@/core/scripts/sandbox";
import { emptyScopes } from "@/core/variables/resolver";
const context = {
  scopes: emptyScopes(),
  request: { url: "https://example.test", method: "GET", headers: [] },
  info: {
    eventName: "test" as const,
    iteration: 0,
    iterationCount: 1,
    requestName: "Test",
    requestId: "test",
  },
};
const modules = {
  modules: {
    "@team/math@1": { source: "let calls=0;exports.add=(a,b)=>a+b;exports.next=()=>++calls;", hash: "hash" },
  },
  aliases: { "@team/math": "@team/math@1" },
};
describe("script package sandbox loader", () => {
  it("loads pinned and approved bundled libraries without host require", async () => {
    const result = await runScript(
      'const lodash=pm.require("npm:lodash@4.18.1");const chai=pm.require("npm:chai@4.5.0");pm.test("libraries",()=>chai.expect(lodash.sum([2,3])).to.equal(5));',
      context,
    );
    expect(result.error).toBeUndefined();
    expect(result.tests[0].passed).toBe(true);
    for (const name of ["fs", "node:fs", "npm:lodash@0.0.0", "https://evil.test/script.js"]) {
      const denied = await runScript(`pm.require(${JSON.stringify(name)});`, context);
      expect(denied.error).toMatch(/unavailable|not approved/);
    }
  });
  it("loads immutable team versions and caches exports only inside one isolate", async () => {
    const code =
      'const a=pm.require("@team/math@1"),b=pm.require("@team/math");pm.test("same module",()=>pm.expect(a===b).to.equal(true));pm.test("counter",()=>{pm.expect(a.next()).to.equal(1);pm.expect(b.next()).to.equal(2);pm.expect(a.add(2,4)).to.equal(6);});';
    for (let i = 0; i < 2; i++) {
      const result = await runScript(code, { ...context, scriptModules: modules });
      expect(result.error).toBeUndefined();
      expect(result.tests.every((t) => t.passed)).toBe(true);
    }
  });
  it("supports nested imports and refuses cycles without executing a host module", async () => {
    const snapshot = {
      modules: {
        ...modules.modules,
        "@team/caller@1": { source: 'exports.result=require("@team/math@1").add(3,4);', hash: "caller" },
      },
      aliases: {},
    };
    const result = await runScript(
      'pm.test("nested",()=>pm.expect(pm.require("@team/caller@1").result).to.equal(7));',
      { ...context, scriptModules: snapshot },
    );
    expect(result.error).toBeUndefined();
    expect(result.tests[0].passed).toBe(true);
    const cycle = await runScript('pm.require("@team/cycle@1");', {
      ...context,
      scriptModules: {
        modules: { "@team/cycle@1": { source: 'require("@team/cycle@1");', hash: "cycle" } },
        aliases: {},
      },
    });
    expect(cycle.error).toMatch(/Cyclic/);
  });
  it("enforces the script deadline for module initializers and prevents host access", async () => {
    const looping = await runScript(
      'pm.require("@team/loop@1");',
      {
        ...context,
        scriptModules: {
          modules: { "@team/loop@1": { source: "while(true){}", hash: "loop" } },
          aliases: {},
        },
      },
      { limits: { timeoutMs: 20 } },
    );
    expect(looping.error).toMatch(/time limit|timed out|interrupted/i);
    const denied = await runScript('pm.require("@team/escape@1");', {
      ...context,
      scriptModules: {
        modules: {
          "@team/escape@1": {
            source: 'module.exports=require("node:fs").readFileSync("/etc/passwd");',
            hash: "escape",
          },
        },
        aliases: {},
      },
    });
    expect(denied.error).toMatch(/unavailable|not approved/);
  });
});
