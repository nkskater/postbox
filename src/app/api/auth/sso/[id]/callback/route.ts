import { route } from "@/server/http";
import { callbackSso } from "@/server/sso-routes";
export const GET = route(callbackSso);
export const POST = route(callbackSso);
