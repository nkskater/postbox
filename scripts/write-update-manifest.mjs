#!/usr/bin/env node
// Writes latest.json, the manifest the desktop app reads to find an update.
//
//   node scripts/write-update-manifest.mjs --version 1.2.3 --url <installer URL> \
//     --signature-file dist/Postbox-Desktop-windows-x64-setup.exe.sig --out dist/latest.json \
//     [--notes "text"] [--expect-version-of package.json]
//
// The signature file is the one `tauri build` writes next to the installer when
// bundle.createUpdaterArtifacts is on and TAURI_SIGNING_PRIVATE_KEY is set.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The manifest object for one Windows x64 installer.
 * @param {{ version: string, url: string, signature: string, notes?: string, pubDate?: Date }} release
 */
export function updateManifest({ version, url, signature, notes, pubDate = new Date() }) {
  const clean = String(version ?? "").replace(/^v/, "");
  if (!SEMVER.test(clean)) throw new Error(`Not a semantic version: ${version}`);
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error(`Not a web address: ${url}`);
  const sig = String(signature ?? "").trim();
  if (!sig) throw new Error("The update signature is empty");
  return {
    version: clean,
    notes: notes || `Postbox ${clean}: https://github.com/nkskater/postbox/releases/tag/v${clean}`,
    pub_date: pubDate.toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: { "windows-x86_64": { signature: sig, url: parsed.toString() } },
  };
}

function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  const version = option(argv, "--version");
  const expectFrom = option(argv, "--expect-version-of");
  if (expectFrom) {
    const expected = JSON.parse(fs.readFileSync(expectFrom, "utf8")).version;
    if (String(version).replace(/^v/, "") !== expected)
      throw new Error(`Version ${version} does not match ${expectFrom} (${expected})`);
  }
  const signatureFile = option(argv, "--signature-file");
  if (!signatureFile) throw new Error("--signature-file is required");
  const manifest = updateManifest({
    version,
    url: option(argv, "--url"),
    signature: fs.readFileSync(signatureFile, "utf8"),
    notes: option(argv, "--notes"),
  });
  const out = option(argv, "--out") ?? "latest.json";
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${out} for version ${manifest.version}`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
