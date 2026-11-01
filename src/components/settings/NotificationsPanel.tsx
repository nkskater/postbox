"use client";
/** Browser notification permission, plus test buttons for the toast, notification and sound. */
import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Bell, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { playChime, showBrowserNotification } from "@/lib/notify";

type Permission = NotificationPermission | "unsupported" | "insecure";

function currentPermission(): Permission {
  if (typeof Notification === "undefined") return window.isSecureContext ? "unsupported" : "insecure";
  if (!window.isSecureContext) return "insecure";
  return Notification.permission;
}

export function NotificationsPanel() {
  const [, refresh] = useState(0);
  // The permission changes when the browser prompt is answered, which re-renders through `refresh`.
  const permission = useSyncExternalStore(
    () => () => undefined,
    currentPermission,
    () => "default" as Permission,
  );
  const explain: Record<Permission, string> = {
    granted: "Browser notifications are allowed.",
    denied: "Browser notifications are blocked. Allow them for this site in your browser's site settings.",
    default: "Your browser has not been asked yet. Use Allow to choose.",
    unsupported: "This browser does not support notifications.",
    insecure:
      "Browsers only allow notifications on HTTPS or localhost pages. Open Postbox over HTTPS (or via localhost) to use them.",
  };
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Browser notifications">
      <h3 className="flex items-center gap-2 font-medium">
        <Bell className="size-4" /> Try it
      </h3>
      <p className="text-sm text-muted-foreground" role="status">
        {explain[permission]}
      </p>
      <div className="flex flex-wrap gap-2">
        {permission === "default" && (
          <Button
            size="sm"
            onClick={() => void Notification.requestPermission().then(() => refresh((v) => v + 1))}
          >
            Allow notifications
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => toast.success("This is how messages look")}>
          Show a test message
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={permission !== "granted"}
          onClick={() => showBrowserNotification("Run passed: Example collection", "12 requests in 45 s")}
        >
          Send a test notification
        </Button>
        <Button size="sm" variant="outline" onClick={() => playChime()}>
          <Volume2 className="size-3.5" /> Play the sound
        </Button>
      </div>
    </section>
  );
}
