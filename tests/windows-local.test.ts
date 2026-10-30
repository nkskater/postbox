import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  APP_ID,
  defaultDataDir,
  findFreePort,
  findRunningCopy,
  formatLocalDate,
  resolveLocalPaths,
  runDailyBackup,
  runningFilePath,
} from "../scripts/local-server.mjs";
import {
  ROOT,
  assertWindowsBinary,
  crc32,
  sanitizeStandaloneServerJs,
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
      fs.rmSync(dir, { recursive: true, force: true });
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

  it("resolves default and overridden local data paths and running lock files", () => {
    const winEnv: NodeJS.ProcessEnv = { NODE_ENV: "production", LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" };
    const winDir = defaultDataDir("win32", winEnv, "C:\\Users\\Alice");
    expect(winDir).toBe(path.join("C:\\Users\\Alice\\AppData\\Local", "Postbox"));

    const posixEnv: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    const posixDir = defaultDataDir("linux", posixEnv, "/home/alice");
    expect(posixDir).toBe(path.join("/home/alice", ".postbox"));

    const tmp = makeTempDir();
    const customData = path.join(tmp, "Data");
    const customEnv: NodeJS.ProcessEnv = { NODE_ENV: "production", DATA_DIR: customData, LOCALAPPDATA: tmp };
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

  it("creates a WAL-checkpointed daily backup and prunes backups beyond BACKUP_KEEP", () => {
    const tmp = makeTempDir();
    const dbPath = path.join(tmp, "Data", "postbox.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('vpn-check');");
    sqlite.close();

    const backupsDir = path.join(path.dirname(dbPath), "Backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    for (const oldDate of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
      fs.writeFileSync(path.join(backupsDir, `postbox-${oldDate}.db`), "old-backup");
    }

    const now = new Date(2026, 9, 30, 12, 0, 0);
    const created = runDailyBackup(dbPath, { backupKeep: 2, appDir: ROOT, now });
    expect(created).toBe(path.join(backupsDir, `postbox-${formatLocalDate(now)}.db`));
    expect(fs.existsSync(created!)).toBe(true);

    // Verify the backed-up SQLite database contains the WAL-committed row.
    const verifyDb = new Database(created!, { readonly: true });
    const row = verifyDb.prepare("SELECT name FROM items WHERE id = 1").get() as { name: string };
    verifyDb.close();
    expect(row.name).toBe("vpn-check");

    // Only the newest 2 backups remain.
    const remaining = fs.readdirSync(backupsDir).sort();
    expect(remaining).toEqual(["postbox-2026-01-03.db", `postbox-${formatLocalDate(now)}.db`]);
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
    fs.mkdirSync(path.join(stage, "sub"), { recursive: true });
    fs.writeFileSync(path.join(stage, "hello.txt"), "hello windows world");
    fs.writeFileSync(path.join(stage, "sub", "nested.json"), '{"ok":true}');

    const zipOut = path.join(tmp, "out.zip");
    const count = writeZip(stage, "Postbox", zipOut);
    expect(count).toBe(2);
    const zipBytes = fs.readFileSync(zipOut);
    expect(zipBytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(zipBytes.includes(Buffer.from("Postbox/hello.txt"))).toBe(true);
    expect(zipBytes.includes(Buffer.from("Postbox/sub/nested.json"))).toBe(true);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("ships Windows launcher scripts configured for loopback and Windows certificate store", () => {
    const launcher = fs.readFileSync(path.join(ROOT, "windows", "Postbox.cmd"), "utf8");
    expect(launcher).toContain("--use-system-ca");
    expect(launcher).toContain('DATA_DIR=%~dp0Data');
    expect(launcher).toContain("Settings.cmd");

    const cliLauncher = fs.readFileSync(path.join(ROOT, "windows", "Postbox CLI.cmd"), "utf8");
    expect(cliLauncher).toContain("--use-system-ca");
    expect(cliLauncher).toContain("cli.mjs");

    const icon = fs.readFileSync(path.join(ROOT, "windows", "app.ico"));
    expect(icon.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]));
  });
});
