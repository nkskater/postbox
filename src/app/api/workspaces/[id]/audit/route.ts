/**
 * GET /api/workspaces/:id/audit — changes made in one workspace. Workspace owners (and administrators).
 * Same filters and export as /api/admin/audit.
 */
import { exportAudit, listAudit } from "@/server/audit-query";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const url = new URL(req.url);
  return exportAudit(url, id) ?? json(listAudit(url, id));
});
