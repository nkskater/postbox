/** GET /api/backup/info — database file path and size, reclaimable space and record counts. Administrators only. */
import { databaseInfo } from "@/server/backup";
import { getDb, getSqlite, resolveDatabasePath } from "@/server/db";
import { requireAdmin } from "@/server/authorize";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route(() => {
  requireAdmin();
  return json(databaseInfo(getDb(), getSqlite(), resolveDatabasePath()));
});
