import { notFound } from "next/navigation";
import { WorkflowPanel } from "@/components/workflows/WorkflowPanel";
import { featureEnabled } from "@/server/features";

export const dynamic = "force-dynamic";

export default function FlowsPage() {
  if (!featureEnabled("workflows")) notFound();
  return <WorkflowPanel />;
}
