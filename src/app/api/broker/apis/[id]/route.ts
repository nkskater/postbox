/** GET / PATCH / DELETE /api/broker/apis/:id — read, change or remove a brokered API (removing it ends all access). */
import { json, parseBody, route } from "@/server/http";
import { apiPatch, deleteApi, getApi, updateApi } from "@/server/broker";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => json(getApi((await params).id)));

export const PATCH = route(async (req: Request, { params }: Ctx) =>
  json(updateApi((await params).id, await parseBody(req, apiPatch))),
);

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  deleteApi((await params).id);
  return json({ deleted: true });
});
