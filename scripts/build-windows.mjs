#!/usr/bin/env node
// Builds the portable Windows edition: a self-contained folder (and a .zip of
// it) that runs on any 64-bit Windows 10/11 PC with no administrator rights
// and nothing installed — it carries its own official signed Node.js runtime.
// Unzip anywhere and double-click "Postbox".
//
//   npm run build:windows
//
// Output:
//   dist/Postbox/                 the ready-to-run folder
//   dist/Postbox-windows-x64.zip  the same folder, zipped
//
// Works from Windows, Linux or macOS: the bundled node.exe is downloaded from
// nodejs.org (same version as the Node running this script, checked against
// the published SHA-256), and better-sqlite3's prebuilt Windows binary is
// sourced from node_modules/better-sqlite3/prebuilds/win32-x64.node (or its
// GitHub release archive), so nothing has to be compiled on the target PC.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const DIST = path.join(ROOT, "dist");
export const CACHE = path.join(DIST, ".cache");
export const FOLDER_NAME = "Postbox";
export const STAGE = path.join(DIST, FOLDER_NAME);
export const APP = path.join(STAGE, "app");
export const ZIP_PATH = path.join(DIST, "Postbox-windows-x64.zip");

const NODE_VERSION = process.versions.node;
const NODE_ABI = process.versions.modules;

function log(msg) {
  console.log(`• ${msg}`);
}

export function assertWindowsBinary(buf, what) {
  if (!buf || buf.length < 2 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new Error(`${what} is not a Windows PE executable/DLL`);
  }
}

async function download(url, dest) {
  if (fs.existsSync(dest)) return fs.readFileSync(dest);
  log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, buf);
  fs.renameSync(`${dest}.part`, dest);
  return buf;
}

async function fetchNodeExe() {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const cachedExe = path.join(CACHE, `node-v${NODE_VERSION}-win-x64.exe`);
  const cachedSums = path.join(CACHE, `node-v${NODE_VERSION}-SHASUMS256.txt`);
  try {
    const exe = await download(`${base}/win-x64/node.exe`, cachedExe);
    const sums = (await download(`${base}/SHASUMS256.txt`, cachedSums)).toString("utf8");
    const line = sums.split("\n").find((l) => l.trim().endsWith(" win-x64/node.exe"));
    if (!line) throw new Error("win-x64/node.exe is missing from SHASUMS256.txt");
    const expected = line.trim().split(/\s+/)[0];
    const actual = crypto.createHash("sha256").update(exe).digest("hex");
    if (actual !== expected) {
      throw new Error(
        `node.exe checksum mismatch (expected ${expected}, got ${actual}) — delete dist/.cache and retry`,
      );
    }
    assertWindowsBinary(exe, "node.exe");
    return exe;
  } catch (err) {
    if (process.platform === "win32" && process.arch === "x64" && fs.existsSync(process.execPath)) {
      log(`Using local Windows Node.js binary (${process.execPath}) after download error: ${err.message}`);
      const exe = fs.readFileSync(process.execPath);
      assertWindowsBinary(exe, "node.exe");
      return exe;
    }
    throw err;
  }
}

// Pulls one file out of a .tar.gz (ustar), by path suffix.
export function extractFromTarGz(tgz, suffix) {
  const tar = zlib.gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (s, n) =>
      header
        .subarray(s, s + n)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = (field(345, 155) ? `${field(345, 155)}/` : "") + field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (name.endsWith(suffix)) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${suffix} not found in archive`);
}

async function fetchSqliteBinding() {
  const bsqDir = path.join(ROOT, "node_modules", "better-sqlite3");
  const prebuiltPath = path.join(bsqDir, "prebuilds", "win32-x64.node");
  if (fs.existsSync(prebuiltPath)) {
    const binding = fs.readFileSync(prebuiltPath);
    assertWindowsBinary(binding, "better-sqlite3 prebuilds/win32-x64.node");
    return binding;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(bsqDir, "package.json"), "utf8"));
  const file = `better-sqlite3-v${pkg.version}-node-v${NODE_ABI}-win32-x64.tar.gz`;
  const tgz = await download(
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${pkg.version}/${file}`,
    path.join(CACHE, file),
  );
  const binding = extractFromTarGz(tgz, "better_sqlite3.node");
  assertWindowsBinary(binding, "better_sqlite3.node");
  return binding;
}

export function sanitizeStandaloneServerJs(source, rootPath = ROOT) {
  const escapedWin = JSON.stringify(rootPath).slice(1, -1);
  const escapedPosix = JSON.stringify(rootPath.split(path.sep).join("/")).slice(1, -1);
  let out = source;
  for (const needle of [escapedWin, escapedPosix]) {
    if (needle) out = out.split(needle).join(".");
  }
  return out;
}

// ── Minimal zip writer (deflate, UTF-8 names) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf);
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function listFiles(dir, base = dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
    })
    .sort();
}

export function writeZip(srcDir, prefix, outFile) {
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const rel of listFiles(srcDir)) {
    const name = Buffer.from(`${prefix}/${rel.split(path.sep).join("/")}`, "utf8");
    const data = fs.readFileSync(path.join(srcDir, rel));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // made by (MS-DOS)
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(stored ? 0 : 8, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    chunks.push(local, name, body);
    offset += local.length + name.length + body.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outFile, Buffer.concat([...chunks, ...central, end]));
  return central.length / 2;
}

