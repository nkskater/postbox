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
    if (path === "echo") return res.end(req.headers.cookie ?? "");
    if (path === "malformed") {
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "text/plain" });
      return res.end("invalid gzip");
    }
    const encoding = path === "raw" ? "deflate" : path === "stacked" ? "gzip, br" : path;
    res.writeHead(200, { "Content-Encoding": encoding, "Content-Type": "text/plain" });
    res.end(compressed[path]);
  });
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
