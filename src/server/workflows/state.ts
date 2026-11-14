import type { RunTicket } from "../run-queue";
export interface ActiveFlow {
  controller: AbortController;
  ticket: RunTicket;
  queued: boolean;
  queueExpired: boolean;
  workspaceId: string;
  workflowId: string;
  deploymentId: string | null;
  completion: Promise<void>;
}
interface FlowState {
  initialized: boolean;
  active: Map<string, ActiveFlow>;
  refreshSchedules?: () => void;
}
const globalFlows = globalThis as typeof globalThis & { __postboxFlows?: FlowState };
export const flowState: FlowState = (globalFlows.__postboxFlows ??= {
  initialized: false,
  active: new Map<string, ActiveFlow>(),
});
export function cancelActive(id: string) {
  const active = flowState.active.get(id);
  if (!active) return false;
  active.controller.abort(new Error("Workflow cancelled"));
  if (active.queued) active.ticket.cancel();
  return true;
}
export function cancelMatching(filter: (active: ActiveFlow) => boolean) {
  for (const [id, active] of flowState.active) if (filter(active)) cancelActive(id);
}
