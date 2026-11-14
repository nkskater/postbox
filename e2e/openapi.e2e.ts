import { expect, inject, it } from "vitest";

it("serves the OpenAPI contract anonymously on an authenticated production instance", async () => {
  const base = inject("authUrl");
  const response = await fetch(`${base}/api/openapi.json`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  const contract = await response.json();
  expect(contract).toMatchObject({ openapi: "3.1.0", info: { title: "Postbox management API" } });
  expect(Object.keys(contract.paths).length).toBeGreaterThan(0);
  expect((await fetch(`${base}/api/workspaces`)).status).toBe(401);
  expect((await fetch(`${base}/api/openapi.json/private`)).status).toBe(401);
});
