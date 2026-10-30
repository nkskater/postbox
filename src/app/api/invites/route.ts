import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { createInvite, listInvites } from "@/server/invites";
export const GET = route((req: Request) =>
  json(listInvites(new URL(req.url).searchParams.get("workspaceId"))),
);
export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z
      .object({
        workspaceId: z.string().min(1).nullish(),
        role: z.enum(["owner", "editor", "viewer"]).optional(),
        expiresInHours: z.number().int().min(1).max(168).optional(),
      })
      .strict(),
  );
  return json(createInvite(input), 201);
});
