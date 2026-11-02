import {
  getSpecification,
  saveSpecification,
  saveSpecificationInput,
  deleteSpecification,
} from "@/server/specifications";
import { route, json, parseBody } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (req: Request, ctx: Context) => {
  const { id } = await ctx.params;
  const query = new URL(req.url).searchParams,
    version = query.has("version") ? Number(query.get("version")) : undefined,
    document = getSpecification(id, version);
  if (query.get("export") === "bundle")
    return json(
      { format: document.format, entrypoint: document.entrypoint, files: document.files },
      { headers: { "Content-Disposition": 'attachment; filename="specification-bundle.json"' } },
    );
  return json(document);
});
export const PATCH = route(async (req: Request, ctx: Context) =>
  json(saveSpecification((await ctx.params).id, await parseBody(req, saveSpecificationInput))),
);
export const DELETE = route(async (_req: Request, ctx: Context) =>
  json(deleteSpecification((await ctx.params).id)),
);
