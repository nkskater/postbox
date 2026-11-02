import {
  getCollectionSpecification,
  generateSpecification,
  generateSpecificationInput,
  unlinkSpecification,
} from "@/server/specification-sync";
import { json, parseBody, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_req: Request, ctx: Context) =>
  json(getCollectionSpecification((await ctx.params).id)),
);
export const POST = route(async (req: Request, ctx: Context) =>
  json(generateSpecification((await ctx.params).id, await parseBody(req, generateSpecificationInput)), 201),
);
export const DELETE = route(async (_req: Request, ctx: Context) =>
  json(unlinkSpecification((await ctx.params).id)),
);
