#!/usr/bin/env node
/**
 * Fails when the home page's first-load JavaScript exceeds the budget. Run after `next build`.
 *
 * First load = the framework's root main files plus the chunks the root layout and home page
 * reference (from the page's client reference manifest). Chunks that load later through
 * next/dynamic or import() are not counted.
 *
 * Usage: node scripts/bundle-budget.mjs [--max-raw-kb 1500] [--max-gzip-kb 500]
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const maxRaw = option("--max-raw-kb", 1500) * 1000;
const maxGzip = option("--max-gzip-kb", 500) * 1000;
const dist = path.resolve(".next");

const buildManifest = JSON.parse(fs.readFileSync(path.join(dist, "build-manifest.json"), "utf8"));
const context = { globalThis: {} };
context.globalThis = context;
vm.runInNewContext(
  fs.readFileSync(path.join(dist, "server/app/page_client-reference-manifest.js"), "utf8"),
  context,
);
const page = context.__RSC_MANIFEST["/page"];
const entries = page.entryJSFiles ?? {};
const files = new Set([
  ...buildManifest.rootMainFiles,
  ...(entries["[project]/src/app/layout"] ?? []),
  ...(entries["[project]/src/app/page"] ?? []),
]);
if (!files.size) throw new Error("No first-load chunks found; is .next a production build?");

const rows = [...files].map((file) => {
  const bytes = fs.readFileSync(path.join(dist, file));
  return { file, raw: bytes.length, gzip: zlib.gzipSync(bytes, { level: 9 }).length };
});
rows.sort((a, b) => b.raw - a.raw);
const raw = rows.reduce((n, r) => n + r.raw, 0);
const gzip = rows.reduce((n, r) => n + r.gzip, 0);
const kb = (n) => `${(n / 1000).toFixed(1)} kB`;

console.log(`Home page first-load JavaScript: ${kb(raw)} raw, ${kb(gzip)} gzipped, ${rows.length} chunks`);
console.log(`Budget: ${kb(maxRaw)} raw, ${kb(maxGzip)} gzipped`);
for (const r of rows.slice(0, 8))
  console.log(`  ${kb(r.raw).padStart(10)}  ${kb(r.gzip).padStart(9)} gz  ${r.file}`);
if (raw > maxRaw || gzip > maxGzip) {
  console.error("Over budget: load the new code with next/dynamic or import() where it is used.");
  process.exit(1);
}
