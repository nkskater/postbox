/** LAB-277: enforced Content-Security-Policy for app pages and HSTS over HTTPS. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "postbox-csp-")), "c.db");

const { proxy } = await import("@/proxy");
const { appCsp, appliesCsp } = await import("@/server/csp");

const get = (url: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(url, { headers: new Headers(headers) }));
const nonceOf = (policy: string | null) => /'nonce-([^']+)'/.exec(policy ?? "")?.[1];

describe("Content-Security-Policy", () => {
  it("is enforced on app pages with a fresh nonce per response", () => {
    const first = get("http://localhost/");
    const second = get("http://localhost/profile");
    const policy = first.headers.get("content-security-policy");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).not.toContain("unsafe-eval");
    expect(first.headers.get("content-security-policy-report-only")).toBeNull();
    const a = nonceOf(policy);
    const b = nonceOf(second.headers.get("content-security-policy"));
    expect(a).toMatch(/^[A-Za-z0-9+/]{24}$/);
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    // Next.js reads the nonce from the forwarded request headers.
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(a);
  });

  it("leaves API routes and the public receivers to their own headers", () => {
    for (const p of [
      "/api/health",
      "/api/catalog",
      "/mock/abc/x",
      "/hook/abc",
      "/capture/abc",
      "/_next/data/x",
    ])
      expect(appliesCsp(p), p).toBe(false);
    for (const p of ["/", "/login", "/profile", "/invite", "/admin/sso", "/gateway"])
      expect(appliesCsp(p), p).toBe(true);
    expect(get("http://localhost/api/health").headers.get("content-security-policy")).toBeNull();
  });

  it("allows eval only in development", () => {
    expect(appCsp("n", true)).toContain("'unsafe-eval'");
    expect(appCsp("n", false)).not.toContain("'unsafe-eval'");
  });
});

describe("Strict-Transport-Security", () => {
  it("is sent only when the request arrived over HTTPS", () => {
    expect(get("http://localhost/").headers.get("strict-transport-security")).toBeNull();
    expect(get("https://postbox.example/").headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(
      get("http://localhost/api/health", { "x-forwarded-proto": "https" }).headers.get(
        "strict-transport-security",
      ),
    ).toBe("max-age=31536000");
  });
});
