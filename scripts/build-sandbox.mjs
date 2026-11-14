import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const approvedCatalog = JSON.parse(
  await readFile(new URL("../src/core/packages/catalog.json", import.meta.url), "utf8"),
);
for (const entry of approvedCatalog) {
  const installed = JSON.parse(
    await readFile(path.join(root, "node_modules", entry.name, "package.json"), "utf8"),
  );
  if (installed.version !== entry.version)
    throw new Error(
      `Approved sandbox library ${entry.name} changed from ${entry.version} to ${installed.version}; review and update its catalog pin`,
    );
}
// Each approved package is compiled independently. References to another approved
// package resolve through the guest cache so SDK/Buffer/Chai identities stay shared.
const units = {};
const entries = [
  ["core", { entryPoints: ["scripts/sandbox/libraries.js"] }],
  ["schema", { entryPoints: ["scripts/sandbox/schema.js"] }],
  ...approvedCatalog.map(({ name }) => [
    name,
    {
      stdin: { contents: `module.exports = require(${JSON.stringify(name)});`, resolveDir: root },
    },
  ]),
];
for (const [name, entry] of entries) {
  const result = await build({
    absWorkingDir: root,
    ...entry,
    inject: name === "core" || name === "chai" ? [] : ["scripts/sandbox/shims.js"],
    bundle: true,
    platform: "browser",
    format: "cjs",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "inline",
    metafile: true,
    plugins: [
      {
        name: "approved-guest-dependencies",
        setup(build) {
          build.onResolve({ filter: /./ }, (args) => {
            if (args.path !== name && approvedCatalog.some((item) => item.name === args.path))
              return { path: args.path, namespace: "approved-guest", sideEffects: false };
          });
          build.onLoad({ filter: /./, namespace: "approved-guest" }, (args) => ({
            contents: `module.exports = __loadApproved(${JSON.stringify(args.path)});`,
          }));
        },
      },
    ],
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
  units[name] =
    "(function(){var module={exports:{}};var exports=module.exports;\n" +
    result.outputFiles[0].text +
    "\nreturn module.exports;})()" +
    "\n/*\n" +
    [...notices.values()].sort().join("\n\n").replaceAll("*/", "* /") +
    "\n*/\n";
}
const output = new URL("../src/core/scripts/libraries.generated.ts", import.meta.url);
const source = `// Rebuild with npm run build:sandbox.\nexport const LIBRARY_UNITS: Record<string, string> = ${JSON.stringify(units)};\nexport const APPROVED_CATALOG = ${JSON.stringify(approvedCatalog)};\n`;
if ((await readFile(output, "utf8").catch(() => "")) !== source) await writeFile(output, source);

await import("./build-visualizer.mjs");
