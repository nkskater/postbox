"use client";
import { useEffect, useState } from "react";
import { useApp } from "@/stores/app";
export interface Identity {
  kind: string;
  isAdmin: boolean;
  user: { id: string; username: string; displayName: string } | null;
  workspaces: { id: string; role: string; memberCount: number }[];
}
export function useIdentity() {
  const workspaceId = useApp((s) => s.workspaceId);
  const [identity, setIdentity] = useState<Identity | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      void fetch("/api/me", { signal: controller.signal })
        .then(async (response) => {
          if (response.ok) setIdentity(await response.json());
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener("postbox:membership-changed", load);
    return () => {
      controller.abort();
      window.removeEventListener("postbox:membership-changed", load);
    };
  }, [workspaceId]);
  return identity;
}
