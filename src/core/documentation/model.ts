import { z } from "zod";
import type { FolderNode, Variable } from "../types";
export const DOCUMENTATION_LIMITS = {
  bytes: 2 * 1024 * 1024,
  requests: 500,
  depth: 32,
  text: 8192,
  body: 32768,
};
export interface DocumentationSnapshot {
  root: FolderNode;
  variables: Pick<Variable, "key" | "type" | "enabled">[];
  authTypes: Record<string, string>;
  omissions: string[];
}
export const publicationInputSchema = z.object({
  visibility: z.enum(["private", "public"]),
  title: z.string().trim().min(1).max(300).optional(),
  expectedRevision: z.number().int().nonnegative(),
  customOrigin: z
    .string()
    .max(2048)
    .default("")
    .superRefine((value, ctx) => {
      if (!value) return;
      try {
        const url = new URL(value);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Use an HTTP(S) origin, without credentials, path, query or fragment",
        });
      }
    }),
});
export type PublicationInput = z.input<typeof publicationInputSchema>;
