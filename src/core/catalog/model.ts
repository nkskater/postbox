import { z } from "zod";
export const CATALOG_LIMITS = { workspaceBytes: 16 * 1024 * 1024, versions: 64 };
export const visibilitySchema = z.enum(["private", "team", "public"]);
const metadata = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(2000).default(""),
  tags: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/))
    .max(20)
    .default([]),
  owners: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
  visibility: visibilitySchema,
  expectedRevision: z.number().int().nonnegative(),
};
export const catalogPublishSchema = z.object({
  ...metadata,
  label: z
    .string()
    .max(64)
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
});
export const catalogMetadataSchema = z.object(metadata);
export const catalogSearchSchema = z.object({
  query: z.string().max(200).default(""),
  tag: z.string().max(32).default(""),
  visibility: visibilitySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export const catalogVersionSchema = z.coerce.number().int().positive().optional();
export const catalogImportSchema = z.object({
  workspaceId: z.string().min(1),
  version: z.number().int().positive().optional(),
});
export type CatalogPublishInput = z.input<typeof catalogPublishSchema>;
export type CatalogMetadataInput = z.input<typeof catalogMetadataSchema>;
export type CatalogSearchInput = z.input<typeof catalogSearchSchema>;
