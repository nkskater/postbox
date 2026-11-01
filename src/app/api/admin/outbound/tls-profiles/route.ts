/**
 * GET  /api/admin/outbound/tls-profiles — saved profiles (certificates described, private keys never returned).
 * POST /api/admin/outbound/tls-profiles { name, hosts, ca?, cert?, key?, passphrase? } — create one.
 *      `hosts` are `host`, `*.domain` or `host:port`. `ca` is added to the system roots; `cert` + `key`
 *      are presented for mutual TLS. Administrators only.
 */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { createProfile, listProfiles } from "@/server/outbound";

export const dynamic = "force-dynamic";

const profileBody = z
  .object({
    name: z.string().min(1).max(80),
    hosts: z.array(z.string().min(1).max(300)).min(1).max(50),
    ca: z.string().max(131072).optional(),
    cert: z.string().max(131072).optional(),
    key: z.string().max(131072).optional(),
    passphrase: z.string().max(1024).optional(),
  })
  .strict();

export const GET = route(() => json(listProfiles()));

export const POST = route(async (req: Request) =>
  json(createProfile(await parseBody(req, profileBody)), 201),
);
