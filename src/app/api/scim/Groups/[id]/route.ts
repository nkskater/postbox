import { deleteScimGroup, patchScimGroup, readScimGroup, replaceScimGroup, scimRoute } from "@/server/scim";
export const GET = scimRoute("GET", (req, ctx, caller) => readScimGroup(req, ctx, caller));
export const PUT = scimRoute("PUT", (req, ctx, caller) => replaceScimGroup(req, ctx, caller));
export const PATCH = scimRoute("PATCH", (req, ctx, caller) => patchScimGroup(req, ctx, caller));
export const DELETE = scimRoute("DELETE", (req, ctx, caller) => deleteScimGroup(req, ctx, caller));