function ensureAppBuilt(skipBuild) {
  const standaloneServer = path.join(ROOT, ".next", "standalone", "server.js");
  const cliBundle = path.join(ROOT, "dist", "cli.mjs");
  if (skipBuild && fs.existsSync(standaloneServer) && fs.existsSync(cliBundle)) {
    return;
  }
  log("Building Next.js standalone server and Postbox CLI");
  const r = spawnSync("npm", ["run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  if (r.status !== 0) {
    throw new Error("`npm run build` failed");
  }
}

async function main() {
  const skipBuild = process.argv.includes("--skip-build");
  log(`Building the Postbox Windows edition with Node.js v${NODE_VERSION}`);
  if (!fs.existsSync(path.join(ROOT, "node_modules", "better-sqlite3"))) {
    throw new Error("Run `npm ci` first (the build reads the installed better-sqlite3 package)");
  }

  ensureAppBuilt(skipBuild);

  const [nodeExe, binding] = await Promise.all([fetchNodeExe(), fetchSqliteBinding()]);

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(ZIP_PATH, { force: true });
  fs.mkdirSync(APP, { recursive: true });

  log("Staging standalone server, static assets, migrations, and CLI");
  fs.cpSync(path.join(ROOT, ".next", "standalone"), APP, { recursive: true });
  fs.cpSync(path.join(ROOT, ".next", "static"), path.join(APP, ".next", "static"), {
    recursive: true,
  });
  fs.cpSync(path.join(ROOT, "public"), path.join(APP, "public"), { recursive: true });
  fs.cpSync(path.join(ROOT, "drizzle"), path.join(APP, "drizzle"), { recursive: true });

  // Bundle the CLI alongside server.js so `Postbox CLI.cmd` shares app/node_modules.
  fs.copyFileSync(path.join(ROOT, "dist", "cli.mjs"), path.join(APP, "cli.mjs"));
  const cliNodeModules = path.join(ROOT, "dist", "node_modules");
  if (fs.existsSync(cliNodeModules)) {
    fs.cpSync(cliNodeModules, path.join(APP, "node_modules"), { recursive: true });
  }

  // Strip build-machine paths from app/server.js.
  const serverJsPath = path.join(APP, "server.js");
  const sanitizedServer = sanitizeStandaloneServerJs(fs.readFileSync(serverJsPath, "utf8"));
  fs.writeFileSync(serverJsPath, sanitizedServer);

  // Copy the local Windows server entrypoint.
  fs.copyFileSync(path.join(ROOT, "scripts", "local-server.mjs"), path.join(APP, "local.mjs"));

  // Ensure better-sqlite3 contains only the Windows x64 prebuilt addon (and build/Release fallback)
  // and drop C/C++ sources and non-Windows prebuilds.
  const bsq = path.join(APP, "node_modules", "better-sqlite3");
  for (const dir of ["deps", "src", "build", "prebuilds"]) {
    fs.rmSync(path.join(bsq, dir), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(bsq, "prebuilds"), { recursive: true });
  fs.writeFileSync(path.join(bsq, "prebuilds", "win32-x64.node"), binding);
  fs.mkdirSync(path.join(bsq, "build", "Release"), { recursive: true });
  fs.writeFileSync(path.join(bsq, "build", "Release", "better_sqlite3.node"), binding);

  // Drop non-Windows @img/sharp-* native directories if built on Linux/macOS.
  const imgDir = path.join(APP, "node_modules", "@img");
  if (fs.existsSync(imgDir)) {
    for (const entry of fs.readdirSync(imgDir)) {
      if (!entry.includes("win32-x64") && !entry.includes("wasm")) {
        fs.rmSync(path.join(imgDir, entry), { recursive: true, force: true });
      }
    }
  }

  // Bundle the official signed Windows Node.js executable.
  fs.mkdirSync(path.join(STAGE, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(STAGE, "runtime", "node.exe"), nodeExe);

  // Copy launcher scripts and README to the top of the folder with CRLF line endings.
  for (const f of [
    "Postbox.cmd",
    "Postbox CLI.cmd",
    "Create desktop shortcut.cmd",
    "READ ME.txt",
  ]) {
    const text = fs
      .readFileSync(path.join(ROOT, "windows", f), "utf8")
      .replace(/\r?\n/g, "\r\n");
    fs.writeFileSync(path.join(STAGE, f), text);
  }
  fs.copyFileSync(path.join(ROOT, "windows", "app.ico"), path.join(APP, "app.ico"));

  // Include offline documentation in Docs\.
  const docsStage = path.join(STAGE, "Docs");
  fs.mkdirSync(docsStage, { recursive: true });
  if (fs.existsSync(path.join(ROOT, "README.md"))) {
    fs.copyFileSync(path.join(ROOT, "README.md"), path.join(docsStage, "README.md"));
  }
  if (fs.existsSync(path.join(ROOT, "docs"))) {
    fs.cpSync(path.join(ROOT, "docs"), docsStage, { recursive: true });
  }

  log("Zipping");
  const count = writeZip(STAGE, FOLDER_NAME, ZIP_PATH);
  const mb = (fs.statSync(ZIP_PATH).size / 1048576).toFixed(1);
  log(`Done: ${path.relative(ROOT, ZIP_PATH)} (${count} files, ${mb} MB)`);
  log(`      ${path.relative(ROOT, STAGE)}${path.sep}`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
