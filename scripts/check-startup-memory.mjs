// Exercise the real standalone server in a fresh data directory. RSS includes native/WASM memory,
// unlike the JavaScript heap limit, and must be checked before loading any HTTP route.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEAP_MB = Number(process.env.STARTUP_HEAP_MB ?? 320);
const COLD_MB = 180;
const WARM_MB = 300;
const root = fileURLToPath(new URL("../", import.meta.url));
const server = path.join(root, ".next", "standalone", "server.js");
if (!existsSync(server)) throw new Error("Run `npm run build` first: standalone server is missing.");
if (process.platform !== "linux") throw new Error("RSS assertions require Linux /proc (run in Linux CI).");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
const dir = mkdtempSync(path.join(os.tmpdir(), "postbox-memory-"));
const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, server], {
  cwd: path.dirname(server),
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    DATABASE_PATH: path.join(dir, "db.sqlite"),
    POSTBOX_VAULT_KEY_FILE: path.join(dir, "vault.key"),
    POSTBOX_PASSWORD: "",
    POSTBOX_TOKEN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (data) => (output += data));
child.stderr.on("data", (data) => (output += data));
let exited;
child.on("exit", (code, signal) => (exited = { code, signal }));
const closed = once(child, "close");
const ensureAlive = () => {
  if (exited) throw new Error(`Server exited (${JSON.stringify(exited)})`);
};
const rss = () => {
  ensureAlive();
  const kb = readFileSync(`/proc/${child.pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1];
  if (!kb) throw new Error("Cannot read server resident memory from /proc");
  return Number(kb) / 1024;
};
const checkRss = (phase, limit) => {
  const mb = rss();
  console.log(`${phase} RSS: ${mb.toFixed(1)} MB (limit <${limit} MB; heap ${HEAP_MB} MB)`);
  if (mb >= limit) throw new Error(`${phase} resident memory ${mb.toFixed(1)} MB exceeds ${limit} MB`);
};
const base = `http://127.0.0.1:${port}`;
const request = async (route, options) => {
  ensureAlive();
  const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text;
};

try {
  // Next's Ready log precedes config/route initialization. Let startup settle without an HTTP probe;
  // otherwise the first health request would invalidate the cold-memory measurement.
  const deadline = Date.now() + 60_000;
  while (!output.includes("Ready in")) {
    ensureAlive();
    if (Date.now() >= deadline) throw new Error("Server did not report ready within 60 seconds");
    await sleep(100);
  }
  await sleep(8000);
  checkRss("Cold (no HTTP requests)", COLD_MB);

  const health = JSON.parse(await request("/api/health"));
  if (health.status !== "ok" || health.app !== "postbox") throw new Error("Unexpected health response");
  await request("/");
  const workspaces = JSON.parse(await request("/api/workspaces"));
  const workspaceId = workspaces[0]?.id;
  if (!workspaceId) throw new Error("Default workspace missing");
  const lists = [
    "environments",
    "history",
    "runs",
    "schedules",
    "datasets",
    "workflows",
    "monitors",
    "specifications",
    "mocks",
    "load-runs",
  ];
  for (const route of lists) {
    JSON.parse(await request(`/api/${route}?workspaceId=${encodeURIComponent(workspaceId)}`));
  }
  const result = JSON.parse(
    await request("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        request: {
          name: "Memory smoke",
          method: "GET",
          url: `${base}/api/health`,
          params: [],
          headers: [],
          body: { mode: "none" },
          auth: { type: "none" },
          testScript: "pm.test('health status', () => pm.expect(pm.response.code).to.equal(200));",
        },
      }),
    }),
  );
  if (
    result.error ||
    result.response?.status !== 200 ||
    result.tests?.length !== 1 ||
    !result.tests[0].passed
  )
    throw new Error(`Scripted send failed: ${JSON.stringify(result).slice(0, 600)}`);
  // Include delayed startup work, retain loaded route modules, and do not force garbage collection.
  await sleep(8000);
  checkRss("Warm (health, home, ten lists, scripted send)", WARM_MB);
  await request("/api/health");
  console.log("Startup and warm-up memory checks passed.");
} catch (error) {
  console.error(`Startup memory check failed: ${error.message}`);
  console.error(output.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  child.kill();
  const stopped = await Promise.race([closed.then(() => true), sleep(5000).then(() => false)]);
  if (!stopped) {
    child.kill("SIGKILL");
    await closed;
  }
  rmSync(dir, { recursive: true, force: true });
}
