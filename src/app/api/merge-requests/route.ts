import { listMergeRequests } from "@/server/forks";
import { json, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET ?workspaceId=[&status=open|merged|closed] — requests to review in, or proposed from, a workspace. */
export const GET = route((req: Request) => {
  const url = new URL(req.url);
  return json(
    listMergeRequests(requireParam(url, "workspaceId"), url.searchParams.get("status") ?? undefined),
  );
});
