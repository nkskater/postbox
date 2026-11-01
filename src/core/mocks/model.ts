import { z } from "zod";
import type { KeyValue, ResponseExample } from "../types";
import type { MockCandidate } from "./matcher";
import { scenariosSchema, type Scenario } from "./scenarios";
export interface MockRoute extends MockCandidate {
  requestId: string;
  response: ResponseExample;
}
/** The settings fields without defaults. Defaults apply on create only; a patch must never inject them. */
const settingsFields = {
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  public: z.boolean(),
  matchQuery: z.boolean(),
  matchBody: z.boolean(),
  delayMs: z.number().int().min(0).max(30000),
  status: z.number().int().min(200).max(599).nullable(),
  headers: z
    .array(z.object({ key: z.string().max(200), value: z.string().max(8192), enabled: z.boolean() }))
    .max(100),
  /** Failure simulations applied to every request, with counters kept per session. */
  scenarios: scenariosSchema,
};
export const mockSettingsSchema = z.object({
  ...settingsFields,
  enabled: settingsFields.enabled.default(true),
  public: settingsFields.public.default(false),
  matchQuery: settingsFields.matchQuery.default(true),
  matchBody: settingsFields.matchBody.default(true),
  delayMs: settingsFields.delayMs.default(0),
  status: settingsFields.status.default(null),
  headers: settingsFields.headers.default([]),
  scenarios: settingsFields.scenarios.default([]),
});
export const mockCreateSchema = mockSettingsSchema.extend({
  workspaceId: z.string().min(1),
  folderId: z.string().min(1),
});
/** Partial update: only the fields that are present change. */
export const mockPatchSchema = z.object(settingsFields).partial();
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
  scenarios: Scenario[];
  revision: number;
  routeCount: number;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
}
export interface MockDocument extends MockSummary {
  routes: MockRoute[];
}
