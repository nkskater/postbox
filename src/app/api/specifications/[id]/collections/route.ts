import {
  generateCollection,
  generateCollectionInput,
  listSpecificationCollections,
} from "@/server/specification-sync";
import { json, parseBody, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_req: Request, ctx: Context) =>
  json(listSpecificationCollections((await ctx.params).id)),
);
export const POST = route(async (req: Request, ctx: Context) =>
  json(await generateCollection((await ctx.params).id, await parseBody(req, generateCollectionInput)), 201),
);
