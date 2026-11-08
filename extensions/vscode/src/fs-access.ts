import fs from "node:fs/promises";
import path from "node:path";
import type { FileAccess } from "./bridge/offline";

const SKIP = new Set([".git", "node_modules", ".next", "dist", ".vscode"]);
/** Reads the real file system for offline mode; skips dependency and build directories. */
export const nodeFiles: FileAccess = {
  async listFiles(root) {
    const out: string[] = [];
    const walk = async (dir: string, rel: string, depth: number) => {
      if (depth > 8 || out.length >= 20_000) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
        const next = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), next, depth + 1);
        else if (entry.isFile()) out.push(next);
      }
    };
    await walk(root, "", 0);
    return out.sort();
  },
  read: (file) => fs.readFile(file, "utf8"),
};
