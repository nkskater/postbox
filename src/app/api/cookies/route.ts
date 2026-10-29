import { z } from "zod";
import * as repo from "@/server/repo";
import { json, parseBody, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => json(repo.listCookies(requireParam(req.url, "workspaceId"))));

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      workspaceId: z.string(),
      cookie: z.object({
        name: z.string().min(1),
        value: z.string(),
        domain: z.string().min(1),
        path: z.string().default("/"),
        expires: z.number().nullish(),
        httpOnly: z.boolean().default(false),
        secure: z.boolean().default(false),
      }),
    }),
  );
  const list = repo
    .listCookies(input.workspaceId)
    .filter(
      (c) =>
        !(c.domain === input.cookie.domain && c.path === input.cookie.path && c.name === input.cookie.name),
    );
  repo.saveCookies(input.workspaceId, [...list, { ...input.cookie, hostOnly: true }]);
  return json(repo.listCookies(input.workspaceId));
});

export const DELETE = route((req: Request) => {
  repo.clearCookies(requireParam(req.url, "workspaceId"));
  return json({ ok: true });
});
