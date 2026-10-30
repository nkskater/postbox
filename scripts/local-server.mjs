#!/usr/bin/env node
// Local entry point — what the Windows launcher ("Postbox.cmd") and
// `npm run start:local` run.
//
// Runs the same Next.js standalone server as the Docker container, configured
// for a single Windows PC with no administrator rights required:
//   - listens on 127.0.0.1 only, so Windows Defender Firewall never prompts for
//     elevation and nothing else on the network can reach the local server
//   - originates all outgoing HTTP/HTTPS requests directly from this PC's
//     network stack (including active corporate VPN tunnels and allowlisted IPs)
//   - keeps its SQLite database in DATA_DIR (default: the "Data" folder next to
//     Postbox.cmd when launched from the Windows package, or %LOCALAPPDATA%\Postbox)
//   - takes an automatic daily SQLite backup in <DATA_DIR>\Backups\ (keeping the
//     newest BACKUP_KEEP copies, default 30)
//   - opens the default web browser once the server is ready
//   - if Postbox is already running for the same database on this PC, opens a
//     new browser tab at the running instance instead of starting a second copy
//
// Environment overrides (via Settings.cmd or environment variables):
//   DATA_DIR           folder where postbox.db and Backups\ live
//   DATABASE_PATH      explicit SQLite file path (overrides DATA_DIR\postbox.db)
//   PORT               preferred loopback port (default 47392; falls back to an
//                      OS-assigned free port if taken or excluded by Hyper-V/VPN)
//   NO_BROWSER=1       do not open a browser window automatically
//   BACKUP_KEEP        daily backups kept (default 30; 0 disables daily backups)
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APP_ID = "postbox";
export const HOST = "127.0.0.1";
export const DEFAULT_PREFERRED_PORT = 47392;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function defaultDataDir(
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
) {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(homedir, "AppData", "Local");
    return path.join(base, "Postbox");
  }
  return path.join(homedir, ".postbox");
}

export function runningFilePath(
  databasePath,
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
) {
  const normalized = path.resolve(databasePath).toLowerCase();
  const hash = crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  return path.join(defaultDataDir(platform, env, homedir), `running-${hash}.json`);
}

export function resolveLocalPaths({
  appDir = __dirname,
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  const dataDir = path.resolve(env.DATA_DIR || defaultDataDir(platform, env, homedir));
  const databasePath = path.resolve(env.DATABASE_PATH || path.join(dataDir, "postbox.db"));
  const migrationsPath = path.resolve(env.MIGRATIONS_PATH || path.join(appDir, "drizzle"));
  const runningFile = runningFilePath(databasePath, platform, env, homedir);
  return { dataDir, databasePath, migrationsPath, runningFile };
}

export function healthCheck(port, host = HOST, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/api/health", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

export async function findRunningCopy(runningFile, host = HOST) {
  let running;
  try {
    running = JSON.parse(fs.readFileSync(runningFile, "utf8"));
  } catch {
    return null;
  }
  if (!running || !running.port || !running.instance) return null;
  const health = await healthCheck(running.port, host);
  return health &&
    health.status === "ok" &&
    health.app === APP_ID &&
    health.instance === running.instance
    ? running.port
    : null;
}

function tryBindPort(port, host = HOST) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(port, host, () => {
      const assigned = srv.address().port;
      srv.close(() => resolve(assigned));
    });
  });
}

export async function findFreePort(preferredPort = DEFAULT_PREFERRED_PORT, host = HOST) {
  try {
    return await tryBindPort(preferredPort, host);
  } catch (err) {
    // Taken by another program, or reserved by Windows (Hyper-V/WSL/VPN port
    // exclusions surface as EACCES): let the OS pick a free ephemeral port.
    if (err.code !== "EADDRINUSE" && err.code !== "EACCES") throw err;
    return await tryBindPort(0, host);
  }
}

