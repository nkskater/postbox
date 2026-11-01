import { z } from "zod";
import type { KeyValue, ResponseExample } from "../types";
import type { MockCandidate } from "./matcher";
export interface MockRoute extends MockCandidate {
  requestId: string;
  response: ResponseExample;
}
export const mockSettingsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  public: z.boolean().default(false),
  matchQuery: z.boolean().default(true),
  matchBody: z.boolean().default(true),
  delayMs: z.number().int().min(0).max(30000).default(0),
  status: z.number().int().min(200).max(599).nullable().default(null),
  headers: z
    .array(z.object({ key: z.string().max(200), value: z.string().max(8192), enabled: z.boolean() }))
    .max(100)
    .default([]),
});
export const mockCreateSchema = mockSettingsSchema.extend({
  workspaceId: z.string().min(1),
  folderId: z.string().min(1),
});
export const mockPatchSchema = mockSettingsSchema.partial();
export interface MockSummary {
  id: string;
  workspaceId: string;
  folderId: string;
  name: string;
  enabled: boolean;
  public: boolean;
  matchQuery: boolean;
  matchBody: boolean;
  delayMs: number;
  status: number | null;
  headers: KeyValue[];
  revision: number;
  routeCount: number;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
}
export interface MockDocument extends MockSummary {
  routes: MockRoute[];
}
