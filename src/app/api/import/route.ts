/**
 * POST /api/import — import Postman collection/environment or OpenAPI content.
 * Body: { workspaceId, content } or { workspaceId, url } to fetch a spec server-side.
 */
import { z } from "zod";
import { importContent } from "@/server/importer";
import { getPolicy } from "@/server/context";
import { sendRequest } from "@/core/http/engine";
import { DEFAULT_SETTINGS } from "@/core/types";
import { HttpError, json, parseBody, route } from "@/server/http";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z
      .object({ workspaceId: z.string(), content: z.string().optional(), url: z.string().url().optional() })
      .refine((v) => v.content || v.url, {
        message: "content or url is required",
      }),
  );
  let content = input.content ?? "";
  if (input.url) {
    const res = await sendRequest(
      {
        method: "GET",
        url: input.url,
        headers: [["Accept", "application/json, application/yaml, */*"]],
        settings: { ...DEFAULT_SETTINGS, useCookieJar: false },
      },
      { policy: getPolicy() },
    );
    if (res.status >= 400) throw new HttpError(400, `Fetching ${input.url} failed with status ${res.status}`);
    content = res.bodyText;
  }
  try {
    return json(importContent(input.workspaceId, content, input.url), 201);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});
