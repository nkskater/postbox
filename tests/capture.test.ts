import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MASK,
  SecretSet,
  captureBody,
  checkCaptureTarget,
  hashToken,
  hostAllowed,
  isCaptureToken,
  normalizeHostFilter,
  parseRelayTarget,
  redactHeaders,
  redactUrl,
  toHar,
  type StoredEntry,
} from "@/core/capture";
import { importHar } from "@/core/convert/har";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
import { startTestServer, type TestServer } from "./helpers/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-capture-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
process.env.PROXY_DENY_HOSTS = "blocked.example";
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const capture = await import("@/server/capture");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { getSqlite } = await import("@/server/db");
const { queryAudit } = await import("@/server/audit");
const { isPublicPath } = await import("@/server/auth");
const relayRoute = await import("@/app/capture/[token]/[[...target]]/route");
const listRoute = await import("@/app/api/capture/sessions/route");
const oneRoute = await import("@/app/api/capture/sessions/[id]/route");
const entriesRoute = await import("@/app/api/capture/sessions/[id]/entries/route");
const requestsRoute = await import("@/app/api/capture/sessions/[id]/requests/route");
const exportRoute = await import("@/app/api/capture/sessions/[id]/export/route");
const rotateRoute = await import("@/app/api/capture/sessions/[id]/rotate/route");

const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });

// ------------------------------------------------------------------ pure rules

describe("redaction before storage", () => {
  it("removes credentials from URLs and remembers them", () => {
    const secrets = new SecretSet();
    const url = redactUrl("https://user:pw1234@example.com/a?api_key=K3Y12345&q=ok#frag", secrets);
    expect(url).not.toContain("pw1234");
    expect(url).not.toContain("K3Y12345");
    expect(url).not.toContain("user:");
    expect(new URL(url).searchParams.get("q")).toBe("ok");
    expect(new URL(url).searchParams.get("api_key")).toBe(MASK);
    expect(secrets.scrub("x K3Y12345 y pw1234")).toBe(`x ${MASK} y ${MASK}`);
    expect(() => redactUrl("ftp://example.com/x", secrets)).toThrow();
  });

  it("masks credential headers and the pieces of a Basic login", () => {
    const secrets = new SecretSet();
    const basic = `Basic ${Buffer.from("alice:hunter22").toString("base64")}`;
    const headers = redactHeaders(
      [
        ["Authorization", basic],
        ["X-Api-Key", "abcd1234"],
        ["Accept", "application/json"],
      ],
      { keepCookies: false },
      secrets,
    );
    expect(headers).toEqual([
      ["Authorization", MASK],
      ["X-Api-Key", MASK],
      ["Accept", "application/json"],
    ]);
    expect(secrets.scrub("password is hunter22 for alice")).toBe(`password is ${MASK} for ${MASK}`);
  });

  it("masks every cookie by default and only harmless ones when cookies are opted in", () => {
    const line: [string, string][] = [["Cookie", "theme=dark; session=abc12345; lang=en"]];
    expect(redactHeaders(line, { keepCookies: false }, new SecretSet())[0][1]).toBe(
      `theme=${MASK}; session=${MASK}; lang=${MASK}`,
    );
    const secrets = new SecretSet();
    expect(redactHeaders(line, { keepCookies: true }, secrets)[0][1]).toBe(
      `theme=dark; session=${MASK}; lang=en`,
    );
    expect(secrets.scrub("abc12345")).toBe(MASK);
    const set = redactHeaders(
      [["Set-Cookie", "sid=zzzz9999; Path=/; HttpOnly"]],
      { keepCookies: true },
      new SecretSet(),
    );
    expect(set[0][1]).toBe(`sid=${MASK}; Path=/; HttpOnly`);
  });

  it("redacts bodies by structure and by value, and does not keep binary or oversized text", () => {
    const secrets = new SecretSet();
    secrets.add("tok-from-header");
    const json = captureBody(
      Buffer.from(
        JSON.stringify({
          user: "a",
          password: "p4ssw0rd",
          nested: [{ token: "t0ken-value" }],
          note: "see tok-from-header",
        }),
      ),
      "application/json",
      secrets,
    );
    expect(json.text).not.toContain("p4ssw0rd");
    expect(json.text).not.toContain("t0ken-value");
    expect(json.text).not.toContain("tok-from-header");
    expect(JSON.parse(json.text).user).toBe("a");
    const form = captureBody(
      Buffer.from("a=1&client_secret=shh-secret"),
      "application/x-www-form-urlencoded",
      secrets,
    );
    expect(form.text).not.toContain("shh-secret");
    expect(form.text).toContain("a=1");
    const png = captureBody(Buffer.from([0x89, 0x50, 0xff, 0xfe]), "image/png", secrets);
    expect(png).toMatchObject({ encoding: "omitted", text: "", bytes: 4 });
    const big = captureBody(Buffer.from("x".repeat(1000)), "text/plain", secrets, 100);
    expect(big.text).toHaveLength(100);
    expect(big.truncated).toBe(true);
    expect(captureBody(Buffer.alloc(0), "text/plain", secrets).encoding).toBe("empty");
  });
});

