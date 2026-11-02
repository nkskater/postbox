/**
 * POST /api/load-runs — start a load test of a collection or folder. The response is a stream of newline-delimited
 * JSON events (queued, start, progress, done). The test keeps running and is stored even if the client disconnects.
 *   { workspaceId, folderId, environmentId?, profile, thresholds?, thinkMs?, timeoutMs?, verifySsl?, dataset?, selectedRequestIds? }
 *   profile: { type: "constant", vus, durationSec }
 *          | { type: "ramp", startVus?, stages: [{ durationSec, target }] }
 *          | { type: "spike", baseVus, spikeVus, durationSec, spikeAtSec, spikeForSec }
 *   thresholds: [{ metric: p50|p90|p95|p99|avg|min|max|errorRate|checkFailRate|rps|requests, op, value, request? }]
 * GET /api/load-runs?workspaceId=&folderId= — recent tests with headline numbers.
 */
import { createEventStream } from "@/server/event-stream";
import { json, parseBody, requireParam, route } from "@/server/http";
import { admitLoadTest, listLoadRuns, loadTestSchema, startLoadTest } from "@/server/load";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => {
  const url = new URL(req.url);
  return json(listLoadRuns(requireParam(url, "workspaceId"), url.searchParams.get("folderId")));
});

export const POST = route(async (req: Request) => {
  // Everything that can be refused with a status code happens before the response becomes a stream.
  const admitted = admitLoadTest(await parseBody(req, loadTestSchema));
  const events = createEventStream();
  void startLoadTest(admitted, { source: "manual", onEvent: events.send })
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
