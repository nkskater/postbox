/** GET /api/broker/grants?workspaceId=&apiId= — access grants. Owners see all; everyone else sees their own. */
import { json, requireParam, route } from "@/server/http";
import { listGrants } from "@/server/broker";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => {
  const url = new URL(req.url);
  return json(listGrants(requireParam(url, "workspaceId"), url.searchParams.get("apiId") ?? undefined));
});
