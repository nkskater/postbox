import { z } from "zod";
import type { RequestDef } from "@/core/types";
import * as repo from "@/server/repo";
import { json, notFound, parseBody, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const r = repo.getRequest(id);
  if (!r) throw notFound("Request");
  return json(r);
});

const allowed = [
  "name",
  "method",
  "url",
  "params",
  "headers",
  "body",
  "auth",
  "preRequestScript",
  "testScript",
  "settings",
  "examples",
  "description",
] as const;

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!repo.getRequest(id)) throw notFound("Request");
  const body = await parseBody(req, z.record(z.string(), z.unknown()));
  const patch: Partial<RequestDef> = {};
  for (const k of allowed) if (k in body) (patch as Record<string, unknown>)[k] = body[k];
  return json(repo.updateRequest(id, patch));
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  repo.deleteRequest(id);
  return json({ ok: true });
});
