import { randomBytes } from "node:crypto";
import { renderDocumentation } from "@/core/documentation/render";
import { documentationCollection, visibleDocumentation } from "@/server/documentation";
import { documentationHtml } from "@/server/documentation-response";
import { callerOf } from "@/server/caller";
import { json, route } from "@/server/http";
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const id = (await params).id;
  const caller = callerOf(req);
  const row = visibleDocumentation(id, caller);
  const format = new URL(req.url).searchParams.get("format");
  if (format === "collection")
    return json(documentationCollection(id, caller), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="collection.json"',
        "X-Content-Type-Options": "nosniff",
      },
    });
  if (format === "json")
    return json(
      { title: row.title, revision: row.revision, visibility: row.visibility, snapshot: row.snapshot },
      { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  const nonce = randomBytes(16).toString("base64");
  return documentationHtml(
    renderDocumentation(row.snapshot, {
      title: row.title,
      visibility: row.visibility,
      revision: row.revision,
      id,
      nonce,
    }),
    nonce,
  );
});