export function formatLocalDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function runDailyBackup(
  databasePath,
  { backupKeep = 30, appDir = __dirname, now = new Date() } = {},
) {
  if (!(backupKeep > 0)) return null;
  if (!fs.existsSync(databasePath)) return null;
  let stat;
  try {
    stat = fs.statSync(databasePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const backupsDir = path.join(path.dirname(databasePath), "Backups");
  const baseName = path.basename(databasePath, path.extname(databasePath)) || "postbox";
  const todayFile = `${baseName}-${formatLocalDate(now)}.db`;
  const dest = path.join(backupsDir, todayFile);
  if (fs.existsSync(dest)) return dest;

  fs.mkdirSync(backupsDir, { recursive: true });

  // Checkpoint WAL frames into the main database file if better-sqlite3 is available.
  try {
    const req = createRequire(path.join(appDir, "package.json"));
    const Database = req("better-sqlite3");
    const sqlite = new Database(databasePath);
    try {
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      sqlite.close();
    }
  } catch {
    // Fallback to raw file copy if better-sqlite3 cannot be loaded here.
  }

  const part = `${dest}.part-${process.pid}`;
  fs.copyFileSync(databasePath, part);
  try {
    const req = createRequire(path.join(appDir, "package.json"));
    const Database = req("better-sqlite3");
    const backupDb = new Database(part);
    try {
      backupDb.pragma("journal_mode = DELETE");
    } finally {
      backupDb.close();
    }
  } catch {
    /* ignore */
  }
  fs.renameSync(part, dest);

  // Prune older daily backups beyond backupKeep.
  try {
    const prefix = `${baseName}-`;
    const files = fs
      .readdirSync(backupsDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".db"))
      .sort();
    while (files.length > backupKeep) {
      const oldest = files.shift();
      try {
        fs.unlinkSync(path.join(backupsDir, oldest));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  return dest;
}

export function openBrowser(url, env = process.env, platform = process.platform) {
  if (env.NO_BROWSER) return;
  let cmd;
  let args;
  let opts = { detached: true, stdio: "ignore" };
  if (platform === "win32") {
    cmd = "cmd.exe";
    args = ["/d", "/s", "/c", `start "" "${url}"`];
    opts = { ...opts, windowsVerbatimArguments: true, windowsHide: true };
  } else if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, opts);
    child.on("error", () => {
      console.log(`  (Couldn't open a browser automatically — open ${url} yourself.)`);
    });
    child.unref();
  } catch {
    console.log(`  (Couldn't open a browser automatically — open ${url} yourself.)`);
  }
}

function resolveAppDir() {
  // 1. Packaged Windows layout: app/local.mjs sits right next to app/server.js.
  if (fs.existsSync(path.join(__dirname, "server.js"))) {
    return __dirname;
  }
  // 2. Source checkout layout: scripts/local-server.mjs -> ../.next/standalone/server.js.
  const root = path.resolve(__dirname, "..");
  const standalone = path.join(root, ".next", "standalone");
  if (fs.existsSync(path.join(standalone, "server.js"))) {
    // Ensure static assets, public/, and drizzle/ are present in .next/standalone.
    const staticSrc = path.join(root, ".next", "static");
    const staticDest = path.join(standalone, ".next", "static");
    if (fs.existsSync(staticSrc) && !fs.existsSync(staticDest)) {
      fs.cpSync(staticSrc, staticDest, { recursive: true });
    }
    for (const dir of ["public", "drizzle"]) {
      const src = path.join(root, dir);
      const dest = path.join(standalone, dir);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.cpSync(src, dest, { recursive: true });
      }
    }
    return standalone;
  }
  throw new Error(
    "Standalone build not found. Run `npm run build` first (or use the packaged Windows build).",
  );
}

async function waitForServerReady(port, instance, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await healthCheck(port, HOST, 1000);
    if (health && health.status === "ok" && health.instance === instance) {
      return health;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Postbox server did not become ready on http://${HOST}:${port}/api/health`);
}

async function main() {
  const appDir = resolveAppDir();
  const { dataDir, databasePath, migrationsPath, runningFile } = resolveLocalPaths({ appDir });

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(path.dirname(runningFile), { recursive: true });

  const runningPort = await findRunningCopy(runningFile);
  if (runningPort) {
    const url = `http://${HOST}:${runningPort}/`;
    console.log(`Postbox is already running — opening ${url}`);
    openBrowser(url);
    return;
  }

  const backupKeep = Number(process.env.BACKUP_KEEP ?? 30);
  try {
    runDailyBackup(databasePath, { backupKeep, appDir });
  } catch (err) {
    console.warn(`  Warning: daily backup skipped (${err.message || err})`);
  }

  const preferredPort = Number(process.env.PORT || DEFAULT_PREFERRED_PORT);
  const port = await findFreePort(preferredPort, HOST);
  const instance = crypto.randomBytes(12).toString("hex");

  process.env.NODE_ENV = "production";
  process.env.NEXT_TELEMETRY_DISABLED = "1";
  process.env.HOSTNAME = HOST;
  process.env.PORT = String(port);
  process.env.DATA_DIR = dataDir;
  process.env.DATABASE_PATH = databasePath;
  process.env.MIGRATIONS_PATH = migrationsPath;
  process.env.POSTBOX_INSTANCE_ID = instance;

  let cleanedUp = false;
  function cleanupRunningFile() {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      const current = JSON.parse(fs.readFileSync(runningFile, "utf8"));
      if (current && current.instance === instance) {
        fs.unlinkSync(runningFile);
      }
    } catch {
      /* already removed */
    }
  }

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Stopping Postbox…");
    cleanupRunningFile();
    process.exit(0);
  }

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(sig, shutdown);
    } catch {
      /* signal not supported on this platform */
    }
  }
  process.on("exit", cleanupRunningFile);

  // Start the Next.js standalone server in-process.
  await import(pathToFileURL(path.join(appDir, "server.js")).href);
  await waitForServerReady(port, instance);

  const url = `http://${HOST}:${port}/`;
  fs.writeFileSync(runningFile, JSON.stringify({ port, pid: process.pid, instance }));

  console.log("");
  console.log("  Postbox is running.");
  console.log("");
  console.log(`  Open:  ${url}`);
  console.log(`  Data:  ${databasePath}`);
  console.log("");
  console.log("  Requests are sent directly from this PC (including active VPN connections).");
  console.log("  Keep this window open while you use Postbox.");
  console.log("  Close it (or press Ctrl+C) to stop the app.");
  console.log("");

  openBrowser(url);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  main().catch((err) => {
    console.error("");
    console.error("Postbox could not start:");
    console.error((err && err.stack) || err);
    process.exit(1);
  });
}
