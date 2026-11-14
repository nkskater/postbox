import { route } from "@/server/http";
import * as handlers from "@/server/workflows/handlers";
export const GET = route(handlers.get);
export const PUT = route(handlers.update);
export const DELETE = route(handlers.remove);
