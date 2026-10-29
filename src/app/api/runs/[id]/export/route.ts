/** GET /api/runs/:id/export?format=json|junit|html — download a run report. */
import { renderReport, type ReportFormat } from "@/core/runner/reporters";
import { getRunSummary } from "@/server/runs";
import { notFound, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const run = getRunSummary(id);
  if (!run) throw notFound("Run");
  const format = (new URL(req.url).searchParams.get("format") ?? "json") as ReportFormat;
  const { body, contentType, ext } = renderReport(
    run,
    ["json", "junit", "html"].includes(format) ? format : "json",
  );
  const file = `${run.name.replace(/[^\w.-]+/g, "_")}-${new Date(run.startedAt).toISOString().slice(0, 19).replace(/:/g, "")}.${ext}`;
  return new Response(body, {
    headers: {
      "Content-Type": `${contentType}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${file}"`,
    },
  });
});
