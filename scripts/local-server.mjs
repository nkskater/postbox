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
//   - acquires an exclusive per-database startup/lifetime lock so concurrent
//     launches never start two servers against the same SQLite file
//   - takes an automatic consistent daily SQLite backup in <DATA_DIR>\Backups\
//     using SQLite `VACUUM INTO` (capturing committed WAL frames even if a
//     reader pins the WAL checkpoint)
//   - opens the default web browser once the server is ready
//
// Environment overrides (via Settings.cmd or environment variables):
//   DATA_DIR           folder where postbox.db and Backups\ live
//   DATABASE_PATH      explicit SQLite file path (overrides DATA_DIR\postbox.db)
//   PORT               preferred loopback port (default 47392; falls back to an
//                      OS-assigned free port if taken or excluded by Hyper-V/VPN)
//   NO_BROWSER=1       do not open a browser window automatically
//   BACKUP_KEEP        daily backups kept (default 30; 0 disables daily backups)
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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

function databaseKeyHash(databasePath) {
  const normalized = path.resolve(databasePath).toLowerCase();
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

export function runningFilePath(
  databasePath,
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
) {
  return path.join(
    defaultDataDir(platform, env, homedir),
    `running-${databaseKeyHash(databasePath)}.json`,
  );
}

export function lockFilePath(
  databasePath,
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
) {
  return path.join(
    defaultDataDir(platform, env, homedir),
    `running-${databaseKeyHash(databasePath)}.lock`,
  );
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
  const lockFile = lockFilePath(databasePath, platform, env, homedir);
  return { dataDir, databasePath, migrationsPath, runningFile, lockFile };
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function tryAcquireInstanceLock(lockFile, instance, pid = process.pid) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid, instance, startedAt: Date.now() }), "utf8");
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const cur = JSON.parse(fs.readFileSync(lockFile, "utf8"));
          if (cur && cur.instance === instance) {
            fs.unlinkSync(lockFile);
          }
        } catch {
          /* already removed */
        }
      };
      return { acquired: true, release };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      } catch {
        // If the lock file was just created and is still being written, treat as active.
        try {
          const st = fs.statSync(lockFile);
          if (Date.now() - st.mtimeMs < 2000) {
            return { acquired: false, holder: null };
          }
        } catch {
          continue;
        }
      }
      if (holder && holder.pid && isProcessAlive(holder.pid)) {
        return { acquired: false, holder };
      }
      // Lock owner is dead or lock file is stale/corrupt; remove and retry once.
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* removed by another contender */
      }
    }
  }
  return { acquired: false, holder: null };
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

/**
 * Coordinates single-instance startup across concurrent launches.
 * Either acquires the exclusive per-database lock (returning `{ role: "leader", releaseLock }`)
 * or waits for the active leader to publish its healthy port in `runningFile`
 * (returning `{ role: "secondary", port }`).
 */
