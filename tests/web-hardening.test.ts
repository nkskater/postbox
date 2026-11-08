import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { proxy } from "@/proxy";
import { SESSION_COOKIE } from "@/server/auth";
import { callerOf } from "@/server/caller";
import { restPolicy } from "@/server/access-policy";
import { allowedOrigins, isCrossOriginWrite } from "@/server/request-origin";
import { route } from "@/server/http";

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "postbox-hardening-")), "h.db");

afterEach(() => {
  delete process.env.POSTBOX_PASSWORD;
  delete process.env.POSTBOX_ALLOWED_ORIGINS;
});

const url = "http://postbox.local:3000/api/workspaces";
const write = (headers: Record<string, string>, method = "POST") =>
  isCrossOriginWrite(method, new Headers({ host: "postbox.local:3000", ...headers }), url, []);

describe("cross-origin write detection", () => {
  it("accepts reads, same-origin writes and clients without an Origin", () => {
    expect(write({ origin: "http://evil.local" }, "GET")).toBe(false);
    expect(write({ origin: "http://postbox.local:3000" })).toBe(false);
    expect(write({ origin: "http://POSTBOX.local:3000" }, "DELETE")).toBe(false);
    expect(write({})).toBe(false);
    expect(write({ "sec-fetch-site": "same-origin" })).toBe(false);
    expect(write({ "sec-fetch-site": "none" })).toBe(false);
  });

  it("rejects other origins, including other ports on the same host", () => {
    expect(write({ origin: "http://evil.local" })).toBe(true);
    expect(write({ origin: "http://postbox.local:8080" }, "PATCH")).toBe(true);
    expect(write({ origin: "null" })).toBe(true);
    expect(write({ "sec-fetch-site": "same-site" })).toBe(true);
    expect(write({ "sec-fetch-site": "cross-site", origin: "http://postbox.local:3000" })).toBe(true);
  });

  it("trusts forwarded hosts, bearer requests and configured origins", () => {
    expect(write({ origin: "https://postbox.example", "x-forwarded-host": "postbox.example" })).toBe(false);
    expect(write({ origin: "http://evil.local", authorization: "Bearer pbx_x" })).toBe(false);
    process.env.POSTBOX_ALLOWED_ORIGINS = " https://Postbox.Example/ , https://other.example";
    expect(allowedOrigins()).toEqual(["https://postbox.example", "https://other.example"]);
    const headers = new Headers({ host: "app:3000", origin: "https://postbox.example" });
    expect(isCrossOriginWrite("POST", headers, url)).toBe(false);
    expect(
      isCrossOriginWrite("POST", new Headers({ host: "app:3000", origin: "https://x.example" }), url),
    ).toBe(true);
  });
});

describe("proxy gate origin check", () => {
  const req = (pathname: string, headers: Record<string, string>, method = "POST") =>
    new NextRequest(new URL(pathname, "http://postbox.local"), {
      method,
      headers: { host: "postbox.local", ...headers },
    });
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("rejects cross-origin API writes even when sign-in is off", async () => {
    const res = proxy(req("/api/workspaces", { origin: "http://evil.local" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Cross-origin request rejected" });
    expect(proxy(req("/api/auth/login", { origin: "http://evil.local" })).status).toBe(403);
    expect(passes(proxy(req("/api/workspaces", { origin: "http://postbox.local" })))).toBe(true);
    expect(passes(proxy(req("/api/workspaces", { origin: "http://evil.local" }, "GET")))).toBe(true);
  });

  it("leaves public receivers and the MCP endpoint to their own rules", () => {
    const evil = { origin: "http://evil.local" };
    expect(passes(proxy(req("/mock/m1/items", evil)))).toBe(true);
    expect(passes(proxy(req("/hook/hk_1", evil)))).toBe(true);
    expect(passes(proxy(req("/api/telemetry/ingest/src_1/v1/traces", evil)))).toBe(true);
    expect(passes(proxy(req("/api/mcp", evil)))).toBe(true);
  });

  it("checks origin before authentication", () => {
    process.env.POSTBOX_PASSWORD = "hunter2";
    expect(proxy(req("/api/workspaces", { origin: "http://evil.local" })).status).toBe(403);
    expect(proxy(req("/api/workspaces", { origin: "http://postbox.local" })).status).toBe(401);
  });
});

describe("malformed session cookies", () => {
  it("count as no session instead of failing the request", async () => {
    process.env.POSTBOX_PASSWORD = "hunter2";
    const request = new Request("http://postbox.local/api/workspaces", {
      headers: { cookie: `${SESSION_COOKIE}=%E0%A4%A` },
    });
    expect(callerOf(request)).toBeNull();
    const handler = route(async (_req: Request) => Response.json({ ok: true }));
    expect((await handler(request)).status).toBe(401);
  });
});

describe("REST policy lookup", () => {
  it("matches parameterised routes and decodes the resource ID", () => {
    expect(restPolicy("GET", "/api/requests/abc%20def")).toMatchObject({
      pattern: "/api/requests/[id]",
      id: "abc def",
    });
    expect(restPolicy("GET", "/api/requests/abc/")).toMatchObject({ id: "abc" });
    expect(restPolicy("PUT", "/api/nothing-here")).toBeNull();
  });

  it("treats dots in route patterns literally", () => {
    expect(restPolicy("GET", "/api/openapi.json")).not.toBeNull();
    expect(restPolicy("GET", "/api/openapiXjson")).toBeNull();
  });

  it("answers 400 for an undecodable resource ID", async () => {
    const handler = route(async (_req: Request) => Response.json({ ok: true }));
    const res = await handler(new Request("http://postbox.local/api/requests/%E0%A4%A"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Malformed resource ID in the URL" });
  });
});

describe("default security headers", () => {
  it("protect the app and API but not the public receivers", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    const [{ source, headers }] = rules;
    expect(Object.fromEntries(headers.map((h) => [h.key, h.value]))).toEqual({
      "X-Frame-Options": "SAMEORIGIN",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
    const matcher = new RegExp(`^${source}$`);
    for (const p of ["/", "/login", "/api/workspaces", "/api/documentation/abc"])
      expect(matcher.test(p)).toBe(true);
    for (const p of ["/mock/m1/x", "/hook/hk_1", "/capture/tok/https/example.com"])
      expect(matcher.test(p)).toBe(false);
  });
});
