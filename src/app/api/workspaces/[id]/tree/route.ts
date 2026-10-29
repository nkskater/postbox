import * as repo from "@/server/repo";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Sidebar listing: folders + request summaries for the workspace. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  return json(repo.getTreeSummary(id));
});
