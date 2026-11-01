/** A small HTTP forward proxy with CONNECT support, optional Basic auth and request logging. */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

export interface TestProxy {
  port: number;
  url: string;
  /** Forwarded plain requests: "METHOD absolute-url". */
  forwarded: string[];
  /** CONNECT targets: "host:port". */
  tunnels: string[];
  /** Requests rejected for missing or wrong credentials. */
  rejected: number;
  close(): Promise<void>;
}

export async function startTestProxy(
  opts: { auth?: { username: string; password: string }; denyConnect?: RegExp } = {},
): Promise<TestProxy> {
  const sockets = new Set<net.Socket>();
  const expected = opts.auth
    ? `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString("base64")}`
    : null;
  const state = { forwarded: [] as string[], tunnels: [] as string[], rejected: 0 };
  const authorized = (header: string | undefined) => !expected || header === expected;

  const server = http.createServer((req, res) => {
    if (!authorized(req.headers["proxy-authorization"])) {
      state.rejected++;
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="proxy"' });
      return res.end();
    }
    state.forwarded.push(`${req.method} ${req.url}`);
    const target = new URL(req.url!);
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.on("connect", (req, clientStream, head) => {
    const client = clientStream as net.Socket;
    if (!authorized(req.headers["proxy-authorization"])) {
      state.rejected++;
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\n\r\n',
      );
      return;
    }
    state.tunnels.push(req.url!);
    if (opts.denyConnect?.test(req.url!)) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const [host, port] = req.url!.replace(/^\[|\]:/g, (m) => (m === "[" ? "" : ":")).split(/:(?=\d+$)/);
    const upstream = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    get forwarded() {
      return state.forwarded;
    },
    get tunnels() {
      return state.tunnels;
    },
    get rejected() {
      return state.rejected;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
