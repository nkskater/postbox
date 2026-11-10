import { z } from "zod";
import { providerInput, secretInput } from "@/core/sso/model";
import { HttpError, readBodyText } from "./http";
const bodyInput = z.object({ config: providerInput, secrets: secretInput.optional() }).strict();
export async function readProviderInput(req: Request) {
  const text = await readBodyText(req, 65536);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
  return bodyInput.parse(body);
}
