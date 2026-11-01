import { packageRevisionSchema } from "@/core/packages/model";
import { reviseScriptPackage } from "@/server/script-packages";
import { json, parseBody, route } from "@/server/http";
export const POST = route(async (request: Request, c: { params: Promise<{ id: string }> }) =>
  json(reviseScriptPackage((await c.params).id, await parseBody(request, packageRevisionSchema)), 201),
);
