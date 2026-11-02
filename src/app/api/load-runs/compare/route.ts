/** GET /api/load-runs/compare?workspaceId=&base=&head= — how the headline numbers and each request's p95 changed between two tests. */
import { compareLoadRuns } from "@/server/load";
import { json, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => {
  const url = new URL(req.url);
  return json(
    compareLoadRuns(requireParam(url, "workspaceId"), requireParam(url, "base"), requireParam(url, "head")),
  );
});
