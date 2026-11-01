import { buildOpenApi } from "@/core/management-api/openapi";
import { json, route } from "@/server/http";

/** The management API's OpenAPI document. Public: it describes routes, never data. */
export const GET = route(() => {
  const response = json(buildOpenApi());
  response.headers.set("Cache-Control", "public, max-age=300");
  return response;
});
