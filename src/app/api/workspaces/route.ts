import { z } from "zod";
import * as repo from "@/server/repo";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((_req: Request) => json(repo.ensureDefaultWorkspace()));

export const POST = route(async (req: Request) => {
  const { name } = await parseBody(req, z.object({ name: z.string().min(1).max(200) }));
  return json(repo.createWorkspace(name), 201);
});
