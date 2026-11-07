import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

/**
 * Starts the production build (`next start`) on a free port with an empty database, plus a small
 * target API for requests to hit. Tests read the addresses from the environment (`provide`).
 */
const apps: ChildProcess[] = [];
let target: http.Server | undefined;
let dir = "";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

export default async function setup({ provide }: { provide: (key: string, value: string) => void }) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-e2e-"));
  const port = await freePort();
  const targetPort = await freePort();
  target = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, method: req.method, url: req.url, body }));
    });
  });
  // The same port also speaks WebSocket (echoes every message) for the live-protocol tests.
  const sockets = new WebSocketServer({ server: target });
  sockets.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => socket.send(isBinary ? data : `echo:${data.toString()}`));
  });
  await new Promise<void>((r) => target!.listen(targetPort, "127.0.0.1", r));
  /** Start the production build with its own database; resolves to its base URL. */
  const start = async (name: string, port: number, extraEnv: Record<string, string>) => {
    const child = spawn(
      process.execPath,
      [path.resolve("node_modules/next/dist/bin/next"), "start", "-p", String(port)],
      {
        env: {
          ...process.env,
          DATABASE_PATH: path.join(dir, `${name}.sqlite`),
          NEXT_TELEMETRY_DISABLED: "1",
          NODE_ENV: "production",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    apps.push(child);
    let log = "";
    child.stdout?.on("data", (c) => (log += c));
    child.stderr?.on("data", (c) => (log += c));
    const url = `http://localhost:${port}`;
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        if ((await fetch(`${url}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (child.exitCode !== null) throw new Error(`Server exited early:\n${log}`);
      if (Date.now() > deadline) throw new Error(`Server did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    return url;
  };
  const base = await start("db", port, {});
  // A second, password-protected instance for the sign-in tests.
  const authPort = await freePort();
  const authBase = await start("auth", authPort, {
    POSTBOX_PASSWORD: "e2e-correct-horse",
    POSTBOX_SESSION_SECRET: "e2e-session-secret-value-0123456789",
  });
  provide("baseUrl", base);
  provide("authUrl", authBase);
  provide("targetUrl", `http://127.0.0.1:${targetPort}`);
  provide("wsUrl", `ws://127.0.0.1:${targetPort}`);
  return async () => {
    for (const child of apps) child.kill();
    await new Promise<void>((r) => (target ? target.close(() => r()) : r()));
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Best-effort cleanup on Windows if child processes take time to release SQLite file handles
    }
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
    targetUrl: string;
    wsUrl: string;
    authUrl: string;
  }
}
