import { readProviderInput } from "@/server/sso-input";
import { json, route } from "@/server/http";
import { saveProvider, deleteProvider } from "@/server/sso";
type Context = { params: Promise<{ id: string }> };
export const PUT = route(async (req: Request, context: Context) => {
  const { id } = await context.params,
    body = await readProviderInput(req);
  return json(saveProvider(id, body.config, body.secrets));
});
export const DELETE = route(async (_req: Request, context: Context) => {
  deleteProvider((await context.params).id);
  return json({ ok: true });
});
