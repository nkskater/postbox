/**
 * GET    /api/admin/outbound/tls-profiles/:id
 * PATCH  /api/admin/outbound/tls-profiles/:id { name?, hosts?, ca?, cert?, key?, passphrase? } — omitted
 *        fields keep their value; an empty string removes a certificate, key or passphrase.
 * DELETE /api/admin/outbound/tls-profiles/:id
 * Administrators only.
 */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { deleteProfile, getProfile, updateProfile } from "@/server/outbound";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchBody = z
  .object({
    name: z.string().min(1).max(80).optional(),
    hosts: z.array(z.string().min(1).max(300)).min(1).max(50).optional(),
    ca: z.string().max(131072).optional(),
    cert: z.string().max(131072).optional(),
    key: z.string().max(131072).optional(),
    passphrase: z.string().max(1024).optional(),
  })
  .strict();

export const GET = route(async (_req: Request, { params }: Ctx) => json(getProfile((await params).id)));

export const PATCH = route(async (req: Request, { params }: Ctx) =>
  json(updateProfile((await params).id, await parseBody(req, patchBody))),
);

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  deleteProfile((await params).id);
  return json({ deleted: true });
});
