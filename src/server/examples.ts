import { createHash } from "node:crypto";
import type { z } from "zod";
import { exampleCommandSchema } from "@/core/schemas";
import { validateExamples } from "@/core/examples";
import type { ResponseExample } from "@/core/types";
import { getDb } from "./db";
import { newId } from "./defaults";
import { HttpError, notFound } from "./errors";
import * as repo from "./repo";

const version = (examples: ResponseExample[]) =>
  createHash("sha256").update(JSON.stringify(examples)).digest("hex");
export function listRequestExamples(requestId: string) {
  const request = repo.getRequest(requestId);
  if (!request) throw notFound("Request");
  const examples = request.examples ?? [];
  return { examples, version: version(examples) };
}
export function changeRequestExamples(requestId: string, raw: z.input<typeof exampleCommandSchema>) {
  const command = exampleCommandSchema.parse(raw);
  return getDb().transaction(() => {
    const current = listRequestExamples(requestId);
    if (command.expectedVersion && command.expectedVersion !== current.version)
      throw new HttpError(409, "Examples changed. Reload the examples before saving again.");
    let examples = [...current.examples];
    const action = command.mutation;
    let selectedId: string | undefined;
    if (action.action === "create") {
      selectedId = newId();
      examples.push({ ...action.example, id: selectedId, createdAt: Date.now() });
    } else if (action.action === "reorder") {
      if (
        action.exampleIds.length !== examples.length ||
        new Set(action.exampleIds).size !== examples.length ||
        action.exampleIds.some((id) => !examples.some((example) => example.id === id))
      )
        throw new HttpError(400, "Provide every current example ID exactly once when reordering");
      examples = action.exampleIds.map((id) => examples.find((example) => example.id === id)!);
    } else {
      const index = examples.findIndex((example) => example.id === action.exampleId);
      if (index < 0) throw notFound("Example");
      if (action.action === "delete") examples.splice(index, 1);
      if (action.action === "update") {
        examples[index] = { ...examples[index], ...action.changes };
        selectedId = action.exampleId;
      }
      if (action.action === "duplicate") {
        selectedId = newId();
        examples.splice(index + 1, 0, {
          ...examples[index],
          id: selectedId,
          name: action.name ?? `${examples[index].name.slice(0, 295)} Copy`,
          createdAt: Date.now(),
        });
      }
    }
    try {
      // Repository sanitation is also used by generic request writes/imports.
      repo.updateRequest(requestId, { examples: validateExamples(examples) });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error instanceof Error ? error.message : "Invalid examples");
    }
    const result = listRequestExamples(requestId);
    return {
      ...result,
      ...(selectedId ? { example: result.examples.find((example) => example.id === selectedId) } : {}),
    };
  });
}
