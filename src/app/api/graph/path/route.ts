import { graphPath } from "@/server/graph";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) =>
  json(graphPath(Object.fromEntries(new URL(req.url).searchParams))),
);
