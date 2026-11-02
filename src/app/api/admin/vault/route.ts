/** GET /api/admin/vault — where the vault's key comes from and how many secrets use each key. Administrators only; no key material. */
import { json, route } from "@/server/http";
import { vaultStatus } from "@/server/vault";

export const dynamic = "force-dynamic";

export const GET = route(() => json(vaultStatus()));
