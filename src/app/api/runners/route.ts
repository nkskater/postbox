import { createRunner, listRunners, runnerInput } from "@/server/runners";
import { json, parseBody, route, HttpError } from "@/server/http";
export const GET = route((req: Request) => {
  const id = new URL(req.url).searchParams.get("workspaceId");
  if (!id) throw new HttpError(400, "workspaceId required");
  return json(listRunners(id));
});
export const POST = route(async (req: Request) => json(createRunner(await parseBody(req, runnerInput)), 201));
