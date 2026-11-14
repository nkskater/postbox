import { route } from "@/server/http";
import * as handlers from "@/server/workflows/handlers";
export const GET = route(handlers.webhookStatus);
