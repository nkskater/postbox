import { validateSpecification, validateSpecificationInput } from "@/server/specifications";
import { route, json, parseBody } from "@/server/http";
export const POST = route(async (req: Request) =>
  json(validateSpecification(await parseBody(req, validateSpecificationInput))),
);
