import { rotateMockKey } from "@/server/mocks";
import { route, json } from "@/server/http";
export const POST = route(async (_r: Request, c: { params: Promise<{ id: string }> }) =>
  json(rotateMockKey((await c.params).id)),
);
