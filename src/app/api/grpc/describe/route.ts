/**
 * POST /api/grpc/describe — list the services and methods in a set of .proto sources, given
 * either as `protos` or as a shared `definitionId` of the workspace (import resolution is
 * limited to the supplied files and well-known types). No network access happens here.
 */
import { z } from "zod";
import { describeServices, loadProtoRoot, MAX_PROTO_FILES, ProtoError } from "@/core/grpc/proto";
import { definitionFiles } from "@/server/grpc-definitions";
import { HttpError, json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().min(1),
  protos: z.record(z.string().min(1).max(256), z.string().max(1_048_576)).optional(),
  definitionId: z.string().min(1).max(64).optional(),
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  const protos = input.definitionId ? definitionFiles(input.workspaceId, input.definitionId) : input.protos;
  if (!protos) throw new HttpError(400, "Provide protos or a definitionId");
  if (Object.keys(protos).length > MAX_PROTO_FILES)
    throw new HttpError(400, `At most ${MAX_PROTO_FILES} proto files are allowed`);
  try {
    return json({ services: describeServices(loadProtoRoot(protos)) });
  } catch (err) {
    if (err instanceof ProtoError) throw new HttpError(400, err.message);
    throw err;
  }
});
