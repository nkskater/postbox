import { catalogPublishSchema, catalogMetadataSchema } from "@/core/catalog/model";
import * as catalog from "@/server/catalog";
import { json, parseBody, route } from "@/server/http";
type Ctx = { params: Promise<{ id: string }> };
export const GET = route(async (_req: Request, { params }: Ctx) =>
  json(catalog.getFolderCatalog((await params).id)),
);
export const PUT = route(async (req: Request, { params }: Ctx) =>
  json(catalog.publishCatalog((await params).id, await parseBody(req, catalogPublishSchema))),
);
export const PATCH = route(async (req: Request, { params }: Ctx) =>
  json(catalog.updateCatalog((await params).id, await parseBody(req, catalogMetadataSchema))),
);
export const DELETE = route(async (_req: Request, { params }: Ctx) =>
  json(catalog.revokeCatalog((await params).id)),
);
