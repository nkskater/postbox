import { createScorecard, createScorecardInput, listScorecards } from "@/server/scorecards";
import { route, json, parseBody, HttpError } from "@/server/http";
export const GET = route((req: Request) => {
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId required");
  return json(listScorecards(workspaceId));
});
export const POST = route(async (req: Request) =>
  json(createScorecard(await parseBody(req, createScorecardInput)), 201),
);
