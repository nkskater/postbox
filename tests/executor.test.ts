import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execute } from "@/core/executor";
import { emptyScopes } from "@/core/variables/resolver";
import { DEFAULT_SETTINGS, type FolderDef, type RequestDef } from "@/core/types";
import { startTestServer, type TestServer } from "./helpers/server";

let server: TestServer;
beforeAll(async () => (server = await startTestServer()));
afterAll(() => server.close());

const folder = (p: Partial<FolderDef>): FolderDef => ({
  id: "f",
  name: "F",
  auth: { type: "inherit" },
  headers: [],
  preRequestScript: "",
  testScript: "",
  ...p,
});

const request = (p: Partial<RequestDef>): RequestDef => ({
  id: "r",
  name: "R",
  method: "GET",
  url: "{{base}}/echo",
  params: [],
  headers: [],
  body: { mode: "none" },
  auth: { type: "inherit" },
  preRequestScript: "",
  testScript: "",
  settings: { ...DEFAULT_SETTINGS },
  ...p,
});

describe("executor", () => {
  it("runs scripts in collection → folder → request order and inherits auth and headers", async () => {
    const collection = folder({
      name: "Col",
      auth: { type: "bearer", bearer: { token: "{{token}}" } },
      headers: [{ key: "X-Col", value: "1", enabled: true }],
      preRequestScript: 'pm.variables.set("order", "c"); pm.environment.set("token", "T1");',
      testScript: 'pm.test("collection test", () => pm.response.to.have.status(200));',
    });
    const sub = folder({
      name: "Sub",
      preRequestScript: 'pm.variables.set("order", pm.variables.get("order") + "f");',
    });
    const r = await execute({
      request: request({
        url: "{{base}}/echo?o={{order}}",
        preRequestScript: 'pm.variables.set("order", pm.variables.get("order") + "r");',
        testScript: 'pm.test("echo", () => pm.expect(pm.response.json().query.o).to.equal("cfr"));',
      }),
      ancestors: [collection, sub],
      scopes: { ...emptyScopes(), environment: { base: server.url } },
    });
    expect(r.error).toBeUndefined();
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ["collection test", true],
      ["echo", true],
    ]);
    const echo = JSON.parse(r.response!.bodyText);
    expect(echo.headers.authorization).toBe("Bearer T1");
    expect(echo.headers["x-col"]).toBe("1");
    expect(r.scopes.environment.token).toBe("T1");
  });

  it("uses iteration data and reports unresolved variables", async () => {
    const r = await execute({
      request: request({ url: "{{base}}/echo?asn={{asn_id}}&m={{missing}}" }),
      ancestors: [],
      scopes: { ...emptyScopes(), environment: { base: server.url }, data: { asn_id: "A-1" } },
    });
    expect(JSON.parse(r.response!.bodyText).query.asn).toBe("A-1");
    expect(r.unresolved).toEqual(["missing"]);
  });

  it("skips the request when a pre-request script calls skipRequest", async () => {
    const before = server.requests.length;
    const r = await execute({
      request: request({ preRequestScript: "pm.execution.skipRequest();" }),
      ancestors: [],
      scopes: { ...emptyScopes(), environment: { base: server.url } },
    });
    expect(r.skipped).toBe(true);
    expect(server.requests.length).toBe(before);
  });

  it("returns network errors without throwing and redacts secrets", async () => {
    const r = await execute({
      request: request({ url: "http://127.0.0.1:1/?k={{key}}" }),
      ancestors: [],
      scopes: { ...emptyScopes(), environment: { key: "topsecret" } },
      secrets: ["topsecret"],
    });
    expect(r.error).toMatch(/refused/i);
    expect(r.sent?.url).toContain("********");
    expect(JSON.stringify(r.logs)).not.toContain("topsecret");
  });
  it("resolves pm.sendRequest using variables changed earlier in the same script", async () => {
    const r = await execute({
      request: request({
        preRequestScript: `
        pm.variables.set("fresh", "updated");
        const res = await pm.sendRequest("{{base}}/echo?value={{fresh}}");
        pm.test("fresh variables", () => pm.expect(res.json().query.value).to.equal("updated"));
      `,
      }),
      ancestors: [],
      scopes: { ...emptyScopes(), environment: { base: server.url } },
    });
    expect(r.scriptErrors).toEqual([]);
    expect(r.tests[0].passed).toBe(true);
  });
});
