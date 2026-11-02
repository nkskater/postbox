import { getMonitor, updateMonitor, deleteMonitor, monitorPatch } from "@/server/monitors";
import { json, parseBody, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (req: Request, c: Context) => {
  const p = new URL(req.url).searchParams;
  return json(getMonitor((await c.params).id, Number(p.get("hours") ?? 168), p.get("before") ?? undefined));
});
export const PATCH = route(async (req: Request, c: Context) =>
  json(updateMonitor((await c.params).id, await parseBody(req, monitorPatch))),
);
export const DELETE = route(async (_req: Request, c: Context) => json(deleteMonitor((await c.params).id)));
