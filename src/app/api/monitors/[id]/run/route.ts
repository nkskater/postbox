import { runMonitor } from "@/server/monitors";
import { json, route } from "@/server/http";
export const POST = route(async (_req: Request, c: { params: Promise<{ id: string }> }) =>
  json(await runMonitor((await c.params).id), 202),
);
