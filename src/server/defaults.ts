/**
 * Factories for new entities with sensible defaults.
 */
import type { AuthConfig, BodyConfig, FolderDef, RequestDef } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { nanoid } from "nanoid";

export const newId = () => nanoid(14);

export function defaultRequest(partial: Partial<RequestDef> = {}): RequestDef {
  return {
    id: newId(),
    name: "New Request",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: { mode: "none" } as BodyConfig,
    auth: { type: "inherit" } as AuthConfig,
    preRequestScript: "",
    testScript: "",
    settings: { ...DEFAULT_SETTINGS },
    description: "",
    examples: [],
    ...partial,
  };
}

export function defaultFolder(partial: Partial<FolderDef> = {}): FolderDef {
  return {
    id: newId(),
    name: "New Folder",
    description: "",
    auth: { type: "inherit" },
    headers: [],
    preRequestScript: "",
    testScript: "",
    ...partial,
  };
}
