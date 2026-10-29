import http from "node:http";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface TestServer {
  url: string;
  close(): Promise<void>;
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** Small HTTP server with routes used by proxy / runner tests. */
export async function startTestServer(): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const u = new URL(req.url!, "http://localhost");
      const json = (status: number, data: unknown, extra: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...extra });
        res.end(JSON.stringify(data));
      };
      switch (u.pathname) {
        case "/echo":
          return json(200, {
            method: req.method,
            path: u.pathname,
            query: Object.fromEntries(u.searchParams),
            headers: req.headers,
            body,
          });
        case "/status":
          return json(Number(u.searchParams.get("code") ?? 200), { ok: true });
        case "/redirect": {
          const n = Number(u.searchParams.get("n") ?? 1);
          const code = Number(u.searchParams.get("code") ?? 302);
          res.writeHead(code, { Location: n > 1 ? `/redirect?n=${n - 1}&code=${code}` : "/echo" });
          return res.end();
        }
        case "/set-cookie":
          res.writeHead(200, { "Set-Cookie": ["session=abc123; Path=/", "theme=dark; Path=/; HttpOnly"] });
          return res.end("ok");
        case "/gzip":
          res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
          return res.end(zlib.gzipSync("compressed hello"));
        case "/slow":
          setTimeout(() => res.end("slow"), Number(u.searchParams.get("ms") ?? 500));
          return;
        case "/binary":
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          return res.end(Buffer.from([0, 1, 2, 3, 255]));
        case "/digest": {
          const realm = "test";
          const nonce = "abc";
          const auth = req.headers.authorization ?? "";
          if (!auth.startsWith("Digest ")) {
            res.writeHead(401, {
              "WWW-Authenticate": `Digest realm="${realm}", nonce="${nonce}", qop="auth"`,
            });
            return res.end();
          }
          const p = Object.fromEntries(
            [...auth.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]),
          );
          const ha1 = md5(`user:${realm}:pass`);
          const ha2 = md5(`${req.method}:${p.uri}`);
          const expected = md5(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
          return json(p.response === expected ? 200 : 401, { authenticated: p.response === expected });
        }
        case "/token":
          return json(200, {
            access_token: "tok-" + (body.includes("client_credentials") ? "cc" : "x"),
            expires_in: 3600,
          });
        default:
          return json(404, { error: "not found" });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
