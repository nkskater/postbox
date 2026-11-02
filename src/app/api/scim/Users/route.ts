import { createScimUser, listScimUsers, scimRoute } from "@/server/scim";
export const GET = scimRoute("GET", (req, _ctx, caller) => listScimUsers(req, caller));
export const POST = scimRoute("POST", (req, _ctx, caller) => createScimUser(req, caller));