export async function acquireOrJoinInstance({
  lockFile,
  runningFile,
  instance,
  host = HOST,
  timeoutMs = 30_000,
  pollIntervalMs = 100,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const existingPort = await findRunningCopy(runningFile, host);
    if (existingPort) {
      return { role: "secondary", port: existingPort };
    }
    const lock = tryAcquireInstanceLock(lockFile, instance);
    if (lock.acquired) {
      const portAfterLock = await findRunningCopy(runningFile, host);
      if (portAfterLock) {
        lock.release();
        return { role: "secondary", port: portAfterLock };
      }
      return { role: "leader", releaseLock: lock.release };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error("Timed out waiting for another starting Postbox instance to become ready");
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

function loadBetterSqlite3(appDir) {
  const candidates = [
    path.join(appDir, "package.json"),
    fileURLToPath(import.meta.url),
  ];
  for (const base of candidates) {
    try {
      const req = createRequire(base);
      return req("better-sqlite3");
    } catch {
      /* try next */
    }
  }
  throw new Error("Could not load better-sqlite3 for consistent online backup");
}

/**
 * Creates a consistent, standalone SQLite snapshot of `databasePath` using
 * SQLite's `VACUUM INTO` command. Unlike a raw file copy after `wal_checkpoint`,
 * `VACUUM INTO` reads through SQLite's WAL index and captures all committed
 * transactions even when another connection holds an open read snapshot that
 * pins the WAL checkpoint. Fails closed if a consistent snapshot cannot be created.
 */
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
  if (!stat.isFile()) return null;
  const walPath = `${databasePath}-wal`;
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  if (stat.size === 0 && walSize === 0) return null;

  const backupsDir = path.join(path.dirname(databasePath), "Backups");
  const baseName = path.basename(databasePath, path.extname(databasePath)) || "postbox";
  const todayFile = `${baseName}-${formatLocalDate(now)}.db`;
  const dest = path.join(backupsDir, todayFile);
  if (fs.existsSync(dest)) return dest;

  fs.mkdirSync(backupsDir, { recursive: true });
  const part = `${dest}.part-${process.pid}-${Date.now()}`;
  try {
    if (fs.existsSync(part)) fs.unlinkSync(part);
    const Database = loadBetterSqlite3(appDir);
    const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      sqlite.pragma("busy_timeout = 5000");
      const verify = sqlite.prepare("SELECT count(*) AS cnt FROM sqlite_schema").get();
      if (!verify) throw new Error("Database schema unreadable");
      sqlite.prepare("VACUUM INTO ?").run(part);
    } finally {
      sqlite.close();
    }
    const partStat = fs.statSync(part);
    if (!partStat.isFile() || partStat.size === 0) {
      throw new Error("VACUUM INTO produced an empty backup file");
    }
    fs.renameSync(part, dest);
  } catch (err) {
    try {
      if (fs.existsSync(part)) fs.unlinkSync(part);
    } catch {
      /* ignore cleanup error */
    }
    throw err;
  }

  // Prune older daily backups beyond backupKeep only after today's consistent backup succeeds.
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
  if (process.env.POSTBOX_APP_DIR && fs.existsSync(path.join(process.env.POSTBOX_APP_DIR, "server.js"))) {
    return path.resolve(process.env.POSTBOX_APP_DIR);
  }
  // 1. Packaged Windows layout: app/local.mjs sits right next to app/server.js.
  if (fs.existsSync(path.join(__dirname, "server.js"))) {
    return __dirname;
  }
  // 2. Source checkout layout: scripts/local-server.mjs -> ../.next/standalone/server.js.
  const root = path.resolve(__dirname, "..");
  const standalone = path.join(root, ".next", "standalone");
  if (fs.existsSync(path.join(standalone, "server.js"))) {
    const staticSrc = path.join(root, ".next", "static");
    const staticDest = path.join(standalone, ".next", "static");
    if (fs.existsSync(staticSrc) && !fs.existsSync(staticDest)) {
      fs.cpSync(staticSrc, staticDest, { recursive: true, dereference: true });
    }
    for (const dir of ["public", "drizzle"]) {
      const src = path.join(root, dir);
      const dest = path.join(standalone, dir);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.cpSync(src, dest, { recursive: true, dereference: true });
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

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

async function main() {
  const appDir = resolveAppDir();
  const { dataDir, databasePath, migrationsPath, runningFile, lockFile } = resolveLocalPaths({
    appDir,
  });

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(path.dirname(runningFile), { recursive: true });

  const instance = crypto.randomBytes(12).toString("hex");
  const coord = await acquireOrJoinInstance({
    lockFile,
    runningFile,
    instance,
    host: HOST,
    timeoutMs: Number(process.env.POSTBOX_STARTUP_TIMEOUT_MS || 30_000),
  });

  if (coord.role === "secondary") {
    const url = `http://${HOST}:${coord.port}/`;
    console.log(`Postbox is already running — opening ${url}`);
    openBrowser(url);
    return;
  }

  const releaseLock = coord.releaseLock;
  let cleanedUp = false;
  function cleanupInstanceFiles() {
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
    releaseLock();
  }

  process.on("exit", cleanupInstanceFiles);

  const backupKeep = Number(process.env.BACKUP_KEEP ?? 30);
  try {
    runDailyBackup(databasePath, { backupKeep, appDir });
  } catch (err) {
    console.warn(`  Warning: daily backup skipped (${err.message || err})`);
  }

  const preferredPort = Number(process.env.PORT || DEFAULT_PREFERRED_PORT);
  const port = await findFreePort(preferredPort, HOST);

  process.env.NODE_ENV = "production";
  process.env.NEXT_TELEMETRY_DISABLED = "1";
  process.env.HOSTNAME = HOST;
  process.env.PORT = String(port);
  process.env.DATA_DIR = dataDir;
  process.env.DATABASE_PATH = databasePath;
  process.env.MIGRATIONS_PATH = migrationsPath;
  process.env.POSTBOX_INSTANCE_ID = instance;

  // Track HTTP servers and signal handlers registered by server.js so we can
  // run server cleanup to completion before releasing instance ownership and exiting.
  const createdServers = new Set();
  const origCreateServer = http.createServer;
  http.createServer = function wrappedCreateServer(...args) {
    const srv = origCreateServer.apply(this, args);
    createdServers.add(srv);
    return srv;
  };

  const serverSignalHandlers = new Map(SIGNALS.map((s) => [s, []]));
  const origProcessOn = process.on.bind(process);
  const origProcessOnce = process.once.bind(process);
  const origProcessAddListener = process.addListener.bind(process);

  function interceptSignalRegistration(origMethod) {
    return function interceptedOn(event, listener) {
      if (SIGNALS.includes(event) && typeof listener === "function") {
        serverSignalHandlers.get(event).push(listener);
        return process;
      }
      return origMethod(event, listener);
    };
  }

  process.on = interceptSignalRegistration(origProcessOn);
  process.once = interceptSignalRegistration(origProcessOnce);
  process.addListener = interceptSignalRegistration(origProcessAddListener);

  const realProcessExit = process.exit.bind(process);
  let shuttingDown = false;
  // If a server signal handler calls process.exit() after finishing its own drain
  // (e.g. Next.js start-server calling process.exit(143)), ensure instance files
  // are cleaned up and normalize graceful signal exit to 0.
  process.exit = function interceptedExit(code) {
    cleanupInstanceFiles();
    return realProcessExit(shuttingDown ? 0 : code);
  };

  async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Stopping Postbox…");

    const forceTimer = setTimeout(() => {
      cleanupInstanceFiles();
      realProcessExit(0);
    }, 5000);
    forceTimer.unref();

    for (const srv of createdServers) {
      try {
        srv.closeIdleConnections?.();
      } catch {
        /* ignore */
      }
    }

    let handlers = serverSignalHandlers.get(sig) || [];
    if (handlers.length === 0) {
      handlers =
        serverSignalHandlers.get("SIGTERM")?.length > 0
          ? serverSignalHandlers.get("SIGTERM")
          : serverSignalHandlers.get("SIGINT") || [];
    }

    const closePromises = [];
    for (const srv of createdServers) {
      if (srv.listening) {
        closePromises.push(
          new Promise((resolve) => {
            srv.once("close", () => setImmediate(resolve));
          }),
        );
      }
    }

    if (handlers.length > 0) {
      await Promise.allSettled(
        handlers.map((fn) => {
          try {
            return Promise.resolve(fn(sig));
          } catch (err) {
            return Promise.reject(err);
          }
        }),
      );
    }

    for (const srv of createdServers) {
      if (srv.listening) {
        try {
          srv.close();
        } catch {
          /* ignore */
        }
      }
    }

    if (closePromises.length > 0) {
      await Promise.allSettled(closePromises);
    }

    clearTimeout(forceTimer);
    cleanupInstanceFiles();
    realProcessExit(0);
  }

  for (const sig of SIGNALS) {
    try {
      origProcessOn(sig, () => {
        void shutdown(sig);
      });
    } catch {
      /* signal not supported on this platform */
    }
  }

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
