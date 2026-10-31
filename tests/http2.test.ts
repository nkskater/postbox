import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendRequest } from "@/core/http/engine";
import { toH2Headers } from "@/core/http/h2";
import { HostPolicy } from "@/core/http/policy";
import { DEFAULT_SETTINGS, type HttpVersionMode, type PreparedRequest } from "@/core/types";

const tlsOptions = {
  key: fs.readFileSync(new URL("./fixtures/tls/localhost-key.pem", import.meta.url)),
  cert: fs.readFileSync(new URL("./fixtures/tls/localhost-cert.pem", import.meta.url)),
};

let h2Tls: string; // h2 over TLS (also accepts http/1.1)
let h1Tls: string; // http/1.1-only TLS
let h2c: string; // cleartext HTTP/2
let h1Plain: string; // cleartext HTTP/1.1
const h2Sessions = new Set<http2.ServerHttp2Session>();
const closers: (() => Promise<void>)[] = [];

const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;

function h2Handler(req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) {
  const path = req.url;
  if (path === "/hang") return; // never answers
  if (path === "/big") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("x".repeat(4096));
  }
  if (path === "/trailers") {
    res.writeHead(200, { "content-type": "text/plain", trailer: "x-checksum" });
    res.write("body");
    res.addTrailers({ "x-checksum": "abc123" });
    return res.end();
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
    res.end(
      JSON.stringify({
        httpVersion: req.httpVersion,
        method: req.method,
        authority: req.authority,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }),
    );
  });
}

function track(server: http2.Http2Server | http2.Http2SecureServer) {
  server.on("session", (s) => {
    h2Sessions.add(s);
    s.on("close", () => h2Sessions.delete(s));
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of h2Sessions) s.destroy();
        server.close(() => resolve());
      }),
  );
}

beforeAll(async () => {
  const secure = http2.createSecureServer({ ...tlsOptions, allowHTTP1: true }, h2Handler);
  track(secure);
  await new Promise<void>((r) => secure.listen(0, "127.0.0.1", r));
  h2Tls = `https://localhost:${port(secure)}`;

  const plain = http2.createServer(h2Handler);
  track(plain);
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  h2c = `http://localhost:${port(plain)}`;

  const tls1 = https.createServer(tlsOptions, (_req, res) => res.end("h1"));
  closers.push(() => new Promise<void>((r) => tls1.close(() => r())));
  await new Promise<void>((r) => tls1.listen(0, "127.0.0.1", r));
  h1Tls = `https://localhost:${port(tls1)}`;

  const plain1 = http.createServer((_req, res) => res.end("h1"));
  closers.push(() => new Promise<void>((r) => plain1.close(() => r())));
  await new Promise<void>((r) => plain1.listen(0, "127.0.0.1", r));
  h1Plain = `http://localhost:${port(plain1)}`;
});

afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});

function req(
  url: string,
  httpVersion: HttpVersionMode | undefined,
  extra: Partial<PreparedRequest> = {},
): PreparedRequest {
  return {
    method: "GET",
    url,
    headers: [],
    settings: { ...DEFAULT_SETTINGS, verifySsl: false, httpVersion },
    ...extra,
  };
}

describe("toH2Headers", () => {
  it("lowercases names, drops connection-specific headers and maps Host to :authority", () => {
    const out = toH2Headers(
      [
        ["Host", "example.test:8443"],
        ["Connection", "keep-alive"],
        ["Transfer-Encoding", "chunked"],
        ["TE", "gzip"],
        ["Accept", "a"],
        ["Accept", "b"],
        ["X-Custom", "1"],
      ],
      "fallback.test",
    );
    expect(out).toEqual({ ":authority": "example.test:8443", accept: ["a", "b"], "x-custom": "1" });
    expect(toH2Headers([["TE", "trailers"]], "h.test")).toEqual({ ":authority": "h.test", te: "trailers" });
  });
});

