import { createSpecification, createSpecificationInput, listSpecifications } from "@/server/specifications";
import { route, json, parseBody, HttpError } from "@/server/http";
export const GET = route((req: Request) => {
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId required");
  return json(listSpecifications(workspaceId));
});
export const POST = route(async (req: Request) =>
  json(createSpecification(await parseBody(req, createSpecificationInput)), 201),
);
