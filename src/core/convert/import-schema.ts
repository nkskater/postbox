import { z } from "zod";

const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  }, "Use an HTTP(S) URL without embedded credentials");
export const importSourceFields = {
  content: z.string().optional().describe("Raw JSON, YAML or SoapUI XML content"),
  url: httpUrl.optional().describe("Fetch the root document from this URL"),
  files: z
    .array(z.object({ path: z.string().min(1).max(2048), content: z.string() }))
    .min(1)
    .max(100)
    .optional()
    .describe("OpenAPI files with relative paths preserved from the uploaded folder"),
  entrypoint: z.string().min(1).optional().describe("Root OpenAPI file path in files"),
  sourceUrl: httpUrl.optional().describe("Original root document URL for pasted or uploaded OpenAPI files"),
  allowedRefOrigins: z
    .array(
      httpUrl.refine((value) => {
        const url = new URL(value);
        return url.pathname === "/" && !url.search && !url.hash;
      }, "Reference approval must be an origin: scheme, host and optional port"),
    )
    .max(100)
    .optional()
    .describe(
      "Explicitly approved HTTP(S) origins for reference downloads, including redirect destinations; host policy still applies",
    ),
  includeCredentials: z
    .boolean()
    .optional()
    .describe("Include recognized credentials from supported collection formats"),
  preview: z.boolean().optional().describe("Preview OpenAPI or SoapUI counts and diagnostics without saving"),
};
export const importSourceSchema = z.object(importSourceFields).superRefine((value, ctx) => {
  if (!value.content && !value.url && !value.files)
    ctx.addIssue({ code: "custom", message: "content, url or files is required" });
  if (value.files && (value.content !== undefined || value.url !== undefined))
    ctx.addIssue({ code: "custom", message: "Use files separately from content or url" });
  if (value.files && !value.entrypoint)
    ctx.addIssue({ code: "custom", message: "entrypoint is required for a file bundle" });
  if (value.entrypoint && !value.files)
    ctx.addIssue({ code: "custom", message: "entrypoint requires files" });
});
export type ImportSource = z.infer<typeof importSourceSchema>;
