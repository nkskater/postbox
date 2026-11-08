import { authenticateRunner, heartbeatJob } from "@/server/runners";
import { json, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const POST = route(async (req: Request, c: Context) =>
  json(heartbeatJob(authenticateRunner(req), (await c.params).id)),
);
