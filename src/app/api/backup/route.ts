/**
 * GET  /api/backup — download a full backup (workspaces, collections, requests, environments,
 *                    variables, datasets, schedules, memberships and instance settings) as JSON.
 *                    `?secrets=omit` scrubs secret values, credentials and secret dataset columns.
 * POST /api/backup — replace all workspace data with an uploaded backup: { backup, confirm: "restore" }.
 *
 * Administrators only. A backup that includes secrets contains credentials in plain text.
 */
import { z } from "zod";
import { BackupError, createBackup, restoreBackup } from "@/server/backup";
import { getDb, getSqlite } from "@/server/db";
import { requireAdmin } from "@/server/authorize";
import { audit } from "@/server/audit";
import { HttpError, json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => {
  requireAdmin();
  const omit = new URL(req.url).searchParams.get("secrets") === "omit";
  const backup = createBackup(getDb(), { includeSecrets: !omit });
  audit({ action: "backup.export", entityKind: "backup", meta: { secretsIncluded: !omit } });
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(backup), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="postbox-backup${omit ? "-no-secrets" : ""}-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
});

const restoreSchema = z.object({
  backup: z.unknown(),
  confirm: z.literal("restore"),
});

export const POST = route(async (req: Request) => {
  requireAdmin();
  const input = await parseBody(req, restoreSchema);
  try {
    const restored = restoreBackup(getDb(), getSqlite(), input.backup);
    audit({ action: "backup.restore", entityKind: "backup", meta: { restored } });
    return json({ ok: true, restored });
  } catch (err) {
    if (err instanceof BackupError) throw new HttpError(400, err.message);
    throw err;
  }
});
