/**
 * GET    /api/grpc/definitions/:id — one definition with its files and the requests that use it.
 * PATCH  /api/grpc/definitions/:id — change name, description and/or files (revision increases with the files).
 * DELETE /api/grpc/definitions/:id — refused with 409 while requests still use it.
 */
import {
  definitionPatchSchema,
  deleteDefinition,
  getDefinition,
  updateDefinition,
} from "@/server/grpc-definitions";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, c: Context) => json(getDefinition((await c.params).id)));
export const PATCH = route(async (req: Request, c: Context) =>
  json(updateDefinition((await c.params).id, await parseBody(req, definitionPatchSchema))),
);
export const DELETE = route(async (_req: Request, c: Context) => json(deleteDefinition((await c.params).id)));
