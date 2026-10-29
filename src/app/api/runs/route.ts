/**
 * POST /api/runs — start a collection/folder run. The response is a stream of
 * newline-delimited JSON events (start, iteration, request, result, log, done).
 * GET  /api/runs?workspaceId=&folderId= — list recent runs.
 */
import { z } from "zod";
import { startRun, listRuns } from "@/server/runs";
import { json, parseBody, requireParam, route } from "@/server/http";
import { createEventStream } from "@/server/event-stream";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string(),
  folderId: z.string(),
  environmentId: z.string().nullish(),
  options: z
    .object({
      iterations: z.number().int().min(0).max(100000).optional(),
      delayMs: z.number().int().min(0).max(600000).optional(),
      stopOnFailure: z.boolean().optional(),
      timeoutMs: z.number().int().min(100).optional(),
      verifySsl: z.boolean().optional(),
      persistVariables: z.boolean().optional(),
    })
    .optional(),
  data: z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), z.string())) }).nullish(),
  selectedRequestIds: z.array(z.string()).nullish(),
});

export const GET = route((req: Request) => {
  const url = new URL(req.url);
  return json(listRuns(requireParam(url, "workspaceId"), url.searchParams.get("folderId")));
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  const events = createEventStream();
  // Runs persist results even if the subscriber disconnects or falls behind.
  void startRun({
    workspaceId: input.workspaceId,
    folderId: input.folderId,
    environmentId: input.environmentId ?? null,
    options: input.options,
    data: input.data,
    selectedRequestIds: input.selectedRequestIds,
    retainResults: false,
    onEvent: events.send,
  })
    .catch((err) => events.send({ type: "error", error: (err as Error).message }))
    .finally(events.close);
  return new Response(events.stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
});
