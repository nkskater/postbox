/**
 * Failed-login throttling (LAB-265): trusted client addresses, a single-user budget that address
 * rotation cannot escape, no third-party account lockout, bounded bodies and bearer throttling.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "postbox-throttle-")), "t.db");

const auth = await import("@/server/auth");
const address = await import("@/server/client-address");
const { proxy } = await import("@/proxy");
const loginRoute = await import("@/app/api/auth/login/route");
const inviteRoute = await import("@/app/api/auth/invite/route");

address.installClientAddressHook();

const login = (body: unknown, client: string, extra: Record<string, string> = {}) =>
  loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", [address.CLIENT_ADDRESS_HEADER]: client, ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const gate = (bearer: string, client: string) =>
  proxy(
    new NextRequest("http://localhost/api/workspaces", {
      headers: { authorization: `Bearer ${bearer}`, [address.CLIENT_ADDRESS_HEADER]: client },
    }),
  ).status;

beforeEach(() => auth.resetLoginFailures());
afterEach(() => {
  delete process.env.POSTBOX_PASSWORD;
  delete process.env.POSTBOX_TOKEN;
  delete process.env.POSTBOX_TRUSTED_PROXIES;
});

describe("client address", () => {
  it("ignores forwarding headers unless proxies are trusted", () => {
    expect(address.resolveClientAddress("203.0.113.5", "1.1.1.1, 2.2.2.2", 0)).toBe("203.0.113.5");
    expect(address.resolveClientAddress("10.0.0.2", "1.1.1.1, 198.51.100.7", 1)).toBe("198.51.100.7");
    expect(address.resolveClientAddress("10.0.0.2", "forged, 198.51.100.7, 10.0.0.9", 2)).toBe(
      "198.51.100.7",
    );
    expect(address.resolveClientAddress("10.0.0.2", "198.51.100.7", 3)).toBe("198.51.100.7");
    expect(address.resolveClientAddress("10.0.0.2", undefined, 1)).toBe("10.0.0.2");
    expect(address.trustedProxyCount({ POSTBOX_TRUSTED_PROXIES: "1" })).toBe(1);
    expect(address.trustedProxyCount({ POSTBOX_TRUSTED_PROXIES: "nope" })).toBe(0);
    expect(address.trustedProxyCount({})).toBe(0);
  });

  it("stamps the socket address on real requests and overwrites forged values", async () => {
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers[address.CLIENT_ADDRESS_HEADER] as string | undefined);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const send = () =>
      fetch(`http://127.0.0.1:${port}/`, {
        headers: { "x-forwarded-for": "9.9.9.9", [address.CLIENT_ADDRESS_HEADER]: "8.8.8.8" },
      });
    try {
      await send();
      process.env.POSTBOX_TRUSTED_PROXIES = "1";
      await send();
    } finally {
      server.close();
    }
    expect(seen).toEqual(["127.0.0.1", "9.9.9.9"]);
  });
});

describe("single-user login", () => {
  it("keys on the trusted address, not on a rotating X-Forwarded-For", async () => {
    process.env.POSTBOX_PASSWORD = "hunter2";
    for (let i = 0; i < 10; i++)
      expect(
        (await login({ password: "x" }, "203.0.113.9", { "x-forwarded-for": `10.0.${i}.1` })).status,
      ).toBe(401);
    expect(
      (await login({ password: "hunter2" }, "203.0.113.9", { "x-forwarded-for": "10.9.9.9" })).status,
    ).toBe(429);
  });

  it("caps failures against the single secret across every address", async () => {
    process.env.POSTBOX_PASSWORD = "hunter2";
    const { max } = auth.LOGIN_LIMITS.secret;
    for (let i = 0; i < max; i++)
      expect((await login({ password: "x" }, `198.51.${i >> 8}.${i & 255}`)).status).toBe(401);
    expect((await login({ password: "hunter2" }, "192.0.2.200")).status).toBe(429);
  });

  it("does not let other clients lock the real user out", async () => {
    process.env.POSTBOX_PASSWORD = "hunter2";
    for (let i = 0; i < 10; i++) await login({ password: "x" }, "203.0.113.66");
    expect((await login({ password: "hunter2" }, "192.0.2.1")).status).toBe(200);
  });
});

describe("bounded login and invite bodies", () => {
  it("refuses an oversized body or password before hashing", async () => {
    process.env.POSTBOX_PASSWORD = "hunter2";
    const huge = await login({ password: "a".repeat(auth.LOGIN_BODY_LIMIT + 1) }, "192.0.2.2");
    expect(huge.status).toBe(413);
    const long = await login({ password: "a".repeat(auth.MAX_PASSWORD_LENGTH + 1) }, "192.0.2.2");
    expect(long.status).toBe(400);
    const invite = await inviteRoute.POST(
      new Request("http://localhost/api/auth/invite", {
        method: "POST",
        headers: { "content-type": "application/json", [address.CLIENT_ADDRESS_HEADER]: "192.0.2.2" },
        body: JSON.stringify({ token: "t".repeat(40), username: "u", password: "p".repeat(20_000) }),
      }),
    );
    expect(invite.status).toBe(413);
  });
});

describe("bearer attempts against POSTBOX_TOKEN", () => {
  it("are throttled per client and across clients", () => {
    process.env.POSTBOX_TOKEN = "env-token-123";
    for (let i = 0; i < 10; i++) expect(gate("guess-" + i, "203.0.113.20")).toBe(401);
    expect(gate("env-token-123", "203.0.113.20")).toBe(429);
    expect(gate("env-token-123", "192.0.2.3")).not.toBe(429);

    const { max } = auth.LOGIN_LIMITS.secret;
    for (let i = 0; i < max; i++) gate("guess", `198.18.${i >> 8}.${i & 255}`);
    expect(gate("env-token-123", "192.0.2.4")).toBe(429);
  });
});
