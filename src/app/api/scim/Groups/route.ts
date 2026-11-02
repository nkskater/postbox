import { createScimGroup, listScimGroups, scimRoute } from "@/server/scim";
export const GET = scimRoute("GET", (req, _ctx, caller) => listScimGroups(req, caller));
export const POST = scimRoute("POST", (req, _ctx, caller) => createScimGroup(req, caller));
