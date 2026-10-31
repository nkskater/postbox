import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/sandbox/libraries.js"],
  inject: ["scripts/sandbox/shims.js"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "inline",
  metafile: true,
});
// Keep complete dependency notices with the source embedded in every runtime bundle.
const notices = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const index = input.lastIndexOf("node_modules/");
  if (index < 0) continue;
  const parts = input.slice(index + "node_modules/".length).split("/");
  const directory = path.resolve(
    root,
    input.slice(0, index),
    "node_modules",
    parts[0],
    parts[0].startsWith("@") ? parts[1] : "",
  );
  if (notices.has(directory)) continue;
  const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  let license = "";
  for (const name of [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "license",
    "license.md",
    "license.txt",
    "COPYING",
  ]) {
    license = await readFile(path.join(directory, name), "utf8").catch(() => "");
    if (license) break;
  }
  notices.set(directory, `${metadata.name}@${metadata.version} (${metadata.license})\n${license}`);
}
const bundledSource =
  result.outputFiles[0].text +
  "\n/*\n" +
  [...notices.values()].sort().join("\n\n").replaceAll("*/", "* /") +
  "\n*/\n";
const output = new URL("../src/core/scripts/libraries.generated.ts", import.meta.url);
const source = `// Rebuild with npm run build:sandbox.\nexport const LIBRARIES_SOURCE = ${JSON.stringify(bundledSource)};\n`;
if ((await readFile(output, "utf8").catch(() => "")) !== source) await writeFile(output, source);
