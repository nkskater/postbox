// Starts the standalone server (after `npm run build`) with a small JavaScript heap and fails if it
// does not come up and stay up. The default container limit is 1 GB; a server that needs a heap
// larger than HEAP_MB at startup has regressed (LAB-162: every route chunk carried its own copy of
// large dependencies and Next loads them all at boot).
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEAP_MB = Number(process.env.STARTUP_HEAP_MB ?? 320);
const root = fileURLToPath(new URL("../", import.meta.url));
const server = path.join(root, ".next", "standalone", "server.js");
if (!existsSync(server)) {
  console.error("Run `npm run build` first: .next/standalone/server.js does not exist.");
  process.exit(2);
}
const dir = mkdtempSync(path.join(os.tmpdir(), "postbox-memory-"));
const port = 3100 + Math.floor(Math.random() * 800);
const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, server], {
  cwd: path.dirname(server),
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    DATABASE_PATH: path.join(dir, "db.sqlite"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
let exited = null;
child.on("exit", (code, signal) => (exited = { code, signal }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const healthy = () =>
  fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);

let failure = "";
try {
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline && !exited) {
    if (await healthy()) {
      up = true;
      break;
    }
    await sleep(250);
  }
  if (!up)
    failure = exited
      ? `the server exited (${JSON.stringify(exited)})`
      : "the server did not become healthy in 60 s";
  else {
    // The failure this guards against happened a few seconds after the server reported ready.
    await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
    await sleep(8000);
    if (exited) failure = `the server exited after starting (${JSON.stringify(exited)})`;
    else if (!(await healthy())) failure = "the server stopped answering after starting";
  }
  if (!failure) {
    const rss = (() => {
      try {
        return readFileSync(`/proc/${child.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1];
      } catch {
        return undefined; // not Linux
      }
    })();
    console.log(
      `Startup OK with a ${HEAP_MB} MB heap${rss ? ` (resident ${Math.round(Number(rss) / 1024)} MB)` : ""}.`,
    );
  }
} finally {
  child.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
if (failure) {
  console.error(`Startup memory check failed with a ${HEAP_MB} MB heap: ${failure}.`);
  console.error(output.split("\n").slice(-25).join("\n"));
  process.exit(1);
}
