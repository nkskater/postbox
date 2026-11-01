/**
 * GET /api/admin/usage — usage of every workspace over a period (default: this month, UTC), with the
 * latest quota alerts. Query: from, to (dates or milliseconds). ?export=csv|json downloads it.
 * Administrators only.
 */
import { json, route } from "@/server/http";
import { adminUsage, exportUsage } from "@/server/usage-query";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => {
  const url = new URL(req.url);
  const data = adminUsage(url);
  return (
    exportUsage(url, data.workspaces, data.from, data.to) ??
    json({ from: data.from, to: data.to, workspaces: data.workspaces, alerts: data.alerts })
  );
});
