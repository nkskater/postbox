import { rotateSessionToken } from "@/server/capture";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** POST replaces the relay URL; the old one stops working at once. */
export const POST = route(async (_req: Request, { params }: Context) =>
  json(rotateSessionToken((await params).id)),
);
