import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  createSession,
  getAuthConfig,
  isPublicPath,
  loginAllowed,
  recordLoginFailure,
  verifyBearer,
  verifyLoginSecret,
  verifySession,
} from "@/server/auth";
import { proxy } from "@/proxy";
import { POST as login } from "@/app/api/auth/login/route";

const env = { POSTBOX_PASSWORD: "hunter2", POSTBOX_TOKEN: "tok-123" } as unknown as NodeJS.ProcessEnv;

afterEach(() => {
  delete process.env.POSTBOX_PASSWORD;
  delete process.env.POSTBOX_TOKEN;
});

describe("auth primitives", () => {
  it("is disabled without credentials", () => {
    expect(getAuthConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("signs and verifies sessions, rejecting tampering and expiry", () => {
    const cfg = getAuthConfig(env)!;
    const { value } = createSession(cfg, 1_000);
    expect(verifySession(cfg, value, 2_000)).toBe(true);
    expect(verifySession(cfg, value, 1_000 + cfg.sessionTtlMs + 1)).toBe(false);
    const [v, exp, mac] = value.split(".");
    expect(verifySession(cfg, `${v}.${Number(exp) + 99999}.${mac}`, 2_000)).toBe(false);
    expect(verifySession(cfg, "garbage", 2_000)).toBe(false);
    // Changing the password invalidates old sessions.
    const other = getAuthConfig({ ...env, POSTBOX_PASSWORD: "changed" })!;
    expect(verifySession(other, value, 2_000)).toBe(false);
  });

  it("checks bearer tokens and login secrets", () => {
    const cfg = getAuthConfig(env)!;
    expect(verifyBearer(cfg, "Bearer tok-123")).toBe(true);
    expect(verifyBearer(cfg, "bearer  tok-123 ")).toBe(true);
    expect(verifyBearer(cfg, "Bearer nope")).toBe(false);
    expect(verifyBearer(cfg, null)).toBe(false);
    expect(verifyLoginSecret(cfg, "hunter2")).toBe(true);
    expect(verifyLoginSecret(cfg, "tok-123")).toBe(true);
    expect(verifyLoginSecret(cfg, "wrong")).toBe(false);
  });

  it("keeps only health, login and auth routes public", () => {
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/login")).toBe(true);
    expect(isPublicPath("/api/mcp")).toBe(false);
    expect(isPublicPath("/api/proxy")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
  });

  it("rate limits failed logins", () => {
    const key = "10.0.0.9";
    for (let i = 0; i < 10; i++) recordLoginFailure(key, 0);
    expect(loginAllowed(key, 1)).toBe(false);
    expect(loginAllowed(key, 10 * 60_000)).toBe(true);
  });
});

describe("proxy gate", () => {
  const req = (path: string, init: { headers?: Record<string, string>; cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    return new NextRequest(new URL(path, "http://postbox.local"), { headers });
  };
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("lets everything through when auth is disabled", () => {
    expect(passes(proxy(req("/api/mcp")))).toBe(true);
  });

  it("blocks unauthenticated API and page requests", async () => {
    Object.assign(process.env, env);
    const mcp = proxy(req("/api/mcp"));
    expect(mcp.status).toBe(401);
    expect(await mcp.json()).toEqual({ error: "Authentication required" });
    const page = proxy(req("/some/page?x=1"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("http://postbox.local/login?next=%2Fsome%2Fpage%3Fx%3D1");
    expect(passes(proxy(req("/api/health")))).toBe(true);
    expect(passes(proxy(req("/login")))).toBe(true);
  });

  it("accepts a valid session cookie or bearer token", () => {
    Object.assign(process.env, env);
    const cfg = getAuthConfig()!;
    const { value } = createSession(cfg);
    expect(passes(proxy(req("/api/mcp", { cookie: `${SESSION_COOKIE}=${value}` })))).toBe(true);
    expect(passes(proxy(req("/api/mcp", { headers: { authorization: "Bearer tok-123" } })))).toBe(true);
    expect(proxy(req("/api/mcp", { headers: { authorization: "Bearer bad" } })).status).toBe(401);
  });

  it("issues an HTTP-only session cookie on successful login", async () => {
    Object.assign(process.env, env);
    const post = (password: string) =>
      login(
        new Request("http://postbox.local/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.1" },
          body: JSON.stringify({ password }),
        }),
      );
    expect((await post("wrong")).status).toBe(401);
    const ok = await post("hunter2");
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=v1.`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
  });
});
