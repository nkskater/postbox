/**
 * GET /api/runs/compare?workspaceId=&baselineId=&candidateId=&folderId=
 * Compare two historical collection runs to identify regressions, recoveries,
 * status changes, added/missing executions, and timing deltas without re-running.
 */
import * as repo from "@/server/repo";
import { compareRuns } from "@/server/runs";
import { json, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => {
  const url = new URL(req.url);
  const workspaceId = requireParam(url, "workspaceId");
  const baselineId = requireParam(url, "baselineId");
  const candidateId = requireParam(url, "candidateId");
  const folderId = url.searchParams.get("folderId");
  repo.requireWorkspace(workspaceId);
  if (folderId) {
    repo.requireFolderIn(workspaceId, folderId);
  }
  return json(compareRuns({ workspaceId, baselineId, candidateId, folderId }));
});
