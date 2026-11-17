/**
 * GET /api/backup/snapshot — download a complete, restorable copy of the SQLite database (every
 * table, including accounts, API keys, history and runs), taken with `VACUUM INTO` while Postbox
 * keeps running. Administrators only. The file contains credentials and secrets in plain text.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { requireAdmin } from "@/server/authorize";
import { audit } from "@/server/audit";
import { getSqlite } from "@/server/db";
import { writeSnapshot } from "@/server/db/snapshot";
import { route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route(() => {
  requireAdmin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-db-snapshot-"));
  const file = path.join(dir, "postbox.db");
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    writeSnapshot(getSqlite(), file);
  } catch (error) {
    cleanup();
    throw error;
  }
  audit({ action: "backup.snapshot", entityKind: "backup", meta: { bytes: fs.statSync(file).size } });
  const stream = fs.createReadStream(file);
  stream.on("close", cleanup);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Length": String(fs.statSync(file).size),
      "Content-Disposition": `attachment; filename="postbox-snapshot-${stamp}.db"`,
      "Cache-Control": "no-store",
    },
  });
});
