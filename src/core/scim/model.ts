/**
 * SCIM 2.0 model: schema identifiers, request validation and response shapes.
 *
 * Pure functions and types only — no database or framework imports (see ARCHITECTURE.md).
 */
import { z } from "zod";

export const SCIM_CONTENT_TYPE = "application/scim+json";
export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export type ScimRecord = Record<string, unknown>;
export type ScimResourceType = "User" | "Group";

/** An invalid SCIM request: carries the status the endpoint must answer with. */
export class ScimError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
  }
}

/** The error body every SCIM endpoint answers with (instead of the generic { error }). */
export const scimErrorBody = (status: number, detail: string): ScimRecord => ({
  schemas: [SCIM_ERROR_SCHEMA],
  detail,
  status: String(status),
});

// ------------------------------------------------------------------ pagination

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;

export interface ScimPage {
  startIndex: number;
  count: number;
}

export function parsePage(params: URLSearchParams): ScimPage {
  const rawStart = params.get("startIndex");
  const rawCount = params.get("count");
  const startIndex = rawStart === null ? 1 : Number(rawStart);
  const count = rawCount === null ? DEFAULT_PAGE_SIZE : Number(rawCount);
  if (!Number.isInteger(startIndex) || startIndex < 1)
    throw new ScimError(400, `startIndex must be a positive integer, got "${rawStart}"`);
  if (!Number.isInteger(count) || count < 0 || count > MAX_PAGE_SIZE)
    throw new ScimError(400, `count must be an integer between 0 and ${MAX_PAGE_SIZE}, got "${rawCount}"`);
  return { startIndex, count };
}

/** A sortable or filterable attribute path: `userName`, `name.givenName`, `members.value`. */
export const ATTRIBUTE_RE = /^[A-Za-z][A-Za-z0-9._]*$/;

export function parseSortOrder(params: URLSearchParams): "asc" | "desc" {
  const value = params.get("sortOrder") ?? "asc";
  if (value !== "asc" && value !== "desc") throw new ScimError(400, `sortOrder must be "asc" or "desc"`);
  return value;
}

// ------------------------------------------------------------------ input shapes

export const scimNameSchema = z
  .object({
    formatted: z.string().max(240).optional(),
    givenName: z.string().max(240).optional(),
    familyName: z.string().max(240).optional(),
  })
  .passthrough();

export const scimEmailSchema = z
  .object({
    value: z.string().min(1).max(320),
    type: z.string().max(64).optional(),
    primary: z.boolean().optional(),
  })
  .passthrough();

export const scimPhoneSchema = z
  .object({ value: z.string().min(1).max(320), type: z.string().max(64).optional() })
  .passthrough();

export const scimMemberSchema = z
  .object({
    value: z.string().min(1).max(120),
    display: z.string().max(240).optional(),
    type: z.string().max(64).optional(),
    primary: z.boolean().optional(),
  })
  .passthrough();

/** A SCIM User resource body, as accepted by POST and PUT. */
export const scimUserInput = z.object({
  userName: z.string().regex(/^[A-Za-z0-9._-]{2,64}$/),
  externalId: z.string().max(120).optional(),
  name: scimNameSchema.optional(),
  emails: z.array(scimEmailSchema).optional(),
  phoneNumbers: z.array(scimPhoneSchema).optional(),
  active: z.boolean().optional(),
  /** Provisioned accounts have no password until one is set; a create may carry one. */
  password: z.string().min(8).max(1024).optional(),
});

/** A SCIM Group resource body, as accepted by POST and PUT. */
export const scimGroupInput = z
  .object({
    name: z.string().min(1).max(120).optional(),
    displayName: z.string().min(1).max(240).optional(),
    externalId: z.string().max(120).optional(),
    members: z.array(scimMemberSchema).optional(),
  })
  .refine((group) => group.name || group.displayName, "Group displayName is required")
  .transform((group) => ({ ...group, name: group.name ?? group.displayName! }));

export const scimPatchOperationSchema = z.object({
  op: z.preprocess(
    (value) => (typeof value === "string" ? value.toLowerCase() : value),
    z.enum(["add", "remove", "replace"]),
  ),
  path: z.string().min(1).max(120).optional(),
  value: z.unknown().optional(),
});

export const scimPatchInput = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z.array(scimPatchOperationSchema).min(1),
});

// ------------------------------------------------------------------ response shapes

const iso = (ms: number) => new Date(ms).toISOString();

export function scimMeta(resourceType: ScimResourceType, location: string, created: number, updated: number) {
  return { resourceType, created: iso(created), lastModified: iso(updated), location };
}

export const userLocation = (id: string) => `/api/scim/Users/${id}`;
export const groupLocation = (id: string) => `/api/scim/Groups/${id}`;

export interface ScimUserData {
  id: string;
  externalId?: string | null;
  userName: string;
  active: boolean;
  /** The stored profile attributes: name, emails, phoneNumbers, ... */
  profile: ScimRecord;
  /** Group memberships reported on the resource. */
  groups?: { value: string; display?: string; type?: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface ScimGroupData {
  id: string;
  externalId?: string | null;
  name: string;
  displayName: string;
  members: Record<string, unknown>[];
  createdAt: number;
  updatedAt: number;
}

export function scimUserResource(user: ScimUserData): ScimRecord {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    ...(user.externalId ? { externalId: user.externalId } : {}),
    userName: user.userName,
    ...user.profile,
    active: user.active,
    ...(user.groups && user.groups.length ? { groups: user.groups } : {}),
    meta: scimMeta("User", userLocation(user.id), user.createdAt, user.updatedAt),
  };
}

export function scimGroupResource(group: ScimGroupData): ScimRecord {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    ...(group.externalId ? { externalId: group.externalId } : {}),
    name: group.name,
    displayName: group.displayName,
    members: group.members,
    meta: scimMeta("Group", groupLocation(group.id), group.createdAt, group.updatedAt),
  };
}

// ------------------------------------------------------------------ list responses

export interface ListOptions {
  page: ScimPage;
  filter?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

/** One page of resources in the SCIM ListResponse envelope. */
export function scimListResponse(
  resourceType: ScimResourceType,
  resources: ScimRecord[],
  totalResults: number,
  options: ListOptions,
): ScimRecord {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults,
    startIndex: options.page.startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.sortBy ? { sortBy: options.sortBy, sortOrder: options.sortOrder ?? "asc" } : {}),
  };
}
