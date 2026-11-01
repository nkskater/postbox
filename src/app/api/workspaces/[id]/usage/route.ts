/**
 * GET /api/workspaces/:id/usage — this workspace's usage and quota status over a period (default: this
 * month, UTC). Workspace owners and administrators. ?export=csv|json downloads it.
 */
import { json, route } from "@/server/http";
import { getSqlite } from "@/server/db";
import { exportUsage, oneWorkspaceUsage } from "@/server/usage-query";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const url = new URL(req.url);
  const name =
    (getSqlite().prepare("SELECT name FROM workspaces WHERE id = ?").get(id) as { name: string } | undefined)
      ?.name ?? "";
  const data = oneWorkspaceUsage(url, id, name);
  return (
    exportUsage(url, [data.row], data.from, data.to) ??
    json({ from: data.from, to: data.to, lines: data.row.lines, alerts: data.alerts })
  );
});
