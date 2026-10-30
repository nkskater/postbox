/**
 * Give each test run its own temp directory (tests create SQLite files under
 * os.tmpdir()) and remove it afterwards, so runs never leave data behind.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-vitest-"));
  process.env.TMPDIR = dir;
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
