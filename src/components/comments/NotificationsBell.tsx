"use client";
import { useCallback, useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Feed = Awaited<ReturnType<typeof api.comments.notifications>>;

/** Mentions and replies addressed to the signed-in user. Hidden when there is nothing to show and no account. */
export function NotificationsBell() {
  const [feed, setFeed] = useState<Feed>({ notifications: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const refresh = useCallback(() => {
    api.comments.notifications().then(setFeed, () => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const go = async (n: Feed["notifications"][number]) => {
    const c = n.comment;
    const app = useApp.getState();
    if (c.targetKind === "request") await app.openRequest(c.targetId);
    else if (c.targetKind === "folder")
      app.openTab({ id: `folder-${c.targetId}`, type: "folder", folderId: c.targetId, name: "Discussion" });
    else app.openTab({ id: "api-specifications", type: "specifications", name: "API specifications" });
    setOpen(false);
    await api.comments.markRead([n.id]);
    refresh();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-7" title="Mentions and replies">
          <Bell className="size-4" />
          {feed.unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-[9px] leading-3.5 text-primary-foreground">
              {feed.unread > 99 ? "99+" : feed.unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2 text-xs">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-medium">Mentions and replies</span>
          {feed.unread > 0 && (
            <button
              className="underline"
              onClick={async () => {
                await api.comments.markRead();
                refresh();
              }}
            >
              Mark all read
            </button>
          )}
        </div>
        {feed.notifications.length === 0 && <p className="py-3 text-muted-foreground">Nothing yet.</p>}
        <ul className="max-h-80 space-y-1 overflow-auto">
          {feed.notifications.map((n) => (
            <li key={n.id}>
              <button
                className={`block w-full rounded p-2 text-left hover:bg-accent ${n.readAt ? "opacity-60" : ""}`}
                onClick={() => void go(n)}
              >
                <span className="font-medium">{n.comment.authorName}</span>{" "}
                {n.kind === "mention" ? "mentioned you" : "replied to you"}
                <span className="block truncate text-muted-foreground">{n.comment.body}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
