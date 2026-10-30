import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, onAuthenticationRequired } from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API authentication notifications", () => {
  it("notifies the shell on 401 before parsing a possibly non-JSON response", async () => {
    vi.stubGlobal("window", new EventTarget());
    const listener = vi.fn();
    const stop = onAuthenticationRequired(listener);
    const response = new Response("<html>Sign in</html>", { status: 401 });
    const read = vi.spyOn(response, "text");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(api.workspaces.list()).rejects.toMatchObject({
      status: 401,
      message: "Authentication required",
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    stop();
  });

  it("removes the notification listener on cleanup and still throws a typed error", async () => {
    vi.stubGlobal("window", new EventTarget());
    const listener = vi.fn();
    const stop = onAuthenticationRequired(listener);
    stop();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(api.workspaces.list()).rejects.toBeInstanceOf(ApiError);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not request navigation for successful or other failed responses", async () => {
    vi.stubGlobal("window", new EventTarget());
    const listener = vi.fn();
    const stop = onAuthenticationRequired(listener);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json([{ id: "workspace", name: "Workspace" }]))
        .mockResolvedValueOnce(Response.json({ error: "Invalid input" }, { status: 400 })),
    );
    await expect(api.workspaces.list()).resolves.toEqual([{ id: "workspace", name: "Workspace" }]);
    await expect(api.workspaces.list()).rejects.toMatchObject({ status: 400, message: "Invalid input" });
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it("handles unauthorized responses without a browser global", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(api.workspaces.list()).rejects.toMatchObject({
      status: 401,
      message: "Authentication required",
    });
  });
});
