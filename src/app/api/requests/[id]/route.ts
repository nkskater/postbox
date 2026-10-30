import type { RequestDef } from "@/core/types";
import * as repo from "@/server/repo";
import { json, notFound, parseBody, route } from "@/server/http";
import { requestInputSchema } from "@/core/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const r = repo.getRequest(id);
  if (!r) throw notFound("Request");
  return json(r);
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const existing = repo.getRequest(id);
  if (!existing) throw notFound("Request");
  const { id: _id, settings, ...rest } = await parseBody(req, requestInputSchema);
  const patch: Partial<RequestDef> = settings
    ? { ...rest, settings: { ...existing.settings, ...settings } }
    : rest;
  return json(repo.updateRequest(id, patch));
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  repo.deleteRequest(id);
  return json({ ok: true });
});
