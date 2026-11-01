import { randomBytes } from "node:crypto";
import { catalogSearchSchema } from "@/core/catalog/model";
import { renderCatalogIndex } from "@/core/catalog/render";
import { searchCatalog } from "@/server/catalog";
import { callerOf } from "@/server/caller";
import { documentationHtml } from "@/server/documentation-response";
import { json, route } from "@/server/http";
export const GET = route((req: Request) => {
  const params = new URL(req.url).searchParams;
  if (params.get("format") === "html") {
    const nonce = randomBytes(16).toString("base64");
    return documentationHtml(renderCatalogIndex(nonce), nonce);
  }
  const input = catalogSearchSchema.parse(Object.fromEntries(params));
  return json(searchCatalog(input, callerOf(req)), {
    headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" },
  });
});
