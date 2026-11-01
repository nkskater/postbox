import { mockCreateSchema } from "@/core/mocks/model";
import { listMocks, createMock } from "@/server/mocks";
import { route, json, parseBody, requireParam } from "@/server/http";
export const GET = route((r: Request) => json(listMocks(requireParam(r.url, "workspaceId"))));
export const POST = route(async (r: Request) => json(createMock(await parseBody(r, mockCreateSchema)), 201));
