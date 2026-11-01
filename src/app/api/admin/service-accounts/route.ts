/**
 * GET  /api/admin/service-accounts — service accounts with their active keys (metadata only).
 * POST /api/admin/service-accounts { username, displayName? } — create one. A service account has no
 *      password or sessions; give it workspace roles like a member and issue it keys. Administrators only.
 */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { createServiceAccount, listServiceAccounts, toPublicUser } from "@/server/users";

export const dynamic = "force-dynamic";

export const GET = route((_req: Request) => json(listServiceAccounts()));

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({ username: z.string().max(64), displayName: z.string().max(200).optional() }).strict(),
  );
  return json({ ...toPublicUser(createServiceAccount(input)), tokens: [] }, 201);
});
