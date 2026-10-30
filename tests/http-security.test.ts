import https from "node:https";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendRequest } from "@/core/http/engine";
import { HostPolicy } from "@/core/http/policy";
import { CookieJarStore } from "@/core/http/cookies";
import { DEFAULT_SETTINGS, type PreparedRequest } from "@/core/types";

const decoded = Buffer.alloc(64 * 1024, "a");
const compressed: Record<string, Buffer> = {
  gzip: zlib.gzipSync(decoded),
  deflate: zlib.deflateSync(decoded),
  raw: zlib.deflateRawSync(decoded),
  br: zlib.brotliCompressSync(decoded),
  stacked: zlib.brotliCompressSync(zlib.gzipSync(decoded)),
};
const servers: http.Server[] = [];
let source: string;
let destination: string;
let secureSource: string;
const seen: http.IncomingHttpHeaders[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  destination = await listen((req, res) => {
    seen.push(req.headers);
    if (req.url === "/digest") {
      res.writeHead(401, { "WWW-Authenticate": 'Digest realm="other", nonce="n", qop="auth"' });
    }
    res.end("destination");
  });
  source = await listen((req, res) => {
    const path = req.url!.slice(1);
    if (path === "cross" || path === "cross-digest" || path === "same") {
      const location = path === "same" ? "/echo" : destination + (path === "cross-digest" ? "/digest" : "/");
      res.writeHead(302, { Location: location });
      return res.end();
    }
    if (path === "upgrade") {
      res.writeHead(302, { Location: secureSource + "/echo" });
      return res.end();
    }
    if (path === "blocked-hop") {
      res.writeHead(302, { Location: destination.replace("127.0.0.1", "localhost") });
      return res.end();
    }
    if (path === "echo") {
      if (req.headers["x-json"]) return res.end(JSON.stringify(req.headers));
      return res.end(req.headers.cookie ?? "");
    }
    if (path === "malformed") {
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "text/plain" });
      return res.end("invalid gzip");
    }
    const encoding = path === "raw" ? "deflate" : path === "stacked" ? "gzip, br" : path;
    res.writeHead(200, { "Content-Encoding": encoding, "Content-Type": "text/plain" });
    res.end(compressed[path]);
  });
  const tls = https.createServer(
    {
      key: fs.readFileSync(new URL("./fixtures/tls/localhost-key.pem", import.meta.url)),
      cert: fs.readFileSync(new URL("./fixtures/tls/localhost-cert.pem", import.meta.url)),
    },
    (req, res) => {
      if (req.url === "/same") res.writeHead(302, { Location: "/echo" });
      else if (req.url === "/echo") return res.end(JSON.stringify(req.headers));
      else res.writeHead(307, { Location: destination });
      res.end();
    },
  );
  servers.push(tls);
  await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
  secureSource = `https://127.0.0.1:${(tls.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

function request(path: string, extra: Partial<PreparedRequest> = {}): PreparedRequest {
  return { method: "GET", url: source + path, headers: [], settings: { ...DEFAULT_SETTINGS }, ...extra };
}

describe("HTTP security boundaries", () => {
  it("rejects literal IPs outside IP-only and mixed allowlists before connecting", async () => {
    for (const allow of [["10.0.0.0/8"], ["api.example.com", "10.0.0.0/8"]]) {
      await expect(sendRequest(request("/echo"), { policy: new HostPolicy(allow) })).rejects.toThrow(
        /not in PROXY_ALLOW_HOSTS/,
      );
    }
    expect((await sendRequest(request("/echo"), { policy: new HostPolicy(["127.0.0.0/8"]) })).status).toBe(
      200,
    );
  });

  it("handles bracketed IPv6 literals without deferring to DNS", () => {
    const policy = new HostPolicy(["fd00::/8"]);
    expect(policy.check("[::1]")).toMatch(/not in/);
    expect(policy.check("[fd00::1]")).toBeNull();
    expect(policy.check("service.internal")).toBeNull();
    expect(policy.check("service.internal", "::1")).toMatch(/not in/);
    expect(new HostPolicy(["*"], ["::1"]).check("[::1]")).toMatch(/blocked/);
  });

  it.each([
    "",
    " ",
    "https://example.com",
    "host/path",
    "10.0.0.0/",
    "10.0.0.0/abc",
    "10.0.0.0/-1",
    "10.0.0.0/33",
    "10.0.0.0/1/2",
    "fd00::/129",
    "fd00::/8.5",
    "999.1.1.1",
    "127.1",
    "example.com:443",
    "[::1",
    "[host]",
    "foo.*.test",
    "*example.com",
    "*.",
    "*.127.0.0.1",
    "bad..host",
    "-host.test",
    "host_.test",
    "a".repeat(64) + ".test",
  ])("rejects malformed allow and deny rule %j", (pattern) => {
    expect(() => new HostPolicy([pattern])).toThrow(/Invalid PROXY_ALLOW_HOSTS/);
    expect(() => new HostPolicy([], [pattern])).toThrow(/Invalid PROXY_DENY_HOSTS/);
  });

  it("validates entire environment lists and normalizes hostname case and trailing dots", () => {
    for (const value of ["example.com,", ",example.com", "example.com,,localhost", "*,bad/rule"])
      expect(() => HostPolicy.fromEnv({ NODE_ENV: "test", PROXY_DENY_HOSTS: value })).toThrow(
        /Invalid PROXY_DENY_HOSTS/,
      );
    expect(
      HostPolicy.fromEnv({ NODE_ENV: "test", PROXY_ALLOW_HOSTS: " ", PROXY_DENY_HOSTS: "" }).check(
        "anything.test",
      ),
    ).toBeNull();
    const policy = new HostPolicy(
      [" API.Example.COM. ", "*.Sub.Example.COM.", "[::1]"],
      ["blocked.sub.example.com"],
    );
    expect(policy.check("api.example.com")).toBeNull();
    expect(policy.check("API.EXAMPLE.COM.")).toBeNull();
    expect(policy.check("a.sub.example.com.")).toBeNull();
    expect(policy.check("sub.example.com", "192.0.2.1")).toMatch(/not in/);
    expect(policy.check("BLOCKED.SUB.EXAMPLE.COM.")).toMatch(/blocked/);
    expect(policy.check("[::1]")).toBeNull();
    expect(new HostPolicy(["0.0.0.0/0", "::/0"]).check("::1")).toBeNull();
  });

  it("strips arbitrary custom and proxy credentials across origins while retaining content negotiation", async () => {
    const start = seen.length;
    await sendRequest(
      request("/cross", {
        headers: [
          ["X-Api-Key", "secret"],
          ["X-Custom-Credential", "secret"],
          ["aPi-KeY", "secret"],
          ["Proxy-Authorization", "secret"],
          ["Referer", "https://private.test/?token=secret"],
          ["Accept", "application/json"],
          ["Accept-Language", "en"],
          ["User-Agent", "Postbox-test"],
        ],
      }),
    );
    expect(seen.slice(start)).toHaveLength(1);
    for (const key of ["x-api-key", "x-custom-credential", "api-key", "proxy-authorization", "referer"])
      expect(seen[start][key]).toBeUndefined();
    expect(seen[start]).toMatchObject({
      accept: "application/json",
      "accept-language": "en",
      "user-agent": "Postbox-test",
    });
  });

  it("keeps custom credentials and authorization on same-origin redirects", async () => {
    const res = await sendRequest(
      request("/same", {
        headers: [
          ["X-Json", "1"],
          ["X-Api-Key", "secret"],
          ["Authorization", "Bearer secret"],
        ],
      }),
    );
    expect(JSON.parse(res.bodyText)).toMatchObject({ "x-api-key": "secret", authorization: "Bearer secret" });
  });

  it("blocks HTTPS downgrade before transmitting a body or any credentials", async () => {
    const start = seen.length;
    await expect(
      sendRequest(
        request("", {
          method: "POST",
          url: secureSource + "/downgrade",
          body: Buffer.from("private-body"),
          headers: [["X-Api-Key", "secret"]],
          settings: { ...DEFAULT_SETTINGS, verifySsl: false },
        }),
      ),
    ).rejects.toMatchObject({ code: "EREDIRECTDOWNGRADE" });
    expect(seen).toHaveLength(start);
    const same = await sendRequest(
      request("", {
        url: secureSource + "/same",
        headers: [["X-Api-Key", "secret"]],
        settings: { ...DEFAULT_SETTINGS, verifySsl: false },
      }),
    );
    expect(JSON.parse(same.bodyText)["x-api-key"]).toBe("secret");
    const unfollowed = await sendRequest(
      request("", {
        url: secureSource + "/downgrade",
        settings: { ...DEFAULT_SETTINGS, verifySsl: false, followRedirects: false },
      }),
    );
    expect(unfollowed.status).toBe(307);
    expect(seen).toHaveLength(start);
  });

  it("strips credentials on HTTP-to-HTTPS origin changes too", async () => {
    const response = await sendRequest(
      request("/upgrade", {
        headers: [
          ["X-Api-Key", "secret"],
          ["Authorization", "Bearer secret"],
          ["Accept", "application/json"],
        ],
        settings: { ...DEFAULT_SETTINGS, verifySsl: false },
      }),
    );
    const headers = JSON.parse(response.bodyText);
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers.accept).toBe("application/json");
  });

  it("checks resolved addresses even when the hostname is allowed", async () => {
    await expect(
      sendRequest(request("", { url: source.replace("127.0.0.1", "localhost") + "/echo" }), {
        policy: new HostPolicy(["localhost"], ["127.0.0.0/8", "::1"]),
      }),
    ).rejects.toThrow(/blocked by PROXY_DENY_HOSTS/);
  });

  it("checks host policy on a redirect destination before connecting", async () => {
    const start = seen.length;
    await expect(
      sendRequest(request("/blocked-hop"), {
        policy: new HostPolicy(["*"], ["localhost"]),
      }),
    ).rejects.toThrow(/blocked by PROXY_DENY_HOSTS/);
    expect(seen).toHaveLength(start);
  });

  it("does not resurrect explicit cookies after a cross-origin redirect", async () => {
    const jar = new CookieJarStore();
    await jar.storeSetCookies(["jar=destination; Path=/"], destination);
    const start = seen.length;
    await sendRequest(
      request("/cross", {
        headers: [
          ["Cookie", "secret=original"],
          ["Authorization", "Bearer secret"],
        ],
      }),
      { cookieJar: jar },
    );
    expect(seen.slice(start)).toHaveLength(1);
    expect(seen[start].cookie).toBe("jar=destination");
    expect(seen[start].authorization).toBeUndefined();
  });

  it("preserves explicit and jar cookies on same-origin redirects", async () => {
    const jar = new CookieJarStore();
    await jar.storeSetCookies(["jar=value; Path=/"], source);
    const res = await sendRequest(request("/same", { headers: [["Cookie", "explicit=value"]] }), {
      cookieJar: jar,
    });
    expect(res.bodyText).toBe("explicit=value; jar=value");
  });

  it("does not answer a new origin's Digest challenge", async () => {
    const start = seen.length;
    const res = await sendRequest(
      request("/cross-digest", { digest: { username: "user", password: "secret" } }),
    );
    expect(res.status).toBe(401);
    expect(seen.slice(start)).toHaveLength(1);
    expect(seen[start].authorization).toBeUndefined();
  });

  it.each(Object.keys(compressed))("bounds decoded %s responses", async (encoding) => {
    await expect(sendRequest(request("/" + encoding), { maxBodyBytes: 2048 })).rejects.toMatchObject({
      code: "ERESPONSETOOLARGE",
    });
    const res = await sendRequest(request("/" + encoding), { maxBodyBytes: decoded.length });
    expect(res.bodyText).toBe(decoded.toString());
  });

  it("preserves the existing fallback for malformed compressed responses", async () => {
    expect((await sendRequest(request("/malformed"))).bodyText).toBe("invalid gzip");
  });

  it("does not send requests whose signal is already aborted", async () => {
    await expect(sendRequest(request("/cross"), { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "ECANCELLED",
    });
  });
});
