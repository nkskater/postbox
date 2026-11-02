import { lintDraft, lintDraftInput } from "@/server/governance";
import { json, route, parseBody } from "@/server/http";
export const POST = route(async (req: Request) => json(lintDraft(await parseBody(req, lintDraftInput))));
