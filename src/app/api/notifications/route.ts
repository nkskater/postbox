import { listNotifications } from "@/server/comments";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET ?unread=1 — mentions and replies addressed to the signed-in user. */
export const GET = route((req: Request) => {
  const url = new URL(req.url);
  return json(
    listNotifications(url.searchParams.get("unread") === "1", Number(url.searchParams.get("limit")) || 50),
  );
});
