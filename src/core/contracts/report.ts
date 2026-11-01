import type { RequestDef } from "../types";
import { validateDraft, validateExample } from "./validate";
/** Observation only: no executor, network, script or database access. */
export function contractReport(request: RequestDef) {
  return {
    enabled: !!request.contract,
    request: validateDraft(request),
    examples: request.contract
      ? (request.examples ?? []).map((example) => ({
          id: example.id,
          name: example.name,
          diagnostics: validateExample(request.contract!, example),
        }))
      : [],
  };
}
