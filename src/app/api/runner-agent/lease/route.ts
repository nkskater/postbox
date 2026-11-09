import { z } from "zod";
import { authenticateRunner, leaseJob } from "@/server/runners";
import { json, parseBody, route } from "@/server/http";
const body = z.object({ version: z.string().max(40).optional() }).strict();
/** POST /api/runner-agent/lease — a runner asks for its next check; also its heartbeat. 204 when idle. */
export const POST = route(async (req: Request) => {
  const runner = authenticateRunner(req);
  const { version } = await parseBody(req, body);
  const job = leaseJob(runner, version ?? null);
  return job ? json(job) : new Response(null, { status: 204 });
});
