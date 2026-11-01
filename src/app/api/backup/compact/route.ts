/** POST /api/backup/compact — VACUUM the database to give back free space. Administrators only. */
import { compactDatabase } from "@/server/backup";
import { getSqlite, resolveDatabasePath } from "@/server/db";
import { requireAdmin } from "@/server/authorize";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const POST = route(() => {
  requireAdmin();
  return json(compactDatabase(getSqlite(), resolveDatabasePath()));
});
