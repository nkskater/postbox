import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { listMembers, setMember } from "@/server/authorize";

type Ctx = { params: Promise<{ id: string }> };
export const GET = route(async (_req: Request, { params }: Ctx) => json(listMembers((await params).id)));
export const PUT = route(async (req: Request, { params }: Ctx) => {
  const input = await parseBody(
    req,
    z.object({ username: z.string().min(1), role: z.enum(["owner", "editor", "viewer"]) }),
  );
  const { id } = await params;
  setMember(id, input.username, input.role);
  return json(listMembers(id));
});
export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const { username } = await parseBody(req, z.object({ username: z.string().min(1) }));
  const { id } = await params;
  setMember(id, username, null);
  return json(listMembers(id));
});
