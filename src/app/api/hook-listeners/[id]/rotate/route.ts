import { rotateListenerToken } from "@/server/hook-listeners";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** POST gives the listener a new URL; the old one stops working at once. */
export const POST = route(async (_req: Request, { params }: Context) =>
  json(rotateListenerToken((await params).id)),
);
