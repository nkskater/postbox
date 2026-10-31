/**
 * POST /api/grpc/describe — list the services and methods in a set of .proto sources
 * (import resolution is limited to the supplied files and well-known types). No network
 * access happens here.
 */
import { z } from "zod";
import { describeServices, loadProtoRoot, MAX_PROTO_FILES, ProtoError } from "@/core/grpc/proto";
import { HttpError, json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().min(1),
  protos: z.record(z.string().min(1).max(256), z.string().max(1_048_576)),
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  if (Object.keys(input.protos).length > MAX_PROTO_FILES)
    throw new HttpError(400, `At most ${MAX_PROTO_FILES} proto files are allowed`);
  try {
    return json({ services: describeServices(loadProtoRoot(input.protos)) });
  } catch (err) {
    if (err instanceof ProtoError) throw new HttpError(400, err.message);
    throw err;
  }
});
