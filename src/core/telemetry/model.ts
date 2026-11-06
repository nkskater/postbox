import { z } from "zod";
export const TELEMETRY_LIMITS = {
  sources: 25,
  batchBytes: 2 * 1024 * 1024,
  spans: 1000,
  resources: 100,
  scopes: 100,
  attributes: 128,
  workspaceObservations: 20000,
  failedExamples: 20,
} as const;
export const DEFAULT_SEGMENTS = [
  "api",
  "v1",
  "v2",
  "v3",
  "users",
  "user",
  "orders",
  "order",
  "items",
  "products",
  "customers",
  "accounts",
  "health",
  "healthz",
  "status",
  "ready",
  "live",
  "login",
  "logout",
  "search",
  "graphql",
  "metrics",
  "services",
  "me",
  "profile",
  "auth",
  "sessions",
  "tokens",
  "files",
  "uploads",
];
export const telemetryConfig = z
  .object({
    name: z.string().trim().min(1).max(200),
    serviceName: z.string().trim().min(1).max(120),
    environment: z.string().trim().min(1).max(100).default("production"),
    enabled: z.boolean().default(false),
    sampleRate: z.number().min(0).max(1).default(1),
    retentionDays: z.number().int().min(1).max(30).default(7),
    maxObservations: z.number().int().min(100).max(5000).default(2000),
    staticSegments: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/))
      .max(100)
      .default(DEFAULT_SEGMENTS),
  })
  .strict();
export type TelemetryConfig = z.infer<typeof telemetryConfig>;
export interface Observation {
  traceId: string;
  spanId: string;
  method: string;
  route: string;
  routeSource: "template" | "path" | "unknown";
  status: number | null;
  error: boolean;
  durationMs: number;
  at: number;
  service: string;
  environment: string;
  sampleRate: number;
}
export interface IntakeCounts {
  received: number;
  accepted: number;
  sampledOut: number;
  ignored: number;
  rejected: number;
  duplicates: number;
  evicted: number;
}
export type StoredObservation = Observation & { id: string; sourceId: string; sourceRevision: number };
export const telemetryQuery = z
  .object({
    sourceId: z.string().max(200).optional(),
    service: z.string().max(120).optional(),
    environment: z.string().max(100).optional(),
    from: z.number().finite().nonnegative(),
    to: z.number().finite().positive(),
    search: z.string().max(200).default(""),
    errorsOnly: z.boolean().default(false),
    offset: z.number().int().min(0).max(20000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (v) => v.to > v.from && v.to - v.from <= 30 * 86400000,
    "Choose a nonempty window of at most 30 days",
  );
export type TelemetryQuery = z.infer<typeof telemetryQuery>;
