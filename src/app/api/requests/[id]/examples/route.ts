import { exampleCommandSchema } from "@/core/schemas";
import { listRequestExamples, changeRequestExamples } from "@/server/examples";
import { json, parseBody, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_request: Request, { params }: Context) =>
  json(listRequestExamples((await params).id)),
);
export const POST = route(async (request: Request, { params }: Context) =>
  json(changeRequestExamples((await params).id, await parseBody(request, exampleCommandSchema))),
);
