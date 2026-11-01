/**
 * GET  /api/grpc/definitions?workspaceId=… — shared .proto sets of a workspace (without files).
 * POST /api/grpc/definitions — create one: { workspaceId, name, description?, files }. The files are
 *      validated (parsed, imports resolved, types linked) before anything is saved.
 */
import { createDefinition, definitionCreateSchema, listDefinitions } from "@/server/grpc-definitions";
import { json, parseBody, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => json(listDefinitions(requireParam(req.url, "workspaceId"))));

export const POST = route(async (req: Request) =>
  json(createDefinition(await parseBody(req, definitionCreateSchema)), 201),
);
