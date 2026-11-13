import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  APP_ID,
  appWindowArgs,
  defaultDataDir,
  findAppBrowser,
  findFreePort,
  findRunningCopy,
  formatHostEvent,
  formatLocalDate,
  isHostMode,
  isWindowMode,
  lockFilePath,
  resolveLocalPaths,
  runDailyBackup,
  runningFilePath,
  tryAcquireInstanceLock,
} from "../scripts/local-server.mjs";
import {
  ROOT,
  assertWindowsBinary,
  crc32,
  fetchNodeExe,
  sanitizeStandaloneServerJs,
  stageApp,
  verifyNodeExe,
  writeZip,
} from "../scripts/build-windows.mjs";

describe("portable Windows local edition", () => {
  let healthGet: () => Response;
  const tempDirs: string[] = [];

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-win-test-"));
    tempDirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    process.env.DATABASE_PATH = ":memory:";
    const mod = await import("@/app/api/health/route");
    healthGet = mod.GET;
  }, 30_000);

  afterEach(() => {
    delete process.env.POSTBOX_INSTANCE_ID;
    while (tempDirs.length) {
      const dir = tempDirs.pop()!;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore EBUSY cleanup on Windows */
      }
    }
  });

  it("includes app identifier and optional instance ID on /api/health", async () => {
    const res1 = healthGet();
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { status: string; app: string; instance?: string };
    expect(body1.status).toBe("ok");
    expect(body1.app).toBe("postbox");
    expect(body1.instance).toBeUndefined();

    process.env.POSTBOX_INSTANCE_ID = "inst-abc-123";
    const res2 = healthGet();
    const body2 = (await res2.json()) as { status: string; app: string; instance?: string };
    expect(body2.status).toBe("ok");
    expect(body2.app).toBe("postbox");
    expect(body2.instance).toBe("inst-abc-123");
  });

  it("resolves default and overridden local data paths, running file, and lock file", () => {
    const winEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
    };
    const winDir = defaultDataDir("win32", winEnv, "C:\\Users\\Alice");
    expect(winDir).toBe(path.join("C:\\Users\\Alice\\AppData\\Local", "Postbox"));

    const posixEnv: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    const posixDir = defaultDataDir("linux", posixEnv, "/home/alice");
    expect(posixDir).toBe(path.join("/home/alice", ".postbox"));

    const tmp = makeTempDir();
    const customData = path.join(tmp, "Data");
    const customEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      DATA_DIR: customData,
      LOCALAPPDATA: tmp,
    };
    const paths = resolveLocalPaths({
      appDir: path.join(tmp, "app"),
      env: customEnv,
      platform: "win32",
      homedir: tmp,
    });
    expect(paths.dataDir).toBe(path.resolve(customData));
    expect(paths.databasePath).toBe(path.resolve(customData, "postbox.db"));
    expect(paths.migrationsPath).toBe(path.resolve(tmp, "app", "drizzle"));
    expect(paths.runningFile).toBe(runningFilePath(paths.databasePath, "win32", customEnv, tmp));
    expect(paths.lockFile).toBe(lockFilePath(paths.databasePath, "win32", customEnv, tmp));
  });

  it("falls back to an OS-assigned free loopback port when the preferred port is occupied", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const occupiedPort = (blocker.address() as net.AddressInfo).port;
    try {
      const fallbackPort = await findFreePort(occupiedPort, "127.0.0.1");
      expect(fallbackPort).toBeGreaterThan(0);
      expect(fallbackPort).not.toBe(occupiedPort);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("detects a running local instance only when /api/health matches app and instance ID", async () => {
    const tmp = makeTempDir();
    const runningFile = path.join(tmp, "running.json");
    let activeInstance = "instance-live-1";

    const srv = http.createServer((req, res) => {
      if (req.url === "/api/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok", app: APP_ID, instance: activeInstance }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    const port = (srv.address() as net.AddressInfo).port;

    try {
      fs.writeFileSync(runningFile, JSON.stringify({ port, pid: process.pid, instance: "instance-live-1" }));
      expect(await findRunningCopy(runningFile, "127.0.0.1")).toBe(port);

      activeInstance = "different-instance";
      expect(await findRunningCopy(runningFile, "127.0.0.1")).toBeNull();
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }

    expect(await findRunningCopy(runningFile, "127.0.0.1")).toBeNull();
  });

  it("captures committed WAL rows even when an open read transaction pins the WAL checkpoint", () => {
    const tmp = makeTempDir();
    const dbPath = path.join(tmp, "Data", "postbox.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const writer = new Database(dbPath);
    writer.pragma("journal_mode = WAL");
    writer.exec(
      "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('row-1');",
    );
    // Flush initial schema + row-1 to main file, then pin a reader snapshot at row-1.
    writer.pragma("wal_checkpoint(TRUNCATE)");

    const pinnedReader = new Database(dbPath, { readonly: true });
    pinnedReader.exec("BEGIN DEFERRED");
    expect(pinnedReader.prepare("SELECT name FROM items ORDER BY id").all()).toEqual([{ name: "row-1" }]);

    // Commit row-2 while pinnedReader holds the snapshot open so row-2 stays in the WAL file.
    writer.prepare("INSERT INTO items (name) VALUES (?)").run("row-2-in-wal");
    writer.close();

    const backupsDir = path.join(path.dirname(dbPath), "Backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    for (const oldDate of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
      fs.writeFileSync(path.join(backupsDir, `postbox-${oldDate}.db`), "old-backup");
    }

    const now = new Date(2026, 9, 30, 12, 0, 0);
    let created: string | null = null;
    try {
      created = runDailyBackup(dbPath, { backupKeep: 2, appDir: ROOT, now });
    } finally {
      pinnedReader.exec("ROLLBACK");
      pinnedReader.close();
    }

    expect(created).toBe(path.join(backupsDir, `postbox-${formatLocalDate(now)}.db`));
    expect(fs.existsSync(created!)).toBe(true);

    // Verify the backup contains both row-1 and the WAL-resident row-2-in-wal.
    const verifyDb = new Database(created!, { readonly: true });
    const rows = verifyDb.prepare("SELECT name FROM items ORDER BY id").all() as {
      name: string;
    }[];
    verifyDb.close();
    expect(rows).toEqual([{ name: "row-1" }, { name: "row-2-in-wal" }]);

    // Only the newest 2 backups remain.
    const remaining = fs.readdirSync(backupsDir).sort();
    expect(remaining).toEqual(["postbox-2026-01-03.db", `postbox-${formatLocalDate(now)}.db`]);
  });

  it("fails closed without pruning existing backups when the source database is corrupt", () => {
    const tmp = makeTempDir();
    const dbPath = path.join(tmp, "Data", "postbox.db");
    const backupsDir = path.join(tmp, "Data", "Backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(dbPath, "not-a-valid-sqlite-database");
    fs.writeFileSync(path.join(backupsDir, "postbox-2026-01-01.db"), "good-backup-1");
    fs.writeFileSync(path.join(backupsDir, "postbox-2026-01-02.db"), "good-backup-2");

    expect(() =>
      runDailyBackup(dbPath, {
        backupKeep: 1,
        appDir: ROOT,
        now: new Date(2026, 9, 30, 12, 0, 0),
      }),
    ).toThrow();

    // Existing backups are untouched when today's backup fails.
    expect(fs.readdirSync(backupsDir).sort()).toEqual(["postbox-2026-01-01.db", "postbox-2026-01-02.db"]);
  });

  it("reclaims stale instance locks from dead PIDs and coordinates concurrent initial launches", async () => {
    const tmp = makeTempDir();
    const lockFile = path.join(tmp, "running-test.lock");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999999, instance: "dead-instance", startedAt: 1 }));
    const acquired = tryAcquireInstanceLock(lockFile, "live-instance", process.pid);
    expect(acquired.acquired).toBe(true);
    acquired.release!();
    expect(fs.existsSync(lockFile)).toBe(false);

    // Create a fixture appDir with a server.js that takes 350ms before listening,
    // and records each server start + handles SIGTERM cleanup asynchronously.
    const appDir = path.join(tmp, "app");
    const dataDir = path.join(tmp, "Data");
    const startsDir = path.join(tmp, "starts");
    const cleanupMarker = path.join(tmp, "sigterm-cleaned.txt");
    fs.mkdirSync(path.join(appDir, "drizzle"), { recursive: true });
    fs.mkdirSync(startsDir, { recursive: true });

    const fixtureServer = `
      import fs from "node:fs";
      import http from "node:http";
      import path from "node:path";

      const startsDir = ${JSON.stringify(startsDir)};
      const cleanupMarker = ${JSON.stringify(cleanupMarker)};
      fs.writeFileSync(path.join(startsDir, String(process.pid)), String(Date.now()));

      await new Promise((r) => setTimeout(r, 350));

      const srv = http.createServer((req, res) => {
        if (req.url === "/api/health") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            status: "ok",
            app: "postbox",
            instance: process.env.POSTBOX_INSTANCE_ID,
          }));
          return;
        }
        if (req.url === "/__test_sigterm") {
          res.statusCode = 200;
          res.end("closing");
          setImmediate(() => process.emit("SIGTERM", "SIGTERM"));
          return;
        }
        res.statusCode = 200;
        res.end("ok");
      });

      await new Promise((resolve) => srv.listen(Number(process.env.PORT), process.env.HOSTNAME || "127.0.0.1", resolve));

      process.on("SIGTERM", async () => {
        await new Promise((r) => setTimeout(r, 80));
        await new Promise((resolve) => srv.close(() => {
          fs.writeFileSync(cleanupMarker, "cleaned:" + process.env.POSTBOX_INSTANCE_ID);
          resolve();
        }));
      });
    `;
    fs.writeFileSync(path.join(appDir, "server.js"), fixtureServer);
    fs.writeFileSync(path.join(appDir, "package.json"), '{"type":"module"}');

    const freePort = await findFreePort(0, "127.0.0.1");
    const scriptPath = path.join(ROOT, "scripts", "local-server.mjs");
    const childEnv = {
      ...process.env,
      NO_BROWSER: "1",
      BACKUP_KEEP: "0",
      DATA_DIR: dataDir,
      LOCALAPPDATA: tmp,
      PORT: String(freePort),
      POSTBOX_APP_DIR: appDir,
    };

    const spawnLauncher = () => {
      const child = spawn(process.execPath, [scriptPath], {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      const exitPromise = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
      });
      return { child, getOutput: () => ({ stdout, stderr }), exitPromise };
    };

    // Launch two processes concurrently against the same fresh DATA_DIR.
    const p1 = spawnLauncher();
    const p2 = spawnLauncher();

    try {
      // Wait for whichever process became the secondary to exit cleanly.
      const firstExit = await Promise.race([
        p1.exitPromise.then((res) => ({ which: 1, res, leader: p2, secondary: p1 })),
        p2.exitPromise.then((res) => ({ which: 2, res, leader: p1, secondary: p2 })),
      ]);

      expect(firstExit.res.code).toBe(0);
      expect(firstExit.res.stdout).toContain("Postbox is already running — opening http://127.0.0.1:");

      // Wait until the leader prints "Postbox is running."
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !firstExit.leader.getOutput().stdout.includes("Postbox is running.")) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(firstExit.leader.getOutput().stdout).toContain("Postbox is running.");

      // Exactly ONE server process was ever started.
      expect(fs.readdirSync(startsDir).length).toBe(1);

      // Now send SIGTERM to the running leader and verify its async SIGTERM
      // cleanup handler runs to completion before the process exits.
      // On Windows, child.kill("SIGTERM") calls TerminateProcess immediately without
      // delivering a signal to the child, so trigger SIGTERM via the fixture endpoint.
      if (process.platform === "win32") {
        await fetch(`http://127.0.0.1:${freePort}/__test_sigterm`);
      } else {
        firstExit.leader.child.kill("SIGTERM");
      }
      const leaderExit = await firstExit.leader.exitPromise;
      expect(leaderExit.code).toBe(0);
      expect(fs.existsSync(cleanupMarker)).toBe(true);
      expect(fs.readFileSync(cleanupMarker, "utf8")).toMatch(/^cleaned:/);

      // Both runningFile and lockFile must be cleaned up after graceful shutdown.
      const paths = resolveLocalPaths({
        appDir,
        env: childEnv as NodeJS.ProcessEnv,
        platform: process.platform,
        homedir: tmp,
      });
      expect(fs.existsSync(paths.runningFile)).toBe(false);
      expect(fs.existsSync(paths.lockFile)).toBe(false);
    } finally {
      try {
        p1.child.kill("SIGKILL");
      } catch {}
      try {
        p2.child.kill("SIGKILL");
      } catch {}
    }
  }, 20_000);

  it("fails closed when runtime SHA256 verification fails or SHASUMS entry is missing", async () => {
    const validPe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x01, 0x02]);
    const actualHash = crypto.createHash("sha256").update(validPe).digest("hex");
    const wrongHash = "0".repeat(64);

    expect(() => verifyNodeExe(validPe, `${wrongHash}  win-x64/node.exe`)).toThrow(/checksum mismatch/);
    expect(() => verifyNodeExe(validPe, `${actualHash}  linux-x64/node`)).toThrow(
      /missing from SHASUMS256\.txt/,
    );
    expect(verifyNodeExe(validPe, `${actualHash}  win-x64/node.exe`)).toEqual(validPe);

    await expect(
      fetchNodeExe({
        nodeVersion: "22.99.99",
        cacheDir: makeTempDir(),
        downloadFn: async (url: string) => {
          if (url.endsWith("node.exe")) return validPe;
          return Buffer.from(`${wrongHash}  win-x64/node.exe\n`, "utf8");
        },
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it("validates PE binaries, sanitizes standalone server.js paths, and writes valid zip archives", () => {
    expect(() => assertWindowsBinary(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "test.exe")).not.toThrow();
    expect(() => assertWindowsBinary(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), "elf")).toThrow(
      /not a Windows PE executable/,
    );

    const rawServerJs =
      'const cfg = {"outputFileTracingRoot":"C:\\\\Users\\\\alice\\\\postbox","repoRoot":"C:\\\\Users\\\\alice\\\\postbox"};';
    const sanitized = sanitizeStandaloneServerJs(rawServerJs, "C:\\Users\\alice\\postbox");
    expect(sanitized).not.toContain("alice");
    expect(sanitized).toContain('"outputFileTracingRoot":"."');

    const tmp = makeTempDir();
    const stage = path.join(tmp, "stage");
    const externalTarget = path.join(tmp, "external-pkg");
    fs.mkdirSync(path.join(stage, "sub"), { recursive: true });
    fs.mkdirSync(externalTarget, { recursive: true });
    fs.writeFileSync(path.join(stage, "hello.txt"), "hello windows world");
    fs.writeFileSync(path.join(stage, "sub", "nested.json"), '{"ok":true}');
    fs.writeFileSync(path.join(externalTarget, "index.js"), "module.exports = 42;");
    fs.symlinkSync(
      externalTarget,
      path.join(stage, "linked-pkg"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const zipOut = path.join(tmp, "out.zip");
    const count = writeZip(stage, "Postbox", zipOut);
    expect(count).toBe(3);
    const zipBytes = fs.readFileSync(zipOut);
    expect(zipBytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(zipBytes.includes(Buffer.from("Postbox/hello.txt"))).toBe(true);
    expect(zipBytes.includes(Buffer.from("Postbox/sub/nested.json"))).toBe(true);
    expect(zipBytes.includes(Buffer.from("Postbox/linked-pkg/index.js"))).toBe(true);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("stages the app folder with or without the CLI and the Windows sqlite binding", async () => {
    const root = makeTempDir();
    const write = (rel: string, text = "x") => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    write(".next/standalone/server.js", `const dir = ${JSON.stringify(root)};`);
    write(".next/standalone/.next/server/app.js");
    write(".next/standalone/node_modules/better-sqlite3/package.json", "{}");
    write(".next/standalone/node_modules/better-sqlite3/src/sqlite3.c");
    write(".next/standalone/node_modules/@img/sharp-linux-x64/lib.node");
    write(".next/standalone/node_modules/@img/sharp-win32-x64/lib.node");
    // Turbopack links hashed externals to the real package, like a production build.
    fs.mkdirSync(path.join(root, ".next/standalone/.next/node_modules"), { recursive: true });
    fs.symlinkSync(
      path.join(root, ".next/standalone/node_modules/better-sqlite3"),
      path.join(root, ".next/standalone/.next/node_modules/better-sqlite3-abc123"),
      "junction",
    );
    write(".next/static/chunks/main.js");
    write("public/favicon.ico");
    write("drizzle/meta/_journal.json", "{}");
    write("scripts/local-server.mjs", "// launcher");
    write("dist/cli.mjs", "// cli");
    write("dist/node_modules/cli-dep/index.js");
    const binding = Buffer.from("MZfake-binding");

    for (const includeCli of [true, false]) {
      const appDir = path.join(root, includeCli ? "out-zip" : "out-desktop", "app");
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(path.join(appDir, "stale.txt"), "old");
      await stageApp({ appDir, includeCli, root, binding });
      const has = (rel: string) => fs.existsSync(path.join(appDir, rel));
      expect(has("stale.txt")).toBe(false);
      for (const rel of [
        "server.js",
        "local.mjs",
        ".next/server/app.js",
        ".next/static/chunks/main.js",
        "public/favicon.ico",
        "drizzle/meta/_journal.json",
        "node_modules/@img/sharp-win32-x64/lib.node",
      ]) {
        expect(has(rel), rel).toBe(true);
      }
      expect(has("node_modules/@img/sharp-linux-x64")).toBe(false);
      expect(has("node_modules/better-sqlite3/src")).toBe(false);
      for (const bsq of ["node_modules/better-sqlite3", ".next/node_modules/better-sqlite3-abc123"]) {
        expect(fs.readFileSync(path.join(appDir, bsq, "prebuilds", "win32-x64.node"))).toEqual(binding);
        expect(fs.readFileSync(path.join(appDir, bsq, "build", "Release", "better_sqlite3.node"))).toEqual(
          binding,
        );
      }
      expect(fs.readFileSync(path.join(appDir, "server.js"), "utf8")).not.toContain(root);
      const linked = path.join(appDir, ".next/node_modules/better-sqlite3-abc123");
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(linked, "package.json"), "utf8")).toBe("{}");
      expect(has("cli.mjs")).toBe(includeCli);
      expect(has("node_modules/cli-dep/index.js")).toBe(includeCli);
    }
    // Staging must never write through a link into the build output.
    expect(fs.existsSync(path.join(root, ".next/standalone/node_modules/better-sqlite3/prebuilds"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(root, ".next/standalone/node_modules/better-sqlite3/src"))).toBe(true);
  });

  it("ships Windows launcher scripts configured for loopback and Windows certificate store", () => {
    const launcher = fs.readFileSync(path.join(ROOT, "windows", "Postbox.cmd"), "utf8");
    expect(launcher).toContain("--use-system-ca");
    expect(launcher).toContain("DATA_DIR=%~dp0Data");
    expect(launcher).toContain("Settings.cmd");

    const cliLauncher = fs.readFileSync(path.join(ROOT, "windows", "Postbox CLI.cmd"), "utf8");
    expect(cliLauncher).toContain("--use-system-ca");
    expect(cliLauncher).toContain("cli.mjs");

    const icon = fs.readFileSync(path.join(ROOT, "windows", "app.ico"));
    expect(icon.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]));
  });

  it("detects app-window mode from the flag or POSTBOX_WINDOW", () => {
    expect(isWindowMode(["node", "local.mjs"], {})).toBe(false);
    expect(isWindowMode(["node", "local.mjs", "--window"], {})).toBe(true);
    expect(isWindowMode(["node", "local.mjs"], { POSTBOX_WINDOW: "1" })).toBe(true);
    expect(isWindowMode(["node", "local.mjs"], { POSTBOX_WINDOW: "0" })).toBe(false);
    expect(isWindowMode(["node", "local.mjs"], { POSTBOX_WINDOW: "false" })).toBe(false);
    expect(isWindowMode(["node", "local.mjs"], { POSTBOX_WINDOW: "" })).toBe(false);
  });

  it("finds Edge before Chrome on Windows, honors POSTBOX_BROWSER, and reports none", () => {
    const env = {
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    } as unknown as NodeJS.ProcessEnv;
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const both = new Set([edge, chrome]);
    expect(findAppBrowser({ env, platform: "win32", exists: (f) => both.has(f) })).toBe(edge);
    expect(findAppBrowser({ env, platform: "win32", exists: (f) => f === chrome })).toBe(chrome);
    expect(findAppBrowser({ env, platform: "win32", exists: () => false })).toBeNull();

    const custom = "D:\\Browsers\\brave.exe";
    expect(
      findAppBrowser({
        env: { ...env, POSTBOX_BROWSER: custom },
        platform: "win32",
        exists: (f) => f === custom || f === edge,
      }),
    ).toBe(custom);
    // An override that does not exist is an error, not a silent fallback.
    expect(
      findAppBrowser({
        env: { ...env, POSTBOX_BROWSER: custom },
        platform: "win32",
        exists: (f) => f === edge,
      }),
    ).toBeNull();

    expect(
      findAppBrowser({
        env: { PATH: "/usr/local/bin:/usr/bin" } as unknown as NodeJS.ProcessEnv,
        platform: "linux",
        exists: (f) => f === "/usr/bin/chromium",
      }),
    ).toBe("/usr/bin/chromium");
  });

  it("builds app-window arguments with a separate profile", () => {
    const args = appWindowArgs("http://127.0.0.1:47392/", "C:\\Postbox\\Data\\Window");
    expect(args[0]).toBe("--app=http://127.0.0.1:47392/");
    expect(args).toContain("--user-data-dir=C:\\Postbox\\Data\\Window");
    expect(args).toContain("--no-first-run");
  });

  it("ships a hidden app-window launcher and shortcuts that use it", () => {
    const cmd = fs.readFileSync(path.join(ROOT, "windows", "Postbox.cmd"), "utf8");
    expect(cmd).toContain('local.mjs" %*');
    expect(cmd).toContain("exit /b %RC%");
    // A hidden launch must never block on `pause`.
    expect(cmd).toMatch(/not "%~1"=="--window"/);

    const vbs = fs.readFileSync(path.join(ROOT, "windows", "Postbox App.vbs"), "utf8");
    expect(vbs).toContain("--window");
    expect(vbs).toMatch(/shell\.Run\(.*, 0, True\)/);
    expect(vbs).toContain("startup-error.log");

    const shortcut = fs.readFileSync(path.join(ROOT, "windows", "Create desktop shortcut.cmd"), "utf8");
    expect(shortcut).toContain("Postbox App.vbs");
    expect(shortcut).toContain("wscript.exe");

    const build = fs.readFileSync(path.join(ROOT, "scripts", "build-windows.mjs"), "utf8");
    expect(build).toContain('"Postbox App.vbs"');
  });

  describe.skipIf(process.platform === "win32")("app-window mode", () => {
    async function runWindowMode(browserScript: string) {
      const tmp = makeTempDir();
      const appDir = path.join(tmp, "app");
      const dataDir = path.join(tmp, "Data");
      fs.mkdirSync(path.join(appDir, "drizzle"), { recursive: true });
      fs.writeFileSync(path.join(appDir, "package.json"), '{"type":"module"}');
      fs.writeFileSync(
        path.join(appDir, "server.js"),
        `import http from "node:http";
         const srv = http.createServer((req, res) => {
           res.setHeader("Content-Type", "application/json");
           res.end(JSON.stringify({ status: "ok", app: "postbox", instance: process.env.POSTBOX_INSTANCE_ID }));
         });
         srv.listen(Number(process.env.PORT), "127.0.0.1");
         process.on("SIGTERM", () => srv.close(() => process.exit(0)));`,
      );
      const browser = path.join(tmp, "fake-browser.sh");
      fs.writeFileSync(
        browser,
        `#!/bin/sh\necho "$@" > ${JSON.stringify(path.join(tmp, "browser-args.txt"))}\n${browserScript}\n`,
        { mode: 0o755 },
      );
      const port = await findFreePort(0, "127.0.0.1");
      const env = { ...process.env } as unknown as NodeJS.ProcessEnv;
      delete env.NO_BROWSER;
      Object.assign(env, {
        BACKUP_KEEP: "0",
        DATA_DIR: dataDir,
        LOCALAPPDATA: tmp,
        PORT: String(port),
        POSTBOX_APP_DIR: appDir,
        POSTBOX_BROWSER: browser,
        POSTBOX_WINDOW_HANDOFF_MS: "300",
      });
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", "local-server.mjs"), "--window"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      return { child, exited, out: () => out, tmp, port, dataDir };
    }

    it("opens a chromeless window with its own profile and stops the server when it closes", async () => {
      const run = await runWindowMode("sleep 1.2");
      try {
        const code = await Promise.race([
          run.exited,
          new Promise<string>((r) => setTimeout(() => r("timeout"), 15_000)),
        ]);
        expect(code, run.out()).toBe(0);
        const args = fs.readFileSync(path.join(run.tmp, "browser-args.txt"), "utf8");
        expect(args).toContain(`--app=http://127.0.0.1:${run.port}/`);
        expect(args).toContain(`--user-data-dir=${path.join(run.dataDir, "Window")}`);
        expect(run.out()).toContain("Close the Postbox window to stop the app.");
      } finally {
        run.child.kill("SIGKILL");
      }
    }, 20_000);

    it("keeps the server running when the browser hands the window to another process", async () => {
      const run = await runWindowMode("exit 0");
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !run.out().includes("leaving Postbox running")) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(run.out()).toContain("leaving Postbox running");
        const res = await fetch(`http://127.0.0.1:${run.port}/api/health`);
        expect((await res.json()).app).toBe("postbox");
      } finally {
        run.child.kill("SIGKILL");
      }
    }, 20_000);

    it("refuses to start without a usable browser and leaves the reason on disk", async () => {
      const tmp = makeTempDir();
      const dataDir = path.join(tmp, "Data");
      fs.mkdirSync(path.join(tmp, "app"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "app", "server.js"), "");
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", "local-server.mjs"), "--window"], {
        env: {
          ...process.env,
          NO_BROWSER: "",
          DATA_DIR: dataDir,
          LOCALAPPDATA: tmp,
          POSTBOX_APP_DIR: path.join(tmp, "app"),
          POSTBOX_BROWSER: path.join(tmp, "missing-browser"),
        },
        stdio: "ignore",
      });
      const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      expect(code).toBe(1);
      expect(fs.readFileSync(path.join(dataDir, "startup-error.log"), "utf8")).toContain(
        "Microsoft Edge or Google Chrome",
      );
    }, 20_000);
  });
  it("detects host mode and formats host protocol lines", () => {
    expect(isHostMode({})).toBe(false);
    expect(isHostMode({ POSTBOX_HOST_PIPE: "0" })).toBe(false);
    expect(isHostMode({ POSTBOX_HOST_PIPE: "false" })).toBe(false);
    expect(isHostMode({ POSTBOX_HOST_PIPE: "1" })).toBe(true);
    expect(formatHostEvent("ready", { port: 1, role: "leader" })).toBe(
      'POSTBOX_READY {"port":1,"role":"leader"}\n',
    );
    expect(formatHostEvent("error", { message: "x" })).toBe('POSTBOX_ERROR {"message":"x"}\n');
  });

  describe.skipIf(process.platform === "win32")("desktop host mode", () => {
    type HostRun = {
      child: ReturnType<typeof spawn>;
      exited: Promise<number | null>;
      stdout: () => string;
      out: () => string;
    };

    function makeHostFixture(serverJs?: string) {
      const tmp = makeTempDir();
      const appDir = path.join(tmp, "app");
      const dataDir = path.join(tmp, "Data");
      fs.mkdirSync(path.join(appDir, "drizzle"), { recursive: true });
      fs.writeFileSync(path.join(appDir, "package.json"), '{"type":"module"}');
      fs.writeFileSync(
        path.join(appDir, "server.js"),
        serverJs ??
          `import http from "node:http";
           const srv = http.createServer((req, res) => {
             res.setHeader("Content-Type", "application/json");
             res.end(JSON.stringify({ status: "ok", app: "postbox", instance: process.env.POSTBOX_INSTANCE_ID }));
           });
           srv.listen(Number(process.env.PORT), "127.0.0.1");
           process.on("SIGTERM", () => srv.close(() => process.exit(0)));`,
      );
      const browser = path.join(tmp, "fake-browser.sh");
      const browserMarker = path.join(tmp, "browser-ran.txt");
      fs.writeFileSync(browser, `#!/bin/sh\necho "$@" > ${JSON.stringify(browserMarker)}\n`, {
        mode: 0o755,
      });
      return { tmp, appDir, dataDir, browserMarker, browser };
    }

    function startHost(fixture: ReturnType<typeof makeHostFixture>, port: number): HostRun {
      const env = { ...process.env } as unknown as NodeJS.ProcessEnv;
      delete env.NO_BROWSER;
      delete env.DATABASE_PATH;
      Object.assign(env, {
        BACKUP_KEEP: "0",
        DATA_DIR: fixture.dataDir,
        LOCALAPPDATA: fixture.tmp,
        PORT: String(port),
        POSTBOX_APP_DIR: fixture.appDir,
        POSTBOX_BROWSER: fixture.browser,
        POSTBOX_WINDOW: "1",
        POSTBOX_HOST_PIPE: "1",
      });
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", "local-server.mjs"), "--window"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let out = "";
      child.stdout!.on("data", (d) => {
        stdout += d;
        out += d;
      });
      child.stderr!.on("data", (d) => (out += d));
      const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      return { child, exited, stdout: () => stdout, out: () => out };
    }

    async function waitForLine(run: HostRun, prefix: string, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const line = run
          .stdout()
          .split("\n")
          .find((l) => l.startsWith(prefix + " "));
        if (line) return JSON.parse(line.slice(prefix.length + 1));
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`No ${prefix} line. Output:\n${run.out()}`);
    }

    function withTimeout<T>(p: Promise<T>, ms: number) {
      return Promise.race([p, new Promise<string>((r) => setTimeout(() => r("timeout"), ms))]);
    }

    it("reports readiness, serves a second start as secondary, and stops when stdin closes", async () => {
      const fixture = makeHostFixture();
      const port = await findFreePort(0, "127.0.0.1");
      const leader = startHost(fixture, port);
      try {
        const ready = await waitForLine(leader, "POSTBOX_READY");
        expect(ready).toEqual({
          port,
          url: `http://127.0.0.1:${port}/`,
          role: "leader",
          dataDir: fixture.dataDir,
        });
        expect(leader.stdout().match(/^POSTBOX_READY /gm)).toHaveLength(1);

        const databasePath = path.join(fixture.dataDir, "postbox.db");
        const runningFile = runningFilePath(databasePath);
        const lockFile = lockFilePath(databasePath);
        expect(fs.existsSync(runningFile)).toBe(true);
        expect(fs.existsSync(lockFile)).toBe(true);

        const second = startHost(fixture, port);
        try {
          expect(await withTimeout(second.exited, 15_000), second.out()).toBe(0);
          expect(await waitForLine(second, "POSTBOX_READY")).toMatchObject({ port, role: "secondary" });
        } finally {
          second.child.kill("SIGKILL");
        }

        leader.child.stdin!.end();
        expect(await withTimeout(leader.exited, 10_000), leader.out()).toBe(0);
        expect(fs.existsSync(runningFile)).toBe(false);
        expect(fs.existsSync(lockFile)).toBe(false);
        expect(fs.existsSync(fixture.browserMarker)).toBe(false);
      } finally {
        leader.child.kill("SIGKILL");
      }
    }, 40_000);

    it("stops before readiness when stdin closes during start-up", async () => {
      const fixture = makeHostFixture(`await new Promise((r) => setTimeout(r, 60_000));`);
      const port = await findFreePort(0, "127.0.0.1");
      const run = startHost(fixture, port);
      try {
        const databasePath = path.join(fixture.dataDir, "postbox.db");
        const lockFile = lockFilePath(databasePath);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !fs.existsSync(lockFile)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(fs.existsSync(lockFile)).toBe(true);
        run.child.stdin!.end();
        expect(await withTimeout(run.exited, 10_000), run.out()).toBe(0);
        expect(fs.existsSync(lockFile)).toBe(false);
        expect(run.stdout()).not.toContain("POSTBOX_READY");
      } finally {
        run.child.kill("SIGKILL");
      }
    }, 20_000);

    it("reports a failed start with POSTBOX_ERROR and leaves the reason on disk", async () => {
      const fixture = makeHostFixture(`throw new Error("fixture start failure");`);
      const port = await findFreePort(0, "127.0.0.1");
      const run = startHost(fixture, port);
      try {
        expect(await withTimeout(run.exited, 15_000), run.out()).toBe(1);
        const error = await waitForLine(run, "POSTBOX_ERROR", 1000);
        const log = path.join(fixture.dataDir, "startup-error.log");
        expect(error).toEqual({ message: "fixture start failure", log });
        expect(fs.readFileSync(log, "utf8")).toContain("fixture start failure");
        expect(fs.existsSync(lockFilePath(path.join(fixture.dataDir, "postbox.db")))).toBe(false);
        expect(fs.existsSync(fixture.browserMarker)).toBe(false);
      } finally {
        run.child.kill("SIGKILL");
      }
    }, 20_000);
  });
});
