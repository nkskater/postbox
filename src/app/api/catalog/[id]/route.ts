import { sdkOptionsSchema } from "@/core/sdk/model";
import { generateCatalogSdk } from "@/server/sdk";
import { randomBytes } from "node:crypto";
import { catalogVersionSchema } from "@/core/catalog/model";
import { renderDocumentation } from "@/core/documentation/render";
import { getCatalogEntry, exportCatalog } from "@/server/catalog";
import { callerOf } from "@/server/caller";
import { documentationHtml } from "@/server/documentation-response";
import { json, route } from "@/server/http";
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const id = (await params).id,
    query = new URL(req.url).searchParams,
    caller = callerOf(req);
  const version = catalogVersionSchema.parse(query.get("version") ?? undefined);
  const entry = getCatalogEntry(id, version, caller);
  if (query.get("format") === "sdk") {
    const options = sdkOptionsSchema.parse({
      language: query.get("language"),
      name: query.get("name") ?? undefined,
      version: entry.label,
    });
    const artifact = generateCatalogSdk(id, entry.version, options.language, options.name, caller);
    return new Response(Buffer.from(artifact.archive), {
      headers: {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `attachment; filename="${artifact.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-SDK-SHA256": artifact.sha256,
        "X-Source-SHA256": artifact.sourceHash,
        "X-Catalog-Version": String(entry.version),
      },
    });
  }
  if (query.get("format") === "collection")
    return json(exportCatalog(id, version, caller), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="collection.json"',
        "X-Content-Type-Options": "nosniff",
      },
    });
  if (query.get("format") === "html") {
    const nonce = randomBytes(16).toString("base64");
    return documentationHtml(
      renderDocumentation(entry.snapshot, {
        title: `${entry.title} · ${entry.label}`,
        visibility: entry.visibility,
        revision: entry.revision,
        id,
        nonce,
        queryVersion: entry.version,
        versions: entry.versions,
        details: `Owners: ${entry.owners.join(", ")}\nTags: ${entry.tags.join(", ")}\n${entry.description}`,
      }),
      nonce,
    );
  }
  return json(entry, { headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" } });
});
