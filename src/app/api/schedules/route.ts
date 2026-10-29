import { createSchedule, listSchedules, scheduleInput } from "@/server/scheduler";
import { json, parseBody, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route((req: Request) => {
  const url = new URL(req.url);
  return json(listSchedules(requireParam(url, "workspaceId"), url.searchParams.get("folderId")));
});

export const POST = route(async (req: Request) =>
  json(createSchedule(await parseBody(req, scheduleInput)), 201),
);
