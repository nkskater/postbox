import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendRequest } from "@/core/http/engine";
import { prepareRequest } from "@/core/http/prepare";
import { CookieJarStore } from "@/core/http/cookies";
import { HostPolicy, HostPolicyError } from "@/core/http/policy";
import { Resolver, emptyScopes } from "@/core/variables/resolver";
import { DEFAULT_SETTINGS, type RequestDef } from "@/core/types";
import { startTestServer, type TestServer } from "./helpers/server";

let server: TestServer;
beforeAll(async () => (server = await startTestServer()));
afterAll(() => server.close());

function req(partial: Partial<RequestDef>): RequestDef {
  return {
    id: "r",
    name: "r",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: { mode: "none" },
    auth: { type: "none" },
    preRequestScript: "",
    testScript: "",
    settings: { ...DEFAULT_SETTINGS },
    ...partial,
  };
}

async function send(
  r: RequestDef,
  opts: Parameters<typeof sendRequest>[1] = {},
  vars: Record<string, string> = {},
) {
  const resolver = new Resolver({ ...emptyScopes(), environment: { base: server.url, ...vars } });
  const { prepared } = await prepareRequest(r, [], resolver, opts);
  return sendRequest(prepared, opts);
}

describe("proxy engine", () => {
  it("sends a GET and returns status, headers, body, size and timings", async () => {
    const res = await send(req({ url: "{{base}}/echo?x=1" }));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.bodyText);
    expect(body.query).toEqual({ x: "1" });
    expect(body.headers["user-agent"]).toMatch(/^Postbox/);
    expect(res.size).toBe(Buffer.byteLength(res.bodyText));
    expect(res.timings.total).toBeGreaterThan(0);
    expect(Object.keys(res.timings).sort()).toEqual(["dns", "download", "tcp", "tls", "total", "ttfb"]);
    expect(res.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1]).toBe("application/json");
  });

  it("encodes JSON, urlencoded, form-data and GraphQL bodies", async () => {
    let res = await send(
      req({
        method: "POST",
        url: "{{base}}/echo",
        body: { mode: "raw", language: "json", raw: '{"a":"{{v}}"}' },
      }),
      {},
      { v: "1" },
    );
    let echo = JSON.parse(res.bodyText);
    expect(echo.body).toBe('{"a":"1"}');
    expect(echo.headers["content-type"]).toBe("application/json");

    res = await send(
      req({
        method: "POST",
        url: "{{base}}/echo",
        body: { mode: "urlencoded", urlencoded: [{ key: "a b", value: "c&d", enabled: true }] },
      }),
    );
    echo = JSON.parse(res.bodyText);
    expect(echo.body).toBe("a+b=c%26d");

    res = await send(
      req({
        method: "POST",
        url: "{{base}}/echo",
        body: {
          mode: "formdata",
          formdata: [
            { key: "field", value: "v", enabled: true, type: "text" },
            {
              key: "file",
              value: "",
              enabled: true,
              type: "file",
              fileName: "a.txt",
              data: Buffer.from("hi").toString("base64"),
            },
          ],
        },
      }),
    );
    echo = JSON.parse(res.bodyText);
    expect(echo.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(echo.body).toContain('name="field"\r\n\r\nv');
    expect(echo.body).toContain('filename="a.txt"');

    res = await send(
      req({
        method: "POST",
        url: "{{base}}/echo",
        body: { mode: "graphql", graphql: { query: "{ me }", variables: '{"x":1}' } },
      }),
    );
    expect(JSON.parse(JSON.parse(res.bodyText).body)).toEqual({ query: "{ me }", variables: { x: 1 } });
  });

  it("follows redirects and records hops", async () => {
    const res = await send(req({ url: "{{base}}/redirect?n=3" }));
    expect(res.status).toBe(200);
    expect(res.redirects).toHaveLength(3);
    expect(res.url).toBe(`${server.url}/echo`);
  });

  it("converts POST to GET on 303 and keeps method on 307", async () => {
    let res = await send(
      req({
        method: "POST",
        url: "{{base}}/redirect?code=303",
        body: { mode: "raw", language: "text", raw: "x" },
      }),
    );
    expect(JSON.parse(res.bodyText).method).toBe("GET");
    res = await send(
      req({
        method: "POST",
        url: "{{base}}/redirect?code=307",
        body: { mode: "raw", language: "text", raw: "x" },
      }),
    );
    expect(JSON.parse(res.bodyText)).toMatchObject({ method: "POST", body: "x" });
  });

  it("can disable redirect following", async () => {
    const res = await send(
      req({ url: "{{base}}/redirect", settings: { ...DEFAULT_SETTINGS, followRedirects: false } }),
    );
    expect(res.status).toBe(302);
  });

  it("stores cookies in the jar and sends them back", async () => {
    const jar = new CookieJarStore();
    const first = await send(req({ url: "{{base}}/set-cookie" }), { cookieJar: jar });
    expect(first.cookies.map((c) => c.name).sort()).toEqual(["session", "theme"]);
    const res = await send(req({ url: "{{base}}/echo" }), { cookieJar: jar });
    expect(JSON.parse(res.bodyText).headers.cookie).toContain("session=abc123");
    expect((await jar.list()).length).toBe(2);
  });

  it("decompresses gzip and detects binary bodies", async () => {
    expect((await send(req({ url: "{{base}}/gzip" }))).bodyText).toBe("compressed hello");
    const bin = await send(req({ url: "{{base}}/binary" }));
    expect(bin.isBinary).toBe(true);
    expect(Buffer.from(bin.bodyBase64, "base64")).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  });

  it("times out", async () => {
    await expect(
      send(req({ url: "{{base}}/slow?ms=1000", settings: { ...DEFAULT_SETTINGS, timeoutMs: 100 } })),
    ).rejects.toThrow(/timed out/);
  });

  it("applies basic, bearer and API key auth", async () => {
    let echo = JSON.parse(
      (
        await send(
          req({ url: "{{base}}/echo", auth: { type: "basic", basic: { username: "u", password: "p" } } }),
        )
      ).bodyText,
    );
    expect(echo.headers.authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    echo = JSON.parse(
      (
        await send(
          req({ url: "{{base}}/echo", auth: { type: "bearer", bearer: { token: "{{tok}}" } } }),
          {},
          { tok: "T" },
        )
      ).bodyText,
    );
    expect(echo.headers.authorization).toBe("Bearer T");
    echo = JSON.parse(
      (
        await send(
          req({
            url: "{{base}}/echo",
            auth: { type: "apikey", apikey: { key: "k", value: "v", in: "query" } },
          }),
        )
      ).bodyText,
    );
    expect(echo.query).toEqual({ k: "v" });
  });

  it("answers digest challenges", async () => {
    const res = await send(
      req({
        url: "{{base}}/digest",
        auth: { type: "digest", digest: { username: "user", password: "pass" } },
      }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.bodyText).authenticated).toBe(true);
  });

  it("fetches OAuth2 client-credentials tokens", async () => {
    const res = await send(
      req({
        url: "{{base}}/echo",
        auth: {
          type: "oauth2",
          oauth2: {
            grantType: "client_credentials",
            accessTokenUrl: "{{base}}/token",
            clientId: "id",
            clientSecret: "secret",
            scope: "",
            clientAuthentication: "header",
            accessToken: "",
            headerPrefix: "Bearer",
          },
        },
      }),
    );
    expect(JSON.parse(res.bodyText).headers.authorization).toBe("Bearer tok-cc");
  });

  it("enforces host allow/deny policy", async () => {
    const deny = new HostPolicy([], ["127.0.0.0/8"]);
    await expect(send(req({ url: "{{base}}/echo" }), { policy: deny })).rejects.toBeInstanceOf(
      HostPolicyError,
    );
    const allowOther = new HostPolicy(["api.example.com"]);
    await expect(send(req({ url: "{{base}}/echo" }), { policy: allowOther })).rejects.toThrow(
      /not in PROXY_ALLOW_HOSTS/,
    );
    const allow = new HostPolicy(["127.0.0.1"]);
    expect((await send(req({ url: "{{base}}/echo" }), { policy: allow })).status).toBe(200);
  });

  it("matches policy patterns", () => {
    const p = new HostPolicy(["*.example.com", "10.0.0.0/8"], ["bad.example.com"]);
    expect(p.check("a.example.com")).toBeNull();
    expect(p.check("example.com", "93.184.216.34")).not.toBeNull();
    expect(p.check("bad.example.com")).toMatch(/blocked/);
    expect(p.check("10.1.2.3")).toBeNull();
    expect(p.check("internal", "10.0.0.1")).toBeNull();
    expect(p.check("internal", "192.168.1.1")).not.toBeNull();
  });

  it("reports connection errors", async () => {
    await expect(send(req({ url: "http://127.0.0.1:1/" }))).rejects.toThrow(/refused/i);
  });
});
