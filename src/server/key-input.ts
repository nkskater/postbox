import { z } from "zod";
import { KEY_SCOPES } from "@/core/scopes";

/** Options shared by every route that issues an API key. */
export const keyOptionsSchema = z.object({
  name: z.string().max(100),
  scope: z.enum(KEY_SCOPES as [string, ...string[]]).default("full") as unknown as z.ZodType<
    (typeof KEY_SCOPES)[number]
  >,
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
  /** Requests per minute allowed for this key; omit or null for unlimited. */
  rateLimitPerMinute: z.number().int().min(1).max(100_000).nullish(),
});

export const rotateInput = z.object({ graceMinutes: z.number().int().min(0).max(43_200).optional() });

type Rotated = {
  token: string;
  info: unknown;
  retiredAt: number;
};
/** The new key (shown once), plus when the old one stops working. */
export const rotateResponse = (r: Rotated) => ({
  ...(r.info as object),
  token: r.token,
  previousKeyEndsAt: r.retiredAt,
});