describe("HTTP/2 transport", () => {
  it("uses HTTP/2 over TLS when forced and reports the negotiated version", async () => {
    const res = await sendRequest(
      req(`${h2Tls}/echo`, "http2", {
        method: "POST",
        headers: [
          ["X-Test", "yes"],
          ["Connection", "close"],
        ],
        body: Buffer.from("hello"),
      }),
    );
    expect(res.httpVersion).toBe("2");
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.bodyText);
    expect(echoed.httpVersion).toBe("2.0");
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe("hello");
    expect(echoed.headers["x-test"]).toBe("yes");
    expect(echoed.headers.connection).toBeUndefined();
    expect(res.headers.filter(([k]) => k === "set-cookie").map(([, v]) => v)).toEqual(["a=1", "b=2"]);
    expect(res.headers.some(([k]) => k.startsWith(":"))).toBe(false);
    expect(res.timings.tls).toBeGreaterThan(0);
  });

  it("collects response trailers", async () => {
    const res = await sendRequest(req(`${h2Tls}/trailers`, "http2"));
    expect(res.bodyText).toBe("body");
    expect(res.trailers).toEqual([["x-checksum", "abc123"]]);
  });

  it("negotiates h2 in auto mode and stays on HTTP/1.1 by default", async () => {
    expect((await sendRequest(req(`${h2Tls}/echo`, "auto"))).httpVersion).toBe("2");
    expect((await sendRequest(req(`${h2Tls}/echo`, undefined))).httpVersion).toBe("1.1");
    expect((await sendRequest(req(`${h2Tls}/echo`, "http1"))).httpVersion).toBe("1.1");
  });

  it("falls back to HTTP/1.1 in auto mode when h2 is not offered", async () => {
    const tls = await sendRequest(req(h1Tls, "auto"));
    expect(tls.httpVersion).toBe("1.1");
    expect(tls.bodyText).toBe("h1");
    const plain = await sendRequest(req(h1Plain, "auto"));
    expect(plain.httpVersion).toBe("1.1");
  });

  it("fails clearly when HTTP/2 is required but not negotiated", async () => {
    await expect(sendRequest(req(h1Tls, "http2"))).rejects.toMatchObject({ code: "EH2NEGOTIATE" });
  });

  it("speaks cleartext HTTP/2 with prior knowledge only when forced", async () => {
    const res = await sendRequest(req(`${h2c}/echo`, "http2"));
    expect(res.httpVersion).toBe("2");
    expect(JSON.parse(res.bodyText).httpVersion).toBe("2.0");
  });

  it("follows redirects across transports with the same policy checks", async () => {
    const server = http2.createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: `${h2Tls}/echo` });
        return response.end();
      }
      response.end("unexpected");
    });
    track(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const res = await sendRequest(req(`http://localhost:${port(server)}/start`, "http2"));
    expect(res.redirects).toHaveLength(1);
    expect(res.httpVersion).toBe("2");
    expect(res.url).toBe(`${h2Tls}/echo`);
  });

  it("truncates bodies at the size limit", async () => {
    const res = await sendRequest(req(`${h2Tls}/big`, "http2"), { maxBodyBytes: 100 });
    expect(res.truncated).toBe(true);
    expect(res.size).toBe(100);
  });

  it("enforces the host policy on the resolved address", async () => {
    await expect(
      sendRequest(req(`${h2Tls}/echo`, "http2"), { policy: new HostPolicy([], ["127.0.0.0/8"]) }),
    ).rejects.toThrow(/denied|blocked|not allowed|PROXY_DENY_HOSTS/i);
    await expect(
      sendRequest(req(`${h2Tls}/echo`, "auto"), { policy: new HostPolicy([], ["127.0.0.0/8"]) }),
    ).rejects.toThrow(/denied|blocked|not allowed|PROXY_DENY_HOSTS/i);
  });

  it("times out, and cleans up the connection", async () => {
    const request = req(`${h2Tls}/hang`, "http2");
    request.settings.timeoutMs = 300;
    await expect(sendRequest(request)).rejects.toMatchObject({ code: "ETIMEDOUT" });
    await waitFor(() => h2Sessions.size === 0);
  });

  it("honours cancellation, and cleans up the connection", async () => {
    const controller = new AbortController();
    const pending = sendRequest(req(`${h2Tls}/hang`, "http2"), { signal: controller.signal });
    await waitFor(() => h2Sessions.size > 0);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ECANCELLED" });
    await waitFor(() => h2Sessions.size === 0);
    await expect(
      sendRequest(req(`${h2Tls}/echo`, "http2"), { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ECANCELLED" });
  });

  it("closes the session after a successful exchange", async () => {
    await sendRequest(req(`${h2Tls}/echo`, "http2"));
    await waitFor(() => h2Sessions.size === 0);
  });

  it("refuses to silently downgrade HTTP/2-only requests that need HTTP/1.1 features", async () => {
    const socket = req(`${h2Tls}/echo`, "http2");
    socket.settings.socketPath = "/tmp/never.sock";
    await expect(
      sendRequest(socket, { policy: new HostPolicy([], [], ["/tmp/never.sock"]) }),
    ).rejects.toMatchObject({ code: "EH2UNSUPPORTED" });
    await expect(
      sendRequest(
        req(`${h2Tls}/echo`, "http2", { ntlm: { username: "u", password: "p" } as PreparedRequest["ntlm"] }),
      ),
    ).rejects.toMatchObject({ code: "EH2UNSUPPORTED" });
  });
});

async function waitFor(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}
