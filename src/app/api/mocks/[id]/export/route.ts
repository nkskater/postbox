import { exportMock } from "@/server/mocks";
import { route, json } from "@/server/http";
export const GET = route(async (_r: Request, c: { params: Promise<{ id: string }> }) =>
  json(exportMock((await c.params).id)),
);
