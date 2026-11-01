/** Shared by the admin and workspace audit routes: parse filters, page results, export. */
import { auditToCsv } from "@/core/audit";
import { HttpError } from "./errors";
import { audit, parseCursor, queryAudit, toAuditRow, type AuditEvent, type AuditFilter } from "./audit";

const EXPORT_LIMIT = 50_000;

export const timeParam = (value: string | null, name: string): number | undefined => {
  if (!value) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms))
    throw new HttpError(400, `"${name}" must be a date or a timestamp in milliseconds`);
  return ms;
};

export function filterFrom(url: URL, workspaceId?: string): AuditFilter {
  const q = url.searchParams;
  const limit = Number(q.get("limit") ?? 50);
  return {
    workspaceId,
    actor: q.get("actor") || undefined,
    action: q.get("action") || undefined,
    entityKind: q.get("kind") || undefined,
    entityId: q.get("entityId") || undefined,
    result: q.get("result") || undefined,
    from: timeParam(q.get("from"), "from"),
    to: timeParam(q.get("to"), "to"),
    q: q.get("q") || undefined,
    limit: Number.isFinite(limit) ? limit : 50,
    cursor: parseCursor(q.get("cursor")),
  };
}

export function listAudit(url: URL, workspaceId?: string) {
  return queryAudit(filterFrom(url, workspaceId));
}

/** `?export=csv` or `?export=json`: every matching event (up to 50,000) as a download. */
export function exportAudit(url: URL, workspaceId?: string): Response | null {
  const format = url.searchParams.get("export");
  if (!format) return null;
  if (format !== "csv" && format !== "json") throw new HttpError(400, 'export must be "csv" or "json"');
  const filter = { ...filterFrom(url, workspaceId), limit: 1000, cursor: undefined };
  const events: AuditEvent[] = [];
  for (;;) {
    const page = queryAudit({
      ...filter,
      cursor: parseCursor(events.length ? `${events.at(-1)!.at}:${events.at(-1)!.id}` : null),
    });
    events.push(...page.events);
    if (!page.next || events.length >= EXPORT_LIMIT) break;
  }
  audit({
    action: "audit.export",
    entityKind: "other",
    workspaceId: workspaceId ?? null,
    meta: { format, events: events.length },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const body = format === "csv" ? auditToCsv(events.map(toAuditRow)) : JSON.stringify(events);
  return new Response(body, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="postbox-audit-${stamp}.${format}"`,
      "Cache-Control": "no-store",
    },
  });
}
