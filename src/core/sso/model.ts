import { z } from "zod";

const endpoint = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.hash &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    );
  }, "Use HTTPS (HTTP is allowed only on loopback)");
const common = {
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(false),
  origin: endpoint.refine((v) => new URL(v).origin === v, "Use an origin without a path or trailing slash"),
  autoProvision: z.boolean().default(false),
  sessionSeconds: z.number().int().min(60).max(86400).default(3600),
  displayNameClaim: z.string().min(1).max(200).default("name"),
  groupsClaim: z.string().min(1).max(200).default("groups"),
  roles: z
    .array(
      z
        .object({
          workspaceId: z.string().min(1),
          group: z.string().min(1).max(200),
          role: z.enum(["viewer", "editor", "owner"]),
        })
        .strict(),
    )
    .max(100)
    .default([]),
};
export const providerInput = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...common,
        kind: z.literal("oidc"),
        issuer: endpoint,
        clientId: z.string().min(1).max(500),
        clientAuth: z.enum(["basic", "post", "none"]).default("basic"),
        algorithm: z.enum(["RS256", "PS256", "ES256", "EdDSA"]).default("RS256"),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("saml"),
        entryPoint: endpoint,
        idpIssuer: z.string().min(1).max(2048),
        entityId: z.string().min(1).max(2048),
        idpCert: z.string().min(100).max(20000),
        publicCert: z.string().max(20000).optional(),
      })
      .strict(),
  ])
  .refine(
    (v) => v.kind !== "saml" || v.origin.startsWith("https:"),
    "SAML requires HTTPS for cross-site POST cookies",
  );
export type Provider = z.infer<typeof providerInput>;
export const secretInput = z
  .object({ clientSecret: z.string().max(16000).optional(), privateKey: z.string().max(16000).optional() })
  .strict();
export type ProviderSecrets = z.infer<typeof secretInput>;
export function safeNext(value: unknown): string {
  return typeof value === "string" && /^\/(?!\/)/.test(value) && !/[\\\x00-\x20]/.test(value) ? value : "/";
}
export interface VerifiedIdentity {
  subject: string;
  claims: Record<string, unknown>;
  expiresAt: number;
}
