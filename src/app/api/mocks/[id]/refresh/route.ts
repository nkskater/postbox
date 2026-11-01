import { refreshMock } from "@/server/mocks";
import { route, json } from "@/server/http";
export const POST = route(async (_r: Request, c: { params: Promise<{ id: string }> }) =>
  json(refreshMock((await c.params).id)),
);
