import { randomBytes } from "node:crypto";
import { publicationInputSchema } from "@/core/documentation/model";
import { renderDocumentation } from "@/core/documentation/render";
import * as documentation from "@/server/documentation";
import { documentationHtml } from "@/server/documentation-response";
import { json, parseBody, route } from "@/server/http";
type Ctx = { params: Promise<{ id: string }> };
export const GET = route(async (req: Request, { params }: Ctx) => {
  const id = (await params).id;
  if (new URL(req.url).searchParams.get("preview") === "1") {
    const snapshot = documentation.previewDocumentation(id);
    const nonce = randomBytes(16).toString("base64");
    return documentationHtml(
      renderDocumentation(snapshot, { title: snapshot.root.name, visibility: "preview", revision: 0, nonce }),
      nonce,
    );
  }
  return json(documentation.getDocumentation(id));
});
export const PUT = route(async (req: Request, { params }: Ctx) =>
  json(documentation.publishDocumentation((await params).id, await parseBody(req, publicationInputSchema))),
);
export const DELETE = route(async (_req: Request, { params }: Ctx) =>
  json(documentation.revokeDocumentation((await params).id)),
);
