import { z } from "zod";
import { createSession, listSessions, sessionInput } from "@/server/capture";
import { json, parseBody, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET /api/capture/sessions?workspaceId= — recording sessions (never their tokens). */
export const GET = route((req: Request) => json(listSessions(requireParam(req.url, "workspaceId"))));

/** POST creates a session; the response is the only one that contains its relay path. */
export const POST = route(async (req: Request) => {
  const { workspaceId, ...rest } = await parseBody(req, z.looseObject({ workspaceId: z.string().min(1) }));
  return json(createSession(workspaceId, sessionInput.parse(rest)), 201);
});
