import { USAGE_METRICS, periodEnd, periodStart, usageToCsv, type UsageMetric } from "@/core/usage";
import { timeParam } from "./audit-query";
import { audit } from "./audit";
import { HttpError } from "./errors";
import { allWorkspaceUsage, listAlerts, workspaceUsage, type WorkspaceUsageRow } from "./usage";

/** `from` and `to` default to the current month (UTC). */
export function windowFrom(url: URL): { from: number; to: number } {
  const now = Date.now();
  const from = timeParam(url.searchParams.get("from"), "from") ?? periodStart("month", now);
  const to = timeParam(url.searchParams.get("to"), "to") ?? periodEnd("month", now);
  if (to <= from) throw new HttpError(400, '"to" must be after "from"');
  return { from, to };
}

export function exportUsage(url: URL, rows: WorkspaceUsageRow[], from: number, to: number): Response | null {
  const format = url.searchParams.get("export");
  if (!format) return null;
  if (format !== "csv" && format !== "json") throw new HttpError(400, 'export must be "csv" or "json"');
  audit({ action: "usage.export", entityKind: "other", meta: { format, from, to } });
  const flat = rows.flatMap((w) =>
    w.lines.map((l) => ({
      workspaceId: w.workspaceId,
      workspaceName: w.workspaceName,
      metric: l.metric as UsageMetric,
      unit: USAGE_METRICS[l.metric].unit,
      used: l.used,
    })),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(
    format === "csv" ? usageToCsv(from, to, flat) : JSON.stringify({ from, to, workspaces: rows }),
    {
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="postbox-usage-${stamp}.${format}"`,
        "Cache-Control": "no-store",
      },
    },
  );
}

export function adminUsage(url: URL) {
  const { from, to } = windowFrom(url);
  const workspaces = allWorkspaceUsage(from, to);
  return { from, to, workspaces, alerts: listAlerts({ limit: 50 }), rows: workspaces };
}

export function oneWorkspaceUsage(url: URL, workspaceId: string, name = "") {
  const { from, to } = windowFrom(url);
  const row: WorkspaceUsageRow = {
    workspaceId,
    workspaceName: name,
    deleted: false,
    lines: workspaceUsage(workspaceId, from, to),
  };
  return { from, to, row, alerts: listAlerts({ workspaceId, limit: 50 }) };
}
