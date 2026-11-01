import { z } from "zod";

export type JsonSchema = boolean | Record<string, unknown>;
export const jsonSchema = z.union([z.boolean(), z.record(z.string(), z.unknown())]);
export const contractSchema = z
  .object({
    pathTemplate: z.string().max(2000).optional(),
    parameters: z
      .array(
        z.object({
          in: z.enum(["query", "header", "path"]),
          name: z.string().min(1).max(200),
          required: z.boolean().default(false),
          description: z.string().max(2000).default(""),
          schema: jsonSchema,
        }),
      )
      .max(100)
      .default([]),
    requestBody: jsonSchema.optional(),
    responseBody: jsonSchema.optional(),
    responseStatus: z.array(z.number().int().min(100).max(599)).max(100).optional(),
  })
  .superRefine((contract, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(contract)).length > 65536)
      ctx.addIssue({ code: "custom", message: "Contract exceeds 64 KiB" });
    if (contract.parameters.some((p) => p.in === "path") && !contract.pathTemplate)
      ctx.addIssue({
        code: "custom",
        message: "Path parameters require pathTemplate, for example /pets/{id}",
      });
    const names = contract.parameters.map(
      (p) => `${p.in}:${p.in === "header" ? p.name.toLowerCase() : p.name}`,
    );
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: "custom", message: "Duplicate parameter declaration" });
  });
export type RequestContract = z.infer<typeof contractSchema>;
export interface ContractDiagnostic {
  location: string;
  status: "passed" | "error" | "deferred";
  message: string;
}
