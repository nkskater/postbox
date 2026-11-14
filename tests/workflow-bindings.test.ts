import http from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { execute } from "@/core/executor";
import { defaultRequest } from "@/server/defaults";
import { emptyScopes, resolveTemplate } from "@/core/variables/resolver";
const token = "workspace-private-credential";
it("keeps input-shaped references literal through local aliases and request-script copies", () => {
  const scopes = emptyScopes();
  scopes.vault = { private: token };
  scopes.globals.secret = token;
  scopes.local["flow.input"] = "{{vault:private}}";
  scopes.local.copy = "{{vault:private}}";
  scopes.literalLocalKeys = ["flow.input"];
  scopes.literalTemplates = ["{{vault:private}}"];
  scopes.globals.alias = "{{copy}}";
  for (const text of ["{{flow.input}}", "{{copy}}", "{{alias}}", "{{vault:private}}"])
    expect(resolveTemplate(text, scopes).value).toBe("{{vault:private}}");
  expect(resolveTemplate("{{secret}}", scopes).value).toBe(token);
});
let server: http.Server, base: string;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(req.url === "/large" ? JSON.stringify({ large: "x".repeat(5000) }) : JSON.stringify({ body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it("preserves literal binding policy after prerequest scripts and pm.sendRequest", async () => {
  const scopes = emptyScopes();
  scopes.vault = { private: token };
  scopes.local["flow.input"] = "{{vault:private}}";
  scopes.literalLocalKeys = ["flow.input"];
  scopes.literalTemplates = ["{{vault:private}}"];
  const request = defaultRequest({
    method: "POST",
    url: base + "/echo",
    body: { mode: "raw", language: "text", raw: "{{copied}}" },
    preRequestScript: `pm.variables.set("copied",pm.variables.get("flow.input")); const response=await pm.sendRequest({url:${JSON.stringify(base + "/echo")},method:"POST",body:{mode:"raw",raw:pm.variables.get("flow.input")}});pm.test("nested literal data",()=>pm.expect(response.json().body).to.equal("{{vault:private}}"));`,
  });
  const result = await execute({ request, ancestors: [], scopes, maxResponseBytes: 10000 });
  expect(result.error).toBeUndefined();
  expect(result.response?.bodyText).toBe(JSON.stringify({ body: "{{vault:private}}" }));
  expect(result.tests[0]).toMatchObject({ name: "nested literal data", passed: true });
  expect(JSON.stringify(result.sent)).not.toContain(token);
});
it("applies stricter response caps to both graph requests and script host requests", async () => {
  const request = defaultRequest({
    url: base + "/large",
    preRequestScript: `const response=await pm.sendRequest(${JSON.stringify(base + "/large")});pm.test("bounded nested response",()=>pm.expect(response.text().length).to.be.at.most(1000));`,
  });
  const result = await execute({ request, ancestors: [], scopes: emptyScopes(), maxResponseBytes: 1000 });
  expect(result.error).toBeUndefined();
  expect(result.response?.truncated).toBe(true);
  expect(result.response!.bodyBase64.length).toBeLessThan(1400);
  expect(result.tests[0].passed).toBe(true);
});

it("retains expansion limits when protecting literal workflow input", () => {
  const scopes = emptyScopes();
  scopes.literalTemplates = ["{{external}}"];
  scopes.globals.a = "{{a}}".repeat(20);
  expect(() => resolveTemplate("{{a}} {{external}}", scopes)).toThrow(/expansion exceeds/);
});

it("checks restored literal size before allocating repeated workflow input", () => {
  const scopes = emptyScopes();
  const literal = `{{${"x".repeat(60000)}}}`;
  scopes.literalTemplates = [literal];
  scopes.local.copy = literal;
  expect(() => resolveTemplate("{{copy}}".repeat(1000), scopes)).toThrow(/expansion exceeds/);
});
