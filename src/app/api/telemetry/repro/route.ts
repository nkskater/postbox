import { route, json, parseBody } from "@/server/http";
import { planTelemetryRepro, telemetryReproInput } from "@/server/telemetry-repro";
export const POST = route(async (req: Request) =>
  json(planTelemetryRepro(await parseBody(req, telemetryReproInput))),
);
