import { readProviderInput } from "@/server/sso-input";
import { json, route } from "@/server/http";
import { listProviders, saveProvider } from "@/server/sso";
export const GET = route((_req: Request) => json(listProviders()));
export const POST = route(async (req: Request) => {
  const body = await readProviderInput(req);
  return json(saveProvider(undefined, body.config, body.secrets), 201);
});
