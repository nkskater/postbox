import { z } from "zod";
import { packageCreateSchema } from "@/core/packages/model";
import { listScriptPackages, createScriptPackage, approvedLibraries } from "@/server/script-packages";
import { json, parseBody, route, requireParam } from "@/server/http";
export const GET = route((request: Request) =>
  json({
    packages: listScriptPackages(requireParam(request.url, "workspaceId")),
    libraries: approvedLibraries(),
  }),
);
export const POST = route(async (request: Request) => {
  const input = await parseBody(request, z.object({ workspaceId: z.string() }).and(packageCreateSchema));
  return json(createScriptPackage(input.workspaceId, input), 201);
});
