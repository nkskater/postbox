/** GET /api/load-runs/:id/export?format=json|csv|junit — download a load-test report. */
import { renderLoadReport, type LoadReportFormat } from "@/core/load/report";
import { getLoadRun } from "@/server/load";
import { HttpError } from "@/server/errors";
import { route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const run = getLoadRun((await params).id);
  if (!run.result) throw new HttpError(409, "This test has no result yet");
  const format = (new URL(req.url).searchParams.get("format") ?? "json") as LoadReportFormat;
  if (!["json", "csv", "junit"].includes(format))
    throw new HttpError(400, "format must be json, csv or junit");
  const { body, contentType, ext } = renderLoadReport(
    {
      id: run.id,
      name: run.name,
      status: run.status,
      profile: run.profile,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? run.startedAt,
      ...run.result,
    },
    format,
  );
  const file = `${run.name.replace(/[^\w.-]+/g, "_")}-load-${new Date(run.startedAt).toISOString().slice(0, 19).replace(/:/g, "")}.${ext}`;
  return new Response(body, {
    headers: {
      "Content-Type": `${contentType}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${file}"`,
    },
  });
});
