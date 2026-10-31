import { z } from "zod";
export function datasetQuery(input: string) {
  const url = new URL(input),
    version = url.searchParams.get("version");
  return {
    version: version === null ? undefined : z.coerce.number().int().positive().parse(version),
    includeSecrets: url.searchParams.get("includeSecrets") === "1",
    previewRows: url.searchParams.has("previewRows")
      ? z.coerce.number().int().min(1).max(1000).parse(url.searchParams.get("previewRows"))
      : undefined,
  };
}
