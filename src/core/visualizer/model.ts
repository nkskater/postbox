import { z } from "zod";
export const VISUALIZER_LIMITS = {
  template: 128 * 1024,
  data: 256 * 1024,
  output: 512 * 1024,
  timeoutMs: 1000,
  memoryBytes: 64 * 1024 * 1024,
};
export const visualizationSchema = z
  .object({
    template: z.string().max(VISUALIZER_LIMITS.template),
    data: z.unknown().optional(),
    options: z.object({ noEscape: z.boolean().optional(), strict: z.boolean().optional() }).optional(),
  })
  .refine(
    (v) =>
      new TextEncoder().encode(v.template).byteLength <= VISUALIZER_LIMITS.template &&
      new TextEncoder().encode(JSON.stringify(v.data ?? {})).byteLength <= VISUALIZER_LIMITS.data &&
      new TextEncoder().encode(JSON.stringify(v)).byteLength <=
        VISUALIZER_LIMITS.template + VISUALIZER_LIMITS.data,
    "Visualization exceeds the template/data limit",
  );
export type Visualization = z.infer<typeof visualizationSchema>;
export interface VisualizerResult {
  html: string;
  error?: string;
}
