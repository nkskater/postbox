import { z } from "zod";
import { normalizeBundlePath } from "../convert/openapi-references";
export const SPEC_LIMITS = {
  files: 30,
  bytes: 1024 * 1024,
  totalBytes: 3 * 1024 * 1024,
  depth: 60,
  nodes: 50000,
  diagnostics: 200,
  symbols: 2000,
  versions: 100,
  specifications: 100,
} as const;
export const specificationFormat = z.enum(["openapi", "asyncapi", "protobuf", "graphql", "smithy"]);
export type SpecificationFormat = z.infer<typeof specificationFormat>;
const bundlePath = z
  .string()
  .min(1)
  .max(200)
  .transform((value, ctx) => {
    try {
      return normalizeBundlePath(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Use a relative bundle path without parent segments" });
      return z.NEVER;
    }
  });
export const specificationFile = z
  .object({ path: bundlePath, content: z.string().max(SPEC_LIMITS.bytes) })
  .strict();
export const specificationSource = z
  .object({
    format: specificationFormat,
    entrypoint: bundlePath,
    files: z.array(specificationFile).min(1).max(SPEC_LIMITS.files),
  })
  .strict();
export type SpecificationSource = z.infer<typeof specificationSource>;
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}
export interface SpecificationDiagnostic extends SourceLocation {
  severity: "error" | "warning";
  code: string;
  message: string;
}
export interface SpecificationReference extends SourceLocation {
  target: string;
  resolved: boolean;
}
export interface SpecificationSymbol extends SourceLocation {
  name: string;
  kind: string;
  description: string;
  detail: string;
}
export interface SpecificationAnalysis {
  valid: boolean;
  diagnostics: SpecificationDiagnostic[];
  references: SpecificationReference[];
  symbols: SpecificationSymbol[];
  title: string;
  description: string;
  truncated: boolean;
}
