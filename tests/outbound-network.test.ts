import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendRequest, RequestError } from "@/core/http/engine";
import { streamEvents, type SseMessage } from "@/core/http/sse";
import { connectWebSocket, type WsEvent } from "@/core/ws/client";
import {
  OutboundConfigError,
  OutboundNetwork,
  parseProxyUrl,
  validateIdentity,
  type TlsProfile,
} from "@/core/http/outbound";
import { HostPolicy, HostPolicyError } from "@/core/http/policy";
import { DEFAULT_SETTINGS, type PreparedRequest } from "@/core/types";
import { createPki, type Pki } from "./helpers/pki";
import { startTestProxy, type TestProxy } from "./helpers/http-proxy";

const hasOpenssl = (() => {
  try {
    createPki();
    return true;
  } catch {
    return false;
  }
})();

const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
const req = (url: string, extra: Partial<PreparedRequest["settings"]> = {}): PreparedRequest => ({
  method: "GET",
  url,
  headers: [],
  settings: { ...DEFAULT_SETTINGS, timeoutMs: 5000, ...extra },
});
const net = (proxy: TestProxy | string | null, profiles: TlsProfile[] = [], extra: object = {}) =>
  new OutboundNetwork({
    proxy: proxy ? { url: typeof proxy === "string" ? proxy : proxy.url, ...extra } : null,
    profiles,
  });
const policy = (n: OutboundNetwork | null, allow: string[] = [], deny: string[] = []) =>
  new HostPolicy(allow, deny).withNetwork(n);

describe("proxy URL and TLS identity validation", () => {
  it("accepts http and https proxies and rejects everything else", () => {
    expect(parseProxyUrl("http://proxy.corp:3128").port).toBe("3128");
    expect(parseProxyUrl("https://proxy.corp").hostname).toBe("proxy.corp");
    expect(() => parseProxyUrl("socks5://p:1080")).toThrow(/SOCKS/);
    expect(() => parseProxyUrl("http://u:p@proxy:80")).toThrow(/own fields/);
    expect(() => parseProxyUrl("http://proxy:80/path")).toThrow(/scheme:\/\/host/);
    expect(() => parseProxyUrl("not a url")).toThrow(OutboundConfigError);
  });

  it.runIf(hasOpenssl)("checks certificates, key pairs and passphrases", () => {
    const pki = createPki();
    expect(() =>
      validateIdentity({ ca: pki.caCert, cert: pki.clientCert, key: pki.clientKey }),
    ).not.toThrow();
    expect(() =>
      validateIdentity({ cert: pki.clientCert, key: pki.encryptedClientKey, passphrase: pki.passphrase }),
    ).not.toThrow();
    expect(() => validateIdentity({ cert: pki.clientCert, key: pki.encryptedClientKey })).toThrow(
      /passphrase/,
    );
    expect(() =>
      validateIdentity({ cert: pki.clientCert, key: pki.encryptedClientKey, passphrase: "wrong" }),
    ).toThrow(/passphrase/);
    expect(() => validateIdentity({ cert: pki.clientCert, key: pki.otherClientKey })).toThrow(
      /does not match/,
    );
    expect(() => validateIdentity({ cert: pki.clientCert })).toThrow(/together/);
    expect(() => validateIdentity({ ca: "nonsense" })).toThrow(/PEM certificate/);
    expect(() => validateIdentity({ cert: pki.clientCert, key: "nonsense" })).toThrow(/valid PEM key/);
  });
});

