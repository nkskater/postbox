import { deleteScimUser, patchScimUser, readScimUser, replaceScimUser, scimRoute } from "@/server/scim";
export const GET = scimRoute("GET", (req, ctx, caller) => readScimUser(req, ctx, caller));
export const PUT = scimRoute("PUT", (req, ctx, caller) => replaceScimUser(req, ctx, caller));
export const PATCH = scimRoute("PATCH", (req, ctx, caller) => patchScimUser(req, ctx, caller));
export const DELETE = scimRoute("DELETE", (req, ctx, caller) => deleteScimUser(req, ctx, caller));
