import { route } from "@/server/http";
import { startSso } from "@/server/sso-routes";
export const GET = route(startSso);