describe("OutboundNetwork selection", () => {
  const profile = (id: string, hosts: string[]): TlsProfile => ({ id, name: id, hosts, ca: id });
  it("applies the bypass list to names, wildcards and addresses", () => {
    const n = net("http://proxy:3128", [], { bypass: ["internal.corp", "*.lan", "10.0.0.0/8", "127.0.0.1"] });
    expect(n.proxyFor(new URL("https://api.example.com"))?.host).toBe("proxy");
    expect(n.proxyFor(new URL("https://internal.corp"))).toBeNull();
    expect(n.proxyFor(new URL("http://svc.lan:8080"))).toBeNull();
    expect(n.proxyFor(new URL("http://10.2.3.4"))).toBeNull();
    expect(n.proxyFor(new URL("http://127.0.0.1:9"))).toBeNull();
    expect(n.proxyFor(new URL("http://11.2.3.4"))?.port).toBe(3128);
    expect(net(null).proxyFor(new URL("http://a.b"))).toBeNull();
  });

  it("picks the most specific TLS profile", () => {
    const n = net(null, [
      profile("wild", ["*.example.com"]),
      profile("exact", ["api.example.com"]),
      profile("port", ["api.example.com:8443"]),
    ]);
    expect((n.tlsFor("a.example.com", 443) as TlsProfile).id).toBe("wild");
    expect((n.tlsFor("api.example.com", 443) as TlsProfile).id).toBe("exact");
    expect((n.tlsFor("api.example.com", 8443) as TlsProfile).id).toBe("port");
    expect(n.tlsFor("other.org", 443)).toBeUndefined();
  });

  it("describes itself without secrets", () => {
    const n = new OutboundNetwork({
      proxy: { url: "http://proxy:3128", username: "u", password: "hunter2-secret" },
      profiles: [
        {
          id: "p",
          name: "P",
          hosts: ["a.b"],
          cert: "CERT",
          key: "PRIVATE-KEY-DATA",
          passphrase: "pp-secret",
        },
      ],
    });
    const text = JSON.stringify(n.describe());
    expect(text).not.toMatch(/hunter2|PRIVATE-KEY|pp-secret|CERT"/);
    expect(n.describe().proxy).toMatchObject({ authenticated: true });
    expect(n.describe().profiles[0]).toMatchObject({ clientCertificate: true });
  });
});

describe("host policy through a proxy", () => {
  const n = net("http://proxy:3128");
  it("matches by name only and demands explicit names when address rules exist", () => {
    expect(policy(n).checkTarget("api.example.com", true)).toBeNull();
    expect(policy(n, [], ["evil.com"]).checkTarget("evil.com", true)).toMatch(/PROXY_DENY_HOSTS/);
    expect(policy(n, ["*.example.com"]).checkTarget("api.example.com", true)).toBeNull();
    expect(policy(n, ["*.example.com"]).checkTarget("other.org", true)).toMatch(/PROXY_ALLOW_HOSTS/);
    // Address-only allow rules cannot admit a name that a proxy resolves.
    expect(policy(n, ["10.0.0.0/8"]).checkTarget("svc.corp", true)).toMatch(/only host names/);
    expect(policy(n, ["10.0.0.0/8"]).checkTarget("10.1.1.1", true)).toBeNull();
    // Address deny rules: the name must be allowed explicitly, `*` is not enough.
    const denyPrivate = policy(n, [], ["10.0.0.0/8", "127.0.0.0/8"]);
    expect(denyPrivate.checkTarget("api.example.com", true)).toMatch(/cannot be verified/);
    expect(denyPrivate.checkTarget("10.1.1.1", true)).toMatch(/PROXY_DENY_HOSTS/);
    expect(policy(n, ["*"], ["10.0.0.0/8"]).checkTarget("api.example.com", true)).toMatch(
      /cannot be verified/,
    );
    expect(policy(n, ["api.example.com"], ["10.0.0.0/8"]).checkTarget("api.example.com", true)).toBeNull();
    // The same policy still permits the name on a direct connection (the DNS hook checks addresses).
    expect(denyPrivate.checkTarget("api.example.com", false)).toBeNull();
  });

  it("refuses protocols that dial resolved addresses when the proxy applies", () => {
    const p = policy(net("http://proxy:3128", [], { bypass: ["direct.corp"] }));
    expect(() => p.assertDirect("broker.example.com", 8883, "MQTT")).toThrow(
      /MQTT cannot use the outbound proxy/,
    );
    expect(() => p.assertDirect("direct.corp", 8883, "MQTT")).not.toThrow();
    expect(() => policy(null).assertDirect("broker.example.com", 1, "gRPC")).not.toThrow();
  });
});

describe("HTTP and HTTPS through a proxy", () => {
  let origin: http.Server;
  let originUrl: string;
  let proxy: TestProxy;
  beforeAll(async () => {
    origin = http.createServer((r, res) => {
      if (r.url === "/redirect-away") {
        res.writeHead(302, { location: "http://blocked.example:1/x" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          url: r.url,
          host: r.headers.host,
          proxyAuth: r.headers["proxy-authorization"] ?? null,
        }),
      );
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    originUrl = `http://127.0.0.1:${port(origin)}`;
    proxy = await startTestProxy({ auth: { username: "alice", password: "p@ss:word" } });
  });
  afterAll(async () => {
    origin.close();
    await proxy.close();
  });

  it("forwards plain http requests in absolute form with proxy credentials", async () => {
    const res = await sendRequest(req(`${originUrl}/a?b=1`), {
      policy: policy(net(proxy, [], { username: "alice", password: "p@ss:word" })),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.bodyText);
    expect(body).toMatchObject({ url: "/a?b=1", host: `127.0.0.1:${port(origin)}`, proxyAuth: null });
    expect(proxy.forwarded).toContain(`GET ${originUrl}/a?b=1`);
  });

  it("reports a proxy authentication failure on both paths", async () => {
    const before = proxy.rejected;
    const wrong = policy(net(proxy, [], { username: "alice", password: "nope" }));
    const plain = await sendRequest(req(`${originUrl}/x`), { policy: wrong });
    expect(plain.status).toBe(407);
    await expect(sendRequest(req("https://secure.example.test/x"), { policy: wrong })).rejects.toMatchObject({
      code: "EPROXYAUTH",
    });
    expect(proxy.rejected).toBe(before + 2);
  });

  it("does not use the proxy for bypassed hosts", async () => {
    const n = proxy.forwarded.length;
    const res = await sendRequest(req(`${originUrl}/direct`), {
      policy: policy(net(proxy, [], { username: "alice", password: "wrong", bypass: ["127.0.0.1"] })),
    });
    expect(res.status).toBe(200);
    expect(proxy.forwarded.length).toBe(n);
  });

  it("reports an unreachable proxy clearly", async () => {
    await expect(
      sendRequest(req("https://secure.example.test/"), { policy: policy(net("http://127.0.0.1:1")) }),
    ).rejects.toMatchObject({ code: "EPROXY", message: expect.stringContaining("Could not reach proxy") });
  });

  it("checks every redirect target by name", async () => {
    const p = policy(net(proxy, [], { username: "alice", password: "p@ss:word" }), [], ["blocked.example"]);
    await expect(
      sendRequest(req(`${originUrl}/redirect-away`, { followRedirects: true }), { policy: p }),
    ).rejects.toBeInstanceOf(HostPolicyError);
  });

  it("applies address deny rules by requiring explicit names", async () => {
    const p = policy(net(proxy, [], { username: "alice", password: "p@ss:word" }), [], ["127.0.0.0/8"]);
    // The literal address is denied outright; a name would have to be allowed explicitly.
    await expect(sendRequest(req(`${originUrl}/x`), { policy: p })).rejects.toBeInstanceOf(HostPolicyError);
    await expect(sendRequest(req("http://localhost:1/x"), { policy: p })).rejects.toThrow(
      /cannot be verified/,
    );
  });

  it("refuses NTLM and cleartext HTTP/2 through the proxy", async () => {
    const p = policy(net(proxy, [], { username: "alice", password: "p@ss:word" }));
    await expect(
      sendRequest(
        { ...req(`${originUrl}/x`), ntlm: { username: "u", password: "p" } as PreparedRequest["ntlm"] },
        { policy: p },
      ),
    ).rejects.toMatchObject({ code: "EPROXYUNSUPPORTED" });
    await expect(
      sendRequest(req(`${originUrl}/x`, { httpVersion: "http2" }), { policy: p }),
    ).rejects.toMatchObject({
      code: "EH2UNSUPPORTED",
    });
  });
});

describe.runIf(hasOpenssl)("custom CA and client certificates (mTLS)", () => {
  let pki: Pki;
  let server: https.Server;
  let url: string;
  let proxy: TestProxy;
  const subject = (r: http.IncomingMessage) =>
    (r.socket as unknown as { getPeerCertificate(): { subject?: { CN?: string } } }).getPeerCertificate()
      .subject?.CN ?? null;

  beforeAll(async () => {
    pki = createPki();
    server = https.createServer(
      {
        key: pki.serverKey,
        cert: pki.serverCert,
        ca: [pki.caCert],
        requestCert: true,
        rejectUnauthorized: true,
      },
      (r, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ client: subject(r) }));
      },
    );
    // Without a client certificate the handshake is refused, so surface that as a failed connection.
    server.on("tlsClientError", () => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `https://localhost:${port(server)}`;
    proxy = await startTestProxy({ auth: { username: "a", password: "b" } });
  });
  afterAll(async () => {
    server.close();
    await proxy.close();
  });

  const profile = (extra: Partial<TlsProfile> = {}): TlsProfile => ({
    id: "mtls",
    name: "internal",
    hosts: ["localhost"],
    ca: pki.caCert,
    cert: pki.clientCert,
    key: pki.clientKey,
    ...extra,
  });

  it("rejects a private CA until the CA is configured", async () => {
    await expect(sendRequest(req(`${url}/`), { policy: policy(net(null, [])) })).rejects.toBeInstanceOf(
      RequestError,
    );
    await expect(
      sendRequest(req(`${url}/`), {
        policy: policy(net(null, [{ ...profile(), cert: undefined, key: undefined }])),
      }),
    ).rejects.toBeDefined(); // trusted now, but the server still demands a client certificate
  });

  it("presents the client certificate selected by host", async () => {
    const res = await sendRequest(req(`${url}/`), { policy: policy(net(null, [profile()])) });
    expect(JSON.parse(res.bodyText)).toEqual({ client: "postbox-client" });
  });

  it("supports encrypted private keys", async () => {
    const res = await sendRequest(req(`${url}/`), {
      policy: policy(net(null, [profile({ key: pki.encryptedClientKey, passphrase: pki.passphrase })])),
    });
    expect(JSON.parse(res.bodyText).client).toBe("postbox-client");
  });

  it("does not offer the certificate to other hosts or ports", async () => {
    const other = profile({ hosts: [`localhost:${port(server) + 1}`] });
    await expect(sendRequest(req(`${url}/`), { policy: policy(net(null, [other])) })).rejects.toBeDefined();
  });

  it("rejects a client certificate from an untrusted CA", async () => {
    const intruder = profile({ cert: pki.otherClientCert, key: pki.otherClientKey });
    await expect(
      sendRequest(req(`${url}/`), { policy: policy(net(null, [intruder])) }),
    ).rejects.toBeDefined();
  });

  it("tunnels TLS end to end through the proxy with CONNECT", async () => {
    const before = proxy.tunnels.length;
    const res = await sendRequest(req(`${url}/`), {
      policy: policy(net(proxy, [profile()], { username: "a", password: "b" })),
    });
    expect(JSON.parse(res.bodyText).client).toBe("postbox-client");
    expect(proxy.tunnels.slice(before)).toEqual([`localhost:${port(server)}`]);
  });

  it("reports a proxy that refuses CONNECT", async () => {
    const strict = await startTestProxy({ denyConnect: /localhost/ });
    try {
      await expect(
        sendRequest(req(`${url}/`), { policy: policy(net(strict, [profile()])) }),
      ).rejects.toMatchObject({ code: "EPROXYDENIED", message: expect.stringContaining("HTTP 403") });
    } finally {
      await strict.close();
    }
  });

  it("negotiates HTTP/2 through the tunnel", async () => {
    const h2 = http2.createSecureServer({
      key: pki.serverKey,
      cert: pki.serverCert,
      ca: [pki.caCert],
      requestCert: true,
      allowHTTP1: true,
    });
    h2.on("request", (r, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`h2 ${r.httpVersion}`);
    });
    await new Promise<void>((resolve) => h2.listen(0, "127.0.0.1", resolve));
    const before = proxy.tunnels.length;
    try {
      const res = await sendRequest(req(`https://localhost:${port(h2)}/`, { httpVersion: "http2" }), {
        policy: policy(net(proxy, [profile()], { username: "a", password: "b" })),
      });
      expect(res.httpVersion).toBe("2");
      expect(res.bodyText).toBe("h2 2.0");
      expect(proxy.tunnels.length).toBe(before + 1);
    } finally {
      h2.close();
    }
  });

  it("streams server-sent events through the proxy and with mTLS", async () => {
    const sse = https.createServer(
      {
        key: pki.serverKey,
        cert: pki.serverCert,
        ca: [pki.caCert],
        requestCert: true,
        rejectUnauthorized: true,
      },
      (r, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: hello ${subject(r)}\n\n`);
      },
    );
    await new Promise<void>((resolve) => sse.listen(0, "127.0.0.1", resolve));
    const before = proxy.tunnels.length;
    const messages: SseMessage[] = [];
    try {
      await streamEvents(req(`https://localhost:${port(sse)}/`), (m) => messages.push(m), {
        policy: policy(net(proxy, [profile()], { username: "a", password: "b" })),
        maxReconnects: 0,
      });
      expect(messages.find((m) => m.type === "event")).toMatchObject({ data: "hello postbox-client" });
      expect(proxy.tunnels.length).toBe(before + 1);
    } finally {
      sse.close();
    }
  });

  it("opens secure WebSockets through the proxy with a client certificate", async () => {
    const wsServer = https.createServer({
      key: pki.serverKey,
      cert: pki.serverCert,
      ca: [pki.caCert],
      requestCert: true,
      rejectUnauthorized: true,
    });
    const wss = new WebSocketServer({ server: wsServer });
    wss.on("connection", (socket, r) => socket.send(`hi ${subject(r)}`));
    await new Promise<void>((resolve) => wsServer.listen(0, "127.0.0.1", resolve));
    const before = proxy.tunnels.length;
    const events: WsEvent[] = [];
    try {
      const done = new Promise<void>((resolve) => {
        const conn = connectWebSocket(
          req(`wss://localhost:${port(wsServer)}/`),
          (e) => {
            events.push(e);
            if (e.type === "message") {
              conn.close();
            }
            if (e.type === "close" || e.type === "error") resolve();
          },
          { policy: policy(net(proxy, [profile()], { username: "a", password: "b" })) },
        );
      });
      await done;
      expect(events.find((e) => e.type === "message")).toMatchObject({ data: "hi postbox-client" });
      expect(proxy.tunnels.length).toBe(before + 1);
    } finally {
      wss.close();
      wsServer.close();
    }
  });
});

describe("plain WebSocket through the proxy", () => {
  it("uses a CONNECT tunnel for ws:// too", async () => {
    const proxy = await startTestProxy();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => socket.send("hello"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const events: WsEvent[] = [];
    try {
      await new Promise<void>((resolve) => {
        const conn = connectWebSocket(
          req(`ws://127.0.0.1:${port(server)}/`),
          (e) => {
            events.push(e);
            if (e.type === "message") conn.close();
            if (e.type === "close" || e.type === "error") resolve();
          },
          { policy: policy(net(proxy)) },
        );
      });
      expect(events.some((e) => e.type === "message")).toBe(true);
      expect(proxy.tunnels).toEqual([`127.0.0.1:${port(server)}`]);
    } finally {
      wss.close();
      server.close();
      await proxy.close();
    }
  });
});

void fs;
