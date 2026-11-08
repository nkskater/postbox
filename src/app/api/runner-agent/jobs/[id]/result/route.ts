import { authenticateRunner, completeJob } from "@/server/runners";
import { json, route } from "@/server/http";
import { HttpError } from "@/server/errors";
type Context = { params: Promise<{ id: string }> };
export const POST = route(async (req: Request, c: Context) => {
  const runner = authenticateRunner(req);
  const { id } = await c.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
  return json(completeJob(runner, id, body));
});
