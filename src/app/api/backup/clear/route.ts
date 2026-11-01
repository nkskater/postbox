/**
 * POST /api/backup/clear — delete history, cookies or run results for one workspace or all of
 * them: { target: "history" | "cookies" | "runs", workspaceId? }. Administrators only.
 */
import { z } from "zod";
import { clearData } from "@/server/backup";
import { getDb } from "@/server/db";
import { requireAdmin } from "@/server/authorize";
import { audit } from "@/server/audit";
import { json, parseBody, route } from "@/server/http";
import * as repo from "@/server/repo";

export const dynamic = "force-dynamic";

const schema = z.object({
  target: z.enum(["history", "cookies", "runs"]),
  workspaceId: z.string().min(1).optional(),
});

export const POST = route(async (req: Request) => {
  requireAdmin();
  const input = await parseBody(req, schema);
  if (input.workspaceId) repo.requireWorkspace(input.workspaceId);
  const removed = clearData(getDb(), input.target, input.workspaceId ? [input.workspaceId] : undefined);
  audit({
    action: `data.clear.${input.target}`,
    entityKind: "other",
    workspaceId: input.workspaceId ?? null,
    meta: { removed, scope: input.workspaceId ? "workspace" : "all workspaces" },
  });
  return json({ ok: true, removed });
});
