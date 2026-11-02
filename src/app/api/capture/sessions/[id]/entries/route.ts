import { z } from "zod";
import { addHarEntries, deleteEntries, getEntry, listEntries } from "@/server/capture";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** GET /api/capture/sessions/:id/entries[?limit=] or ?entry=<id> for one with headers and bodies. */
export const GET = route(async (req: Request, { params }: Context) => {
  const { id } = await params;
  const url = new URL(req.url);
  const one = url.searchParams.get("entry");
  if (one) return json(getEntry(id, one));
  const limit = Number(url.searchParams.get("limit"));
  return json(listEntries(id, Number.isFinite(limit) && limit > 0 ? limit : undefined));
});

/** POST a HAR 1.2 file (`{ "har": {...} }`) to add its requests to the session. */
export const POST = route(async (req: Request, { params }: Context) => {
  const { har } = await parseBody(req, z.object({ har: z.unknown() }));
  return json(addHarEntries((await params).id, har));
});

/** DELETE removes the entries named in `entryIds`, or every entry when none are given. */
export const DELETE = route(async (req: Request, { params }: Context) => {
  const text = await req.text();
  const ids = text
    ? z.object({ entryIds: z.array(z.string()).max(500).optional() }).parse(JSON.parse(text)).entryIds
    : undefined;
  deleteEntries((await params).id, ids);
  return json({ ok: true });
});
