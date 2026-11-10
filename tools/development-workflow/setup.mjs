import { readFileSync, existsSync, lstatSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { validateConfig } from "./policy.mjs";

export function setup(root, config) {
  validateConfig(config);
  const marker =
    "Read AGENTS.md and tools/development-workflow/WORKFLOW.md before working. Follow the shared lifecycle and .github/development-workflow.json.";
  // Instruction files stay local and contain pointers only, never duplicate rules.
  const files = ["CLAUDE.md", ".claude/CLAUDE.md", ".agents/rules/development-workflow.md"];
  for (const name of files) {
    const path = resolve(root, name);
    let ancestor = path;
    while (ancestor.startsWith(resolve(root))) {
      if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink())
        throw new Error(`Refusing symlink: ${name}`);
      if (ancestor === resolve(root)) break;
      ancestor = dirname(ancestor);
    }
  }
  for (const name of files) {
    const path = resolve(root, name);
    mkdirSync(dirname(path), { recursive: true });
    if (name.startsWith(".agents/rules/") && !existsSync(path))
      appendFileSync(path, "---\ntrigger: always_on\n---\n");
    if (!existsSync(path) || !readFileSync(path, "utf8").includes(marker))
      appendFileSync(path, `\n${marker}\n`);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(process.argv[2] ?? ".");
  const config = JSON.parse(readFileSync(resolve(root, ".github/development-workflow.json"), "utf8"));
  console.log(`Installed local workflow pointers: ${setup(root, config).join(", ")}`);
}
