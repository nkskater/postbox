import { z } from "zod";
import { packagePatchSchema } from "@/core/packages/model";
import { getScriptPackage, updateScriptPackage, deleteScriptPackage } from "@/server/script-packages";
import { json, parseBody, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (request: Request, c: Context) => {
  const value = new URL(request.url).searchParams.get("version");
  return json(
    getScriptPackage(
      (await c.params).id,
      value === null ? undefined : z.coerce.number().int().positive().parse(value),
    ),
  );
});
export const PATCH = route(async (request: Request, c: Context) =>
  json(updateScriptPackage((await c.params).id, await parseBody(request, packagePatchSchema))),
);
export const DELETE = route(async (_request: Request, c: Context) =>
  json(deleteScriptPackage((await c.params).id)),
);
