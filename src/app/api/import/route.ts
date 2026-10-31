/** POST /api/import — shared collection/spec loading with non-persisting OpenAPI/SoapUI previews. */
import { z } from "zod";
import { importSourceSchema } from "@/core/convert/import-schema";
import { isOpenApiResolutionError } from "@/core/convert/openapi-references";
import { importSource } from "@/server/import-source";
import { HttpError, json, parseBody, route } from "@/server/http";

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, z.object({ workspaceId: z.string() }).and(importSourceSchema));
  try {
    const outcome = await importSource(input.workspaceId, input, { signal: req.signal });
    return json(outcome, outcome.kind === "preview" ? 200 : 201);
  } catch (err) {
    if (isOpenApiResolutionError(err)) return json({ error: err.message, diagnostics: err.diagnostics }, 400);
    throw new HttpError(400, err instanceof Error ? err.message : "Import failed");
  }
});