describe("targets and tokens", () => {
  it("reads the target URL from the relay path, repairing collapsed slashes", () => {
    expect(parseRelayTarget("/https://example.com/a/b", "?x=1")).toBe("https://example.com/a/b?x=1");
    expect(parseRelayTarget("/http:/example.com/a", "")).toBe("http://example.com/a");
    expect(parseRelayTarget("/https%3A%2F%2Fexample.com%2Fa%3Fb%3D1", "")).toBe("https://example.com/a?b=1");
    for (const bad of [
      "",
      "/",
      "/example.com/a",
      "/ftp://example.com",
      "/javascript:alert(1)",
      "/https://",
      "/%E0%A4%A",
    ])
      expect(parseRelayTarget(bad, "")).toBeNull();
  });

  it("requires consent for https and honours host filters", () => {
    const open = { allowHttps: false, hosts: [] };
    expect(checkCaptureTarget("http://example.com/", open)).toBeNull();
    expect(checkCaptureTarget("https://example.com/", open)).toMatch(/HTTPS/);
    expect(checkCaptureTarget("https://example.com/", { ...open, allowHttps: true })).toBeNull();
    expect(checkCaptureTarget("ftp://example.com/", open)).toMatch(/http/);
    expect(checkCaptureTarget("not a url", open)).toMatch(/absolute/);
    const filtered = { allowHttps: true, hosts: normalizeHostFilter(["API.Example.com", "*.cdn.test"]) };
    expect(checkCaptureTarget("https://api.example.com/", filtered)).toBeNull();
    expect(checkCaptureTarget("https://evil.example.com/", filtered)).toMatch(/host list/);
    expect(checkCaptureTarget("https://a.cdn.test/", filtered)).toBeNull();
    expect(checkCaptureTarget("https://cdn.test/", filtered)).toMatch(/host list/);
    expect(hostAllowed("anything.test", [])).toBe(true);
    expect(() => normalizeHostFilter(["bad host"])).toThrow();
  });

  it("recognises well-formed tokens only", () => {
    expect(isCaptureToken("cap_" + "a".repeat(32))).toBe(true);
    for (const bad of [
      "",
      "cap_",
      "hk_" + "a".repeat(32),
      "cap_" + "a/b".repeat(10),
      "cap_" + "a".repeat(200),
    ])
      expect(isCaptureToken(bad)).toBe(false);
  });

  it("serves the relay without a login, since the token is the credential", () => {
    expect(isPublicPath("/capture/cap_x/https://example.com")).toBe(true);
    expect(isPublicPath("/api/capture/sessions")).toBe(false);
  });
});

describe("converting recordings", () => {
  it("produces a HAR the importer turns into requests without credentials", () => {
    const entry: StoredEntry = {
      id: "e1",
      startedAt: Date.UTC(2026, 0, 1),
      method: "POST",
      url: "https://example.com/items?page=2",
      requestHeaders: [
        ["Content-Type", "application/json"],
        ["Authorization", MASK],
      ],
      requestBody: { text: '{"a":1}', encoding: "utf8", bytes: 7, truncated: false },
      status: 201,
      statusText: "Created",
      responseHeaders: [["Content-Type", "application/json"]],
      responseBody: { text: '{"id":5}', encoding: "utf8", bytes: 8, truncated: false },
      durationMs: 12,
    };
    const { root } = importHar(toHar([entry]));
    const request = root.children[0];
    expect(request.kind).toBe("request");
    if (request.kind !== "request") return;
    expect(request.method).toBe("POST");
    expect(request.url).toContain("example.com/items");
    expect(request.body).toMatchObject({ mode: "raw", raw: expect.stringContaining('"a": 1') });
    expect(request.headers.find((h) => /authorization/i.test(h.key))).toMatchObject({ enabled: false });
    expect(request.examples?.[0]).toMatchObject({ status: 201 });
  });
});

