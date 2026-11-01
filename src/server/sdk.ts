import type { Caller } from "./caller";
import { currentCaller } from "./access-context";
import { getCatalogEntry } from "./catalog";
import { generateSdk } from "@/core/sdk/generate";
import { sdkFromCollection } from "@/core/sdk/source";
import { sdkOptionsSchema } from "@/core/sdk/model";
import { HttpError } from "./errors";
export function generateCatalogSdk(
  id: string,
  version: number | undefined,
  language: "typescript" | "python",
  name = "postbox_client",
  caller: Caller | null | undefined = currentCaller(),
) {
  const entry = getCatalogEntry(id, version, caller);
  const options = sdkOptionsSchema.parse({ language, name, version: entry.label });
  try {
    return {
      ...generateSdk(sdkFromCollection(entry.snapshot.root, [], entry.snapshot.authTypes), options),
      catalogVersion: entry.version,
      catalogLabel: entry.label,
    };
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Cannot generate SDK");
  }
}
