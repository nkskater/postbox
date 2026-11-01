/**
 * GET /api/admin/audit — the audit log across every workspace. Administrators only.
 *   Filters: actor, action (exact or dotted prefix), kind, entityId, result (ok|denied), from, to, q,
 *            workspaceId, limit (default 50, max 1000), cursor (the `next` of the previous page).
 *   ?export=csv|json downloads every matching event (up to 50,000).
 */
import { exportAudit, listAudit } from "@/server/audit-query";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId") || undefined;
  return exportAudit(url, workspaceId) ?? json(listAudit(url, workspaceId));
});
