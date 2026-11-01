/**
 * GET /api/admin/outbound/policy — the active host allow/deny rules (from PROXY_ALLOW_HOSTS,
 * PROXY_DENY_HOSTS and PROXY_ALLOW_SOCKETS), the proxy, and how the rules apply through a proxy.
 * Read-only; administrators only.
 */
import { json, route } from "@/server/http";
import { getPolicy } from "@/server/context";
import { describePolicy } from "@/server/outbound";

export const dynamic = "force-dynamic";

export const GET = route(() => json(describePolicy(getPolicy())));
