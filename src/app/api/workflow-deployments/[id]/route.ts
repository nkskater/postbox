import { route } from "@/server/http";
import * as handlers from "@/server/workflows/handlers";
export const GET = route(handlers.deploymentInfo);
export const PUT = route(handlers.updateDeployment);
export const DELETE = route(handlers.removeDeployment);
