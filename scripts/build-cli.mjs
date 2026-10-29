import { build } from "esbuild";
import { chmod, cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
await build({
  absWorkingDir: root,
  entryPoints: ["src/cli/index.ts"],
  outfile: path.join(output, "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["quickjs-emscripten"],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  metafile: true,
}).then((result) => {
  if (
    Object.keys(result.metafile.inputs).some(
      (file) => file.startsWith("src/server/") || file.startsWith("src/app/"),
    )
  ) {
    throw new Error("CLI must not depend on the application or database layers");
  }
});

// Keep QuickJS packages intact: its dynamic loaders resolve adjacent WASM files.
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
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyRuntime(dependency, manifestPath);
  }
}
await copyRuntime("quickjs-emscripten", path.join(root, "package.json"));
await chmod(path.join(output, "cli.mjs"), 0o755);
