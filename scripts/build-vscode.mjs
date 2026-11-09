import "./build-sandbox.mjs";
import { build } from "esbuild";
import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "extensions", "vscode", "dist");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["extensions/vscode/src/extension.ts"],
  outfile: path.join(output, "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode", "quickjs-emscripten"],
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
});
if (
  Object.keys(result.metafile.inputs).some(
    (file) => file.startsWith("src/server/") || file.startsWith("src/app/"),
  )
)
  throw new Error("The extension must not depend on the application or database layers");

// QuickJS (used to run scripts offline) resolves its WASM files next to itself, so it ships as a package.
const copied = new Set();
async function copyRuntime(name, resolveFrom) {
  if (copied.has(name)) return;
  copied.add(name);
  const require = createRequire(resolveFrom);
  let directory = path.dirname(require.resolve(name));
  while (
    JSON.parse(await readFile(path.join(directory, "package.json"), "utf8").catch(() => "{}")).name !== name
  ) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate runtime package ${name}`);
    directory = parent;
  }
  const manifestPath = path.join(directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const destination = path.join(output, "node_modules", name);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(directory, destination, { recursive: true });
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    await copyRuntime(dependency, manifestPath);
}
await copyRuntime("quickjs-emscripten", path.join(root, "package.json"));
console.log(`Built ${path.relative(root, path.join(output, "extension.js"))}`);
