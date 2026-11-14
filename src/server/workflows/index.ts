export * from "./repo";
export * from "./runner";
export * from "./deployments";
import { getDb, schema } from "../db";
import { eq } from "drizzle-orm";
import { currentCaller } from "../access-context";
import { authorize } from "../authorize";
import { HttpError } from "../errors";
import { row, deleteWorkflowRow } from "./repo";
import { cancelMatching, flowState } from "./state";
export function deleteWorkflow(id: string) {
  const workflow = row(id);
  authorize(currentCaller(), workflow.workspaceId, "manage");
  if (
    getDb()
      .select()
      .from(schema.workflowDeployments)
      .where(eq(schema.workflowDeployments.workflowId, id))
      .get()
  )
    throw new HttpError(409, "Delete this workflow's deployments first");
  cancelMatching((active) => active.workflowId === id);
  deleteWorkflowRow(id);
  flowState.refreshSchedules?.();
}
