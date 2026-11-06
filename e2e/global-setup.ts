import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Starts the production build (`next start`) on a free port with an empty database, plus a small
 * target API for requests to hit. Tests read the addresses from the environment (`provide`).
 */
let app: ChildProcess | undefined;
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
  await new Promise<void>((r) => target!.listen(targetPort, "127.0.0.1", r));
  app = spawn(
    process.execPath,
    [path.resolve("node_modules/next/dist/bin/next"), "start", "-p", String(port)],
    {
      env: {
        ...process.env,
        DATABASE_PATH: path.join(dir, "db.sqlite"),
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  app.stdout?.on("data", (c) => (log += c));
  app.stderr?.on("data", (c) => (log += c));
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (app.exitCode !== null) throw new Error(`Server exited early:\n${log}`);
    if (Date.now() > deadline) throw new Error(`Server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  provide("baseUrl", base);
  provide("targetUrl", `http://127.0.0.1:${targetPort}`);
  return async () => {
    app?.kill();
    await new Promise<void>((r) => (target ? target.close(() => r()) : r()));
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
    targetUrl: string;
  }
}
