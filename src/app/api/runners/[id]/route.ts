import { deleteRunner, getRunner, runnerPatch, updateRunner } from "@/server/runners";
import { json, parseBody, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_req: Request, c: Context) => json(getRunner((await c.params).id)));
export const PATCH = route(async (req: Request, c: Context) =>
  json(updateRunner((await c.params).id, await parseBody(req, runnerPatch))),
);
export const DELETE = route(async (_req: Request, c: Context) => json(deleteRunner((await c.params).id)));
