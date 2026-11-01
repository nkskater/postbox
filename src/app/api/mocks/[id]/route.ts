import { mockPatchSchema } from "@/core/mocks/model";
import { getMock, updateMock, deleteMock } from "@/server/mocks";
import { route, json, parseBody } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_r: Request, c: Context) => json(getMock((await c.params).id)));
export const PATCH = route(async (r: Request, c: Context) =>
  json(updateMock((await c.params).id, await parseBody(r, mockPatchSchema))),
);
export const DELETE = route(async (_r: Request, c: Context) => json(deleteMock((await c.params).id)));
