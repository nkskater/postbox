import { route } from "@/server/http";
import * as handlers from "@/server/workflows/handlers";
export const POST = route(handlers.runDeployment);
