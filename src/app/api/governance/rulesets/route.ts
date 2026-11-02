import { listRuleSets, createRuleSet, createRuleSetInput } from "@/server/governance";
import { json, route, parseBody, HttpError } from "@/server/http";
export const GET = route((req: Request) => {
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId required");
  return json(listRuleSets(workspaceId));
});
export const POST = route(async (req: Request) =>
  json(createRuleSet(await parseBody(req, createRuleSetInput)), 201),
);