// ------------------------------------------------------------------ the running service

let owner: UserRow, editor: UserRow, outsider: UserRow;
let workspaceId: string;
let local: TestServer;
const keys: Record<string, string> = {};

const api = async (
  handler: (...args: never[]) => Promise<Response>,
  url: string,
  init: { method?: string; key?: string | null; body?: unknown; id?: string } = {},
) => {
  const key = init.key === undefined ? keys[owner.id] : init.key;
  const response = await (handler as unknown as (request: Request, ctx: unknown) => Promise<Response>)(
    new Request(`http://localhost${url}`, {
      method: init.method ?? "GET",
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    { params: Promise.resolve({ id: init.id ?? "" }) },
  );
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, data: data as any, text };
};

async function create(extra: Record<string, unknown> = {}) {
  const created = await api(listRoute.POST, "/api/capture/sessions", {
    method: "POST",
    body: { workspaceId, name: "Session", ...extra },
  });
  expect(created.status, created.text).toBe(201);
  return created.data as { id: string; token: string; path: string };
}

/** Send a request through the relay the way a client configured to use it would. */
async function through(
  token: string,
  target: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
) {
  const response = await relayRoute.POST(
    new Request(`http://localhost/capture/${token}/${target}`, {
      method: init.method ?? "POST",
      headers: init.headers,
      body: init.body,
    }),
    { params: Promise.resolve({ token }) },
  );
  return { status: response.status, text: await response.text(), headers: response.headers };
}

beforeAll(async () => {
  local = await startTestServer();
  owner = await users.createUser({ username: "owner", password: "password123" });
  editor = await users.createUser({ username: "editor", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  for (const user of [owner, editor, outsider]) keys[user.id] = users.createToken(user.id, "t").token;
  workspaceId = withCaller(caller(owner), () => repo.createWorkspace("Capture").id);
  withCaller(caller(owner), () => setMember(workspaceId, editor.username, "editor"));
});
afterAll(async () => {
  await local.close();
});

describe("recording through the relay", () => {
  it("keeps Postbox credentials out of upstream requests while preserving API-client cookies", async () => {
    const session = await create();
    vi.stubEnv("POSTBOX_TOKEN", "recovery-credential-for-capture-test");
    try {
      for (const credential of [keys[owner.id], "pbx_revoked_key", process.env.POSTBOX_TOKEN]) {
        const result = await through(session.token, `${local.url}/echo`, {
          headers: {
            Authorization: `bEaReR ${credential}`,
            Cookie:
              "theme=dark; postbox_session=v2.victim; postbox_sso_state=sso-secret; other=1; postbox_session=duplicate",
            "Proxy-Authorization": "Basic cHJveHk6c2VjcmV0",
            Referer: `http://localhost/capture/${session.token}/`,
          },
        });
        expect(result.status).toBe(200);
        const received = local.requests.at(-1)!.headers;
        expect(received.authorization).toBeUndefined();
        expect(received["proxy-authorization"]).toBeUndefined();
        expect(received.referer).toBeUndefined();
        expect(received.cookie).toBe("theme=dark; other=1");
      }
    } finally {
      vi.unstubAllEnvs();
      withCaller(caller(owner), () => capture.deleteSession(session.id));
    }
  });

  it("does not forward any browser cookies or authorization", async () => {
    const session = await create();
    try {
      const result = await through(session.token, `${local.url}/echo`, {
        headers: {
          Cookie: "theme=dark; postbox_session=victim",
          Authorization: "Bearer upstream-key",
          "Sec-Fetch-Site": "same-origin",
        },
      });
      expect(result.status).toBe(200);
      expect(local.requests.at(-1)!.headers.cookie).toBeUndefined();
      expect(local.requests.at(-1)!.headers.authorization).toBeUndefined();
      expect(local.requests.at(-1)!.headers["sec-fetch-site"]).toBeUndefined();
    } finally {
      withCaller(caller(owner), () => capture.deleteSession(session.id));
    }
  });

  it("rejects browser navigation before contacting the target and protects error responses", async () => {
    const session = await create();
    try {
      const before = local.requests.length;
      const result = await through(session.token, `${local.url}/echo`, {
        method: "GET",
        headers: { "Sec-Fetch-Mode": "navigate", Cookie: "postbox_session=victim" },
      });
      expect(result.status).toBe(403);
      expect(local.requests).toHaveLength(before);
      expect(result.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; frame-ancestors 'none'",
      );
      const missing = await through("nope", `${local.url}/echo`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-security-policy")).toBe(
        result.headers.get("content-security-policy"),
      );
    } finally {
      withCaller(caller(owner), () => capture.deleteSession(session.id));
    }
  });

  it("isolates hostile upstream HTML and headers while preserving status, body and ordinary headers", async () => {
    const session = await create();
    const html = '<h1>Upstream</h1><script>document.cookie="postbox_session=attacker"</script>';
    const hostile = http.createServer((_req, res) => {
      res.writeHead(201, {
        "Content-Type": "text/html",
        "Set-Cookie": "postbox_session=attacker; Path=/",
        "Set-Cookie2": "other=attacker",
        "Clear-Site-Data": '"*"',
        "Service-Worker-Allowed": "/",
        Refresh: "0; url=/api/health",
        "X-Upstream": "preserved",
        "Content-Security-Policy": "default-src * 'unsafe-inline'",
        "Cache-Control": "public, max-age=9999",
        "Referrer-Policy": "unsafe-url",
        "X-Content-Type-Options": "allow",
      });
      res.end(html);
    });
    await new Promise<void>((resolve) => hostile.listen(0, "127.0.0.1", resolve));
    try {
      const target = `http://127.0.0.1:${(hostile.address() as AddressInfo).port}/html`;
      const result = await through(session.token, target);
      expect(result.status).toBe(201);
      expect(result.text).toBe(html);
      expect(result.headers.get("content-type")).toBe("text/html");
      expect(result.headers.get("x-upstream")).toBe("preserved");
      for (const name of [
        "set-cookie",
        "set-cookie2",
        "clear-site-data",
        "service-worker-allowed",
        "refresh",
      ])
        expect(result.headers.get(name), name).toBeNull();
      expect(result.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; frame-ancestors 'none'",
      );
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(result.headers.get("referrer-policy")).toBe("no-referrer");
      expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await new Promise<void>((resolve) => hostile.close(() => resolve()));
      withCaller(caller(owner), () => capture.deleteSession(session.id));
    }
  });

  it("forwards the request, returns the real response and stores a redacted copy", async () => {
    const session = await create();
    expect(session.path).toBe(`/capture/${session.token}/`);
    const sent = await through(session.token, `${local.url}/echo?api_key=URLKEY9999&q=1`, {
      headers: {
        authorization: "Bearer BEARER-TOKEN-12345",
        cookie: "sid=COOKIE-VALUE-777",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "n", password: "PW-IN-BODY-1" }),
    });
    expect(sent.status).toBe(200);
    // The client gets the real answer: the upstream saw the real credentials.
    expect(local.requests.at(-1)?.headers.authorization).toBe("Bearer BEARER-TOKEN-12345");
    expect(JSON.parse(sent.text).headers.authorization).toBe("Bearer BEARER-TOKEN-12345");

    const listed = await api(entriesRoute.GET, `/api/capture/sessions/${session.id}/entries`, {
      id: session.id,
    });
    expect(listed.data).toHaveLength(1);
    const one = await api(
      entriesRoute.GET,
      `/api/capture/sessions/${session.id}/entries?entry=${listed.data[0].id}`,
      {
        id: session.id,
      },
    );
    expect(one.data).toMatchObject({ method: "POST", status: 200 });
    const stored = JSON.stringify(one.data);
    for (const secret of ["BEARER-TOKEN-12345", "COOKIE-VALUE-777", "URLKEY9999", "PW-IN-BODY-1"])
      expect(stored, secret).not.toContain(secret);
    expect(one.data.redactions).toBeGreaterThan(0);
    // Not even the database file's rows hold them.
    const raw = JSON.stringify(getSqlite().prepare("SELECT * FROM capture_entries").all());
    for (const secret of ["BEARER-TOKEN-12345", "COOKIE-VALUE-777", "URLKEY9999", "PW-IN-BODY-1"])
      expect(raw, secret).not.toContain(secret);
    expect(JSON.parse(one.data.requestBody.text)).toMatchObject({ name: "n" });
  });

  it("looks the same for unknown, malformed and stopped tokens", async () => {
    const session = await create();
    const unknown = await through("cap_" + "x".repeat(32), `${local.url}/echo`);
    const malformed = await through("nope", `${local.url}/echo`);
    await api(oneRoute.PATCH, `/api/capture/sessions/${session.id}`, {
      method: "PATCH",
      id: session.id,
      body: { status: "stopped" },
    });
    const stopped = await through(session.token, `${local.url}/echo`);
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(stopped.status).toBe(404);
    expect(stopped.text).toBe(unknown.text);
    const resume = await api(oneRoute.PATCH, `/api/capture/sessions/${session.id}`, {
      method: "PATCH",
      id: session.id,
      body: { status: "recording" },
    });
    expect(resume.status).toBe(409);
  });

  it("pauses without forwarding or storing", async () => {
    const session = await create();
    await api(oneRoute.PATCH, `/api/capture/sessions/${session.id}`, {
      method: "PATCH",
      id: session.id,
      body: { status: "paused" },
    });
    const before = local.requests.length;
    const sent = await through(session.token, `${local.url}/echo`);
    expect(sent.status).toBe(503);
    expect(local.requests).toHaveLength(before);
    expect(capture.listEntries(session.id)).toHaveLength(0);
  });

  it("needs consent for HTTPS and records nothing it refuses", async () => {
    const session = await create();
    const refused = await through(session.token, "https://example.com/secure");
    expect(refused.status).toBe(403);
    expect(refused.text).toMatch(/HTTPS/);
    expect(capture.listEntries(session.id)).toHaveLength(0);
    const patched = await api(oneRoute.PATCH, `/api/capture/sessions/${session.id}`, {
      method: "PATCH",
      id: session.id,
      body: { allowHttps: true },
    });
    expect(patched.data.allowHttps).toBe(true);
    expect(patched.data.httpsConsentAt).toBeGreaterThan(0);
    // Consent is recorded in the audit trail.
    const events = queryAudit({ workspaceId, limit: 50 }).events.map((e) => e.action);
    expect(events).toContain("capture.session.update");
  });

  it("applies host filters and the outbound host policy", async () => {
    const session = await create({ hosts: ["localhost"] });
    const otherHost = await through(session.token, "http://example.org/x");
    expect(otherHost.status).toBe(403);
    expect(otherHost.text).toMatch(/host list/);
    const open = await create();
    const blocked = await through(open.token, "http://blocked.example/x");
    expect(blocked.status).toBe(403);
    expect(blocked.text).toMatch(/policy/i);
    expect(capture.listEntries(session.id)).toHaveLength(0);
  });

  it("rejects relay requests that do not name a URL", async () => {
    const session = await create();
    const response = await relayRoute.POST(new Request(`http://localhost/capture/${session.token}/x`), {
      params: Promise.resolve({ token: session.token }),
    });
    expect(response.status).toBe(400);
  });

  it("records failed exchanges so they can be reviewed", async () => {
    const session = await create();
    const sent = await through(session.token, "http://localhost:1/never");
    expect(sent.status).toBe(502);
    const [entry] = capture.listEntries(session.id);
    expect(entry.error).toBeTruthy();
    expect(entry.status).toBeNull();
  });

  it("keeps non-credential cookies only after the owner opts in", async () => {
    const session = await create({ captureCookies: true });
    await through(session.token, `${local.url}/echo`, {
      headers: { cookie: "theme=dark; session=SESSION-SECRET-1" },
    });
    const [entry] = capture.listEntries(session.id);
    const detail = capture.getEntry(session.id, entry.id);
    const cookie = detail.requestHeaders.find(([name]) => name.toLowerCase() === "cookie")?.[1];
    expect(cookie).toBe(`theme=dark; session=${MASK}`);
    expect(JSON.stringify(detail)).not.toContain("SESSION-SECRET-1");
  });

  it("rotating the URL stops the old one at once", async () => {
    const session = await create();
    const rotated = await api(rotateRoute.POST, `/api/capture/sessions/${session.id}/rotate`, {
      method: "POST",
      id: session.id,
    });
    expect(rotated.data.token).not.toBe(session.token);
    expect((await through(session.token, `${local.url}/echo`)).status).toBe(404);
    expect((await through(rotated.data.token, `${local.url}/echo`)).status).toBe(200);
  });
});

describe("reviewing and importing", () => {
  it("turns selected recordings into requests in a new folder and marks them imported", async () => {
    const session = await create();
    await through(session.token, `${local.url}/echo?a=1`, {
      method: "GET",
      headers: { authorization: "Bearer IMPORT-SECRET-123" },
    });
    await through(session.token, `${local.url}/status?code=404`, { method: "GET" });
    await through(session.token, "http://localhost:1/fails", { method: "GET" });
    const entries = capture.listEntries(session.id);
    expect(entries).toHaveLength(3);
    const picked = entries.filter((e) => e.url.includes("/echo"));
    const result = await api(requestsRoute.POST, `/api/capture/sessions/${session.id}/requests`, {
      method: "POST",
      id: session.id,
      body: { entryIds: picked.map((e) => e.id), name: "Recorded" },
    });
    expect(result.status, result.text).toBe(201);
    expect(result.data.requests).toBe(1);
    const tree = JSON.stringify([
      getSqlite().prepare("SELECT * FROM requests WHERE workspace_id = ?").all(workspaceId),
      repo.getTreeSummary(workspaceId),
    ]);
    expect(tree).toContain("Recorded");
    expect(tree).not.toContain("IMPORT-SECRET-123");
    const after = capture.listEntries(session.id);
    expect(after.filter((e) => e.importedAt !== null)).toHaveLength(1);

    const failedOnly = entries.filter((e) => e.error);
    const none = await api(requestsRoute.POST, `/api/capture/sessions/${session.id}/requests`, {
      method: "POST",
      id: session.id,
      body: { entryIds: failedOnly.map((e) => e.id) },
    });
    expect(none.status).toBe(400);
    const unknown = await api(requestsRoute.POST, `/api/capture/sessions/${session.id}/requests`, {
      method: "POST",
      id: session.id,
      body: { entryIds: ["missing"] },
    });
    expect(unknown.status).toBe(404);
  });

  it("imports a HAR file with credentials removed and exports it again", async () => {
    const session = await create({ allowHttps: true });
    const har = {
      log: {
        version: "1.2",
        entries: [
          {
            startedDateTime: "2026-01-02T03:04:05.000Z",
            time: 40,
            request: {
              method: "GET",
              url: "https://example.com/data?token=HAR-URL-TOKEN",
              headers: [{ name: "Authorization", value: "Bearer HAR-BEARER-1" }],
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: [{ name: "Content-Type", value: "application/json" }],
              content: { mimeType: "application/json", text: '{"echo":"HAR-BEARER-1","ok":true}' },
            },
          },
          { request: { method: "GET", url: "ftp://example.com/x", headers: [] } },
          { nonsense: true },
        ],
      },
    };
    const added = await api(entriesRoute.POST, `/api/capture/sessions/${session.id}/entries`, {
      method: "POST",
      id: session.id,
      body: { har },
    });
    expect(added.status, added.text).toBe(200);
    expect(added.data.added).toBe(1);
    expect(added.data.skipped).toHaveLength(2);
    const exported = await api(exportRoute.GET, `/api/capture/sessions/${session.id}/export`, {
      id: session.id,
    });
    expect(exported.status).toBe(200);
    expect(exported.text).not.toContain("HAR-BEARER-1");
    expect(exported.text).not.toContain("HAR-URL-TOKEN");
    expect(exported.data.log.entries).toHaveLength(1);
    expect(exported.data.log.entries[0].response.status).toBe(200);
  });

  it("refuses a HAR entry for https unless the session allows it", async () => {
    const session = await create();
    const added = await api(entriesRoute.POST, `/api/capture/sessions/${session.id}/entries`, {
      method: "POST",
      id: session.id,
      body: {
        har: { log: { entries: [{ request: { method: "GET", url: "https://example.com/", headers: [] } }] } },
      },
    });
    expect(added.data.added).toBe(0);
    expect(added.data.skipped[0]).toMatch(/HTTPS/);
  });

  it("deletes selected or all entries and keeps the count right", async () => {
    const session = await create();
    for (let i = 0; i < 3; i++) await through(session.token, `${local.url}/echo?i=${i}`, { method: "GET" });
    const [first, ...rest] = capture.listEntries(session.id);
    capture.deleteEntries(session.id, [first.id]);
    expect(capture.getSession(session.id).entryCount).toBe(2);
    capture.deleteEntries(session.id);
    expect(capture.listEntries(session.id)).toHaveLength(0);
    expect(capture.getSession(session.id).entryCount).toBe(0);
    expect(rest).toHaveLength(2);
  });

  it("prunes old recordings under the retention setting and fixes counters", async () => {
    const session = await create();
    await through(session.token, `${local.url}/echo`, { method: "GET" });
    await through(session.token, `${local.url}/echo?x=1`, { method: "GET" });
    const [old] = capture.listEntries(session.id);
    getSqlite()
      .prepare("UPDATE capture_entries SET started_at = ? WHERE id = ?")
      .run(Date.now() - 40 * 86_400_000, old.id);
    capture.pruneCaptures(0);
    expect(capture.listEntries(session.id)).toHaveLength(2);
    capture.pruneCaptures(14);
    expect(capture.listEntries(session.id)).toHaveLength(1);
    expect(capture.getSession(session.id).entryCount).toBe(1);
  });

  it("caps the number of entries a session keeps", async () => {
    const session = await create();
    const har = {
      log: {
        entries: Array.from({ length: 500 }, (_, i) => ({
          startedDateTime: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
          request: { method: "GET", url: `http://example.com/${i}`, headers: [] },
        })),
      },
    };
    capture.addHarEntries(session.id, har);
    capture.addHarEntries(session.id, { log: { entries: [har.log.entries[0]] } });
    expect(capture.getSession(session.id).entryCount).toBe(500);
  });
});

describe("access and audit", () => {
  it("is for workspace managers: editors and outsiders cannot use the session API", async () => {
    const session = await create();
    const editorList = await api(listRoute.GET, `/api/capture/sessions?workspaceId=${workspaceId}`, {
      key: keys[editor.id],
    });
    expect(editorList.status).toBe(403);
    const outsiderOne = await api(oneRoute.GET, `/api/capture/sessions/${session.id}`, {
      key: keys[outsider.id],
      id: session.id,
    });
    expect([403, 404]).toContain(outsiderOne.status);
    const anonymous = await api(oneRoute.GET, `/api/capture/sessions/${session.id}`, {
      key: null,
      id: session.id,
    });
    expect(anonymous.status).toBe(401);
  });

  it("never lists tokens and audits lifecycle events without secrets", async () => {
    const session = await create({ name: "Audited" });
    const listed = await api(listRoute.GET, `/api/capture/sessions?workspaceId=${workspaceId}`);
    const text = JSON.stringify(listed.data);
    expect(text).not.toContain(session.token);
    expect(text).not.toContain(hashToken(session.token));
    const stored = getSqlite()
      .prepare("SELECT token_hash FROM capture_sessions WHERE id = ?")
      .get(session.id) as {
      token_hash: string;
    };
    expect(stored.token_hash).toBe(hashToken(session.token));
    await through(session.token, `${local.url}/echo`, {
      headers: { authorization: "Bearer AUDIT-SECRET-99" },
    });
    capture.deleteSession(session.id);
    const events = queryAudit({ workspaceId, limit: 100 }).events;
    const actions = events.map((e) => e.action);
    expect(actions).toContain("capture.session.create");
    expect(actions).toContain("capture.session.delete");
    expect(JSON.stringify(events)).not.toContain(session.token);
    expect(JSON.stringify(events)).not.toContain("AUDIT-SECRET-99");
  });

  it("validates session settings", async () => {
    const bad = async (extra: Record<string, unknown>) =>
      (
        await api(listRoute.POST, "/api/capture/sessions", {
          method: "POST",
          body: { workspaceId, name: "x", ...extra },
        })
      ).status;
    expect(await bad({ hosts: ["bad host"] })).toBe(400);
    expect(await bad({ hosts: Array.from({ length: 21 }, (_, i) => `h${i}.test`) })).toBe(400);
    expect(await bad({ unknown: true })).toBe(400);
    expect(await bad({ name: "" })).toBe(400);
  });

  it("caps sessions per workspace", async () => {
    const other = withCaller(caller(owner), () => repo.createWorkspace("Many").id);
    for (let i = 0; i < 20; i++) capture.createSession(other, capture.sessionInput.parse({ name: `s${i}` }));
    expect(() => capture.createSession(other, capture.sessionInput.parse({ name: "one more" }))).toThrow(
      /at most/,
    );
  });
});
