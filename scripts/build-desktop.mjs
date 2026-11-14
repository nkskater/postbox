#!/usr/bin/env node
// Builds the Windows desktop installer: a per-user NSIS setup (no administrator
// rights) that installs a native window around the same local server the
// portable edition runs.
//
//   npm ci --prefix desktop
//   npm run build:desktop               build the app, stage, then build the installer
//   npm run build:desktop -- --skip-build   reuse an existing `npm run build`
//   npm run build:desktop -- --stage-only   stop after staging desktop/payload/
//   npm run build:desktop -- --reuse-payload  build only the installer from the staged payload
//
// Installer options (passed on to `tauri build`):
//   --tauri-config <file>   extra Tauri config, e.g. the update key or a test version
//   --features <list>       Cargo features of the shell (CI uses `update-test`)
//   --out <file name>       name of the installer in dist/ (default below)
//
// With `bundle.createUpdaterArtifacts` on and TAURI_SIGNING_PRIVATE_KEY set, the
// update signature is copied next to the installer as <installer>.sig.
//
// Output: dist/Postbox-Desktop-windows-x64-setup.exe
//
// Staging works on any OS; the installer step needs a Windows build host with
// the Rust toolchain (CI job "windows-desktop").
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIST, ROOT, ensureAppBuilt, fetchNodeExe, fetchSqliteBinding, stageApp } from "./build-windows.mjs";

export const DESKTOP = path.join(ROOT, "desktop");
export const PAYLOAD = path.join(DESKTOP, "payload");
export const PAYLOAD_APP = path.join(PAYLOAD, "app");
export const PAYLOAD_RUNTIME = path.join(PAYLOAD, "runtime");
export const SETUP_PATH = path.join(DIST, "Postbox-Desktop-windows-x64-setup.exe");
export const NSIS_BUNDLE_DIR = path.join(DESKTOP, "src-tauri", "target", "release", "bundle", "nsis");

function log(msg) {
  console.log(`• ${msg}`);
}

export async function stagePayload() {
  const [nodeExe, binding] = await Promise.all([fetchNodeExe(), fetchSqliteBinding()]);
  fs.rmSync(PAYLOAD, { recursive: true, force: true });
  await stageApp({ appDir: PAYLOAD_APP, includeCli: false, binding });
  fs.mkdirSync(PAYLOAD_RUNTIME, { recursive: true });
  // Unmodified official node.exe under a unique name, so the installer can find
  // the server process without touching any other Node.js process.
  fs.writeFileSync(path.join(PAYLOAD_RUNTIME, "postbox-node.exe"), nodeExe);
  fs.copyFileSync(path.join(ROOT, "windows", "app.ico"), path.join(PAYLOAD_APP, "app.ico"));
}

/** Value after `--name` on the command line, if any. */
function option(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function buildInstaller() {
  if (!fs.existsSync(path.join(DESKTOP, "node_modules", "@tauri-apps", "cli"))) {
    throw new Error("Run `npm ci --prefix desktop` first (installs the Tauri CLI)");
  }
  log("Building the native shell and NSIS installer");
  fs.rmSync(NSIS_BUNDLE_DIR, { recursive: true, force: true });
  const args = ["run", "tauri", "--", "build", "--bundles", "nsis"];
  const config = option("--tauri-config");
  if (config) args.push("--config", path.resolve(config));
  const features = option("--features");
  if (features) args.push("--features", features);
  const r = spawnSync("npm", args, {
    cwd: DESKTOP,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) throw new Error("`tauri build` failed");

  const setups = fs.existsSync(NSIS_BUNDLE_DIR)
    ? fs.readdirSync(NSIS_BUNDLE_DIR).filter((f) => f.endsWith("-setup.exe"))
    : [];
  if (setups.length !== 1) {
    throw new Error(`Expected one *-setup.exe in ${NSIS_BUNDLE_DIR}, found ${setups.length}`);
  }
  fs.mkdirSync(DIST, { recursive: true });
  const out = option("--out") ? path.join(DIST, path.basename(option("--out"))) : SETUP_PATH;
  fs.copyFileSync(path.join(NSIS_BUNDLE_DIR, setups[0]), out);
  const signature = path.join(NSIS_BUNDLE_DIR, `${setups[0]}.sig`);
  fs.rmSync(`${out}.sig`, { force: true });
  if (fs.existsSync(signature)) fs.copyFileSync(signature, `${out}.sig`);
  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  log(
    `Done: ${path.relative(ROOT, out)} (${mb} MB)${fs.existsSync(`${out}.sig`) ? " with update signature" : ""}`,
  );
}

async function main() {
  const skipBuild = process.argv.includes("--skip-build");
  const stageOnly = process.argv.includes("--stage-only");
  if (process.argv.includes("--reuse-payload")) {
    if (!fs.existsSync(path.join(PAYLOAD_APP, "local.mjs"))) throw new Error("No staged payload to reuse");
    buildInstaller();
    return;
  }
  log(`Building the Postbox desktop installer with Node.js v${process.versions.node}`);
  if (!fs.existsSync(path.join(ROOT, "node_modules", "better-sqlite3"))) {
    throw new Error("Run `npm ci` first (the build reads the installed better-sqlite3 package)");
  }
  ensureAppBuilt(skipBuild);
  await stagePayload();
  log(`Staged ${path.relative(ROOT, PAYLOAD)}${path.sep}`);
  if (stageOnly) return;
  buildInstaller();
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
