import { z } from "zod";
export const PACKAGE_LIMITS = {
  sourceBytes: 64 * 1024,
  workspaceBytes: 2 * 1024 * 1024,
  versions: 128,
  cacheEntries: 128,
};
export const packageNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, "Use a lowercase package name with letters, numbers and hyphens");
export const packageContentSchema = z
  .object({ source: z.string().min(1).max(PACKAGE_LIMITS.sourceBytes), approved: z.boolean().default(false) })
  .refine(
    (v) => new TextEncoder().encode(v.source).byteLength <= PACKAGE_LIMITS.sourceBytes,
    "Package source exceeds 64 KiB",
  );
export const packageCreateSchema = z.object({
  name: packageNameSchema,
  description: z.string().max(10000).default(""),
  source: z.string().min(1).max(PACKAGE_LIMITS.sourceBytes),
  approved: z.boolean().default(false),
});
export const packageRevisionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  source: z.string().min(1).max(PACKAGE_LIMITS.sourceBytes),
  approved: z.boolean().default(false),
});
export const packagePatchSchema = z.object({ description: z.string().max(10000) });
export interface ModuleDefinition {
  source: string;
  hash: string;
}
export interface ModuleSnapshot {
  modules: Record<string, ModuleDefinition>;
  aliases: Record<string, string>;
}
export interface ScriptPackageSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  latestVersion: number;
  approved: boolean;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
  canApprove: boolean;
}
export interface ScriptPackageVersion {
  version: number;
  hash: string;
  approved: boolean;
  createdAt: number;
  createdBy: string | null;
  approvedBy: string | null;
}
export interface ScriptPackageDocument extends ScriptPackageSummary {
  version: number;
  source: string;
  hash: string;
  versions: ScriptPackageVersion[];
  references: { id: string; name: string; kind: "request" | "folder" | "package" }[];
}
