import { route } from "@/server/http";
import { invokeGateway } from "@/server/gateway";
export const dynamic = "force-dynamic";
async function handle(req: Request, ctx: { params: Promise<{ id: string; path?: string[] }> }) {
  const { id, path = [] } = await ctx.params;
  return invokeGateway(req, id, path);
}
export const GET = route(handle);
export const HEAD = route(handle);
export const POST = route(handle);
export const PUT = route(handle);
export const PATCH = route(handle);
export const DELETE = route(handle);
export const OPTIONS = route(handle);
